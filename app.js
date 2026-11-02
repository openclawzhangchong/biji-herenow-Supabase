/* ================================================================
   biji · 端到端加密静态笔记本 v2
   存储：Supabase Postgres（经 here.now 服务端代理，密钥不出后端）
   特性：Markdown / 任务清单 / 回收站 / 统计热力图 / 每日回顾 / PWA
   ================================================================ */
'use strict';

/* ---------- 小工具 ---------- */
const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc = new TextEncoder();
const byteLen = s => enc.encode(s).length;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.getRandomValues(new Uint8Array(16)).join(''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TAG_RE = /#([\w\u4e00-\u9fff][\w\u4e00-\u9fff-]*)/g;
const MAX_BYTES = 11000;          // 单条内容字节上限（密文后需 < 16KB 记录上限）
const TRASH_DAYS = 30;            // 回收站保留天数
const DAY = 86400000;
const LS = { session:'biji.session.v1', cache:'biji.cache.v1', hint:'biji.hint.v1', theme:'biji.theme.v1' };
const PBKDF2_ITERS = 310000;
const APP_SALT = enc.encode('biji.here.now.app-salt.v1');

/* ---------- 状态 ---------- */
const state = {
  key: null,            // CryptoKey
  notes: new Map(),     // id -> {id, iv, ct, payload:{c,p,ts,d?}, created(ms), updated(ms), fail?}
  filterTag: null,
  query: '',
  view: 'main',         // 'main' | 'trash'
  pollTimer: null,
  editingId: null,
};

/* ---------- Toast / 横幅 ---------- */
function toast(msg, opts={}) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<svg class="icon sm"><use href="#${opts.icon || 'i-check'}"/></svg><span>${esc(msg)}</span>`;
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action;
    b.onclick = () => { clearTimeout(timer); t.remove(); opts.onAction(); };
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  const timer = setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, opts.ms ?? 2600);
}
function banner(msg, sticky=false) {
  const b = $('#banner');
  b.innerHTML = `<svg class="icon sm"><use href="#i-alert"/></svg><span>${esc(msg)}</span>`;
  b.hidden = false;
  if (!sticky) setTimeout(() => b.hidden = true, 5000);
}
const hideBanner = () => $('#banner').hidden = true;
function setDot(s) { $('#sync-dot').className = 'sync-dot ' + s; }

/* ================= 加密 ================= */
async function deriveKey(pass) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:APP_SALT, iterations:PBKDF2_ITERS, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']);
}
async function encryptPayload(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptRecord(key, ivB64, ctB64) {
  const b2n = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:b2n(ivB64) }, key, b2n(ctB64));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}
async function importKey(b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt','decrypt']);
}

/* ================= API（here.now 代理 → Supabase PostgREST，同源相对路径） =================
   密钥由 here.now 服务端注入（.herenow/proxy.json + 账户变量），前端不接触密钥明文 */
function fieldsOf(r) {
  const f = (r && typeof r === 'object' && r.data && typeof r.data === 'object' && ('iv' in r.data || 'ct' in r.data)) ? r.data : (r || {});
  return { iv: f.iv, ct: f.ct };
}
const API_BASE = '/api/db/notes';
async function api(path, opts = {}) {
  setDot('busy');
  try {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const e = new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
      e.code = body && body.code;
      e.retryAfter = body && body.retry_after;
      throw e;
    }
    setDot('ok');
    return body;
  } catch (e) {
    if (e.code !== 'rate_limit_exceeded') setDot('err');
    throw e;
  }
}
const apiList = async () => {
  const rows = await api('?select=*&order=created_at.desc&limit=2000');
  return { records: Array.isArray(rows) ? rows : [], nextCursor: null };
};
const apiCreate = async (iv, ct) => {
  const rows = await api('', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ iv, ct }) });
  return { record: Array.isArray(rows) ? rows[0] : rows };
};
const apiPatch = async (id, fields) => {
  const rows = await api(`?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(fields) });
  return { record: Array.isArray(rows) ? rows[0] : rows };
};
const apiDelete = id => api(`?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ================= 本地缓存（密文，断网可用） ================= */
function saveCache() {
  try {
    const arr = [...state.notes.values()].map(n => ({ id:n.id, iv:n.iv, ct:n.ct, created:n.created, updated:n.updated }));
    localStorage.setItem(LS.cache, JSON.stringify(arr));
  } catch {}
}
async function loadCache() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS.cache) || '[]');
    for (const r of arr) if (!state.notes.has(r.id)) await ingest(r);
  } catch {}
}

/* ================= 数据摄取与同步 ================= */
async function ingest(r, decrypt=true) {
  const { iv, ct } = fieldsOf(r);
  if (!iv || !ct) return false;
  const exist = state.notes.get(r.id);
  const srvCreated = Date.parse(r.createdAt ?? r.created_at ?? '');
  const srvUpdated = Date.parse(r.updatedAt ?? r.updated_at ?? '');
  if (exist && srvUpdated && exist.updated >= srvUpdated) return false;   // 服务器没有更新的版本
  const created = srvCreated || (exist ? exist.created : Date.now());
  const updated = srvUpdated || srvCreated || created;
  const entry = { id:r.id, iv, ct, created, updated, payload: exist && !exist.fail ? exist.payload : null, fail: false };
  if (decrypt && state.key) {
    try {
      const p = await decryptRecord(state.key, iv, ct);
      if (typeof p.c === 'string') entry.payload = { c:p.c, p:!!p.p, ts:p.ts || created, d:p.d || undefined };
    } catch { entry.fail = true; entry.payload = null; }
  }
  state.notes.set(r.id, entry);
  return true;
}
async function pullAll({ silent=true } = {}) {
  if (!silent) setDot('busy');
  let cursor = null, pages = 0, changed = false;
  const serverIds = new Set();
  const fetched = [];
  try {
    do {
      const { records = [], nextCursor } = await apiList(cursor);
      for (const r of records) {
        if (r.status && r.status !== 'active') continue;
        serverIds.add(r.id);
        fetched.push(r);
        changed = (await ingest(r)) || changed;
      }
      cursor = nextCursor || null;
    } while (cursor && ++pages < 25);
    // 修剪：他端已物理删除的记录从本地移除（仅在完整拉取成功后）
    if (!cursor) {
      for (const id of [...state.notes.keys()]) {
        if (!serverIds.has(id)) { state.notes.delete(id); changed = true; }
      }
    }
    // 临时记录对账：服务器上出现相同 iv+ct 指纹则丢弃临时项；90 秒未确认视为失败
    for (const [id, n] of [...state.notes.entries()]) {
      if (!id.startsWith('tmp_')) continue;
      if (fetched.some(r => { const f = fieldsOf(r); return f.iv === n.iv && f.ct === n.ct; })) {
        state.notes.delete(id); changed = true;
      } else if (Date.now() - n.created > 90000) {
        state.notes.delete(id); changed = true;
        toast('一条笔记未能同步到服务器', { icon:'i-alert' });
      }
    }
    // 回收站过期清理（>30 天物理删除）
    const cutoff = Date.now() - TRASH_DAYS * DAY;
    for (const [id, n] of [...state.notes.entries()]) {
      if (n.payload && n.payload.d && n.payload.d < cutoff && !id.startsWith('tmp_')) {
        apiDelete(id).catch(() => {});
        state.notes.delete(id); changed = true;
      }
    }
    if (changed) { render(); saveCache(); }
    setDot('ok'); hideBanner();
  } catch (e) {
    setDot('err');
    if (state.notes.size === 0) banner('同步失败：' + (e.message || '网络异常') + '，稍后自动重试');
  }
}
function startPoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pullAll(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullAll(); });
}

/* ================= Markdown 渲染（先转义，防 XSS） ================= */
function inlineMd(text) {
  let h = esc(text);
  h = h.replace(/`([^`\n]+)`/g, (m, c) => `<code>${c}</code>`);
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  h = h.replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  h = h.replace(TAG_RE, (m, tag) => `<span class="htag" data-tag="${esc(tag.toLowerCase())}">${esc('#' + tag)}</span>`);
  return h;
}
function renderContent(text, noteId) {
  const fences = [];
  let src = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    fences.push(`<pre class="md-pre"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });
  const lines = src.split('\n').map((line, i) => {
    // 任务清单
    let m = line.match(/^(\s*)(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/);
    if (m) {
      const done = m[2].toLowerCase() === 'x';
      return `<div class="md-task" data-line="${i}" data-check="${done ? 1 : 0}">`
        + `<span class="md-box" data-line="${i}" role="checkbox" aria-checked="${done}">${done ? '<svg class="icon sm"><use href="#i-check"/></svg>' : ''}</span>`
        + `<span class="md-task-text ${done ? 'done' : ''}">${inlineMd(m[3])}</span></div>`;
    }
    // 标题
    m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) return `<div class="md-h md-h${m[1].length}">${inlineMd(m[2])}</div>`;
    // 引用
    m = line.match(/^>\s?(.*)$/);
    if (m) return `<div class="md-quote">${inlineMd(m[1])}</div>`;
    // 无序列表
    m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) return `<div class="md-li"><span class="md-li-dot">•</span>${inlineMd(m[1])}</div>`;
    if (line.startsWith('\u0000F')) return line;   // 代码块占位
    return inlineMd(line);
  });
  let html = lines.join('\n');
  html = html.replace(/\u0000F(\d+)\u0000/g, (m, i) => fences[+i]);
  return html;
}
function noteBodyHtml(n) {
  if (n.fail || !n.payload) return `<div class="note-body">无法解密这条记录（可能来自其他密码或已损坏）</div>`;
  return `<div class="note-body">${renderContent(n.payload.c, n.id)}</div>`;
}

/* ================= 标签 / 视图 ================= */
function extractTags(text) {
  const out = new Map();
  for (const m of text.matchAll(TAG_RE)) { const k = m[1].toLowerCase(); if (!out.has(k)) out.set(k, m[1]); }
  return out;
}
function relTime(ms) {
  const d = Date.now() - ms, min = 60000, hr = 3600000;
  const p2 = n => String(n).padStart(2, '0');
  if (d < min) return '刚刚';
  if (d < hr) return Math.floor(d / min) + ' 分钟前';
  const dt = new Date(ms), now = new Date();
  const hm = `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  if (dt.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (dt.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
  if (dt.getFullYear() === now.getFullYear()) return `${dt.getMonth()+1}月${dt.getDate()}日 ${hm}`;
  return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;
}
const isDeleted = n => !!(n.payload && n.payload.d);
const activeNotes = () => [...state.notes.values()].filter(n => n.payload && !isDeleted(n));
const trashNotes = () => [...state.notes.values()].filter(n => n.payload && isDeleted(n) && !n.fail);

function visibleNotes() {
  let list = state.view === 'trash' ? trashNotes() : activeNotes();
  if (state.view === 'main') list = list.filter(n => !n.fail);
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter(n => n.payload && (n.payload.c.toLowerCase().includes(q) || [...extractTags(n.payload.c).keys()].some(t => t.includes(q.slice(1)) && q.startsWith('#'))));
  }
  if (state.filterTag) list = list.filter(n => n.payload && extractTags(n.payload.c).has(state.filterTag));
  return list.sort((a, b) => (b.payload?.p - a.payload?.p) || (b.created - a.created));
}
function renderTagbar() {
  const counts = new Map();
  for (const n of activeNotes()) if (n.payload)
    for (const k of extractTags(n.payload.c).keys()) counts.set(k, (counts.get(k) || 0) + 1);
  const trashCount = trashNotes().length;
  const bar = $('#tagbar');
  const mk = (label, key, n, cls='') => `<button class="chip ${key === state.filterTag && state.view === 'main' ? 'active' : ''} ${cls}" data-tag="${esc(key || '')}" data-view="main">${esc(label)}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`;
  let html = '';
  if (state.view === 'main') {
    html += mk('全部', null, activeNotes().length);
    for (const [k, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) html += mk('#' + k, k, c);
  }
  if (trashCount) html += `<button class="chip ${state.view === 'trash' ? 'active' : ''}" data-view="trash">🗑 回收站 <span class="n">${trashCount}</span></button>`;
  bar.innerHTML = html;
  $$('.chip', bar).forEach(ch => ch.onclick = () => {
    if (ch.dataset.view === 'trash') { state.view = 'trash'; state.filterTag = null; }
    else { state.view = 'main'; state.filterTag = ch.dataset.tag || null; }
    render();
  });
  // 标签管理条
  const tm = $('#tag-manage');
  if (state.view === 'main' && state.filterTag) {
    tm.hidden = false;
    $('#tag-manage-name').textContent = '#' + state.filterTag;
  } else tm.hidden = true;
}
function noteCard(n) {
  if (n.fail || !n.payload) {
    return `<div class="card note fail" data-id="${n.id}">
      <div class="note-body">无法解密这条记录（可能来自其他密码或已损坏）</div>
      <div class="note-foot"><span class="note-time">${relTime(n.created)}</span>
        <div class="note-acts"><button class="icon-btn del" data-act="del" title="删除"><svg class="icon sm"><use href="#i-trash"/></svg></button></div>
      </div></div>`;
  }
  const inTrash = state.view === 'trash';
  const tags = [...extractTags(n.payload.c).values()];
  const acts = inTrash
    ? `<button class="icon-btn" data-act="restore" title="恢复"><svg class="icon sm"><use href="#i-restore"/></svg></button>
       <button class="icon-btn del" data-act="purge" title="彻底删除"><svg class="icon sm"><use href="#i-trash"/></svg></button>`
    : `<button class="icon-btn ${n.payload.p ? 'pin-on' : ''}" data-act="pin" title="${n.payload.p ? '取消置顶' : '置顶'}"><svg class="icon sm"><use href="#i-pin"/></svg></button>
       <button class="icon-btn" data-act="edit" title="编辑"><svg class="icon sm"><use href="#i-edit"/></svg></button>
       <button class="icon-btn del" data-act="del" title="删除"><svg class="icon sm"><use href="#i-trash"/></svg></button>`;
  return `<div class="card note ${n.payload.p && !inTrash ? 'pinned' : ''} ${inTrash ? 'trashed' : ''}" data-id="${n.id}">
    ${noteBodyHtml(n)}
    ${tags.length && !inTrash ? `<div class="note-tags">${tags.map(t => `<span class="note-tag" data-tag="${esc(t.toLowerCase())}">#${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="note-foot">
      <span class="note-time">${relTime(n.created)}${inTrash ? ' · 已删除' : ''}</span>
      <div class="note-acts">${acts}</div>
    </div></div>`;
}
function render() {
  if (!state.key) return;
  renderTagbar();
  const feed = $('#feed');
  const list = visibleNotes();
  if (state.view === 'trash' && list.length === 0) {
    feed.innerHTML = `<div class="empty"><svg class="icon logo-icon"><use href="#i-trash"/></svg><p>回收站是空的</p></div>`;
    return;
  }
  if (state.notes.size === 0) {
    feed.innerHTML = `<div class="empty">
      <svg class="icon logo-icon"><use href="#i-logo"/></svg>
      <p>第一条笔记，从上面输入框开始 ✍️</p>
      <p class="empty-sub">支持 Markdown、#标签、任务清单；菜单里有统计与每日回顾</p></div>`;
    return;
  }
  if (list.length === 0) {
    feed.innerHTML = `<div class="empty"><p>没有匹配「${esc(state.query || '#' + state.filterTag)}」的笔记</p></div>`;
    return;
  }
  const groups = [['置顶', []], ['今天', []], ['昨天', []], ['本周', []], ['更早', []]];
  const now = new Date(); const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - DAY, startWeek = startToday - 6 * DAY;
  for (const n of list) {
    if (state.view === 'trash') { groups[4][1].push(n); continue; }
    if (n.payload?.p) groups[0][1].push(n);
    else if (n.created >= startToday) groups[1][1].push(n);
    else if (n.created >= startYesterday) groups[2][1].push(n);
    else if (n.created >= startWeek) groups[3][1].push(n);
    else groups[4][1].push(n);
  }
  let html = '';
  for (const [title, items] of groups) {
    if (!items.length) continue;
    if (state.view === 'trash') html += `<div class="group-title">🗑 回收站 · ${TRASH_DAYS} 天后自动清除</div>`;
    else if (title === '置顶') html += `<div class="group-title">📌 ${title}</div>`;
    else html += `<div class="group-title">${title}</div>`;
    for (const n of items) html += noteCard(n);
  }
  feed.innerHTML = html;
  $$('.note', feed).forEach(card => {
    const id = card.dataset.id;
    $$('.note-acts .icon-btn', card).forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'del') delNote(id);
      else if (act === 'purge') purgeNote(id);
      else if (act === 'restore') restoreNote(id);
      else if (act === 'edit') openEdit(id);
      else if (act === 'pin') togglePin(id);
    });
    $$('.htag, .note-tag', card).forEach(el => el.onclick = () => {
      state.view = 'main'; state.filterTag = el.dataset.tag; state.query = ''; $('#search-input').value = '';
      render();
    });
    // 任务清单勾选
    $$('.md-box', card).forEach(box => box.onclick = () => toggleTask(id, +box.dataset.line));
  });
}
async function toggleTask(id, lineIdx) {
  const n = state.notes.get(id); if (!n?.payload) return;
  const lines = n.payload.c.split('\n');
  const line = lines[lineIdx];
  if (line == null) return;
  lines[lineIdx] = /\[ \]/.test(line) ? line.replace('[ ]', '[x]') : line.replace(/\[[xX]\]/, '[ ]');
  await updateNote(id, lines.join('\n'), n.payload.p);
}

/* ================= 动作 ================= */
// 乐观创建：先本地插入临时项（tmp_ 前缀），pullAll 用 iv+ct 指纹与服务器对账
async function createRaw(iv, ct, payload) {
  const tmp = { id: 'tmp_' + uuid(), iv, ct, created: payload.ts || Date.now(), updated: Date.now(), payload, fail: false };
  state.notes.set(tmp.id, tmp);
  render(); saveCache();
  try {
    await apiCreate(iv, ct);
  } catch (e) {
    state.notes.delete(tmp.id);
    render(); saveCache();
    throw e;
  }
}
async function createNote(text) {
  const payload = { c: text, p: false, ts: Date.now() };
  const { iv, ct } = await encryptPayload(state.key, payload);
  await createRaw(iv, ct, payload);
}
async function pushPayload(id, payload) {
  const n = state.notes.get(id); if (!n) return;
  const { iv, ct } = await encryptPayload(state.key, payload);
  n.payload = payload; n.iv = iv; n.ct = ct; n.updated = Date.now();
  render(); saveCache();
  try {
    const res = await apiPatch(id, { iv, ct });
    if (res && res.record) await ingest(res.record);
    render(); saveCache();
  } catch (e) { toast('同步失败：' + e.message, { icon:'i-alert' }); }
}
async function updateNote(id, text, pinned) {
  const n = state.notes.get(id); if (!n) return;
  await pushPayload(id, { c: text, p: !!pinned, ts: n.payload?.ts || Date.now(), d: n.payload?.d });
}
async function togglePin(id) {
  const n = state.notes.get(id); if (!n?.payload) return;
  await pushPayload(id, { c: n.payload.c, p: !n.payload.p, ts: n.payload.ts, d: n.payload.d });
}
async function delNote(id) {                 // 移入回收站（软删除）
  const n = state.notes.get(id); if (!n?.payload) return;
  const prev = { ...n.payload };
  await pushPayload(id, { ...n.payload, d: Date.now() });
  toast('已移入回收站', { ms: 6000, icon:'i-trash', action:'撤销', onAction: () => pushPayload(id, prev) });
}
async function restoreNote(id) {
  const n = state.notes.get(id); if (!n?.payload) return;
  const { d, ...rest } = n.payload;
  await pushPayload(id, rest);
  toast('已恢复', { icon:'i-restore' });
}
async function purgeNote(id) {               // 彻底删除
  if (!confirm('彻底删除这条笔记？不可恢复。')) return;
  const snap = state.notes.get(id);
  state.notes.delete(id);
  render(); saveCache();
  try { await apiDelete(id); } catch (e) { toast('删除失败：' + e.message, { icon:'i-alert' }); if (snap) { state.notes.set(id, snap); render(); } }
}

/* ---------- 编辑弹窗 ---------- */
function openEdit(id) {
  const n = state.notes.get(id); if (!n?.payload) return;
  state.editingId = id;
  $('#edit-input').value = n.payload.c;
  updateCount($('#edit-count'), n.payload.c);
  $('#modal-edit').hidden = false;
  $('#edit-input').focus();
}
const closeEdit = () => { $('#modal-edit').hidden = true; state.editingId = null; };
$('#edit-close').onclick = $('#edit-cancel').onclick = closeEdit;
$('#edit-save').onclick = async () => {
  const text = $('#edit-input').value.trim();
  if (!text) return toast('内容不能为空', { icon:'i-alert' });
  if (byteLen(text) > MAX_BYTES) return toast('超出单条字数上限', { icon:'i-alert' });
  const id = state.editingId;
  closeEdit();
  const n = state.notes.get(id);
  await updateNote(id, text, n?.payload?.p);
  toast('已保存');
};
$('#edit-input').addEventListener('input', e => updateCount($('#edit-count'), e.target.value));
$('#edit-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#edit-save').click(); });

/* ---------- 输入区 ---------- */
const composerInput = $('#composer-input');
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, window.innerHeight * .4) + 'px'; }
function updateCount(el, text) {
  const b = byteLen(text);
  el.textContent = b ? `${b} / ${MAX_BYTES}` : '';
  el.classList.toggle('over', b > MAX_BYTES);
}
function renderComposerTags() {
  const tags = [...extractTags(composerInput.value).values()];
  $('#composer-tags').innerHTML = tags.map(t => `<span class="note-tag">#${esc(t)}</span>`).join('');
}
composerInput.addEventListener('input', () => { autoGrow(composerInput); updateCount($('#composer-count'), composerInput.value); renderComposerTags(); });
composerInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#btn-save').click(); });
$('#btn-save').onclick = async () => {
  const text = composerInput.value.trim();
  if (!text) return;
  if (byteLen(text) > MAX_BYTES) return toast('太长了：单条上限约 ' + MAX_BYTES + ' 字节（约3600汉字）', { icon:'i-alert' });
  const btn = $('#btn-save'); btn.disabled = true;
  try {
    await createNote(text);
    composerInput.value = ''; autoGrow(composerInput); updateCount($('#composer-count'), ''); renderComposerTags();
  } catch (e) {
    toast(e.code === 'rate_limit_exceeded' ? '操作太快，请稍后再试' : '保存失败：' + e.message, { icon:'i-alert' });
  } finally { btn.disabled = false; }
};

