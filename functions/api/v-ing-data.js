/**
 * V-ing Site API — data read/write via Cloudflare D1
 * GET  /api/data        — read site data (no password)
 * PUT  /api/data        — write site data (requires X-Password)
 *
 * D1 binding: env.DB (configured in Cloudflare Pages dashboard)
 * Security: No hardcoded password fallback (v4.2 fix)
 */
const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };
}
function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  if (!env.WS_PASSWORD) {
    return false;
  }
  return pwd === env.WS_PASSWORD;
}
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}
async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL,
      last_updated TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`
  ).run();
}
export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  try {
    if (!env.DB) {
      return jsonResp({ error: 'Database not configured' }, 500, hdrs);
    }
    await ensureTable(env);
    const result = await env.DB.prepare(
      'SELECT content, last_updated FROM site_data WHERE id = 1'
    ).first();
    if (!result) {
      return jsonResp({ data: {}, lastUpdated: null, source: 'd1', empty: true }, 200, hdrs);
    }
    const data = JSON.parse(result.content);
    return jsonResp({
      data: data,
      lastUpdated: result.last_updated,
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    return jsonResp({ error: 'Read failed' }, 500, hdrs);
  }
}
export async function onRequestPut(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  if (!checkPassword(request, env)) {
    return jsonResp({ error: 'Forbidden' }, 403, hdrs);
  }
  try {
    if (!env.DB) {
      return jsonResp({ error: 'Database not configured' }, 500, hdrs);
    }
    await ensureTable(env);
    const body = await request.json();
    const data = body.data;
    if (!data) {
      return jsonResp({ error: 'Missing data field' }, 400, hdrs);
    }
    const content = JSON.stringify(data);
    const lastUpdated = data.lastUpdated || new Date().toISOString();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO site_data (id, content, last_updated, updated_at) VALUES (1, ?, ?, ?)'
    ).bind(content, lastUpdated, Date.now()).run();
    return jsonResp({
      success: true,
      lastUpdated: lastUpdated,
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    return jsonResp({ error: 'Save failed' }, 500, hdrs);
  }
}
