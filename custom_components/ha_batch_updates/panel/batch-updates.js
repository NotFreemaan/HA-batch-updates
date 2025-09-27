// Batch Updates panel – iframe-aware, WS/REST client
// - Preserves baseline features
// - Adds reboot button after batch (no auto-reboot)
// - Log refreshes immediately on start
// - Log filters only started/success/fail
// - Better changelog handling
// - Add-on icons or fallback update.svg

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
      return { entries: [] };
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

/* ---------------- Time formatting (LOCAL) ---------------- */
function getTZ() {
  return window?.parent?.hass?.config?.time_zone ||
         window?.top?.hass?.config?.time_zone ||
         Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function fmtLocal(tsIso) {
  if (!tsIso) return "";
  try {
    const tz = getTZ();
    const d = new Date(tsIso);
    const fmt = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, year: "numeric", month: "short", day: "2-digit",
      hour: "numeric", minute: "2-digit", second: "2-digit",
      hour12: true, timeZoneName: "short",
    });
    return fmt.format(d);
  } catch { return tsIso; }
}

/* ---------------- Icons ---------------- */
function safeEntityPicture(url) {
  if (!url) return null;
  try {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) return url;
    return `/${url.replace(/^\/+/, "")}`;
  } catch { return null; }
}
function addonIcon(stateObj) {
  const pic = safeEntityPicture(stateObj?.attributes?.entity_picture);
  return pic || "./update.svg";
}