/* ---------- 搜索 ---------- */
$('#btn-search').onclick = () => { const sb = $('#searchbar'); sb.hidden = !sb.hidden; if (!sb.hidden) $('#search-input').focus(); };
$('#btn-search-close').onclick = () => { $('#searchbar').hidden = true; $('#search-input').value = ''; state.query = ''; render(); };
$('#search-input').addEventListener('input', e => { state.query = e.target.value.trim(); render(); });

/* ---------- 菜单 ---------- */
const sheet = $('#menu-sheet');
$('#btn-menu').onclick = () => sheet.hidden = false;
sheet.onclick = e => { if (e.target === sheet) sheet.hidden = true; };
const closeSheet = () => sheet.hidden = true;
$('#menu-theme').onclick = () => { setTheme(htmlIsDark() ? 'light' : 'dark'); closeSheet(); };
$('#menu-lock').onclick = () => { closeSheet(); lockNow(); };
$('#menu-about').onclick = () => { closeSheet(); $('#modal-about').hidden = false; };
$('#about-close').onclick = () => $('#modal-about').hidden = true;
$('#menu-export').onclick = () => { closeSheet(); doExportJson(); };
$('#menu-export-md').onclick = () => { closeSheet(); doExportMd(); };
$('#menu-import').onclick = () => { closeSheet(); $('#import-file').click(); };
$('#menu-changepass').onclick = () => { closeSheet(); doChangePass(); };
$('#menu-stats').onclick = () => { closeSheet(); openStats(); };
$('#menu-review').onclick = () => { closeSheet(); openReview(); };
$('#menu-trash').onclick = () => { closeSheet(); state.view = 'trash'; state.filterTag = null; render(); window.scrollTo({ top: 0 }); };
$('#import-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) doImport(f); e.target.value = ''; });
$('#btn-refresh').onclick = () => pullAll({ silent:false });

/* ---------- 标签管理 ---------- */
$('#btn-tag-rename').onclick = async () => {
  const oldTag = state.filterTag; if (!oldTag) return;
  const newName = prompt(`把 #${oldTag} 重命名为：`, oldTag);
  if (!newName || newName.trim() === oldTag) return;
  const clean = newName.trim().replace(/\s+/g, '-').replace(/^#/, '').toLowerCase();
  if (!clean || !/^[\w\u4e00-\u9fff-]+$/.test(clean)) return toast('标签只能包含中英文、数字、- 和 _', { icon:'i-alert' });
  const re = new RegExp('#' + oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w\\u4e00-\\u9fff-])', 'gi');
  const targets = activeNotes().filter(n => extractTags(n.payload.c).has(oldTag));
  if (!targets.length) return;
  toast(`正在更新 ${targets.length} 条笔记…`, { icon:'i-tag' });
  for (const n of targets) {
    await pushPayload(n.id, { ...n.payload, c: n.payload.c.replace(re, '#' + clean) });
    await sleep(400);
  }
  state.filterTag = clean;
  render();
  toast(`已重命名为 #${clean}`);
};
$('#btn-tag-delete').onclick = async () => {
  const oldTag = state.filterTag; if (!oldTag) return;
  if (!confirm(`从所有笔记中删除标签 #${oldTag}？（笔记内容保留）`)) return;
  const re = new RegExp('\\s?#' + oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w\\u4e00-\\u9fff-])', 'gi');
  const targets = activeNotes().filter(n => extractTags(n.payload.c).has(oldTag));
  if (!targets.length) return;
  toast(`正在更新 ${targets.length} 条笔记…`, { icon:'i-tag' });
  for (const n of targets) {
    await pushPayload(n.id, { ...n.payload, c: n.payload.c.replace(re, '') });
    await sleep(400);
  }
  state.filterTag = null;
  render();
  toast('标签已删除');
};

