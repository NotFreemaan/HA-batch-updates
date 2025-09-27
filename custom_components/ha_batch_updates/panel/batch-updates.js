// Batch Updates panel – iframe-aware, WS/REST client
// - Buttons are native <button>
// - Hides entity_id next to names
// - Shows a status bar while batch is running and disables controls

console.info("%c[Batch Updates] panel script loaded", "color:#0b74de;font-weight:bold");

/* ---------------- Helpers: get a HA connection or a thin client ---------------- */
async function getHAClient(timeoutMs = 15000) {
  const start = Date.now();

  async function tryGetConn(host) {
    try {
      if (!host) return null;
      if (host.hassConnection && typeof host.hassConnection.then === "function") {
        const { conn } = await host.hassConnection;
        if (conn) return { mode: "ws", conn, hass: host.hass || null };
      }
      const hass = host.hass || host.__hass;
      const conn = hass?.connection || hass?.conn;
      if (conn) return { mode: "ws", conn, hass: hass || null };
    } catch (_) {}
    return null;
  }

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
      return { entries: [] }; // no REST endpoint for our custom log
    },
    async clearLog() { return { ok: true }; },
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
    this._backup = true;
    this._log = [];
    this._unsub = null;
    this._client = null;
    this._running = false;
    this._runWatchTimer = null;
  }

  connectedCallback() { this.render(); this._init(); }
  disconnectedCallback() {
    if (this._unsub) this._unsub();
    if (this._runWatchTimer) clearInterval(this._runWatchTimer);
  }

  async _init() {
    try {
      this._client = await getHAClient(20000);
      if (this._client.mode === "ws") {
        const conn = this._client.conn;
        const resp = await conn.sendMessagePromise({ type: "get_states" });
        this._states = Object.fromEntries(resp.map((s) => [s.entity_id, s]));
        await this._loadLogWS();
        this.render();
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
      } else {
        await this._loadOnceREST();
      }
    } catch (e) {
      console.error("[Batch Updates] initialization error:", e);
      this.shadowRoot.innerHTML = `
        <div style="padding:16px">
          <h3>Home Assistant connection not ready</h3>
          <p>This panel is loaded in an iframe and couldn't access HA's connection.</p>
          <details><summary>Error</summary><pre style="white-space:pre-wrap">${String(e)}</pre></details>
        </div>`;
    }
  }

  async _loadLogWS(limit = 100) {
    try {
      const res = await this._client.conn.sendMessagePromise({ type: "ha_batch_updates/get_log", limit });
      this._log = res.entries || [];
    } catch (e) {
      console.warn("[Batch Updates] WS log fetch failed:", e);
      this._log = [];
    }
  }

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
        (a.attributes.friendly_name || a.entity_id)
          .localeCompare(b.attributes.friendly_name || b.entity_id)
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

  _anySelectedInProgress() {
    const ids = Array.from(this._selected);
    for (const id of ids) {
      const st = this._states[id];
      if (!st) continue;
      if (st.attributes?.in_progress === true) return true;
    }
    return false;
  }

  _allSelectedFinishedOrIdle() {
    // Finished when none of the selected are 'on' with in_progress true
    const ids = Array.from(this._selected);
    for (const id of ids) {
      const st = this._states[id];
      if (!st) continue;
      if (st.attributes?.in_progress === true) return false;
    }
    return true;
  }

  _startRunWatcher() {
    if (this._runWatchTimer) clearInterval(this._runWatchTimer);
    // Every 2s, if in WS mode, refresh states; in REST, refetch states
    this._runWatchTimer = setInterval(async () => {
      try {
        if (this._client.mode === "ws") {
          const all = await this._client.conn.sendMessagePromise({ type: "get_states" });
          this._states = Object.fromEntries(all.map((s) => [s.entity_id, s]));
        } else {
          const all = await this._client.getStates();
          this._states = Object.fromEntries(all.map((s) => [s.entity_id, s]));
        }
        this.render();
        if (this._allSelectedFinishedOrIdle()) {
          this._running = false;
          clearInterval(this._runWatchTimer);
          this._runWatchTimer = null;
          this._toast("Batch finished. Check the log for details.");
          this.render();
        }
      } catch (e) {
        console.warn("[Batch Updates] run watcher error:", e);
      }
    }, 2000);
  }

  async _run() {
    if (this._selected.size === 0) { alert("Select at least one update."); return; }
    this._running = true;
    this.render();

    try {
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
      this._toast("Batch started…");
      this._startRunWatcher();
    } catch (e) {
      this._running = false;
      this._toast(`Error starting batch: ${String(e)}`);
      console.error(e);
      this.render();
    }
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
          <input type="checkbox" data-ent="${id}" ${this._selected.has(id) ? "checked" : ""} ${inprog || this._running ? "disabled" : ""}>
          <span class="name">${name}</span>
        </label>
        <span class="ver">${verFrom ? `${verFrom} ` : ""}${verTo ? `&rarr; ${verTo}` : ""}${inprog ? ' <span class="spinner" aria-label="In progress"></span>' : ''}</span>
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
    const sb = this.shadowRoot.querySelector(".toast");
    if (!sb) return;
    sb.textContent = msg;
    sb.classList.add("show");
    setTimeout(() => sb.classList.remove("show"), 2500);
  }

  render() {
    const list = this._updatesList();
    const count = list.length;
    const disabled = this._running;
    const html = `
      <ha-card header="Batch Updates">
        ${this._running ? `
          <div class="statusbar" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <strong>Updating…</strong>
            <span class="muted">Batch is running; controls are disabled.</span>
            <button class="btn btn-ghost close-status" aria-label="Hide status">×</button>
          </div>
        ` : ""}

        <div class="content ${disabled ? 'is-disabled' : ''}">
          <div class="actions" role="toolbar" aria-label="Batch update controls">
            <button id="all" class="btn btn-outlined" ${disabled ? "disabled" : ""} aria-label="Select all pending updates">Select all</button>
            <button id="none" class="btn btn-outlined" ${disabled ? "disabled" : ""} aria-label="Clear selection">Clear</button>
            <span class="count-pill" title="Pending updates">${count} pending</span>
            <span class="spacer"></span>
            <label class="opt">
              <input id="backup" type="checkbox" ${this._backup ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="Back up before each update">
              Back up before each update
            </label>
            <label class="opt">
              <input id="reboot" type="checkbox" ${this._reboot ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="Reboot host at end">
              Reboot host at end
            </label>
            <button id="run" class="btn btn-raised" ${disabled ? "disabled" : ""} aria-label="Run updates now">Update now</button>
          </div>

          ${count === 0
            ? `<p>No updates available 🎉</p>`
            : `<ul>${list.map((s) => this._row(s)).join("")}</ul>`}
        </div>

        <div class="log">
          <div class="logbar">
            <h3>Update log (latest)</h3>
            <span class="spacer"></span>
            <button id="refreshLog" class="btn btn-ghost" aria-label="Refresh log">Refresh</button>
            <button id="clearLog" class="btn btn-ghost" aria-label="Clear log">Clear log</button>
          </div>
          <table>
            <thead><tr><th>Time (UTC)</th><th>Item</th><th>Result</th><th>Reason / Action</th></tr></thead>
            <tbody>${this._log.slice().reverse().map((e) => this._logRow(e)).join("")}</tbody>
          </table>
        </div>

        <div class="toast" role="status" aria-live="polite"></div>
      </ha-card>

      <style>
        ha-card{max-width:980px;margin:24px auto;display:block}
        .content{padding:16px}
        .actions{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
        .opt{display:flex;align-items:center;gap:6px}
        .spacer{flex:1}

        /* Disabled mode */
        .is-disabled{opacity:.7}
        .is-disabled .btn{pointer-events:none}
        .is-disabled input[type="checkbox"]{pointer-events:none}

        /* Status bar */
        .statusbar{
          display:flex;align-items:center;gap:10px;padding:10px 14px;
          background:var(--info-color, #0b74de);color:#fff;border-top-left-radius:12px;border-top-right-radius:12px
        }
        .statusbar .muted{opacity:.9}
        .close-status{
          margin-left:auto
        }

        /* Spinner */
        .spinner{
          display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.6);
          border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px
        }
        @keyframes spin{to{transform:rotate(360deg)}}

        /* Buttons */
        .btn{
          appearance:none;border:0;cursor:pointer;padding:8px 12px;
          border-radius:12px;font-weight:600;transition:box-shadow .15s, filter .15s;
          background:var(--card-background-color,#fff);color:var(--primary-text-color,#111);
          box-shadow:inset 0 0 0 2px var(--divider-color,#ccc);
        }
        .btn[disabled]{opacity:.6;cursor:not-allowed}
        .btn:hover{filter:brightness(0.98)}
        .btn:focus{outline:2px solid var(--primary-color);outline-offset:2px}
        .btn-raised{
          background:var(--primary-color);color:#fff;box-shadow:none;
        }
        .btn-raised:hover{filter:brightness(1.02)}
        .btn-outlined{
          background:transparent;color:var(--primary-text-color,#111);
        }
        .btn-ghost{
          background:transparent;color:var(--primary-text-color,#111);
          box-shadow:none;opacity:.9
        }

        .count-pill{
          display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;
          font-weight:700;font-size:.9em;background: var(--primary-color);color: white;line-height:1.8;
        }

        ul{list-style:none;margin:0;padding:0}
        .row{display:flex;align-items:center;justify-content:space-between;
             border-bottom:1px solid var(--divider-color);padding:10px 0}
        .left{display:flex;align-items:center;gap:10px}
        .name{font-weight:600}
        .ver{opacity:.9}
        /* Removed .eid display */

        .log{padding:0 16px 16px}
        .logbar{display:flex;align-items:center;margin:8px 0}
        table{width:100%;border-collapse:collapse}
        th,td{padding:8px;border-bottom:1px solid var(--divider-color);text-align:left}
        .badge{padding:2px 8px;border-radius:12px;font-size:.85em}
        .badge.ok{background:var(--success-color,#0f9d58);color:white}
        .badge.err{background:var(--error-color,#d93025);color:white}
        .badge.warn{background:#e6a700;color:black}
        .badge.neutral{background:#999;color:white}
        .ts{white-space:nowrap}

        /* Toast */
        .toast{
          position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
          background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:10px;
          opacity:0;pointer-events:none;transition:opacity .2s;
        }
        .toast.show{opacity:1}
      </style>
    `;
    this.shadowRoot.innerHTML = html;

    const root = this.shadowRoot;
    const cs = (id) => root.getElementById(id);

    const closeBtn = root.querySelector(".close-status");
    if (closeBtn) closeBtn.onclick = () => {
      this._running = false;
      if (this._runWatchTimer) { clearInterval(this._runWatchTimer); this._runWatchTimer = null; }
      this.render();
    };

    if (cs("all")) cs("all").onclick = () => this._selectAll();
    if (cs("none")) cs("none").onclick = () => this._selectNone();
    if (cs("run")) cs("run").onclick = () => this._run();

    root.querySelectorAll('input[type="checkbox"][data-ent]').forEach((cb) => {
      cb.addEventListener("change", (e) => this._togglePick(e));
    });
    const rb = cs("reboot"); if (rb) rb.onchange = (e) => { this._reboot = e.target.checked; };
    const bk = cs("backup"); if (bk) bk.onchange = (e) => { this._backup = e.target.checked; };

    const refresh = cs("refreshLog");
    const clear = cs("clearLog");
    if (refresh) refresh.onclick = async () => {
      if (this._client.mode === "ws") { await this._loadLogWS(); }
      else { await this._loadOnceREST(); }
      this.render();
    };
    if (clear) clear.onclick = async () => { if (confirm("Clear log?")) { await this._clearLog(); } };
  }
}

customElements.define("batch-updates-panel", BatchUpdatesPanel);

// For iframe, mount on DOM ready
if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(() => document.body.appendChild(document.createElement("batch-updates-panel")), 0);
} else {
  document.addEventListener("DOMContentLoaded", () =>
    document.body.appendChild(document.createElement("batch-updates-panel"))
  );
}

console.info("%c[Batch Updates] panel script initialized", "color:#0b74de;font-weight:bold");
