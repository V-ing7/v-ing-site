/**
 * V-ing Site API — data endpoint (Cloudflare Pages Functions)
 *
 * GET  /api/data  — Read data.json (no auth)
 * PUT  /api/data  — Update data.json (requires X-Password header)
 * Security: Rate limiting + brute-force lockout (v4.0+)
 */

const GH_REPO = 'V-ing7/v-ing-site';
const GH_FILE = 'data.json';
const GH_BRANCH = 'main';
const GH_API_BASE = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Password',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

// --- Security: Rate Limiting & Brute-Force Protection ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;   // 1 minute
const RATE_LIMIT_MAX = 8;          // max PUT requests per minute per IP
const LOCKOUT_THRESHOLD = 10;      // failed attempts before lockout
const LOCKOUT_DURATION = 900000;   // 15 minutes lockout

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

// --- Helpers ---
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

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const resp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, {
      headers: {
        'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'v-ing-pages-function',
      },
    });
    if (!resp.ok) {
      return jsonResp({ error: 'GitHub API error: ' + resp.status }, 502);
    }
    const json = await resp.json();
    const binary = atob(json.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(decoded);
    return jsonResp({ sha: json.sha, data: data });
  } catch (err) {
    return jsonResp({ error: 'Read failed: ' + err.message }, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const clientIP = getClientIP(request);

  // Security: Rate limit check
  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({
      error: 'IP 已被锁定，请 ' + Math.ceil(rl.retryAfter / 60) + ' 分钟后再试',
      locked: true,
      retryAfter: rl.retryAfter,
    }, 429, { 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: '请求过于频繁，请稍后再试', rateLimited: true }, 429);
  }

  // Password check
  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: '密码错误，写入被拒绝' }, 403);
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
      return jsonResp({ error: 'SHA conflict (409),请重新获取 sha', conflict: true }, 409);
    }
    if (!resp.ok) {
      const errBody = await resp.text();
      return jsonResp({ error: 'GitHub API error: ' + resp.status, detail: errBody }, 502);
    }
    const json = await resp.json();
    return jsonResp({ sha: json.content ? json.content.sha : null, ok: true });
  } catch (err) {
    return jsonResp({ error: 'Write failed: ' + err.message }, 500);
  }
}