/* ---------- 主题 ---------- */
const htmlIsDark = () => document.documentElement.classList.contains('dark');
function setTheme(mode) {
  const dark = mode === 'dark' || (!mode && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  $('meta[name=theme-color]').content = dark ? '#141618' : '#f6f5f1';
  $('#menu-theme span').textContent = dark ? '浅色模式' : '深色模式';
  $('#menu-theme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  if (mode) localStorage.setItem(LS.theme, mode);
}
setTheme(localStorage.getItem(LS.theme) || undefined);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => !localStorage.getItem(LS.theme) && setTheme());

/* ---------- 导出 / 导入 ---------- */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click(); URL.revokeObjectURL(a.href);
}
function doExportJson() {
  const notes = [...state.notes.values()].filter(n => n.payload).map(n => ({
    content: n.payload.c, pinned: !!n.payload.p, deleted_at: n.payload.d || null,
    created_at: new Date(n.created).toISOString(), tags: [...extractTags(n.payload.c).values()],
  }));
  download(`biji-backup-${new Date().toISOString().slice(0,10)}.json`,
    JSON.stringify({ app:'biji', version:2, exported:new Date().toISOString(), notes }, null, 2), 'application/json');
  toast(`已导出 ${notes.length} 条`);
}
function doExportMd() {
  const list = activeNotes().sort((a, b) => a.created - b.created);
  if (!list.length) return toast('没有可导出的笔记', { icon:'i-alert' });
  const parts = list.map(n => {
    const tags = [...extractTags(n.payload.c).values()].map(t => '#' + t).join(' ');
    return `---\n\n**${new Date(n.created).toLocaleString('zh-CN')}** ${tags}\n\n${n.payload.c}\n`;
  });
  download(`biji-notes-${new Date().toISOString().slice(0,10)}.md`, `# biji 笔记导出（${new Date().toLocaleDateString('zh-CN')}，共 ${list.length} 条）\n\n` + parts.join('\n'), 'text/markdown');
  toast(`已导出 ${list.length} 条为 Markdown`);
}
async function doImport(file) {
  try {
    const data = JSON.parse(await file.text());
    const notes = (data.notes || data).filter?.(n => typeof n?.content === 'string') || [];
    if (!notes.length) return toast('没有可导入的笔记', { icon:'i-alert' });
    const seen = new Set([...state.notes.values()].filter(n => n.payload).map(n => n.payload.c + '|' + n.payload.ts));
    let added = 0;
    for (const n of notes) {
      const ts = Date.parse(n.created_at || '') || Date.now();
      const key = n.content + '|' + ts;
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = { c: n.content, p: !!n.pinned, ts };
      if (n.deleted_at) payload.d = Date.parse(n.deleted_at) || undefined;
      const { iv, ct } = await encryptPayload(state.key, payload);
      await apiCreate(iv, ct);
      added++; if (added % 8 === 0) await sleep(600);
    }
    await pullAll();
    toast(`导入完成，新增 ${added} 条`);
  } catch (e) { toast('导入失败：' + e.message, { icon:'i-alert' }); }
}

