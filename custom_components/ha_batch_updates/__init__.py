# custom_components/ha_batch_updates/__init__.py
from __future__ import annotations

import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.typing import ConfigType
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.components import websocket_api

_LOGGER = logging.getLogger(__name__)

DOMAIN = "ha_batch_updates"
STATIC_URL = "/ha-batch-updates-static"  # URL prefix to serve our static assets
PANEL_JS_URL = f"{STATIC_URL}/panel/batch-updates.js"
LOG_KEY = f"{DOMAIN}_log"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Batch Updates integration."""
    # Ensure in-memory log store exists
    hass.data.setdefault(LOG_KEY, [])

    # Serve files from <integration>/panel under /ha-batch-updates-static
    panel_dir = Path(__file__).parent / "panel"
    panel_dir.mkdir(exist_ok=True)

    try:
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    url_path=STATIC_URL,
                    path=str(panel_dir),
                    cache_headers=False,
                )
            ]
        )
        _LOGGER.debug("Registered static path: %s -> %s", STATIC_URL, panel_dir)
    except Exception as e:
        _LOGGER.exception("Failed to register static path: %s", e)

    # Load our panel JS globally
    try:
        add_extra_js_url(hass, PANEL_JS_URL)
        _LOGGER.debug("Added panel JS: %s", PANEL_JS_URL)
    except Exception as e:
        _LOGGER.exception("Failed to add panel JS: %s", e)

    # ---- WebSocket commands: get_log / clear_log
    async def _ws_get_log(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """Return recent log entries."""
        limit = msg.get("limit", 100)
        entries = hass.data.get(LOG_KEY, [])[-limit:]
        await connection.send_result(msg["id"], {"entries": entries})

    async def _ws_clear_log(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """Clear log entries."""
        hass.data[LOG_KEY] = []
        await connection.send_result(msg["id"], {"ok": True})

    websocket_api.async_register_command(hass, f"{DOMAIN}/get_log", _ws_get_log)
    websocket_api.async_register_command(hass, f"{DOMAIN}/clear_log", _ws_clear_log)
    _LOGGER.debug("WebSocket commands registered")

    # ---- Service: ha_batch_updates.run
    async def async_service_run(call: ServiceCall) -> None:
        entities = call.data.get("entities") or []
        reboot_host = bool(call.data.get("reboot_host"))
        backup = bool(call.data.get("backup"))

        async def _log(entry: dict[str, Any]) -> None:
            entry = dict(entry)
            entry.setdefault("ts", datetime.now(timezone.utc).isoformat())
            hass.data[LOG_KEY].append(entry)
            # clamp size
            if len(hass.data[LOG_KEY]) > 1000:
                hass.data[LOG_KEY] = hass.data[LOG_KEY][-700:]

        await _log({"type": "batch_start", "result": "started", "action": f"backup={backup}, reboot={reboot_host}"})

        for ent in entities:
            st = hass.states.get(ent)
            name = (st and st.attributes.get("friendly_name")) or ent
            try:
                # Built-in service for update.* entities
                await hass.services.async_call(
                    "update",
                    "install",
                    {"entity_id": ent, "backup": backup},
                    blocking=True,
                )
                await _log({"entity_id": ent, "friendly_name": name, "result": "success"})
            except Exception as e:  # noqa: BLE001
                await _log({"entity_id": ent, "friendly_name": name, "result": "failed", "reason": str(e)})

        if reboot_host:
            try:
                await hass.services.async_call("homeassistant", "restart", {}, blocking=False)
                await _log({"type": "ha_restart", "result": "started"})
            except Exception as e:  # noqa: BLE001
                await _log({"type": "ha_restart", "result": "failed", "reason": str(e)})

        await _log({"type": "batch_finishing", "result": "batch_finishing", "action": "done"})

    hass.services.async_register(DOMAIN, "run", async_service_run)
    _LOGGER.debug("Service %s.run registered", DOMAIN)

    return True
