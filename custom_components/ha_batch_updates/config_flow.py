from __future__ import annotations
from homeassistant import config_entries
from . import DOMAIN  # DOMAIN = "ha_batch_updates" from __init__.py

class BatchUpdatesConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Minimal config flow for single-instance UI setup."""
    VERSION = 1

    async def async_step_user(self, user_input=None):
        # Ensure only one instance can be added
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        # No user options; just create the entry
        return self.async_create_entry(title="Batch Updates (Sidebar)", data={})
