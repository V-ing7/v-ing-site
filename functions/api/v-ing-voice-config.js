/**
 * V-ing Site API — voice settings (Azure Speech key)
 *
 *   GET    /api/v-ing-voice-config   key status (masked) + region
 *   POST   /api/v-ing-voice-config   save { key, region }
 *   DELETE /api/v-ing-voice-config   drop the custom pair, fall back to env
 *
 * All methods require the workspace password in the X-Password header.
 * The key is stored in D1 (env.DB) and only ever read server-side by
 * /api/v-ing-tts — the browser receives a mask such as ••••••••4f2a.
 */

import {
  VOICE_KEY_SETTING,
  VOICE_REGION_SETTING,
  deleteSetting,
  getSetting,
  resolveVoiceConfig,
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
const MIN_KEY_CHARS = 16;
const REGION_RE = /^[a-z0-9-]{2,30}$/;

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
  const resolved = await resolveVoiceConfig(env);
  return {
    hasKey: !!resolved.key,
    source: resolved.source,
    region: resolved.region || '',
    masked: maskKey(resolved.key),
    updatedAt: resolved.updatedAt
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
    console.error('[v-ing-voice-config] read failed:', e && e.message);
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

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const region = typeof body.region === 'string' ? body.region.trim().toLowerCase() : '';

  if (key.length < MIN_KEY_CHARS || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
    return jsonResp({ error: 'Invalid key' }, 400, hdrs);
  }
  if (!REGION_RE.test(region)) {
    return jsonResp({ error: 'Invalid region' }, 400, hdrs);
  }

  try {
    await setSetting(env, VOICE_KEY_SETTING, key);
    await setSetting(env, VOICE_REGION_SETTING, region);
    return jsonResp({ ok: true, ...(await buildStatus(env)) }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-voice-config] write failed:', e && e.message);
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
    await deleteSetting(env, VOICE_KEY_SETTING);
    await deleteSetting(env, VOICE_REGION_SETTING);
    return jsonResp({ ok: true, ...(await buildStatus(env)) }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-voice-config] delete failed:', e && e.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