/* ---------- 统计与热力图 ---------- */
function openStats() {
  const list = activeNotes();
  const chars = list.reduce((s, n) => s + n.payload.c.length, 0);
  // 连续天数
  const days = new Set(list.map(n => new Date(n.created).toDateString()));
  let streak = 0;
  const cur = new Date();
  if (!days.has(cur.toDateString())) cur.setDate(cur.getDate() - 1);   // 今天还没写不打断
  while (days.has(cur.toDateString())) { streak++; cur.setDate(cur.getDate() - 1); }
  $('#stat-nums').innerHTML = [
    ['笔记', list.length], ['累计字数', chars >= 10000 ? (chars / 10000).toFixed(1) + ' 万' : chars],
    ['连续记录', streak + ' 天'], ['今日新增', list.filter(n => new Date(n.created).toDateString() === new Date().toDateString()).length],
  ].map(([k, v]) => `<div class="stat-item"><b>${v}</b><span>${k}</span></div>`).join('');
  // 热力图：近 20 周
  const perDay = new Map();
  for (const n of list) {
    const d = new Date(n.created); d.setHours(0, 0, 0, 0);
    perDay.set(d.getTime(), (perDay.get(d.getTime()) || 0) + 1);
  }
  const end = new Date(); end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + (6 - end.getDay()));          // 对齐到周六结尾
  const cells = [];
  for (let i = 139; i >= 0; i--) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const c = perDay.get(d.getTime()) || 0;
    const lvl = c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 6 ? 3 : 4;
    cells.push(`<i class="l${lvl}" title="${d.getMonth()+1}月${d.getDate()}日 · ${c} 条"></i>`);
  }
  $('#heatmap').innerHTML = cells.join('');
  $('#modal-stats').hidden = false;
}
$('#stats-close').onclick = () => $('#modal-stats').hidden = true;

