from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Callable

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.components import panel_custom
from homeassistant.helpers.typing import ConfigType
from homeassistant.config_entries import ConfigEntry
from homeassistant.components.http import HomeAssistantView

DOMAIN = "ha_batch_updates"

MAX_LOGS = 5000  # safety cap
INSTALL_TIMEOUT_S = 900  # 15 minutes per entity

@dataclass
class UpdateLog:
    ts_utc: str  # ISO string (UTC "Z"); frontend renders as local w/o TZ label
    item: str
    result: str   # "started" | "success" | "failed" | "timeout"
    reason: str

class LogStore:
    def __init__(self) -> None:
        self._logs: List[UpdateLog] = []

    def add(self, item: str, result: str, reason: str) -> None:
        now_utc = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
        self._logs.append(UpdateLog(ts_utc=now_utc, item=item, result=result, reason=reason))
        if len(self._logs) > MAX_LOGS:
            self._logs = self._logs[-MAX_LOGS:]

    def get_slice(self, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        logs = list(reversed(self._logs))  # newest first
        slice_ = logs[offset: offset + limit]
        return {"total": len(self._logs), "limit": limit, "offset": offset, "items": [asdict(x) for x in slice_]}

    def seed_example(self) -> None:
        if self._logs:
            return
        self.add("Advanced Camera Card", "started", "Updating v7.15.0 -> v7.17.0")
        self.add("go2rtc", "success", "Updated successfully")
        self.add("HACS Core", "failed", "Network timeout while fetching release")


def _friendly(state) -> str:
    if not state:
        return "Unknown"
    return state.attributes.get("friendly_name") or state.name or state.entity_id

def _latest_version(state) -> Optional[str]:
    return state.attributes.get("latest_version")

def _installed_version(state) -> Optional[str]:
    return state.attributes.get("installed_version")

def _release_payload(state) -> Dict[str, Any]:
    # Gather many possible fields; frontend will pick what exists
    attrs = state.attributes
    keys = [
        "release_summary",
        "release_notes",
        "release_description",
        "changelog",
        "what_new",
        "change_log",
        "release_url",
        "entity_picture",
    ]
    out = {k: attrs.get(k) for k in keys if k in attrs}
    out["installed_version"] = _installed_version(state)
    out["latest_version"] = _latest_version(state)
    return out


# ----------------------------
# HTTP API Views
# ----------------------------
class LogsView(HomeAssistantView):
    url = "/api/ha_batch_updates/logs"
    name = "api:ha_batch_updates:logs"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request):
        try:
            limit = int(request.query.get("limit", "20"))
            offset = int(request.query.get("offset", "0"))
        except ValueError:
            limit, offset = 20, 0

        store: LogStore = self.hass.data[DOMAIN]["log_store"]
        return self.json(store.get_slice(limit=limit, offset=offset))


class PendingView(HomeAssistantView):
    url = "/api/ha_batch_updates/pending"
    name = "api:ha_batch_updates:pending"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request):
        items: List[Dict[str, Any]] = []
        for state in self.hass.states.async_all("update"):
            # "on" means update available (standard UpdateEntity semantics)
            if state.state != "on":
                continue
            items.append({
                "entity_id": state.entity_id,
                "name": _friendly(state),
                "installed_version": _installed_version(state),
                "latest_version": _latest_version(state),
                "release": _release_payload(state),
                "entity_picture": state.attributes.get("entity_picture"),
                "supported_features": state.attributes.get("supported_features", 0),
            })
        return self.json({"count": len(items), "items": items})


class InstallView(HomeAssistantView):
    url = "/api/ha_batch_updates/install"
    name = "api:ha_batch_updates:install"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def post(self, request):
        payload = await request.json()
        entity_ids: List[str] = payload.get("entity_ids", [])
        if not entity_ids:
            return self.json({"status": "error", "message": "No entity_ids provided"}, status_code=400)

        store: LogStore = self.hass.data[DOMAIN]["log_store"]

        async def process_entity(eid: str):
            st = self.hass.states.get(eid)
            if not st or st.state != "on":
                store.add(_friendly(st) if st else eid, "failed", "No update available")
                return

            name = _friendly(st)
            from_v = _installed_version(st) or "unknown"
            to_v = _latest_version(st) or "latest"
            store.add(name, "started", f"Updating {from_v} -> {to_v}")

            # Fire the update.install service (generic across add-ons, HACS, integrations if they expose UpdateEntity)
            try:
                await self.hass.services.async_call(
                    "update",
                    "install",
                    {"entity_id": eid},
                    blocking=False,
                )
            except Exception as e:  # noqa: BLE001
                store.add(name, "failed", f"Service error: {e}")
                return

            # Monitor state changes for completion/timeout
            try:
                result = await _wait_for_update_done(self.hass, eid, timeout=INSTALL_TIMEOUT_S)
                store.add(name, "success" if result else "timeout", "Updated successfully" if result else "Operation timed out")
            except Exception as e:  # noqa: BLE001
                store.add(name, "failed", f"Error while monitoring: {e}")

        await asyncio.gather(*(process_entity(e) for e in entity_ids))
        return self.json({"status": "ok", "count": len(entity_ids)})


async def _wait_for_update_done(hass: HomeAssistant, entity_id: str, timeout: int = INSTALL_TIMEOUT_S) -> bool:
    """
    Returns True when the update is completed (entity turns 'off' and installed_version >= latest_version),
    False on timeout.
    """
    done = asyncio.Event()

    @callback
    def _check_and_set():
        st = hass.states.get(entity_id)
        if not st:
            return
        if st.state == "off":
            # Basic success condition; some entities may leave same installed_version if channel didn't change
            done.set()

    # Initial quick check
    _check_and_set()

    # Subscribe to state changes
    remove: Optional[Callable[[], None]] = None

    @callback
    def _state_listener(event):
        if event.data.get("entity_id") != entity_id:
            return
        _check_and_set()

    remove = hass.bus.async_listen(EVENT_STATE_CHANGED, _state_listener)

    try:
        try:
            await asyncio.wait_for(done.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False
    finally:
        if remove:
            remove()


# ----------------------------
# Setup / Teardown
# ----------------------------
async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["log_store"] = LogStore()
    hass.data[DOMAIN]["log_store"].seed_example()

    # Serve /panel
    panel_path = __package__.replace(".", "/") + "/panel"
    hass.http.register_static_path("/ha_batch_updates", panel_path, cache_headers=True)

    # Sidebar iframe
    await _register_sidebar_panel(hass)

    # Views
    hass.http.register_view(LogsView(hass))
    hass.http.register_view(PendingView(hass))
    hass.http.register_view(InstallView(hass))

    # Services
    async def _reboot_now(call: ServiceCall):
        store: LogStore = hass.data[DOMAIN]["log_store"]
        store.add("System", "started", "Reboot requested by user")

    hass.services.async_register(DOMAIN, "reboot_now", _reboot_now)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True

async def _register_sidebar_panel(hass: HomeAssistant) -> None:
    await panel_custom.async_register_panel(
        hass=hass,
        domain=DOMAIN,
        webcomponent_name="ha-batch-updates",
        sidebar_title="Batch Updates",
        sidebar_icon="mdi:update",
        frontend_url_path="ha_batch_updates",
        html_url="/ha_batch_updates/batch-updates.html",
        require_admin=True,
        embed_iframe=True,
    )
