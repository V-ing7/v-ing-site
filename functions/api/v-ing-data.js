/**
 * V-ing Site API — data read/write via Cloudflare D1
 * GET  /api/v-ing-data   — read site data (no password)
 * PUT  /api/v-ing-data   — write site data (requires X-Password)
 *
 * D1 binding: env.DB (configured in Cloudflare Pages dashboard)
 * Security: v5.0 Deep Security Hardening
 *   - CORS origin whitelist
 *   - Rate limiting per IP (GET + PUT separate)
 *   - IP lockout after failed password attempts
 *   - Payload size limit (512KB)
 *   - Data structure validation
 *   - Timing-safe password comparison
 *   - No hardcoded secrets
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

// --- Rate Limiting Configuration ---
const RATE_LIMIT_WINDOW = 60000;      // 60 second window
const GET_RATE_LIMIT = 60;            // 60 GET requests per minute per IP
const PUT_RATE_LIMIT = 10;            // 10 PUT attempts per minute per IP
const PASSWORD_FAILURE_LOCKOUT = 5;   // 5 failed passwords → lockout
const LOCKOUT_DURATION = 1800000;     // 30 minutes lockout
const MAX_PAYLOAD_SIZE = 512 * 1024;  // 512 KB max payload

// In-memory rate limit store (per worker instance, acceptable for this scale)
const rateStore = new Map();

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
         'unknown';
}

function checkRateLimit(ip, type) {
  const now = Date.now();
  const key = ip + ':' + type;
  let record = rateStore.get(key);

  if (!record) {
    record = { count: 0, windowStart: now, failures: 0, lockedUntil: 0 };
    rateStore.set(key, record);
  }

  // Check if currently locked
  if (record.lockedUntil > now) {
    return {
      allowed: false,
      locked: true,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000)
    };
  }

  // Reset window if expired
  if (now - record.windowStart > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.windowStart = now;
  }

  record.count++;

  const limit = type === 'get' ? GET_RATE_LIMIT : PUT_RATE_LIMIT;
  return { allowed: record.count <= limit, locked: false };
}

function recordPasswordFailure(ip) {
  const now = Date.now();
  const key = ip + ':put';
  let record = rateStore.get(key);

  if (!record) {
    record = { count: 0, windowStart: now, failures: 0, lockedUntil: 0 };
    rateStore.set(key, record);
  }

  record.failures++;

  if (record.failures >= PASSWORD_FAILURE_LOCKOUT) {
    record.lockedUntil = now + LOCKOUT_DURATION;
    record.failures = 0;
  }

  rateStore.set(key, record);
}

function resetPasswordFailures(ip) {
  const key = ip + ':put';
  const record = rateStore.get(key);
  if (record) {
    record.failures = 0;
    rateStore.set(key, record);
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Access-Control-Max-Age': '86400',
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

function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  if (!pwd || !env.WS_PASSWORD) {
    return false;
  }
  // Timing-safe comparison using XOR (prevents timing attacks)
  const expected = env.WS_PASSWORD;
  if (pwd.length !== expected.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < pwd.length; i++) {
    result |= pwd.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

function validateData(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'Data must be an object' };
  }
  if (data.streamers && typeof data.streamers !== 'object') {
    return { valid: false, reason: 'streamers must be an object' };
  }
  if (data.lastUpdated && typeof data.lastUpdated !== 'string') {
    return { valid: false, reason: 'lastUpdated must be a string' };
  }
  const size = JSON.stringify(data).length;
  if (size > MAX_PAYLOAD_SIZE) {
    return { valid: false, reason: 'Data too large (max 512KB)' };
  }
  return { valid: true, size: size };
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
  const clientIP = getClientIP(request);

  const rl = checkRateLimit(clientIP, 'get');
  if (rl.locked) {
    return jsonResp({
      error: 'Rate limited',
      retryAfter: rl.retryAfter
    }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }

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
  const clientIP = getClientIP(request);

  const rl = checkRateLimit(clientIP, 'put');
  if (rl.locked) {
    return jsonResp({
      error: 'Too many failed attempts. IP temporarily locked.',
      locked: true,
      retryAfter: rl.retryAfter
    }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }

  if (!checkPassword(request, env)) {
    recordPasswordFailure(clientIP);
    return jsonResp({ error: 'Forbidden' }, 403, hdrs);
  }

  try {
    if (!env.DB) {
      return jsonResp({ error: 'Database not configured' }, 500, hdrs);
    }

    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      return jsonResp({ error: 'Payload too large' }, 413, hdrs);
    }

    const body = await request.json();
    const data = body.data;

    if (!data) {
      return jsonResp({ error: 'Missing data field' }, 400, hdrs);
    }

    const validation = validateData(data);
    if (!validation.valid) {
      return jsonResp({ error: validation.reason }, 400, hdrs);
    }

    await ensureTable(env);

    const content = JSON.stringify(data);
    const lastUpdated = data.lastUpdated || new Date().toISOString();

    await env.DB.prepare(
      'INSERT OR REPLACE INTO site_data (id, content, last_updated, updated_at) VALUES (1, ?, ?, ?)'
    ).bind(content, lastUpdated, Date.now()).run();

    resetPasswordFailures(clientIP);

    return jsonResp({
      success: true,
      lastUpdated: lastUpdated,
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    return jsonResp({ error: 'Save failed' }, 500, hdrs);
  }
}
