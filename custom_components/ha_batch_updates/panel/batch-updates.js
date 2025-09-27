// Batch Updates panel – iframe-aware, WS/REST client
// - Native <button> controls
// - Status bar during run
// - Log shows LOCAL time (UTC in tooltip)
// - Hides entity_id next to names
// - Icons for items
// - Per-item "i" button modal with changelog
// - NEW: Fallback icon file (/ha-batch-updates-static/panel/update.svg) when no entity_picture

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

/* ---------------- Time formatting (LOCAL) ---------------- */
function getTZ() {
  const tz =
    window?.parent?.hass?.config?.time_zone ||
    window?.top?.hass?.config?.time_zone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz;
}
function fmtLocal(tsIso) {
  if (!tsIso) return "";
  try {
    const tz = getTZ();
    const d = new Date(tsIso);
    const fmt = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    return fmt.format(d);
  } catch { return tsIso; }
}

/* ---------------- Small helpers for icons ---------------- */
function safeEntityPicture(url) {
  if (!url) return null;
  try {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) return url;
    return `/${url.replace(/^\/+/, "")}`;
  } catch { return null; }
}
// Use our bundled fallback icon (served by the integration's static path)
function fallbackUpdateIcon() {
  // This path is registered by the integration to serve files under /ha-batch-updates-static/
  return "/ha-batch-updates-static/panel/update.svg";
}

