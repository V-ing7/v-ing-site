/**
 * V-ing Site API — password verification (workspace lock UX gate)
 * POST /api/v-ing-verify   — verify X-Password, returns ONLY { ok }
 *
 * SECURITY v7.0 (2026-10-19):
 *   - The workspace lock now validates the password SERVER-SIDE, so the
 *     secret never has to be embedded in client code (previously the client
 *     hardcoded WS_PASSWORD='Vikyi', which leaked write access).
 *   - Timing-safe XOR comparison (identical to v-ing-data.js / v-ing-setup.js).
 *   - Rate limited per IP + IP lockout after repeated failures.
 *   - Returns ONLY { ok: boolean } — never echoes the password nor errors.
 *   - This endpoint reads/writes NO data. The real write protection is still
 *     enforced by PUT /api/v-ing-data.
 *   - GET is explicitly blocked (405).
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

// --- Rate Limiting ---
const RATE_LIMIT_WINDOW = 60000;      // 60s window
const VERIFY_RATE_LIMIT = 10;         // 10 attempts per minute per IP
const FAILURE_LOCKOUT = 5;            // 5 failed passwords → lockout
const LOCKOUT_DURATION = 1800000;     // 30 minutes

const rateStore = new Map();

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  };
}

function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
         'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let record = rateStore.get(ip);
  if (!record) {
    record = { count: 0, windowStart: now, failures: 0, lockedUntil: 0 };
    rateStore.set(ip, record);
  }
  if (record.lockedUntil > now) {
    return { allowed: false, locked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  if (now - record.windowStart > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count++;
  return { allowed: record.count <= VERIFY_RATE_LIMIT, locked: false };
}

function recordFailure(ip) {
  const now = Date.now();
  let record = rateStore.get(ip);
  if (!record) {
    record = { count: 0, windowStart: now, failures: 0, lockedUntil: 0 };
    rateStore.set(ip, record);
  }
  record.failures++;
  if (record.failures >= FAILURE_LOCKOUT) {
    record.lockedUntil = now + LOCKOUT_DURATION;
    record.failures = 0;
  }
  rateStore.set(ip, record);
}

function resetFailures(ip) {
  const record = rateStore.get(ip);
  if (record) {
    record.failures = 0;
    rateStore.set(ip, record);
  }
}

// Timing-safe XOR comparison against the server-held secret (env.WS_PASSWORD).
// Matches the PUT endpoint exactly so verify and write agree on the password.
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

// GET is blocked — verification must not happen via query strings/URLs.
export async function onRequestGet(context) {
  return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders(context.request));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const clientIP = getClientIP(request);

  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({ ok: false, locked: true, retryAfter: rl.retryAfter },
      429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ ok: false, error: 'Too many requests' }, 429, hdrs);
  }

  if (!checkPassword(request, env)) {
    recordFailure(clientIP);
    // 403 signals "wrong password" to the client. No detail is leaked.
    return jsonResp({ ok: false }, 403, hdrs);
  }

  resetFailures(clientIP);
  return jsonResp({ ok: true }, 200, hdrs);
}
