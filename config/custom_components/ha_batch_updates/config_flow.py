from __future__ import annotations
from homeassistant import config_entries
from . import DOMAIN

class BatchUpdatesConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        # single-instance only
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Batch Updates (Sidebar)", data={})
