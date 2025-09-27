from __future__ import annotations
import asyncio
import logging
from datetime import timedelta, datetime
from typing import List, Dict, Any, Tuple

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.components import websocket_api
from homeassistant.components.frontend import async_register_built_in_panel
import voluptuous as vol

try:
    from homeassistant.components.http import StaticPathConfig
except Exception:  # noqa: BLE001
    StaticPathConfig = None  # type: ignore

_LOGGER = logging.getLogger(__name__)

DOMAIN = "ha_batch_updates"
PANEL_URL_PATH = "batch-updates"
STATIC_URL = f"/{DOMAIN}"
PANEL_TITLE = "Batch Updates"
PANEL_ICON = "mdi:playlist-check"

LOG_STORE_VERSION = 1
LOG_STORE_FILENAME = f"{DOMAIN}_log.json"
LOG_MAX_ENTRIES = 500


class UpdateLog:
    def __init__(self, hass: HomeAssistant):
        self._store = Store(hass, LOG_STORE_VERSION, LOG_STORE_FILENAME)
        self._entries: List[Dict[str, Any]] = []

    async def async_load(self):
        data = await self._store.async_load()
        self._entries = data or []

    async def async_append(self, entry: Dict[str, Any]):
        self._entries.append(entry)
        if len(self._entries) > LOG_MAX_ENTRIES:
            self._entries = self._entries[-LOG_MAX_ENTRIES:]
        await self._store.async_save(self._entries)

    def tail(self, limit: int = 100) -> List[Dict[str, Any]]:
        return list(self._entries[-limit:])


async def async_setup(hass: HomeAssistant, config) -> bool:
    panel_fs_path = hass.config.path(f"custom_components/{DOMAIN}/panel")

    # Serve panel assets
    try:
        if hasattr(hass.http, "async_register_static_paths") and StaticPathConfig is not None:
            await hass.http.async_register_static_paths([StaticPathConfig(STATIC_URL, panel_fs_path)])
        elif hasattr(hass.http, "register_static_path"):
            hass.http.register_static_path(STATIC_URL, panel_fs_path, cache_headers=True)
        else:
            hass.http.app.router.add_static(STATIC_URL, panel_fs_path, follow_symlinks=True)  # type: ignore[attr-defined]
        _LOGGER.info("%s static mounted at %s", DOMAIN, STATIC_URL)
    except Exception as e:
        _LOGGER.error("Static path registration failed: %s", e)
        return False

    # Sidebar panel
    try:
        async_register_built_in_panel(
            hass,
            component_name="iframe",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=PANEL_URL_PATH,
            config={"url": f"{STATIC_URL}/batch-updates.html"},
            require_admin=True,
        )
        _LOGGER.info("%s iframe panel registered", DOMAIN)
    except Exception as e:
        _LOGGER.error("Failed to register iframe panel: %s", e)
        return False

    # Log store
    log = UpdateLog(hass)
    await log.async_load()
    hass.data[DOMAIN] = {"log": log}

    # WS API
    websocket_api.async_register_command(hass, _ws_get_log)
    websocket_api.async_register_command(hass, _ws_clear_log)

    # Batch run service
    schema = vol.Schema(
        {
            vol.Required("entities"): [str],
            vol.Optional("reboot_host", default=False): bool,  # no longer used
            vol.Optional("backup", default=True): bool,
        }
    )

    async def _service(call: ServiceCall):
        entities: List[str] = call.data["entities"]
        backup_flag: bool = call.data["backup"]
        if not entities:
            _LOGGER.warning("No entities provided to %s.run", DOMAIN)
            return

        # Reorder: HA updates last
        last = [e for e in entities if e.startswith("update.home_assistant_")]
        first = [e for e in entities if not e.startswith("update.home_assistant_")]
        ordered = first + last

        batch_id = _utcnow()
        for ent in ordered:
            st = hass.states.get(ent)
            if not st:
                await _log_item(hass, log, batch_id, ent, "failed_not_found", "Entity not found")
                _notify(hass, f"{ent} not found. Halting batch.")
                return

            if st.state != "on":
                await _log_item(hass, log, batch_id, ent, "skipped_no_update", "No update pending")
                continue

            name = st.attributes.get("friendly_name") or ent
            cur = st.attributes.get("installed_version")
            tgt = st.attributes.get("latest_version")

            await _log_item(
                hass, log, batch_id, ent, "started", "Starting update",
                extra={"name": name, "from": cur, "to": tgt, "backup": backup_flag}
            )

            try:
                await hass.services.async_call(
                    "update", "install", {"entity_id": ent, "backup": backup_flag}, blocking=False
                )
            except Exception as e:
                await _log_item(hass, log, batch_id, ent, "failed_service_error", str(e))
                _notify(hass, f"{name}: service error: {e}. Halting batch.")
                return

            ok, reason = await _wait_update_complete(hass, ent, timedelta(minutes=30))
            if not ok:
                await _log_item(hass, log, batch_id, ent, "failed_timeout_or_incomplete", reason or "timeout")
                _notify(hass, f"{name}: did not complete cleanly. Halting batch.")
                return

            st2 = hass.states.get(ent)
            if st2 and st2.state == "off":
                await _log_item(hass, log, batch_id, ent, "success", "Updated successfully")
                _logbook(hass, f"{name} updated successfully.")
            else:
                await _log_item(hass, log, batch_id, ent, "failed_unclear", f"final_state={st2.state if st2 else 'unknown'}")
                _notify(hass, f"{name}: unclear completion. Halting batch.")
                return

        _notify(hass, "Batch complete. Use the Reboot now button if required.")

    hass.services.async_register(DOMAIN, "run", _service, schema=schema)

    # Reboot-now service
    async def _reboot_service(call: ServiceCall):
        if _is_supervised(hass):
            await hass.services.async_call("hassio", "host_reboot", {}, blocking=False)
        else:
            await hass.services.async_call("homeassistant", "restart", {}, blocking=False)

    hass.services.async_register(DOMAIN, "reboot_now", _reboot_service)
    return True


