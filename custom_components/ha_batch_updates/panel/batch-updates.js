// Batch Updates panel – iframe-aware, grabs hassConnection from parent/top, with REST fallback

console.info("%c[Batch Updates] panel script loaded", "color:#0b74de;font-weight:bold");

/* ---------------- Helpers: get a HA connection or a thin client ---------------- */
async function getHAClient(timeoutMs = 15000) {
  const start = Date.now();

  async function tryGetConn(host) {
    try {
      if (!host) return null;
      // Preferred contract: Promise that resolves to {conn}
      if (host.hassConnection && typeof host.hassConnection.then === "function") {
        const { conn } = await host.hassConnection;
        if (conn) return { mode: "ws", conn, hass: host.hass || null };
      }
      // Direct hass.connection (older/newer builds)
      const hass = host.hass || host.__hass;
      const conn = hass?.connection || hass?.conn;
      if (conn) return { mode: "ws", conn, hass: hass || null };
    } catch (_) {}
    return null;
  }

  // Try current window, then parent, then top (iframe scenarios)
  while (Date.now() - start < timeoutMs) {
    let client =
      (await tryGetConn(window)) ||
      (await tryGetConn(window.parent)) ||
      (await tryGetConn(window.top));
    if (client) {
      console.info("[Batch Updates] got WebSocket connection");
      return client;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // REST fallback (last resort). We need an access token; try to read from parent/top.
  const token =
    window?.parent?.hass?.auth?.data?.access_token ||
    window?.top?.hass?.auth?.data?.access_token ||
    null;

  if (!token) {
    throw new Error("No hassConnection in iframe and no auth token found for REST fallback");
  }

  console.warn("[Batch Updates] using REST fallback (no websocket)");
  const rest = {
    mode: "rest",
    token,
    async getStates() {
      const res = await fetch("/api/states", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`REST /api/states failed: ${res.status}`);
      return await res.json();
    },
    async getLog(limit = 100) {
      // No REST endpoint for our custom log; just return empty in REST mode
      return { entries: [] };
    },
    async clearLog() {
      return { ok: true };
    },
    async callService(domain, service, service_data) {
      const res = await fetch(`/api/services/${domain}/${service}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(service_data || {}),
      });
      if (!res.ok) throw new Error(`REST call_service ${domain}.${service} failed: ${res.status}`);
      return await res.json();
    },
    // subscribe to state changes is not supported in REST fallback
    subscribeStates(handler) {
      console.warn("[Batch Updates] REST mode: live updates disabled");
      return () => {};
    },
  };
  return rest;
}

/* ---------------- Web Component ---------------- */
class BatchUpdatesPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._states = {};
    this._selected = new Set();
    this._reboot = false;
    this._backup = true; // default: make backups
    this._log = [];
    this._unsub = null;
    this._client = null; // {mode:'ws'|'rest', ...}
  }

  connectedCallback() {
    this.render(); // initial shell
    this._init();
  }
  disconnectedCallback() { if (this._unsub) this._unsub(); }

  async _init() {
    try {
      this._client = await getHAClient(20000);
      if (this._client.mode === "ws") {
        console.info("[Batch Updates] hassConnection ready (WS)");
        await this._subscribeWS();
      } else {
        console.info("[Batch Updates] client ready (REST fallback)");
        await this._loadOnceREST();
      }
    } catch (e) {
      console.error("[Batch Updates] initialization error:", e);
      this.shadowRoot.innerHTML = `
        <div style="padding:16px">
          <h3>Home Assistant connection not ready</h3>
          <p>This panel is loaded in an iframe and couldn't access HA's connection.
             Try a hard refresh, or ensure you're logged in on this browser.</p>
          <details><summary>Error</summary><pre style="white-space:pre-wrap">${String(e)}</pre></details>
        </div>`;
    }
  }

  /* ---------- WS mode ---------- */
  async _subscribeWS() {
    const conn = this._client.conn;
    // Load initial states
    const resp = await conn.sendMessagePromise({ type: "get_states" });
    this._states = Object.fromEntries(resp.map((s) => [s.entity_id, s]));
    await this._loadLogWS();
    this.render();

    // Subscribe to live updates for update.* entities
    this._unsub = await conn.subscribeMessage(
      (evt) => {
        const ent = evt?.event?.data?.entity_id;
        if (ent && ent.startsWith("update.")) {
          conn.sendMessagePromise({ type: "get_states" }).then((all) => {
            this._states = Object.fromEntries(all.map((s) => [s.entity_id, s]));
            this.render();
          });
        }
      },
      { type: "subscribe_events", event_type: "state_changed" }
    );
  }

  async _loadLogWS(limit = 100) {
    const conn = this._client.conn;
    try {
      const res = await conn.sendMessagePromise({ type: "ha_batch_updates/get_log", limit });
      this._log = res.entries || [];
    } catch (e) {
      console.warn("[Batch Updates] WS log fetch failed:", e);
      this._log = [];
    }
  }

  /* ---------- REST mode ---------- */
  async _loadOnceREST() {
    const resp = await this._client.getStates();
    this._states = Object.fromEntries(resp.map((s) => [s.entity_id, s]));
    const res = await this._client.getLog(100);
    this._log = res.entries || [];
    this.render();
  }

  async _clearLog() {
    if (this._client.mode === "ws") {
      await this._client.conn.sendMessagePromise({ type: "ha_batch_updates/clear_log" });
      await this._loadLogWS();
    } else {
      await this._client.clearLog();
      this._log = [];
    }
    this.render();
  }

  _updatesList() {
    return Object.values(this._states)
      .filter((s) => s.entity_id?.startsWith?.("update.") && s.state === "on")
      .sort((a, b) =>
        (a.attributes.friendly_name || a.entity_id).localeCompare(
          b.attributes.friendly_name || b.entity_id
        )
      );
  }

  _togglePick(e) {
    const ent = e.currentTarget.dataset.ent;
    if (e.currentTarget.checked) this._selected.add(ent);
    else this._selected.delete(ent);
    this.render();
  }
  _selectAll() { this._selected = new Set(this._updatesList().map((s) => s.entity_id)); this.render(); }
  _selectNone() { this._selected.clear(); this.render(); }

  async _run() {
    if (this._selected.size === 0) { alert("Select at least one update."); return; }
    if (this._client.mode === "ws") {
      await this._client.conn.sendMessagePromise({
        type: "call_service",
        domain: "ha_batch_updates",
        service: "run",
        service_data: {
          entities: Array.from(this._selected),
          reboot_host: this._reboot,
          backup: this._backup,
        },
      });
    } else {
      await this._client.callService("ha_batch_updates", "run", {
        entities: Array.from(this._selected),
        reboot_host: this._reboot,
        backup: this._backup,
      });
    }
    this._toast("Batch started. Logs will appear below.");
    setTimeout(async () => {
      if (this._client.mode === "ws") await this._loadLogWS();
      else await this._loadOnceREST();
      this.render();
    }, 2000);
  }

  _row(s) {
    const id = s.entity_id;
    const name = s.attributes.friendly_name || id;
    const verTo = s.attributes.latest_version || "";
    const verFrom = s.attributes.installed_version || "";
    const inprog = s.attributes.in_progress === true;
    return `
      <li class="row">
        <label class="left">
          <input type="checkbox" data-ent="${id}" ${this._selected.has(id) ? "checked" : ""} ${inprog ? "disabled" : ""}>
          <span class="name">${name}</span>
          <span class="eid">(${id})</span>
        </label>
        <span class="ver">${verFrom ? `${verFrom} ` : ""}${verTo ? `&rarr; ${verTo}` : ""}</span>
      </li>
    `;
  }

  _logRow(e) {
    const ts = e.ts || "";
    const name = e.friendly_name || e.entity_id || e.type;
    const result = e.result || e.type;
    const reason = e.reason || e.action || "";
    let badge = "neutral";
    if (result === "success") badge = "ok";
    else if (String(result).startsWith("failed")) badge = "err";
    else if (result === "started") badge = "warn";
    return `
      <tr>
        <td class="ts">${ts}</td>
        <td class="name">${name}</td>
        <td class="res"><span class="badge ${badge}">${result}</span></td>
        <td class="reason">${reason}</td>
      </tr>
    `;
  }

  _toast(msg) {
    const sb = this.shadowRoot.querySelector("mwc-snackbar");
    if (sb) { sb.labelText = msg; sb.open(); }
  }

  render() {
    const list = this._updatesList();
    const html = `
      <ha-card header="Batch Updates">
        <div class="content">
          <div class="actions">
            <mwc-button id="all" dense>Select all</mwc-button>
            <mwc-button id="none" dense>Clear</mwc-button>
            <span class="spacer"></span>
            <label class="opt">
              <input id="backup" type="checkbox" ${this._backup ? "checked" : ""}>
              Back up before each update
            </label>
            <label class="opt">
              <input id="reboot" type="checkbox" ${this._reboot ? "checked" : ""}>
              Reboot host at end
            </label>
            <mwc-button id="run" raised>Update now</mwc-button>
          </div>

          ${list.length === 0
            ? `<p>No updates available 🎉</p>`
            : `<ul>${list.map((s) => this._row(s)).join("")}</ul>`}
        </div>

        <div class="log">
          <div class="logbar">
            <h3>Update log (latest)</h3>
            <span class="spacer"></span>
            <mwc-button id="refreshLog" dense>Refresh</mwc-button>
            <mwc-button id="clearLog" dense>Clear log</mwc-button>
          </div>
          <table>
            <thead><tr><th>Time (UTC)</th><th>Item</th><th>Result</th><th>Reason / Action</th></tr></thead>
            <tbody>${this._log.slice().reverse().map((e) => this._logRow(e)).join("")}</tbody>
          </table>
        </div>

        <mwc-snackbar></mwc-snackbar>
      </ha-card>

      <style>
        ha-card{max-width:980px;margin:24px auto;display:block}
        .content{padding:16px}
        .actions{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
        .opt{display:flex;align-items:center;gap:6px}
        .spacer{flex:1}
        ul{list-style:none;margin:0;padding:0}
        .row{display:flex;align-items:center;justify-content:space-between;
             border-bottom:1px solid var(--divider-color);padding:10px 0}
        .left{display:flex;align-items:center;gap:10px}
        .name{font-weight:600}
        .eid{opacity:.6;font-size:.9em}
        .ver{opacity:.8}
        .log{padding:0 16px 16px}
        .logbar{display:flex;align-items:center;margin:8px 0}
        table{width:100%;border-collapse:collapse}
        th,td{padding:8px;border-bottom:1px solid var(--divider-color);text-align:left}
        .badge{padding:2px 8px;border-radius:12px;font-size:.85em}
        .badge.ok{background:var(--success-color, #0f9d58);color:white}
        .badge.err{background:var(--error-color, #d93025);color:white}
        .badge.warn{background:#e6a700;color:black}
        .badge.neutral{background:#999;color:white}
        .ts{white-space:nowrap}
      </style>
    `;
    this.shadowRoot.innerHTML = html;

    const root = this.shadowRoot;
    root.querySelectorAll('input[type="checkbox"][data-ent]').forEach((cb) => {
      cb.addEventListener("change", (e) => this._togglePick(e));
    });
    root.getElementById("all").onclick = () => this._selectAll();
    root.getElementById("none").onclick = () => this._selectNone();
    root.getElementById("run").onclick = () => this._run();
    root.getElementById("reboot").onchange = (e) => { this._reboot = e.target.checked; };
    root.getElementById("backup").onchange = (e) => { this._backup = e.target.checked; };
    const refresh = root.getElementById("refreshLog");
    const clear = root.getElementById("clearLog");
    if (refresh) refresh.onclick = async () => {
      if (this._client.mode === "ws") { await this._loadLogWS(); }
      else { await this._loadOnceREST(); }
      this.render();
    };
    if (clear) clear.onclick = async () => { if (confirm("Clear log?")) { await this._clearLog(); } };
  }
}

customElements.define("batch-updates-panel", BatchUpdatesPanel);

// For iframe (no HA loader), just mount on DOM ready
if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(() => document.body.appendChild(document.createElement("batch-updates-panel")), 0);
} else {
  document.addEventListener("DOMContentLoaded", () =>
    document.body.appendChild(document.createElement("batch-updates-panel"))
  );
}

console.info("%c[Batch Updates] panel script initialized", "color:#0b74de;font-weight:bold");
