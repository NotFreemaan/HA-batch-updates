# Batch Updates (Sidebar) – Home Assistant

Adds a **sidebar panel** that lists all `update.*` entities with updates available, lets you **tick** the ones you want, and runs them **sequentially** with an optional **backup per item**, stopping on error and **restarting or rebooting** at the end. Includes a **persistent log** and in-panel **log viewer**.

## Features
- Sidebar page (admin by default)
- Checkboxes + **Update now**
- Optional **Back up before each update**
- Defers Core/OS/Supervisor updates to **last**
- **Stops on first failure** and shows a notification
- **Log history** stored in `.storage/ha_batch_updates_log.json` with in-panel viewer

## Install (HACS – Custom Repository)
1. In HA, go to **HACS → Integrations → ⋮ → Custom repositories**.
2. Add your repo URL (e.g., `https://github.com/yourname/ha-batch-updates`) with category **Integration**.
3. Install **Batch Updates (Sidebar)**.
4. **Restart Home Assistant**.
5. Open **Batch Updates** in the sidebar.

### Manual Install (no HACS)
1. Copy the `custom_components/ha_batch_updates` folder into your HA `config/custom_components` directory.
2. **Restart Home Assistant**.

## Usage
- Open **Batch Updates** from the sidebar.
- Tick the items you want, choose **Back up before each update** (optional), and **Reboot host at end** (HA OS/Supervised only).
- Click **Update now**.
- Watch progress in **Settings → Notifications**; view history in the panel’s **Update log** table.

## Service
You can also trigger via service:
