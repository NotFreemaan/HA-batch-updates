// Batch Updates panel – full version with log width fix and no TZ in time

console.info("%c[Batch Updates] panel script loaded", "color:#0b74de;font-weight:bold");

/* ---------------- HA client ---------------- */
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
    const client =
      (await tryGetConn(window)) ||
      (await tryGetConn(window.parent)) ||
      (await tryGetConn(window.top));
    if (client) return client;
    await new Promise((r) => setTimeout(r, 200));
  }
  const token = window?.parent?.hass?.auth?.data?.access_token ||
                window?.top?.hass?.auth?.data?.access_token || null;
  if (!token) throw new Error("No hassConnection and no token");
  return {
    mode:"rest", token,
    async getStates() {
      const res=await fetch("/api/states",{headers:{Authorization:`Bearer ${token}`}});
      return await res.json();
    },
    async callService(domain,service,data) {
      await fetch(`/api/services/${domain}/${service}`,{
        method:"POST",
        headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
        body:JSON.stringify(data||{})
      });
    },
    async getLog(){ return {entries:[]}; }
  };
}

/* ---------------- Helpers ---------------- */
function safeEntityPicture(url) {
  if (!url) return null;
  if (url.startsWith("http") || url.startsWith("/")) return url;
  return `/${url.replace(/^\/+/, "")}`;
}
function addonIcon(stateObj) {
  const pic = safeEntityPicture(stateObj?.attributes?.entity_picture);
  return pic || "./update.svg";
}
function getTZ() {
  return window?.parent?.hass?.config?.time_zone ||
         window?.top?.hass?.config?.time_zone ||
         Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function fmtLocal(tsIso) {
  // Show only local date + time, no timezone name
  if (!tsIso) return "";
  try {
    const tz = getTZ();
    return new Intl.DateTimeFormat(undefined,{
      timeZone:tz,
      year:"numeric", month:"short", day:"2-digit",
      hour:"numeric", minute:"2-digit", second:"2-digit",
      hour12:true
    }).format(new Date(tsIso));
  } catch { return tsIso; }
}
function escapeHTML(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

/* ---------------- Changelog ---------------- */
async function buildChangelogHTML(stateObj) {
  const attr = stateObj?.attributes || {};
  const title = attr.title || attr.friendly_name || stateObj?.entity_id || "Item";
  const from = attr.installed_version || "";
  const to = attr.latest_version || "";

  const note = attr.release_summary || attr.release_notes || attr.release_note ||
               attr.changelog || attr.release_description || "";
  const releaseUrl = attr.release_url || attr.release_url_template || "";

  if (note) {
    return `
      <h2>${title}</h2>
      <p class="vers">${from ? `${from} → ` : ""}${to || ""}</p>
      <div class="md">${escapeHTML(note)}</div>
      ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank" rel="noreferrer">Open release page</a></p>` : ""}
    `;
  }
  return `
    <h2>${title}</h2>
    <p class="vers">${from ? `${from} → ` : ""}${to || ""}</p>
    <p>No changelog text available.</p>
    ${releaseUrl ? `<p><a href="${releaseUrl}" target="_blank" rel="noreferrer">Open release page</a></p>` : ""}
  `;
}

/* ---------------- Panel ---------------- */
class BatchUpdatesPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({mode:"open"});
    this._states={}; this._selected=new Set();
    this._backup=true; this._log=[]; this._client=null;
    this._running=false; this._justFinished=false; this._watcher=null;
    this._showAllLogs=false;
  }
  connectedCallback(){ this.render(); this._init(); }
  disconnectedCallback(){ if(this._watcher) clearInterval(this._watcher); }

  async _init(){
    this._client=await getHAClient();
    if(this._client.mode==="ws"){
      const states=await this._client.conn.sendMessagePromise({type:"get_states"});
      this._states=Object.fromEntries(states.map(s=>[s.entity_id,s]));
      await this._loadLogWS();
      await this._client.conn.subscribeMessage(
        (evt)=>{
          const ent=evt?.event?.data?.entity_id;
          if(ent && ent.startsWith("update.")){
            this._client.conn.sendMessagePromise({type:"get_states"}).then(all=>{
              this._states=Object.fromEntries(all.map(s=>[s.entity_id,s]));
              this.render();
            });
          }
        },
        {type:"subscribe_events",event_type:"state_changed"}
      );
    } else {
      const resp=await this._client.getStates();
      this._states=Object.fromEntries(resp.map(s=>[s.entity_id,s]));
    }
    this.render();
  }

  async _loadLogWS(limit=100){
    try{
      const res=await this._client.conn.sendMessagePromise({type:"ha_batch_updates/get_log",limit});
      this._log=res.entries||[];
    }catch{this._log=[];}
  }

  _updatesList(){
    return Object.values(this._states)
      .filter(s=>s.entity_id?.startsWith("update.") && s.state==="on")
      .sort((a,b)=>(a.attributes.friendly_name||a.entity_id).localeCompare(b.attributes.friendly_name||b.entity_id));
  }

  async _run(){
    if(this._selected.size===0){alert("Select at least one update.");return;}
    this._running=true; this._justFinished=false; this.render();
    if(this._client.mode==="ws"){
      await this._client.conn.sendMessagePromise({
        type:"call_service",domain:"ha_batch_updates",service:"run",
        service_data:{entities:Array.from(this._selected),backup:this._backup}
      });
      await this._loadLogWS();
    } else {
      await this._client.callService("ha_batch_updates","run",{entities:Array.from(this._selected),backup:this._backup});
    }
    this._startWatcher();
  }

  _startWatcher(){
    if(this._watcher) clearInterval(this._watcher);
    this._watcher=setInterval(async()=>{
      const all=(this._client.mode==="ws")
        ? await this._client.conn.sendMessagePromise({type:"get_states"})
        : await this._client.getStates();
      this._states=Object.fromEntries(all.map(s=>[s.entity_id,s]));
      this.render();
      if(this._allDone()){
        clearInterval(this._watcher); this._watcher=null;
        this._running=false; this._justFinished=true;
        if(this._client.mode==="ws") await this._loadLogWS();
        this.render();
      }
    },2000);
  }

  _allDone(){
    for(const id of this._selected){
      const st=this._states[id]; if(!st) continue;
      if(st.state==="on"||st.attributes.in_progress===true) return false;
    }
    return true;
  }

  async _rebootNow(){
    if(this._client.mode==="ws"){
      await this._client.conn.sendMessagePromise({type:"call_service",domain:"ha_batch_updates",service:"reboot_now",service_data:{}});
    } else {
      await this._client.callService("ha_batch_updates","reboot_now",{});
    }
    this._toast("Reboot triggered.");
  }

  _logRow(e){
    if(!["started","success"].includes(e.result) && !String(e.result).startsWith("failed")) return "";
    const utc=e.ts||"", local=utc?fmtLocal(utc):"", name=e.friendly_name||e.entity_id||e.type;
    let badge="";
    if(e.result==="success") badge=`<span class="badge ok">✔ success</span>`;
    else if(String(e.result).startsWith("failed")) badge=`<span class="badge err">✖ ${e.result}</span>`;
    else if(e.result==="started") badge=`<span class="badge warn">⟳ started</span>`;
    return `<tr>
      <td class="ts">${local}</td>
      <td class="name">${name}</td>
      <td class="res">${badge}</td>
      <td class="reason">${e.reason||""}</td>
    </tr>`;
  }

  _toast(msg){
    const sb=this.shadowRoot.querySelector(".toast"); if(!sb) return;
    sb.textContent=msg; sb.classList.add("show");
    setTimeout(()=>sb.classList.remove("show"),2500);
  }

  render(){
    const list=this._updatesList();
    const logs=this._showAllLogs?this._log.slice().reverse():this._log.slice().reverse().slice(0,20);
    const html=`
      <ha-card header="Batch Updates">
        ${this._running?`<div class="statusbar"><span class="spinner"></span> Updating…</div>`:""}
        ${this._justFinished?`<div class="statusbar done"><strong>Batch complete.</strong><button id="rebootNow">Reboot now</button></div>`:""}
        <div class="content ${this._running?'is-disabled':''}">
          <div class="actions">
            <button id="all" class="btn" ${this._running?"disabled":""}>Select all</button>
            <button id="none" class="btn" ${this._running?"disabled":""}>Clear</button>
            <span class="count-pill">${list.length} pending</span>
            <span class="spacer"></span>
            <label><input id="backup" type="checkbox" ${this._backup?"checked":""} ${this._running?"disabled":""}> Back up before update</label>
            <button id="run" class="btn" ${this._running?"disabled":""}>Update now</button>
          </div>
          ${list.length===0?`<p>No updates 🎉</p>`:`<ul>${list.map(s=>this._row(s)).join("")}</ul>`}
        </div>

        <div class="log">
          <h3>Update log</h3>
          <table class="full">
            <thead>
              <tr><th>Time</th><th>Item</th><th>Result</th><th>Reason</th></tr>
            </thead>
            <tbody>${logs.map(e=>this._logRow(e)).join("")}</tbody>
          </table>
          ${this._log.length>20?`<button id="toggleLogs" class="btn small">${this._showAllLogs?"Show less":"Show more"}</button>`:""}
        </div>

        <div class="toast"></div>

        <div id="modal" class="modal">
          <div class="modal-card">
            <div class="modal-head"><strong>Changelog</strong><button class="btn btn-ghost" id="modal-close">×</button></div>
            <div class="modal-body"></div>
            <div class="modal-footer"><button class="btn btn-raised" id="modal-close-1">Close</button></div>
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

        .spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.6);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}

        ul{list-style:none;margin:0;padding:0}
        .row{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd;padding:10px 0}
        .left{display:flex;align-items:center;gap:10px;min-width:0}
        .avatar{width:28px;height:28px;border-radius:6px;flex:0 0 28px;object-fit:cover;background:#eee;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
        .avatar[src$=".svg"],.avatar[src^="data:image/svg"]{object-fit:contain;padding:2px;background:#0b74de}

        /* --- Log table full-width --- */
        .log{margin-top:8px}
        .log h3{margin:8px 0}
        table.full{width:100%;border-collapse:collapse;font-size:.95em;table-layout:fixed}
        table.full thead th{font-weight:700}
        table.full th, table.full td{padding:8px 10px;border-bottom:1px solid #ccc;text-align:left;vertical-align:top}
        table.full th:nth-child(1), table.full td:nth-child(1){width:24%;}
        table.full th:nth-child(2), table.full td:nth-child(2){width:36%;}
        table.full th:nth-child(3), table.full td:nth-child(3){width:15%;}
        table.full th:nth-child(4), table.full td:nth-child(4){width:25%;}
        table.full td.reason{white-space:normal;word-wrap:break-word}

        .badge{padding:2px 8px;border-radius:12px;font-size:.85em;font-weight:600;display:inline-block}
        .badge.ok{background:#0f9d58;color:white}
        .badge.err{background:#d93025;color:white}
        .badge.warn{background:#e6a700;color:black}

        .btn.small{margin-top:8px;font-size:.85em;padding:4px 10px}

        .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:10px;opacity:0;transition:.2s}
        .toast.show{opacity:1}

        .modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9999}
        .modal.open{display:flex}
        .modal-card{width:min(820px,96vw);max-height:85vh;overflow:auto;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25)}
        .modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #ddd}
        .modal-body{padding:16px}
        .modal-footer{padding:14px 16px;border-top:1px solid #ddd;display:flex;justify-content:flex-end}
      </style>`;
    this.shadowRoot.innerHTML=html;

    // Buttons
    const root=this.shadowRoot;
    const byId=id=>root.getElementById(id);
    if(byId("all")) byId("all").onclick=()=>{this._selected=new Set(this._updatesList().map(s=>s.entity_id));this.render();};
    if(byId("none")) byId("none").onclick=()=>{this._selected.clear();this.render();};
    if(byId("run")) byId("run").onclick=()=>this._run();
    if(byId("rebootNow")) byId("rebootNow").onclick=()=>this._rebootNow();
    if(byId("backup")) byId("backup").onchange=(e)=>{this._backup=e.target.checked;};
    if(byId("toggleLogs")) byId("toggleLogs").onclick=()=>{this._showAllLogs=!this._showAllLogs;this.render();};

    root.querySelectorAll('input[type="checkbox"][data-ent]').forEach(cb=>{
      cb.addEventListener("change",(e)=>{
        const ent=e.currentTarget.dataset.ent;
        if(e.currentTarget.checked) this._selected.add(ent);
        else this._selected.delete(ent);
        this.render();
      });
    });

    // Modal changelog
    root.querySelectorAll('button[data-info]').forEach(btn=>{
      btn.onclick=async()=>{
        const modal=byId("modal"), body=this.shadowRoot.querySelector(".modal-body");
        body.innerHTML=`<div class="loading"><span class="spinner dark"></span> Loading…</div>`;
        modal.classList.add("open");
        const s=this._states[btn.dataset.info];
        const html=await buildChangelogHTML(s);
        body.innerHTML=html;
      };
    });
    if(byId("modal-close")) byId("modal-close").onclick = () => byId("modal").classList.remove("open");
    if(byId("modal-close-1")) byId("modal-close-1").onclick = () => byId("modal").classList.remove("open");

    // Auto-scroll to the newest row
    const tbody = this.shadowRoot.querySelector(".log table tbody");
    if (tbody) tbody.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  _row(s){
    const id = s.entity_id, name = s.attributes.friendly_name || id;
    const from = s.attributes.installed_version || "", to = s.attributes.latest_version || "";
    const inprog = s.attributes.in_progress === true;
    const avatar = addonIcon(s);
    return `<li class="row">
      <div class="left">
        <img class="avatar" src="${avatar}" alt=""/>
        <input type="checkbox" data-ent="${id}" ${this._selected.has(id) ? "checked" : ""} ${inprog || this._running ? "disabled" : ""}/>
        <span>${name}</span>
      </div>
      <div class="ver">${from ? `${from} → ` : ""}${to}${inprog ? '<span class="spinner"></span>' : ""}
        <button class="btn btn-chip info" data-info="${id}">i</button>
      </div>
    </li>`;
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
