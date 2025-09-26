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

_LOGGER = logging.getLogger(__name__)
DOMAIN = "ha_batch_updates"
PANEL_URL_PATH = "batch-updates"
STATIC_URL = f"/{DOMAIN}"
PANEL_TITLE = "Batch Updates"
PANEL_ICON = "mdi:update"

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
    hass.http.register_static_path(
        STATIC_URL, hass.config.path(f"custom_components/{DOMAIN}/panel"), cache_headers=True
    )
    hass.components.frontend.async_register_built_in_panel(
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        config={"embed_iframe": False, "module_url": f"{STATIC_URL}/batch-updates.js"},
        require_admin=True,
    )
    log = UpdateLog(hass)
    await log.async_load()
    hass.data[DOMAIN] = {"log": log}
    websocket_api.async_register_command(hass, _ws_get_log)
    websocket_api.async_register_command(hass, _ws_clear_log)

    schema = vol.Schema({
        vol.Required("entities"): [str],
        vol.Optional("reboot_host", default=False): bool,
        vol.Optional("backup", default=True): bool,
    })

    async def _service(call: ServiceCall):
        entities: List[str] = call.data["entities"]
        reboot_host: bool = call.data["reboot_host"]
        backup_flag: bool = call.data["backup"]
        if not entities:
            _LOGGER.warning("No entities provided")
            return
        last = [e for e in entities if e.startswith("update.home_assistant_")]
        first = [e for e in entities if not e.startswith("update.home_assistant_")]
        ordered = first + last
        batch_id = _utcnow()
        await _log_event(hass, log, {
            "type": "batch_started", "batch_id": batch_id,
            "count": len(ordered), "reboot_host": reboot_host,
            "backup": backup_flag, "ts": _utcnow(),
        })
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
            await _log_item(hass, log, batch_id, ent, "started", "Starting update",
                            extra={"name": name, "from": cur, "to": tgt, "backup": backup_flag})
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
                await _log_item(hass, log, batch_id, ent, "failed_timeout", reason or "timeout")
                _notify(hass, f"{name}: did not complete ({reason or 'timeout'}). Stopping.")
                return
            st2 = hass.states.get(ent)
            if st2 and st2.state == "off":
                await _log_item(hass, log, batch_id, ent, "success", "Updated successfully")
            else:
                await _log_item(hass, log, batch_id, ent, "failed_unclear", "Unclear final state")
                return
        if reboot_host and _is_supervised(hass):
            await _log_event(hass, log, {"type": "batch_finishing", "action": "host_reboot", "ts": _utcnow()})
            await hass.services.async_call("hassio", "host_reboot", {}, blocking=False)
        else:
            await _log_event(hass, log, {"type": "batch_finishing", "action": "ha_restart", "ts": _utcnow()})
            await hass.services.async_call("homeassistant", "restart", {}, blocking=False)

    hass.services.async_register(DOMAIN, "run", _service, schema=schema)
    return True

def _is_supervised(hass: HomeAssistant) -> bool:
    return "hassio" in hass.services.async_services()

def _notify(hass: HomeAssistant, msg: str):
    hass.async_create_task(hass.services.async_call(
        "persistent_notification","create",
        {"title": "Batch Updates","message": msg},blocking=False))

def _utcnow() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"

async def _log_event(hass, log, payload): await log.async_append(payload)
async def _log_item(hass, log, batch, ent, result, reason, extra=None):
    base={"type":"item","batch_id":batch,"entity_id":ent,
          "result":result,"reason":reason,"ts":_utcnow()}
    if extra: base.update(extra)
    await log.async_append(base)

async def _wait_update_complete(hass, ent, timeout) -> Tuple[bool,str|None]:
    done=asyncio.get_event_loop().create_future()
    @callback
    def _ok():
        st=hass.states.get(ent)
        if st and st.state=="off": return True,None
        if st and st.attributes.get("in_progress") in (False,None) and st.state!="on":
            return True,f"final_state={st.state}"
        return False,None
    ok,reason=_ok()
    if ok: return True,reason
    @callback
    def _listener(event):
        if event.data.get("entity_id")==ent:
            ok2,r2=_ok()
            if ok2 and not done.done(): done.set_result((True,r2))
    remove=async_track_state_change_event(hass,[ent],_listener)
    try: return await asyncio.wait_for(done,timeout.total_seconds())
    except asyncio.TimeoutError: return False,"timeout"
    finally: remove()

@websocket_api.websocket_command({"type":f"{DOMAIN}/get_log","limit":vol.Coerce(int)})
@websocket_api.async_response
async def _ws_get_log(hass,connection,msg):
    log:UpdateLog=hass.data[DOMAIN]["log"]
    connection.send_result(msg["id"],{"entries":log.tail(msg.get("limit",100))})

@websocket_api.websocket_command({"type":f"{DOMAIN}/clear_log"})
@websocket_api.async_response
async def _ws_clear_log(hass,connection,msg):
    log:UpdateLog=hass.data[DOMAIN]["log"]
    log._entries=[]; await log._store.async_save([])
    connection.send_result(msg["id"],{"ok":True})
