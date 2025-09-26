from __future__ import annotations
import asyncio
import logging
from datetime import timedelta, datetime
from typing import List, Dict, Any, Tuple

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.components import websocket_api
import voluptuous as vol

# Try to import StaticPathConfig for newer HA; fall back gracefully
try:
    from homeassistant.components.http import StaticPathConfig  # HA 2024.8+
except Exception:  # noqa: BLE001
    StaticPathConfig = None  # type: ignore

_LOGGER = logging.getLogger(__name__)

DOMAIN = "ha_batch_updates"
PANEL_URL_PATH = "batch-updates"
STATIC_URL = f"/{DOMAIN}"
PANEL_TITLE = "Batch Updates"
PANEL_ICON = "mdi:playlist-check"  # pick a valid MDI icon

LOG_STORE_VERSION = 1
LOG_STORE_FILENAME = f"{DOMAIN}_log.json"
LOG_MAX_ENTRIES = 500  # ring buffer


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
    """YAML setup: register static files, sidebar panel, log, WS, and service."""
    # --- Serve panel assets (compat across HA versions) ---
    panel_fs_path = hass.config.path(f"custom_components/{DOMAIN}/panel")
    if hasattr(hass.http, "register_static_path"):
        # Older HA
        hass.http.register_static_path(STATIC_URL, panel_fs_path, cache_headers=True)
    else:
        # Newer HA
        paths = []
        if StaticPathConfig is not None:
            paths = [StaticPathConfig(STATIC_URL, panel_fs_path)]
        # some HA builds accept a (url, path) tuple list; try that as fallback
        try:
            hass.http.async_register_static_paths(paths or [(STATIC_URL, panel_fs_path)])  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001
            _LOGGER.error("Failed to register static paths for %s: %s", DOMAIN, e)
            return False

    # --- Sidebar panel (admin-only by default) ---
    try:
        hass.components.frontend.async_register_built_in_panel(
            component_name="custom",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=PANEL_URL_PATH,
            config={"embed_iframe": False, "module_url": f"{STATIC_URL}/batch-updates.js"},
            require_admin=True,
        )
    except Exception as e:  # noqa: BLE001
        _LOGGER.error("Failed to register sidebar panel: %s", e)
        return False

    # --- Persistent log store ---
    log = UpdateLog(hass)
    await log.async_load()
    hass.data[DOMAIN] = {"log": log}

    # --- WebSocket API: get/clear log ---
    websocket_api.async_register_command(hass, _ws_get_log)
    websocket_api.async_register_command(hass, _ws_clear_log)

    # --- Batch update service ---
    schema = vol.Schema(
        {
            vol.Required("entities"): [str],
            vol.Optional("reboot_host", default=False): bool,
            vol.Optional("backup", default=True): bool,  # pass through to update.install
        }
    )

    async def _service(call: ServiceCall):
        entities: List[str] = call.data["entities"]
        reboot_host: bool = call.data["reboot_host"]
        backup_flag: bool = call.data["backup"]
        if not entities:
            _LOGGER.warning("No entities provided to %s.run", DOMAIN)
            return

        # Defer HA Core/OS/Supervisor to last (they may restart HA)
        last = [e for e in entities if e.startswith("update.home_assistant_")]
        first = [e for e in entities if not e.startswith("update.home_assistant_")]
        ordered = first + last

        batch_id = _utcnow()
        await _log_event(
            hass,
            log,
            {
                "type": "batch_started",
                "batch_id": batch_id,
                "count": len(ordered),
                "reboot_host": reboot_host,
                "backup": backup_flag,
                "ts": _utcnow(),
            },
        )

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
                hass,
                log,
                batch_id,
                ent,
                "started",
                "Starting update",
                extra={"name": name, "from": cur, "to": tgt, "backup": backup_flag},
            )

            try:
                await hass.services.async_call(
                    "update", "install", {"entity_id": ent, "backup": backup_flag}, blocking=False
                )
            except Exception as e:  # noqa: BLE001
                await _log_item(hass, log, batch_id, ent, "failed_service_error", str(e))
                _notify(hass, f"{name}: service error: {e}. Halting batch.")
                return

            ok, reason = await _wait_update_complete(hass, ent, timedelta(minutes=30))
            if not ok:
                await _log_item(
                    hass,
                    log,
                    batch_id,
                    ent,
                    "failed_timeout_or_incomplete",
                    reason or "timeout/incomplete",
                )
                _notify(hass, f"{name}: did not complete cleanly ({reason or 'timeout'}). Halting batch.")
                return

            st2 = hass.states.get(ent)
            post = st2.state if st2 else "unknown"
            if post == "off":
                await _log_item(
                    hass, log, batch_id, ent, "success", "Updated successfully", extra={"final_state": post}
                )
                _logbook(hass, f"{name} updated successfully.")
            else:
                in_prog = st2 and st2.attributes.get("in_progress")
                extra_reason = f"final_state={post}, in_progress={in_prog}"
                await _log_item(hass, log, batch_id, ent, "failed_unclear", extra_reason)
                _notify(hass, f"{name}: unclear completion ({extra_reason}). Halting batch.")
                return

        # All done: reboot host (HA OS/Supervised) or restart core
        if reboot_host and _is_supervised(hass):
            await _log_event(
                hass, log, {"type": "batch_finishing", "batch_id": batch_id, "action": "host_reboot", "ts": _utcnow()}
            )
            await hass.services.async_call("hassio", "host_reboot", {}, blocking=False)
        else:
            await _log_event(
                hass, log, {"type": "batch_finishing", "batch_id": batch_id, "action": "ha_restart", "ts": _utcnow()}
            )
            await hass.services.async_call("homeassistant", "restart", {}, blocking=False)

    hass.services.async_register(DOMAIN, "run", _service, schema=schema)
    return True


