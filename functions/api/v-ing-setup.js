/**
 * V-ing Site API — D1 setup / one-time data migration
 *
 * SECURITY FIX v6.0 (2026-10-19):
 *   - onRequestGet REMOVED (was completely unauthenticated, destructive!)
 *     Any visitor could GET /api/v-ing-setup and REPLACE all D1 production
 *     data with stale GitHub raw copy. This was CVE-level critical.
 *   - onRequestPost now requires X-Password AND has rate limiting.
 *   - Internal error messages are sanitized (no SQL / stack leakage).
 *
 * This endpoint should only be used ONCE during initial D1 setup, then
 * ideally deleted. Kept here behind auth for emergency recovery.
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const GH_RAW_URL = 'https://raw.githubusercontent.com/V-ing7/v-ing-site/main/data.json';

// --- Rate Limiting ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 2;              // only 2 attempts per minute
const LOCKOUT_THRESHOLD = 3;           // 3 failures → lockout
const LOCKOUT_DURATION = 1800000;      // 30 minutes

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };
}

function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
         'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, failures: 0, lockedUntil: 0 };
    rateLimitMap.set(ip, record);
  }
  if (record.lockedUntil > now) {
    return { allowed: false, locked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.firstAttempt = now;
  }
  record.count++;
  return { allowed: record.count <= RATE_LIMIT_MAX, locked: false };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, failures: 0, lockedUntil: 0 };
    rateLimitMap.set(ip, record);
  }
  record.failures++;
  if (record.failures >= LOCKOUT_THRESHOLD) {
    record.lockedUntil = now + LOCKOUT_DURATION;
    record.failures = 0;
  }
  rateLimitMap.set(ip, record);
}

// Timing-safe XOR password comparison (same as v-ing-data.js)
function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  if (!pwd || !env.WS_PASSWORD) return false;
  const expected = env.WS_PASSWORD;
  if (pwd.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < pwd.length; i++) {
    result |= pwd.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

// GET is EXPLICITLY BLOCKED — setup is destructive and must never be called without auth.
export async function onRequestGet(context) {
  const hdrs = corsHeaders(context.request);
  return jsonResp({ error: 'Method not allowed' }, 405, hdrs);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const clientIP = getClientIP(request);

  // Rate limit
  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({ error: 'IP temporarily locked', locked: true, retryAfter: rl.retryAfter },
      429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }

  // Password gate
  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Forbidden' }, 403, hdrs);
  }

  if (!env.DB) {
    return jsonResp({ error: 'Server misconfigured' }, 500, hdrs);
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
      return jsonResp({ error: 'Upstream fetch failed' }, 502, hdrs);
    }
    const ghData = await ghResp.json();

    const content = JSON.stringify(ghData);
    const lastUpdated = ghData.lastUpdated || new Date().toISOString();

    await env.DB.prepare(
      'INSERT OR REPLACE INTO site_data (id, content, last_updated, updated_at) VALUES (1, ?, ?, ?)'
    ).bind(content, lastUpdated, Date.now()).run();

    const streamerCount = ghData.streamers ? Object.keys(ghData.streamers).length : 0;

    return jsonResp({
      success: true,
      message: 'D1 setup complete',
      streamers: streamerCount,
      contentSize: content.length,
      lastUpdated: lastUpdated,
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    // SECURITY: sanitized — never expose err.message (could leak SQL / path info)
    return jsonResp({ error: 'Setup failed' }, 500, hdrs);
  }
}