/* ---------- 每日回顾 ---------- */
function openReview() {
  const pool = activeNotes().filter(n => Date.now() - n.created > 7 * DAY);
  if (!pool.length) {
    $('#review-body').innerHTML = `<div class="empty" style="padding:30px 0"><p>还没有超过 7 天的笔记，继续积累吧 ✍️</p></div>`;
    $('#review-meta').textContent = '';
  } else {
    showReviewNote(pool[Math.floor(Math.random() * pool.length)], pool.length);
  }
  $('#modal-review').hidden = false;
}
function showReviewNote(n, poolSize) {
  $('#review-body').innerHTML = noteBodyHtml(n);
  $('#review-meta').textContent = `写于 ${relTime(n.created)} · 库里还有 ${poolSize - 1} 条旧笔记`;
}
$('#review-close').onclick = () => $('#modal-review').hidden = true;
$('#review-another').onclick = () => {
  const pool = activeNotes().filter(n => Date.now() - n.created > 7 * DAY);
  if (pool.length) showReviewNote(pool[Math.floor(Math.random() * pool.length)], pool.length);
};

/* ---------- 修改密码 ---------- */
async function doChangePass() {
  const pass = prompt('输入新密码（至少 6 位）：');
  if (pass === null) return;
  if (pass.length < 6) return toast('密码至少 6 位', { icon:'i-alert' });
  if (!confirm('将重新加密全部 ' + state.notes.size + ' 条笔记并上传，继续？')) return;
  const newKey = await deriveKey(pass);
  const probe = await encryptPayload(newKey, { c:'__probe__', p:false, ts:Date.now() });
  await decryptRecord(newKey, probe.iv, probe.ct);
  const items = [...state.notes.values()];
  let i = 0, failed = 0;
  for (const n of items) {
    i++;
    if (!n.payload) continue;
    try {
      const { iv, ct } = await encryptPayload(newKey, n.payload);
      await apiPatch(n.id, { iv, ct });
      n.iv = iv; n.ct = ct;
    } catch { failed++; }
    if (i % 5 === 0) await sleep(500);
  }
  state.key = newKey;
  localStorage.setItem(LS.session, JSON.stringify({ k: await exportKey(newKey), t: Date.now() }));
  saveCache();
  toast(failed ? `完成，${failed} 条失败（可重试）` : '密码已更新，全部笔记已重新加密', { icon: failed ? 'i-alert' : 'i-check' });
}

