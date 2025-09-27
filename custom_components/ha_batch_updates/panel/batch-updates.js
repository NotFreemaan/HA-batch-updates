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

  // … keep all your other methods (_init, _loadLogWS, _run, etc) unchanged …

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

  render() {
    // … your big render() from baseline, unchanged …
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