def _is_supervised(hass: HomeAssistant) -> bool:
    return "hassio" in hass.services.async_services()


def _notify(hass: HomeAssistant, msg: str):
    hass.async_create_task(
        hass.services.async_call(
            "persistent_notification",
            "create",
            {"title": "Batch Updates", "message": msg},
            blocking=False,
        )
    )


def _logbook(hass: HomeAssistant, message: str):
    hass.async_create_task(
        hass.services.async_call(
            "logbook", "log", {"name": "Batch Updates", "message": message}, blocking=False
        )
    )


async def _log_event(hass: HomeAssistant, log: UpdateLog, payload: Dict[str, Any]):
    await log.async_append(payload)
    _LOGGER.info("BatchUpdates LOG: %s", payload)


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
        "result": result,  # success | failed_* | started | skipped_no_update
        "reason": reason,
        "ts": _utcnow(),
    }
    if extra:
        base.update(extra)
    await log.async_append(base)
    _LOGGER.info("BatchUpdates LOG: %s", base)


def _utcnow() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


async def _wait_update_complete(hass: HomeAssistant, ent: str, timeout: timedelta) -> Tuple[bool, str | None]:
    """Return (ok, reason). Success if state becomes 'off' or in_progress clears and state != 'on'."""
    done: asyncio.Future = asyncio.get_event_loop().create_future()

    @callback
    def _ok() -> Tuple[bool, str | None]:
        st = hass.states.get(ent)
        if st is None:
            return False, "entity_disappeared"
        in_prog = st.attributes.get("in_progress")
        if st.state == "off":
            return True, None
        if in_prog in (False, None) and st.state != "on":
            return True, f"final_state={st.state}, in_progress={in_prog}"
        return False, None

    ok, reason = _ok()
    if ok:
        return True, reason

    @callback
    def _listener(event):
        if event.data.get("entity_id") != ent:
            return
        ok2, r2 = _ok()
        if ok2 and not done.done():
            done.set_result((True, r2))

    remove = async_track_state_change_event(hass, [ent], _listener)

    try:
        res = await asyncio.wait_for(done, timeout.total_seconds())
        return res
    except asyncio.TimeoutError:
        return False, "timeout"
    finally:
        remove()


# -------------------
# WebSocket endpoints
# -------------------
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


# -----------------------------
# Config entry support
# -----------------------------
async def async_setup_entry(hass: HomeAssistant, entry):
    """Set up Batch Updates from a config entry (if you add a config flow later)."""
    return True


async def async_unload_entry(hass: HomeAssistant, entry):
    """Unload Batch Updates config entry."""
    return True