/* ---------- 锁定 ---------- */
function lockNow() {
  clearInterval(state.pollTimer);
  state.key = null; state.notes.clear();
  state.filterTag = null; state.query = ''; state.view = 'main';
  $('#search-input').value = '';
  localStorage.removeItem(LS.session);
  showLock('unlock');
}

/* ================= 锁屏流程 ================= */
function showLock(mode) {
  $('#screen-main').hidden = true;
  $('#screen-lock').hidden = false;
  $('#form-setup').hidden = mode !== 'setup';
  $('#form-unlock').hidden = mode !== 'unlock';
  $('#trust-row').hidden = mode !== 'unlock';
  $('#lock-sub').textContent = mode === 'setup' ? '创建你的加密笔记本' : '端到端加密，只有你能读';
  const hint = localStorage.getItem(LS.hint);
  const hl = $('#unlock-hint');
  hl.hidden = !(mode === 'unlock' && hint);
  hl.textContent = hint || '';
  $('#unlock-err').hidden = true;
  $(mode === 'setup' ? '#setup-pass' : '#unlock-pass').focus();
}
async function tryUnlock(pass, { remember=true } = {}) {
  const key = await deriveKey(pass);
  const { records = [] } = await apiList().catch(() => ({ records: [] }));
  const withFields = records.map(r => ({ r, f: fieldsOf(r) })).filter(x => x.f.iv && x.f.ct);
  let ok = false;
  for (const { f } of withFields.slice(0, 5)) {
    try { await decryptRecord(key, f.iv, f.ct); ok = true; break; } catch {}
  }
  if (!ok && withFields.length > 0) {
    $('#unlock-err').hidden = false;
    $('.lock-card').classList.add('lock-shake');
    setTimeout(() => $('.lock-card').classList.remove('lock-shake'), 450);
    return false;
  }
  state.key = key;
  const k = await exportKey(key);
  if (remember) localStorage.setItem(LS.session, JSON.stringify({ k, t: Date.now() }));
  else sessionStorage.setItem(LS.session, JSON.stringify({ k, t: Date.now() }));
  await enterMain();
  return true;
}
$('#form-setup').addEventListener('submit', async e => {
  e.preventDefault();
  const p1 = $('#setup-pass').value, p2 = $('#setup-pass2').value;
  if (p1.length < 6) return toast('密码至少 6 位', { icon:'i-alert' });
  if (p1 !== p2) return toast('两次输入不一致', { icon:'i-alert' });
  localStorage.setItem(LS.hint, $('#setup-hint').value.trim());
  state.key = await deriveKey(p1);
  localStorage.setItem(LS.session, JSON.stringify({ k: await exportKey(state.key), t: Date.now() }));
  await enterMain();
  toast('笔记本已创建，本机已记住密码', { icon:'i-lock' });
});
$('#form-unlock').addEventListener('submit', async e => {
  e.preventDefault();
  $('#unlock-err').hidden = true;
  const ok = await tryUnlock($('#unlock-pass').value, { remember: $('#trust-device').checked }).catch(err => {
    toast('连接失败：' + err.message, { icon:'i-alert' }); return false;
  });
  if (ok) $('#unlock-pass').value = '';
});
$('#btn-forgot').onclick = () => {
  if (!confirm('用新密码开始后，旧密码加密的笔记将无法读取（记录仍保留在服务器）。\n确定继续？')) return;
  showLock('setup');
};

