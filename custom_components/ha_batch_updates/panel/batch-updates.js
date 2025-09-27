// Batch Updates panel – robust mount for various HA loader contracts (waits for hassConnection, with logging)

console.info("%c[Batch Updates] panel script loaded", "color:#0b74de;font-weight:bold");

/* ---------------- Helpers: get a HA connection safely ---------------- */
async function getHAConnection(timeoutMs = 15000) {
  // Preferred: window.hassConnection (a Promise from HA)
  const start = Date.now();

  // Poll for either window.hassConnection or <home-assistant>.hass.connection
  while (Date.now() - start < timeoutMs) {
    try {
      if (window.hassConnection && typeof window.hassConnection.then === "function") {
        const { conn } = await window.hassConnection;
        if (conn) return conn;
      }
    } catch (_) {}

    try {
      const haEl = document.querySelector("home-assistant");
      const conn = haEl?.hass?.connection || haEl?.hass?.conn || haEl?.__hass?.connection;
      if (conn) return conn;
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("hassConnection not available after timeout");
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
    this._conn = null;
  }

  connectedCallback() {
    console.info("[Batch Updates] connectedCallback");
    this.render(); // initial shell
    this._init();  // async init
  }
  disconnectedCallback() { if (this._unsub) this._unsub(); }

  async _init() {
    try {
      this._conn = await getHAConnection(20000);
      console.info("[Batch Updates] hassConnection ready");
      await this._subscribe();
    } catch (e) {
      console.error("[Batch Updates] could not obtain hassConnection:", e);
      this.shadowRoot.innerHTML = `
        <div style="padding:16px">
          <h3>Home Assistant connection not ready</h3>
          <p>Try reloading this page, or restarting Home Assistant's frontend.</p>
          <details><summary>Error</summary><pre style="white-space:pre-wrap">${String(e)}</pre></details>
        </div>`;
    }
  }

  async _subscribe() {
    const conn = this._conn;
    // Load initial states
    const resp = await conn.sendMessagePromise({ type: "get_states" });
    this._states = Object.fromEntries(resp.map((s) => [s.entity_id, s]));
    await this._loadLog();
    this.render();

    // Subscribe to live updates
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

  async _loadLog(limit = 100) {
    const res = await this._conn.sendMessagePromise({ type: "ha_batch_updates/get_log", limit });
    this._log = res.entries || [];
  }
  async _clearLog() {
    await this._conn.sendMessagePromise({ type: "ha_batch_updates/clear_log" });
    await this._loadLog();
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
    await this._conn.sendMessagePromise({
      type: "call_service",
      domain: "ha_batch_updates",
      service: "run",
      service_data: {
        entities: Array.from(this._selected),
        reboot_host: this._reboot,
        backup: this._backup,
      },
    });
    this._toast("Batch started. Logs will appear below.");
    setTimeout(async () => { await this._loadLog(); this.render(); }, 2000);
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
    if (refresh) refresh.onclick = async () => { await this._loadLog(); this.render(); };
    if (clear) clear.onclick = async () => { if (confirm("Clear log?")) { await this._clearLog(); } };
  }
}

customElements.define("batch-updates-panel", BatchUpdatesPanel);

/* ---------- Robust mount for multiple HA panel loader contracts ---------- */
function mountInto(el) {
  console.info("[Batch Updates] mountInto", el);
  if (!el) el = document.body; // fallback
  if (!el.querySelector("batch-updates-panel")) {
    el.appendChild(document.createElement("batch-updates-panel"));
  }
}

// Newer contract: window.customPanel = { default: { embed(el) {…} } }
if (typeof window.customPanel === "object" && window.customPanel?.default?.embed) {
  const old = window.customPanel.default.embed;
  window.customPanel.default.embed = (el) => { try { old?.(el); } catch (e) {} mountInto(el); };
} else if (typeof window.customPanel === "function") {
  // Older contract: function(el)
  const oldFn = window.customPanel;
  window.customPanel = (el) => { try { oldFn?.(el); } catch (e) {} mountInto(el); };
} else {
  // If neither is present yet, define a handler HA can call
  window.customPanel = (el) => mountInto(el);
}

// Also try mounting once DOM is ready (helps in some builds)
if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(() => mountInto(document.getElementById("view") || document.body), 0);
} else {
  document.addEventListener("DOMContentLoaded", () => mountInto(document.getElementById("view") || document.body));
}

console.info("%c[Batch Updates] panel script initialized", "color:#0b74de;font-weight:bold");
