/**
 * One-time D1 setup endpoint
 * GET  /api/setup  — creates table + imports data from GitHub raw
 * POST /api/setup  — same (requires X-Password)
 *
 * After migration, this endpoint can be deleted.
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const GH_RAW_URL = 'https://raw.githubusercontent.com/V-ing7/v-ing-site/main/data.json';

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  if (!env.DB) {
    return jsonResp({ error: 'D1 binding not configured. Add DB binding in Pages settings.' }, 500, hdrs);
  }

  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS site_data (
        id INTEGER PRIMARY KEY DEFAULT 1,
        content TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      )`
    ).run();

    const ghResp = await fetch(GH_RAW_URL + '?t=' + Date.now());
    if (!ghResp.ok) {
      return jsonResp({ error: 'Failed to fetch from GitHub: HTTP ' + ghResp.status }, 502, hdrs);
    }
    const ghData = await ghResp.json();

    const content = JSON.stringify(ghData);
    const lastUpdated = ghData.lastUpdated || new Date().toISOString();

    await env.DB.prepare(
      'INSERT OR REPLACE INTO site_data (id, content, last_updated, updated_at) VALUES (1, ?, ?, ?)'
    ).bind(content, lastUpdated, Date.now()).run();

    const streamerCount = ghData.streamers ? Object.keys(ghData.streamers).length : 0;
    const contentSize = content.length;

    return jsonResp({
      success: true,
      message: 'D1 setup complete. Data imported from GitHub.',
      streamers: streamerCount,
      contentSize: contentSize,
      lastUpdated: lastUpdated,
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    return jsonResp({ error: 'Setup failed: ' + (err.message || err) }, 500, hdrs);
  }
}
