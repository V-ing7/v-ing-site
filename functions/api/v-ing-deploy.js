/**
 * V-ing Site API — deploy trigger
 * POST /api/deploy (requires X-Password header)
 * Security: Rate limiting (v4.0+) + error sanitization (v4.2) + no hardcoded IDs (v4.2)
 */

// Security fix SEC-006: CF account ID now read from env variable
const CF_PROJECT = 'v-ing-site';

// Security fix SEC-005: Restrict CORS to specific origins
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
  };
}

// --- Security: Rate Limiting ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 3;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION = 1800000; // 30 minutes lockout for deploy

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
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
  rateLimitMap.set(ip, record);
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

export async function onRequestPost(context) {
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

  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Invalid password' }, 403, hdrs);
  }

  try {
    // Security fix SEC-006: Read CF account ID from env variable
    const accountId = env.CF_ACCOUNT_ID;
    if (!accountId) {
      return jsonResp({ error: 'Server misconfigured' }, 500, hdrs);
    }

    const cfBase = 'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/pages/projects/' + CF_PROJECT;
    const cfHeaders = {
      'Authorization': 'Bearer ' + (env.CF_TOKEN || env.CF_API_TOKEN),
      'Content-Type': 'application/json',
    };
    const listResp = await fetch(cfBase + '/deployments?per_page=1', { headers: cfHeaders });
    const listData = await listResp.json();
    const items = listData.result;
    if (Array.isArray(items) && items.length > 0) {
      const retryResp = await fetch(cfBase + '/deployments/' + items[0].id + '/retry', {
        method: 'POST',
        headers: cfHeaders,
      });
      const retryData = await retryResp.json();
      if (retryData.success) {
        return jsonResp({ ok: true, message: 'Deployment retried' }, 200, hdrs);
      }
      // Security fix SEC-004: Don't leak CF API errors
      return jsonResp({ error: 'Deploy retry failed' }, 502, hdrs);
    }
    return jsonResp({ error: 'No deployments found' }, 404, hdrs);
  } catch (err) {
    // Security fix SEC-004: Don't leak internal error details
    return jsonResp({ error: 'Deploy failed' }, 500, hdrs);
  }
}