def _is_supervised(hass: HomeAssistant) -> bool:
    return "hassio" in hass.services.async_services()


def _notify(hass: HomeAssistant, msg: str):
    hass.async_create_task(
        hass.services.async_call(
            "persistent_notification", "create", {"title": "Batch Updates", "message": msg}, blocking=False
        )
    )


def _logbook(hass: HomeAssistant, message: str):
    hass.async_create_task(
        hass.services.async_call("logbook", "log", {"name": "Batch Updates", "message": message}, blocking=False)
    )


async def _log_item(
    hass: HomeAssistant,
    log: UpdateLog,
    batch_id: str,
    entity_id: str,
    result: str,
    reason: str,
    extra: Dict[str, Any] | None = None,
):
    st = hass.states.get(entity_id)
    base = {
        "type": "item",
        "batch_id": batch_id,
        "entity_id": entity_id,
        "friendly_name": (st and st.attributes.get("friendly_name")) or entity_id,
        "result": result,
        "reason": reason,
        "ts": _utcnow(),
    }
    if extra: base.update(extra)
    await log.async_append(base)
    _LOGGER.info("BatchUpdates LOG: %s", base)


def _utcnow() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


async def _wait_update_complete(hass: HomeAssistant, ent: str, timeout: timedelta) -> Tuple[bool, str | None]:
    done: asyncio.Future = asyncio.get_event_loop().create_future()

    @callback
    def _ok() -> Tuple[bool, str | None]:
        st = hass.states.get(ent)
        if st is None: return False, "entity_disappeared"
        in_prog = st.attributes.get("in_progress")
        if st.state == "off": return True, None
        if in_prog in (False, None) and st.state != "on":
            return True, f"final_state={st.state}, in_progress={in_prog}"
        return False, None

    ok, reason = _ok()
    if ok: return True, reason

    @callback
    def _listener(event):
        if event.data.get("entity_id") != ent: return
        ok2, r2 = _ok()
        if ok2 and not done.done(): done.set_result((True, r2))

    remove = async_track_state_change_event(hass, [ent], _listener)
    try:
        res = await asyncio.wait_for(done, timeout.total_seconds())
        return res
    except asyncio.TimeoutError:
        return False, "timeout"
    finally:
        remove()


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_log", vol.Optional("limit", default=100): vol.Coerce(int)}
)
@websocket_api.async_response
async def _ws_get_log(hass: HomeAssistant, connection, msg):
    log: UpdateLog = hass.data[DOMAIN]["log"]
    connection.send_result(msg["id"], {"entries": log.tail(msg.get("limit", 100))})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/clear_log"})
@websocket_api.async_response
async def _ws_clear_log(hass: HomeAssistant, connection, msg):
    log: UpdateLog = hass.data[DOMAIN]["log"]
    log._entries = []
    await log._store.async_save([])
    connection.send_result(msg["id"], {"ok": True})


async def async_setup_entry(hass, entry):
    return True


async def async_unload_entry(hass, entry):
    return True
