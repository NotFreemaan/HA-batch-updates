// Batch Updates panel – iframe-aware, WS/REST client
// - Native <button> controls
// - Status bar during run
// - Log shows LOCAL time (UTC in tooltip)
// - Hides entity_id next to names
// - Icons for items (fallback to update.svg)
// - NEW: Per-item "i" button opens a modal with changelog + version (tries release_summary/release_notes, or GitHub API via release_url)

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

// Use entity picture if available, otherwise packaged update.svg
function addonIcon(stateObj) {
  const pic = safeEntityPicture(stateObj?.attributes?.entity_picture);
  if (pic) return pic;
  return "./update.svg";
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

    const avatar = addonIcon(s);

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
            <div class="modal-body"></div>
            <div class="modal-footer">
              <button class="btn btn-raised" id="modal-close-1">Close</button>
            </div>
          </div>
        </div>
      </ha-card>

      <style>
        /* CSS omitted for brevity but keep your baseline here */
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

    root.querySelectorAll('button[data-info]').forEach(btn => {
      btn.onclick = () => this._showInfo(btn.dataset.info);
    });
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
