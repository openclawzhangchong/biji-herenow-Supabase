// here.now 发布脚本（Node 版，无 jq 依赖）
// 用法: node publish.js <site-dir> [--slug <slug>] [--overwrite] [--ttl <seconds>]
// 凭据来源(先到先得): --api-key / $HERENOW_API_KEY / ~/.herenow/credentials
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'https://here.now';
const args = process.argv.slice(2);
const dir = path.resolve(args[0]);
let slug = null, overwrite = false, apiKey = null, ttl;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--slug') slug = args[++i];
  else if (args[i] === '--overwrite') overwrite = true;
  else if (args[i] === '--ttl') ttl = +args[++i];
  else if (args[i] === '--api-key') apiKey = args[++i];
}
if (!apiKey) apiKey = process.env.HERENOW_API_KEY || null;
if (!apiKey) {
  try { apiKey = fs.readFileSync(path.join(os.homedir(), '.herenow', 'credentials'), 'utf8').trim() || null; } catch {}
}

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8', '.md':'text/markdown; charset=utf-8', '.wasm':'application/wasm', '.woff2':'font/woff2', '.xml':'application/xml', '.pdf':'application/pdf' };

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      const buf = fs.readFileSync(full);
      out.push({ rel, buf });
    }
  }
  return out;
}

async function main() {
  const files = walk(dir);
  if (!files.some(f => f.rel === 'index.html')) {
    console.error('publish_result.error=missing index.html at site root');
    process.exit(2);
  }
  const body = {
    files: files.map(f => ({ path: f.rel, size: f.buf.length, contentType: MIME[path.extname(f.rel).toLowerCase()] || 'application/octet-stream' })),
  };
  if (ttl) body.ttlSeconds = ttl;

  const headers = { 'content-type': 'application/json', 'X-HereNow-Client': 'zcode/publish-js' };
  if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;

  // 状态文件：放在发布目录之外，避免随站点发布
  const statePath = path.resolve(__dirname, '.herenow-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}

  const createRes = await fetch(slug ? `${API}/api/v1/publish/${slug}` : `${API}/api/v1/publish`, {
    method: slug ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    console.error('publish_result.error=create_failed ' + createRes.status + ' ' + JSON.stringify(created).slice(0, 500));
    process.exit(1);
  }

  // 匿名站点更新：需要 claimToken
  let claimToken = created.claimToken;
  if (!apiKey && slug && !claimToken && state.publishes?.[slug]?.claimToken) {
    claimToken = state.publishes[slug].claimToken;
  }

  let uploadRes = created.upload;
  if (slug && !uploadRes) {
    // PUT 创建后未直接返回 upload（少见）→ 理论上不会走到
    console.error('publish_result.error=no_upload_targets');
    process.exit(1);
  }

  for (const t of (uploadRes?.uploads || [])) {
    const f = files.find(x => x.rel === t.path);
    if (!f) { console.error('publish_result.error=missing_file_for_upload ' + t.path); process.exit(1); }
    const h = { ...(t.headers || {}) };
    const put = await fetch(t.url, { method: t.method || 'PUT', headers: h, body: f.buf });
    if (!put.ok) {
      console.error('publish_result.error=upload_failed ' + t.path + ' ' + put.status);
      process.exit(1);
    }
  }

  // finalize
  const finBody = { versionId: uploadRes.versionId };
  const finHeaders = { 'content-type': 'application/json', 'X-HereNow-Client': 'zcode/publish-js' };
  if (apiKey) finHeaders['authorization'] = 'Bearer ' + apiKey;
  if (!apiKey && claimToken) finHeaders['x-herenow-claim'] = claimToken;
  if (!apiKey && claimToken) finBody.claimToken = claimToken;
  const finRes = await fetch(uploadRes.finalizeUrl, { method: 'POST', headers: finHeaders, body: JSON.stringify(finBody) });
  const fin = await finRes.json().catch(() => ({}));
  if (!finRes.ok) {
    console.error('publish_result.error=finalize_failed ' + finRes.status + ' ' + JSON.stringify(fin).slice(0, 500));
    process.exit(1);
  }

  const outSlug = created.slug || slug;
  // 记录状态
  state.publishes = state.publishes || {};
  state.publishes[outSlug] = {
    siteUrl: fin.siteUrl || created.siteUrl || `https://${outSlug}.here.now/`,
    versionId: uploadRes.versionId,
    ...(claimToken ? { claimToken } : {}),
    ...(created.claimUrl ? { claimUrl: created.claimUrl } : {}),
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
    authenticated: !!apiKey,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

  console.log('publish_result.slug=' + outSlug);
  console.log('publish_result.auth_mode=' + (apiKey ? 'authenticated' : 'anonymous'));
  if (created.anonymous) console.log('publish_result.warning=anonymous site expires in 24 hours');
  if (created.claimUrl) console.log('publish_result.claim_url=' + created.claimUrl);
  if (fin.primaryUrl) console.log('publish_result.primary_url=' + fin.primaryUrl);
  console.log('publish_result.site_url=' + (fin.siteUrl || created.siteUrl));
  console.log('publish_result.version_id=' + uploadRes.versionId);
}

main().catch(e => { console.error('publish_result.error=' + (e.cause?.message || e.message)); process.exit(1); });
