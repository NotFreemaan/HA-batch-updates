# custom_components/ha_batch_updates/__init__.py
from __future__ import annotations

import logging
from pathlib import Path
from datetime import datetime, timezone

from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType
from homeassistant.components.frontend import add_extra_js_url

_LOGGER = logging.getLogger(__name__)

DOMAIN = "ha_batch_updates"
STATIC_URL = "/ha-batch-updates-static"  # our mounted static path
PANEL_JS_URL = f"{STATIC_URL}/panel/batch-updates.js"
LOG_KEY = f"{DOMAIN}_log"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Batch Updates integration."""
    # Serve files from <integration>/panel under /ha-batch-updates-static
    panel_dir = Path(__file__).parent / "panel"
    panel_dir.mkdir(exist_ok=True)  # ensure it exists

    try:
        await hass.http.async_register_static_paths([
            (STATIC_URL, str(panel_dir), False)
        ])
        _LOGGER.debug("Registered static path: %s -> %s", STATIC_URL, panel_dir)
    except Exception as e:
        _LOGGER.exception("Failed to register static path: %s", e)

    # Load our panel JS globally (Home Assistant will iframe the custom panel)
    try:
        add_extra_js_url(hass, PANEL_JS_URL)
        _LOGGER.debug("Added panel JS: %s", PANEL_JS_URL)
    except Exception as e:
        _LOGGER.exception("Failed to add panel JS: %s", e)

    # --- Lightweight in-memory log for batch updates
    hass.data.setdefault(LOG_KEY, [])

    async def _log(entry: dict) -> None:
        entry = dict(entry)
        entry.setdefault("ts", datetime.now(timezone.utc).isoformat())
        hass.data[LOG_KEY].append(entry)
        # clamp size
        if len(hass.data[LOG_KEY]) > 1000:
            hass.data[LOG_KEY] = hass.data[LOG_KEY][-700:]

    # --- WebSocket commands: get_log / clear_log
    async def _ws_router(hass, connection, msg):
        mtype = msg.get("type")
        if mtype == f"{DOMAIN}/get_log":
            limit = msg.get("limit", 100)
            entries = hass.data.get(LOG_KEY, [])[-limit:]
            await connection.send_result(msg["id"], {"entries": entries})
        elif mtype == f"{DOMAIN}/clear_log":
            hass.data[LOG_KEY] = []
            await connection.send_result(msg["id"], {"ok": True})
        else:
            await connection.send_error(msg["id"], "invalid_command", f"Unknown command: {mtype}")

    hass.components.websocket_api.async_register_command(
        f"{DOMAIN}/get_log", lambda hass, conn, msg: hass.async_create_task(_ws_router(hass, conn, msg))
    )
    hass.components.websocket_api.async_register_command(
        f"{DOMAIN}/clear_log", lambda hass, conn, msg: hass.async_create_task(_ws_router(hass, conn, msg))
    )
    _LOGGER.debug("WebSocket commands registered")

    # --- Service: ha_batch_updates.run
    async def async_service_run(call):
        entities = call.data.get("entities") or []
        reboot_host = bool(call.data.get("reboot_host"))
        backup = bool(call.data.get("backup"))

        await _log({"type": "batch_start", "result": "started", "action": f"backup={backup}, reboot={reboot_host}"})

        for ent in entities:
            st = hass.states.get(ent)
            name = (st and st.attributes.get("friendly_name")) or ent
            try:
                await hass.services.async_call(
                    "update",
                    "install",
                    {"entity_id": ent, "backup": backup},
                    blocking=True,
                )
                await _log({"entity_id": ent, "friendly_name": name, "result": "success"})
            except Exception as e:
                await _log({"entity_id": ent, "friendly_name": name, "result": "failed", "reason": str(e)})

        if reboot_host:
            try:
                await hass.services.async_call("homeassistant", "restart", {}, blocking=False)
                await _log({"type": "ha_restart", "result": "started"})
            except Exception as e:
                await _log({"type": "ha_restart", "result": "failed", "reason": str(e)})

        await _log({"type": "batch_finishing", "result": "batch_finishing", "action": "done"})
        return True

    hass.services.async_register(DOMAIN, "run", async_service_run)
    _LOGGER.debug("Service %s.run registered", DOMAIN)

    return True
