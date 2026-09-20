/**
 * V-ing Site API — deploy trigger
 * POST /api/deploy (requires X-Password header)
 * Security: Rate limiting (v4.0+)
 */

const CF_ACCOUNT_ID = 'edb10972ff8ae9f58d46aa4bdcee3fca';
const CF_PROJECT = 'v-ing-site';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Password',
};

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
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...(extraHeaders || {}) },
  });
}

function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  return pwd === (env.WS_PASSWORD || env.WS_PWD);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientIP = getClientIP(request);

  // Security: Rate limit check
  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({
      error: 'IP 已被锁定，请 ' + Math.ceil(rl.retryAfter / 60) + ' 分钟后再试',
      locked: true,
    }, 429, { 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: '部署请求过于频繁，请稍后再试' }, 429);
  }

  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: '密码错误' }, 403);
  }
  try {
    const cfBase = 'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/pages/projects/' + CF_PROJECT;
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
        return jsonResp({ ok: true, message: 'Deployment retried' });
      }
      return jsonResp({ error: 'CF retry failed', detail: retryData.errors }, 502);
    }
    return jsonResp({ error: 'No deployments found' }, 404);
  } catch (err) {
    return jsonResp({ error: 'Deploy failed: ' + err.message }, 500);
  }
}