/* ---------------- Changelog resolver ---------------- */
async function fetchGitHubReleaseBody(releaseUrl) {
  try {
    const u = new URL(releaseUrl, location.origin);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const owner = parts[0], repo = parts[1];
    if (parts[2] !== "releases") return null;

    let apiUrl;
    if (parts[3] === "tag" && parts[4]) {
      apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(parts[4])}`;
    } else if (parts[3] === "latest") {
      apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    } else {
      return null;
    }

    const res = await fetch(apiUrl, { headers: { "Accept": "application/vnd.github+json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.body || "";
    const tag = data.tag_name || "";
    const name = data.name || "";
    return { body, tag, name };
  } catch {
    return null;
  }
}

async function buildChangelogHTML(stateObj) {
  const attr = stateObj?.attributes || {};
  const title = attr.title || attr.friendly_name || stateObj?.entity_id || "Item";
  const from = attr.installed_version || "";
  const to = attr.latest_version || "";
  const releaseSummary = attr.release_summary || attr.release_notes || "";
  const releaseUrl = attr.release_url || attr.release_url_template || "";

  if (releaseSummary) {
    return `
      <h2>${title}</h2>
      <p class="vers">${from ? `${from} &rarr; ` : ""}${to || ""}</p>
      <div class="md">${escapeHTML(releaseSummary)}</div>
      ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank" rel="noreferrer">Open release page</a></p>` : ""}
    `;
  }

  if (releaseUrl && /github\.com\/.+\/releases\//i.test(releaseUrl)) {
    const gh = await fetchGitHubReleaseBody(releaseUrl);
    if (gh && (gh.body || gh.name || gh.tag)) {
      return `
        <h2>${title}</h2>
        <p class="vers">${from ? `${from} &rarr; ` : ""}${to || ""}</p>
        ${gh.name || gh.tag ? `<p class="subtitle">${escapeHTML(gh.name || gh.tag)}</p>` : ""}
        <pre class="prewrap">${escapeHTML(gh.body || "No release notes provided.")}</pre>
        <p><a href="${releaseUrl}" target="_blank" rel="noreferrer">Open on GitHub</a></p>
      `;
    }
  }

  return `
    <h2>${title}</h2>
    <p class="vers">${from ? `${from} &rarr; ` : ""}${to || ""}</p>
    <p>No changelog text available.</p>
    ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank" rel="noreferrer">Open release page</a></p>` : ""}
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

  async _showInfo(entityId) {
    const s = this._states[entityId];
    if (!s) return;
    const modal = this.shadowRoot.getElementById("modal");
    const body = this.shadowRoot.querySelector(".modal-body");
    const footer = this.shadowRoot.querySelector(".modal-footer");
    body.innerHTML = `<div class="loading"><span class="spinner dark"></span> Loading changelog…</div>`;
    modal.classList.add("open");

    try {
      const html = await buildChangelogHTML(s);
      body.innerHTML = html;
      footer.innerHTML = `
        ${s.attributes?.release_url ? `<a class="btn btn-ghost" href="${s.attributes.release_url}" target="_blank" rel="noreferrer">Open release</a>` : ""}
        <button class="btn btn-raised" id="modal-close-2">Close</button>
      `;
      const c2 = this.shadowRoot.getElementById("modal-close-2");
      if (c2) c2.onclick = () => modal.classList.remove("open");
    } catch (e) {
      body.innerHTML = `<p>Could not load changelog.</p><pre class="prewrap">${escapeHTML(String(e))}</pre>`;
    }
  }

  _row(s) {
    const id = s.entity_id;
    const name = s.attributes.friendly_name || id;
    const verTo = s.attributes.latest_version || "";
    const verFrom = s.attributes.installed_version || "";
    const inprog = s.attributes.in_progress === true;

    const picAttr = safeEntityPicture(s.attributes?.entity_picture);
    const avatar = picAttr || fallbackUpdateIcon();

    return `
      <li class="row">
        <label class="left">
          <img class="avatar" src="${avatar}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <input type="checkbox" data-ent="${id}" ${this._selected.has(id) ? "checked" : ""} ${inprog || this._running ? "disabled" : ""}>
          <span class="name" title="${name}">${name}</span>
        </label>
        <span class="ver">
          ${verFrom ? `${verFrom} ` : ""}${verTo ? `&rarr; ${verTo}` : ""}
          ${inprog ? ' <span class="spinner" aria-label="In progress"></span>' : ''}
          <button class="btn btn-chip info" data-info="${id}" title="Show changelog">i</button>
        </span>
      </li>
    `;
  }

  _logRow(e) {
    const utc = e.ts || "";
    const local = utc ? fmtLocal(utc) : "";
    const name = e.friendly_name || e.entity_id || e.type;
    const result = e.result || e.type;
    const reason = e.reason || e.action || "";
    let badge = "neutral";
    if (result === "success") badge = "ok";
    else if (String(result).startsWith("failed")) badge = "err";
    else if (result === "started") badge = "warn";
    return `
      <tr title="UTC: ${utc}">
        <td class="ts">${local}</td>
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
            <thead><tr><th>Time (local)</th><th>Item</th><th>Result</th><th>Reason / Action</th></tr></thead>
            <tbody>${this._log.slice().reverse().map((e) => this._logRow(e)).join("")}</tbody>
          </table>
        </div>

        <div class="toast" role="status" aria-live="polite"></div>

        <!-- Modal -->
        <div id="modal" class="modal" aria-hidden="true">
          <div class="modal-card" role="dialog" aria-modal="true" aria-label="Changelog">
            <div class="modal-head">
              <strong>Changelog</strong>
              <button class="btn btn-ghost" id="modal-close" aria-label="Close">×</button>
            </div>
            <div class="modal-body">
              <!-- dynamic -->
            </div>
            <div class="modal-footer">
              <button class="btn btn-raised" id="modal-close-1">Close</button>
            </div>
          </div>
        </div>
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
        .close-status{margin-left:auto}

        /* Spinner */
        .spinner{
          display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.6);
          border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px
        }
        .spinner.dark{
          border-color: rgba(0,0,0,.25);
          border-top-color: rgba(0,0,0,.65);
        }
        @keyframes spin{to{transform:rotate(360deg)}}

        /* Buttons */
        .btn{
          appearance:none;border:0;cursor:pointer;padding:8px 12px;
          border-radius:12px;font-weight:600;transition:box-shadow .15s, filter .15s;
          background:var(--card-background-color, #ffffff);color:var(--primary-text-color, #111111);
          box-shadow:inset 0 0 0 2px var(--divider-color, #c7c7c7);
        }
        .btn[disabled]{opacity:.6;cursor:not-allowed}
        .btn:hover{filter:brightness(0.98)}
        .btn:focus{outline:2px solid var(--primary-color, #0b74de);outline-offset:2px}
        .btn-raised{
          background:var(--primary-color, #0b74de);
          color:var(--text-on-primary, #ffffff);
          box-shadow:inset 0 0 0 2px rgba(0,0,0,.08);
          border:1px solid rgba(0,0,0,.08);
        }
        .btn-raised:hover{filter:brightness(1.02)}
        .btn-outlined{
          background:transparent;color:var(--primary-text-color, #111111);
        }
        .btn-ghost{
          background:transparent;color:var(--primary-text-color, #111111);
          box-shadow:none;opacity:.9
        }
        .btn-chip{
          padding:4px 8px;border-radius:999px;font-size:.82em;line-height:1.2;margin-left:8px
        }

        .count-pill{
          display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;
          font-weight:700;font-size:.9em;background: var(--primary-color, #0b74de);color: white;line-height:1.8;
        }

        ul{list-style:none;margin:0;padding:0}
        .row{display:flex;align-items:center;justify-content:space-between;
             border-bottom:1px solid var(--divider-color, #e0e0e0);padding:10px 0}
        .left{display:flex;align-items:center;gap:10px;min-width:0}
        .avatar{
          width:28px;height:28px;border-radius:6px;flex:0 0 28px;object-fit:cover;
          box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)
        }
        .name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .ver{opacity:.9;white-space:nowrap}

        .log{padding:0 16px 16px}
        .logbar{display:flex;align-items:center;margin:8px 0}
        table{width:100%;border-collapse:collapse}
        th,td{padding:8px;border-bottom:1px solid var(--divider-color, #e0e0e0);text-align:left}
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

        /* Modal */
        .modal{
          position:fixed;inset:0;display:none;align-items:center;justify-content:center;
          background:rgba(0,0,0,.4);z-index:9999;padding:20px
        }
        .modal.open{display:flex}
        .modal-card{
          width:min(820px, 96vw);max-height:85vh;overflow:auto;border-radius:16px;
          background:var(--card-background-color, #fff);color:var(--primary-text-color, #111);
          box-shadow:0 10px 30px rgba(0,0,0,.25)
        }
        .modal-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--divider-color,#e0e0e0)}
        .modal-body{padding:16px}
        .modal-footer{padding:14px 16px;border-top:1px solid var(--divider-color,#e0e0e0);display:flex;gap:10px;justify-content:flex-end}
        .prewrap{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
        .vers{opacity:.8;margin:.2rem 0 .6rem}
        .subtitle{opacity:.85;margin:.2rem 0 1rem}
        .loading{display:flex;align-items:center;gap:8px}
      </style>
    `;
    this.shadowRoot.innerHTML = html;

    const root = this.shadowRoot;
    const cs = (id) => root.getElementById(id);

    const closeBtn = root.getElementById("modal-close");
    const closeBtn1 = root.getElementById("modal-close-1");
    const modal = root.getElementById("modal");
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove("open");
    if (closeBtn1) closeBtn1.onclick = () => modal.classList.remove("open");

    const statusClose = root.querySelector(".close-status");
    if (statusClose) statusClose.onclick = () => {
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

    // Wire "i" info buttons
    root.querySelectorAll('button[data-info]').forEach(btn => {
      btn.onclick = () => this._showInfo(btn.dataset.info);
    });
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
