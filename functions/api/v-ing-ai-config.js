/**
 * V-ing Site API — Vmi settings (DeepSeek key management)
 *
 *   GET    /api/v-ing-ai-config   current key status (masked, never the key)
 *   POST   /api/v-ing-ai-config   replace key { apiKey }
 *   DELETE /api/v-ing-ai-config   drop the custom key, fall back to env
 *
 * All methods require the workspace password in the X-Password header.
 * The key is stored in D1 (env.DB) and is only ever read server-side by
 * /api/v-ing-ai — the browser receives a mask such as ••••••••4f2a.
 */

import {
  AI_KEY_SETTING,
  deleteSetting,
  getSetting,
  resolveApiKey,
  setSetting
} from '../_lib/app-settings.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const RATE_WINDOW = 60000;
const RATE_LIMIT = 20;
const MAX_BODY_BYTES = 4096;
const MAX_KEY_CHARS = 200;
const MIN_KEY_CHARS = 8;

const rateStore = new Map();

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin'
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
  if (!record || now - record.windowStart > RATE_WINDOW) {
    record = { count: 0, windowStart: now };
  }
  record.count++;
  rateStore.set(ip, record);
  return { allowed: record.count <= RATE_LIMIT };
}

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

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 4) return '••••';
  return '••••••••' + key.slice(-4);
}

async function buildStatus(env) {
  const resolved = await resolveApiKey(env);
  let updatedAt = null;
  if (resolved.source === 'custom') {
    const stored = await getSetting(env, AI_KEY_SETTING);
    updatedAt = stored ? stored.updatedAt : null;
  }
  return {
    hasKey: !!resolved.key,
    source: resolved.source,
    masked: maskKey(resolved.key),
    updatedAt
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 503, hdrs);
  if (!checkRateLimit(getClientIP(request)).allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }
  if (!checkPassword(request, env)) return jsonResp({ error: 'Unauthorized' }, 403, hdrs);
  try {
    return jsonResp(await buildStatus(env), 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-config] read failed:', e && e.message);
    return jsonResp({ error: 'Read failed' }, 500, hdrs);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 503, hdrs);
  if (!checkRateLimit(getClientIP(request)).allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }
  if (!checkPassword(request, env)) return jsonResp({ error: 'Unauthorized' }, 403, hdrs);

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonResp({ error: 'Payload too large' }, 413, hdrs);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ error: 'Invalid JSON' }, 400, hdrs);
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length < MIN_KEY_CHARS || apiKey.length > MAX_KEY_CHARS || /\s/.test(apiKey)) {
    return jsonResp({ error: 'Invalid key' }, 400, hdrs);
  }

  try {
    await setSetting(env, AI_KEY_SETTING, apiKey);
    const status = await buildStatus(env);
    return jsonResp({ ok: true, ...status }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-config] write failed:', e && e.message);
    return jsonResp({ error: 'Write failed' }, 500, hdrs);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 503, hdrs);
  if (!checkRateLimit(getClientIP(request)).allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }
  if (!checkPassword(request, env)) return jsonResp({ error: 'Unauthorized' }, 403, hdrs);

  try {
    await deleteSetting(env, AI_KEY_SETTING);
    const status = await buildStatus(env);
    return jsonResp({ ok: true, ...status }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-config] delete failed:', e && e.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