/* ================= 进入主界面 ================= */
async function enterMain() {
  $('#screen-lock').hidden = true;
  $('#screen-main').hidden = false;
  render();
  await loadCache(); render();
  await pullAll({ silent:false });
  startPoll();
}

/* ================= 启动 ================= */
(async function boot() {
  const saved = localStorage.getItem(LS.session) || sessionStorage.getItem(LS.session);
  if (saved) {
    try {
      state.key = await importKey(JSON.parse(saved).k);
      await enterMain();
      return;
    } catch {}
  }
  let mode = 'unlock';
  try {
    const { records = [] } = await apiList();
    mode = records.length ? 'unlock' : 'setup';
  } catch { banner('无法连接服务器，首次使用可点击下方「创建新密码」', true); }
  showLock(mode);
})();

/* 全局快捷键 */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#modal-edit').hidden) closeEdit();
    else if (!$('#modal-stats').hidden) $('#modal-stats').hidden = true;
    else if (!$('#modal-review').hidden) $('#modal-review').hidden = true;
    else if (!$('#modal-about').hidden) $('#modal-about').hidden = true;
    else if (!$('#menu-sheet').hidden) closeSheet();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#btn-search').click(); }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && state.key
      && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '') && $('#modal-edit').hidden) {
    e.preventDefault(); composerInput.focus();
  }
});
$$('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));