/* ---------------- Changelog resolver ---------------- */
async function buildChangelogHTML(stateObj) {
  const attr = stateObj?.attributes || {};
  const title = attr.title || attr.friendly_name || stateObj?.entity_id || "Item";
  const from = attr.installed_version || "";
  const to = attr.latest_version || "";

  const note = attr.release_summary || attr.release_notes || attr.release_note || attr.changelog || "";
  const releaseUrl = attr.release_url || attr.release_url_template || "";

  if (note) {
    return `
      <h2>${title}</h2>
      <p class="vers">${from ? `${from} → ` : ""}${to || ""}</p>
      <div class="md">${escapeHTML(note)}</div>
      ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank">Open release page</a></p>` : ""}
    `;
  }
  return `
    <h2>${title}</h2>
    <p class="vers">${from ? `${from} → ` : ""}${to || ""}</p>
    <p>No changelog text available.</p>
    ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank">Open release page</a></p>` : ""}
  `;
}
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    this._client = null;
    this._running = false;
    this._justFinished = false;
    this._runWatchTimer = null;
  }

  connectedCallback() { this.render(); this._init(); }
  disconnectedCallback() { if (this._runWatchTimer) clearInterval(this._runWatchTimer); }

  async _init() {
    try {
      this._client = await getHAClient(20000);
      if (this._client.mode === "ws") {
        const conn = this._client.conn;
        const resp = await conn.sendMessagePromise({ type: "get_states" });
        this._states = Object.fromEntries(resp.map((s) => [s.entity_id, s]));
        await this._loadLogWS();
        this.render();
        await conn.subscribeMessage(
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
    }
  }

  async _loadLogWS(limit = 100) {
    try {
      const res = await this._client.conn.sendMessagePromise({ type: "ha_batch_updates/get_log", limit });
      this._log = res.entries || [];
    } catch (e) { this._log = []; }
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

  async _run() {
    if (this._selected.size === 0) { alert("Select at least one update."); return; }
    this._running = true; this._justFinished = false; this.render();

    try {
      if (this._client.mode === "ws") {
        await this._client.conn.sendMessagePromise({
          type: "call_service",
          domain: "ha_batch_updates",
          service: "run",
          service_data: {
            entities: Array.from(this._selected),
            reboot_host: false,
            backup: this._backup,
          },
        });
        await this._loadLogWS(); // immediate refresh so "started" shows
      } else {
        await this._client.callService("ha_batch_updates", "run", {
          entities: Array.from(this._selected),
          reboot_host: false,
          backup: this._backup,
        });
      }
      this._startRunWatcher();
    } catch (e) {
      this._running = false;
      this._toast(`Error: ${String(e)}`);
      this.render();
    }
  }

  _startRunWatcher() {
    if (this._runWatchTimer) clearInterval(this._runWatchTimer);
    this._runWatchTimer = setInterval(async () => {
      try {
        let all;
        if (this._client.mode === "ws") {
          all = await this._client.conn.sendMessagePromise({ type: "get_states" });
        } else {
          all = await this._client.getStates();
        }
        this._states = Object.fromEntries(all.map((s) => [s.entity_id, s]));
        this.render();
        if (this._allSelectedFinishedOrIdle()) {
          this._running = false;
          this._justFinished = true;
          clearInterval(this._runWatchTimer);
          this._runWatchTimer = null;
          if (this._client.mode === "ws") await this._loadLogWS();
          this.render();
        }
      } catch (_) {}
    }, 2000);
  }

  _allSelectedFinishedOrIdle() {
    for (const id of Array.from(this._selected)) {
      const st = this._states[id];
      if (!st) continue;
      if (st.state === "on" || st.attributes?.in_progress === true) return false;
    }
    return true;
  }

  async _rebootNow() {
    try {
      if (this._client.mode === "ws") {
        await this._client.conn.sendMessagePromise({
          type: "call_service", domain: "ha_batch_updates", service: "reboot_now", service_data: {}
        });
      } else {
        await this._client.callService("ha_batch_updates", "reboot_now", {});
      }
    } catch (e) { this._toast("Reboot failed: " + e); }
  }

  _logRow(e) {
    if (!["started","success"].includes(e.result) && !String(e.result).startsWith("failed")) return "";
    const utc = e.ts || "";
    const local = utc ? fmtLocal(utc) : "";
    const name = e.friendly_name || e.entity_id || e.type;
    return `<tr title="UTC: ${utc}">
        <td>${local}</td>
        <td>${name}</td>
        <td>${e.result}</td>
        <td>${e.reason||""}</td>
      </tr>`;
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
    const html = `
      <ha-card header="Batch Updates">
        ${this._running ? `<div class="statusbar"><span class="spinner"></span> Updating…</div>` : ""}
        ${this._justFinished ? `<div class="statusbar done"><strong>Batch complete.</strong><button id="rebootNow">Reboot now</button></div>` : ""}
        <div class="content ${this._running ? 'is-disabled' : ''}">
          <div class="actions">
            <button id="all" class="btn" ${this._running?"disabled":""}>Select all</button>
            <button id="none" class="btn" ${this._running?"disabled":""}>Clear</button>
            <span class="count-pill">${count} pending</span>
            <span class="spacer"></span>
            <label><input id="backup" type="checkbox" ${this._backup?"checked":""} ${this._running?"disabled":""}> Back up before update</label>
            <button id="run" class="btn" ${this._running?"disabled":""}>Update now</button>
          </div>
          ${count === 0 ? `<p>No updates 🎉</p>` : `<ul>${list.map((s)=>this._row(s)).join("")}</ul>`}
        </div>
        <div class="log">
          <h3>Update log</h3>
          <table><thead><tr><th>Time</th><th>Item</th><th>Result</th><th>Reason</th></tr></thead>
          <tbody>${this._log.slice().reverse().map((e)=>this._logRow(e)).join("")}</tbody></table>
        </div>
        <div class="toast"></div>
        <!-- Modal -->
        <div id="modal" class="modal">
          <div class="modal-card">
            <div class="modal-head">
              <strong>Changelog</strong>
              <button class="btn btn-ghost" id="modal-close">×</button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-footer">
              <button class="btn btn-raised" id="modal-close-1">Close</button>
            </div>
          </div>
        </div>
      </ha-card>
      <style>
        ha-card{max-width:980px;margin:24px auto;display:block}
        .actions{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
        .spacer{flex:1}
        .statusbar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:#0b74de;color:#fff;margin-bottom:10px}
        .statusbar.done{background:#0f9d58}
        .statusbar button{margin-left:auto;padding:4px 10px;border:0;border-radius:8px;cursor:pointer}
        .spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.6);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        ul{list-style:none;margin:0;padding:0}
        .row{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--divider-color,#e0e0e0);padding:10px 0}
        .left{display:flex;align-items:center;gap:10px;min-width:0}
        .avatar{width:28px;height:28px;border-radius:6px;flex:0 0 28px;object-fit:cover;background:#eee;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
        .avatar[src$=".svg"],.avatar[src^="data:image/svg"]{object-fit:contain;padding:2px;background:#0b74de}
        .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:10px;opacity:0;transition:.2s}
        .toast.show{opacity:1}
        .modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9999}
        .modal.open{display:flex}
        .modal-card{width:min(820px,96vw);max-height:85vh;overflow:auto;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25)}
        .modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #ddd}
        .modal-body{padding:16px}
        .modal-footer{padding:14px 16px;border-top:1px solid #ddd;display:flex;justify-content:flex-end}
      </style>
    `;
    this.shadowRoot.innerHTML = html;

    const root = this.shadowRoot;
    const cs = (id) => root.getElementById(id);

    if (cs("all")) cs("all").onclick = () => { this._selected = new Set(this._updatesList().map((s) => s.entity_id)); this.render(); };
    if (cs("none")) cs("none").onclick = () => { this._selected.clear(); this.render(); };
    if (cs("run")) cs("run").onclick = () => this._run();
    if (cs("rebootNow")) cs("rebootNow").onclick = () => this._rebootNow();
    if (cs("backup")) cs("backup").onchange = (e) => { this._backup = e.target.checked; };

    root.querySelectorAll('input[type="checkbox"][data-ent]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const ent = e.currentTarget.dataset.ent;
        if (e.currentTarget.checked) this._selected.add(ent);
        else this._selected.delete(ent);
        this.render();
      });
    });

    // Modal changelog
    root.querySelectorAll('button[data-info]').forEach(btn => {
      btn.onclick = async () => {
        const modal = this.shadowRoot.getElementById("modal");
        const body = this.shadowRoot.querySelector(".modal-body");
        body.innerHTML = `<div class="loading"><span class="spinner dark"></span> Loading…</div>`;
        modal.classList.add("open");
        const s = this._states[btn.dataset.info];
        const html = await buildChangelogHTML(s);
        body.innerHTML = html;
      };
    });
    const closeBtn = cs("modal-close");
    const closeBtn1 = cs("modal-close-1");
    const modal = cs("modal");
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove("open");
    if (closeBtn1) closeBtn1.onclick = () => modal.classList.remove("open");
  }

  _row(s) {
    const id = s.entity_id;
    const name = s.attributes.friendly_name || id;
    const verTo = s.attributes.latest_version || "";
    const verFrom = s.attributes.installed_version || "";
    const inprog = s.attributes.in_progress === true;
    const avatar = addonIcon(s);
    return `
      <li class="row">
        <label class="left">
          <img class="avatar" src="${avatar}" alt="" loading="lazy" />
          <input type="checkbox" data-ent="${id}" ${this._selected.has(id) ? "checked" : ""} ${inprog || this._running ? "disabled" : ""}>
          <span class="name" title="${name}">${name}</span>
        </label>
        <span class="ver">
          ${verFrom ? `${verFrom} → ` : ""}${verTo}
          ${inprog ? ' <span class="spinner" aria-label="In progress"></span>' : ''}
          <button class="btn btn-chip info" data-info="${id}" title="Show changelog">i</button>
        </span>
      </li>
    `;
  }
}

customElements.define("batch-updates-panel", BatchUpdatesPanel);

if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(() => document.body.appendChild(document.createElement("batch-updates-panel")), 0);
} else {
  document.addEventListener("DOMContentLoaded", () =>
    document.body.appendChild(document.createElement("batch-updates-panel"))
  );
}

console.info("%c[Batch Updates] panel script initialized", "color:#0b74de;font-weight:bold");
