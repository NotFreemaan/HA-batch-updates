# custom_components/ha_batch_updates/__init__.py
from __future__ import annotations

import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.typing import ConfigType
from homeassistant.components.frontend import (
    add_extra_js_url,
    async_register_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.components import websocket_api

_LOGGER = logging.getLogger(__name__)

DOMAIN = "ha_batch_updates"

# Static mount that serves files in <integration>/panel at this URL prefix:
STATIC_URL = "/ha-batch-updates-static"

# Your panel JS module path (served from STATIC_URL)
PANEL_JS_URL = f"{STATIC_URL}/panel/batch-updates.js"

# Sidebar location (the URL path users click in the sidebar)
SIDEBAR_URL_PATH = "batch-updates"

# In-memory log key
LOG_KEY = f"{DOMAIN}_log"


async def _ensure_static_and_resources(hass: HomeAssistant) -> None:
    """Register static mount and (optionally) preload panel JS."""
    panel_dir = Path(__file__).parent / "panel"
    panel_dir.mkdir(exist_ok=True)

    # Serve /ha-batch-updates-static/* from <integration>/panel
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
    except Exception as e:  # noqa: BLE001
        _LOGGER.exception("Failed to register static path: %s", e)

    # Preload panel JS (optional; the panel also loads it when embedded)
    try:
        add_extra_js_url(hass, PANEL_JS_URL)
        _LOGGER.debug("Added panel JS: %s", PANEL_JS_URL)
    except Exception as e:  # noqa: BLE001
        _LOGGER.exception("Failed to add panel JS: %s", e)


def _register_sidebar_panel(hass: HomeAssistant) -> None:
    """Create/replace the sidebar custom panel."""
    # Remove any existing panel with the same path to avoid duplicates
    try:
        async_remove_panel(hass, SIDEBAR_URL_PATH)
    except Exception:
        pass

    # Register a custom panel that iframes our JS module
    # HA expects a "custom" panel with a config containing module_url and embed_iframe.
    async_register_panel(
        hass=hass,
        component_name="custom",
        frontend_url_path=SIDEBAR_URL_PATH,
        config={
            "module_url": PANEL_JS_URL,
            "embed_iframe": True,
            "trust_external": False,
        },
        require_admin=False,
        sidebar_title="Batch Updates",
        sidebar_icon="mdi:update",
    )
    _LOGGER.debug("Sidebar panel registered at /%s", SIDEBAR_URL_PATH)


def _register_ws(hass: HomeAssistant) -> None:
    """Register websocket commands for log access."""
    async def _ws_get_log(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        limit = msg.get("limit", 100)
        entries = hass.data.get(LOG_KEY, [])[-limit:]
        await connection.send_result(msg["id"], {"entries": entries})

    async def _ws_clear_log(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        hass.data[LOG_KEY] = []
        await connection.send_result(msg["id"], {"ok": True})

    websocket_api.async_register_command(hass, f"{DOMAIN}/get_log", _ws_get_log)
    websocket_api.async_register_command(hass, f"{DOMAIN}/clear_log", _ws_clear_log)
    _LOGGER.debug("WebSocket commands registered")


def _register_services(hass: HomeAssistant) -> None:
    """Register the batch updates service."""
    async def async_service_run(call: ServiceCall) -> None:
        entities = call.data.get("entities") or []
        reboot_host = bool(call.data.get("reboot_host"))
        backup = bool(call.data.get("backup"))

        async def _log(entry: dict[str, Any]) -> None:
            entry = dict(entry)
            entry.setdefault("ts", datetime.now(timezone.utc).isoformat())
            hass.data[LOG_KEY].append(entry)
            if len(hass.data[LOG_KEY]) > 1000:
                hass.data[LOG_KEY] = hass.data[LOG_KEY][-700:]

        await _log(
            {
                "type": "batch_start",
                "result": "started",
                "action": f"backup={backup}, reboot={reboot_host}",
            }
        )

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
            except Exception as e:  # noqa: BLE001
                await _log(
                    {
                        "entity_id": ent,
                        "friendly_name": name,
                        "result": "failed",
                        "reason": str(e),
                    }
                )

        if reboot_host:
            try:
                await hass.services.async_call("homeassistant", "restart", {}, blocking=False)
                await _log({"type": "ha_restart", "result": "started"})
            except Exception as e:  # noqa: BLE001
                await _log({"type": "ha_restart", "result": "failed", "reason": str(e)})

        await _log({"type": "batch_finishing", "result": "batch_finishing", "action": "done"})

    if not hass.services.has_service(DOMAIN, "run"):
        hass.services.async_register(DOMAIN, "run", async_service_run)
        _LOGGER.debug("Service %s.run registered", DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML setup (and shared init)."""
    hass.data.setdefault(LOG_KEY, [])
    await _ensure_static_and_resources(hass)
    _register_ws(hass)
    _register_services(hass)
    _register_sidebar_panel(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    """Config entry setup (delegates to the same initialization)."""
    hass.data.setdefault(LOG_KEY, [])
    await _ensure_static_and_resources(hass)
    _register_ws(hass)
    _register_services(hass)
    _register_sidebar_panel(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload a config entry."""
    try:
        async_remove_panel(hass, SIDEBAR_URL_PATH)
        _LOGGER.debug("Sidebar panel removed: /%s", SIDEBAR_URL_PATH)
    except Exception:
        pass
    # Nothing persistent to unload; returning True tells HA it's cleaned up fine.
    return True
