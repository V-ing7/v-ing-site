/**
 * V-ing Site API — data endpoint (Cloudflare Pages Functions)
 *
 * GET  /api/data          — Read data.json (no auth)
 * GET  /api/data?verify=1 — Verify password (SEC-001 fix)
 * PUT  /api/data          — Update data.json (requires X-Password header)
 * Security: Rate limiting + brute-force lockout (v4.0+) + error sanitization (v4.2)
 */

const GH_REPO = 'V-ing7/v-ing-site';
const GH_FILE = 'data.json';
const GH_BRANCH = 'main';
const GH_API_BASE = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;

// Security fix SEC-005: Restrict CORS to specific origins instead of wildcard
const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

function getCorsHeader(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0]; // Default to primary origin
}

function corsHeaders(request) {
  const allowOrigin = getCorsHeader(request);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
}

// --- Security: Rate Limiting & Brute-Force Protection ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;   // 1 minute
const RATE_LIMIT_MAX = 8;          // max PUT requests per minute per IP
const VERIFY_RATE_LIMIT_MAX = 10;  // max verify requests per minute per IP
const LOCKOUT_THRESHOLD = 10;      // failed attempts before lockout
const LOCKOUT_DURATION = 900000;   // 15 minutes lockout

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

function checkRateLimit(ip, maxLimit) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, failures: 0, lockedUntil: 0 };
    rateLimitMap.set(ip, record);
  }
  // Check lockout
  if (record.lockedUntil > now) {
    return { allowed: false, locked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  // Reset window if expired
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.firstAttempt = now;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  return { allowed: record.count <= (maxLimit || RATE_LIMIT_MAX), locked: false };
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

// --- Helpers ---
function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  return pwd === (env.WS_PASSWORD || env.WS_PWD);
}

export async function onRequestOptions(context) {
  const { request } = context;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  // Security fix SEC-001: Password verification endpoint
  const url = new URL(request.url);
  if (url.searchParams.get('verify') === '1') {
    const clientIP = getClientIP(request);
    const rl = checkRateLimit(clientIP, VERIFY_RATE_LIMIT_MAX);
    if (rl.locked) {
      return jsonResp({
        error: 'IP locked',
        locked: true,
        retryAfter: rl.retryAfter,
      }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
    }
    if (!rl.allowed) {
      return jsonResp({ error: 'Rate limited' }, 429, hdrs);
    }
    if (checkPassword(request, env)) {
      return jsonResp({ ok: true }, 200, hdrs);
    }
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Invalid password' }, 403, hdrs);
  }

  // Normal data read
  try {
    const resp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, {
      headers: {
        'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'v-ing-pages-function',
      },
    });
    if (!resp.ok) {
      // Security fix SEC-004: Sanitize error message — don't leak upstream status
      return jsonResp({ error: 'Failed to read data' }, 502, hdrs);
    }
    const json = await resp.json();
    const binary = atob(json.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(decoded);
    return jsonResp({ sha: json.sha, data: data }, 200, hdrs);
  } catch (err) {
    // Security fix SEC-004: Don't leak internal error details
    return jsonResp({ error: 'Internal error' }, 500, hdrs);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const clientIP = getClientIP(request);

  // Security: Rate limit check
  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({
      error: 'IP locked',
      locked: true,
      retryAfter: rl.retryAfter,
    }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: 'Rate limited' }, 429, hdrs);
  }

  // Password check
  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Invalid password' }, 403, hdrs);
  }

  try {
    const body = await request.json();
    const content = JSON.stringify(body.data, null, 2);
    const encoded = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
    const b64 = btoa(binary);

    let payload = {
      message: body.message || ('Update data via API - ' + new Date().toISOString()),
      content: b64,
      branch: GH_BRANCH,
    };
    if (body.sha) payload.sha = body.sha;

    const resp = await fetch(GH_API_BASE, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'v-ing-pages-function',
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 409) {
      return jsonResp({ error: 'SHA conflict, please re-fetch', conflict: true }, 409, hdrs);
    }
    if (!resp.ok) {
      // Security fix SEC-004: Don't leak upstream response body
      return jsonResp({ error: 'Failed to update data' }, 502, hdrs);
    }
    const json = await resp.json();
    return jsonResp({ sha: json.content ? json.content.sha : null, ok: true }, 200, hdrs);
  } catch (err) {
    // Security fix SEC-004: Don't leak internal error details
    return jsonResp({ error: 'Internal error' }, 500, hdrs);
  }
}
