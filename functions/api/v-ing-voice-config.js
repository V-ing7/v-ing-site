/**
 * V-ing Site API — voice settings (Tencent Cloud TTS credentials)
 *
 *   GET    /api/v-ing-voice-config   credential status (masked) + region + voice
 *   POST   /api/v-ing-voice-config   save { secretId, secretKey, region, voiceId }
 *   DELETE /api/v-ing-voice-config   drop the credentials, fall back to env
 *
 * All methods require the workspace password in the X-Password header.
 * Credentials are stored in D1 (env.DB) and only ever read server-side by
 * /api/v-ing-tts — the browser receives a mask such as ••••••••4f2a.
 */

import {
  TTS_DEFAULT_REGION,
  TTS_REGION_SETTING,
  TTS_SECRET_ID_SETTING,
  TTS_SECRET_KEY_SETTING,
  TTS_VOICE_IDS,
  TTS_VOICE_SETTING,
  deleteSetting,
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
const MIN_CRED_CHARS = 10;
const MAX_CRED_CHARS = 128;
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

function validCredential(value) {
  return typeof value === 'string' &&
    value.length >= MIN_CRED_CHARS &&
    value.length <= MAX_CRED_CHARS &&
    !/\s/.test(value);
}

async function buildStatus(env) {
  const resolved = await resolveVoiceConfig(env);
  return {
    hasKey: resolved.hasKey,
    source: resolved.source,
    masked: maskKey(resolved.secretId),
    region: resolved.region || '',
    voiceId: resolved.voiceId,
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

  const secretId = typeof body.secretId === 'string' ? body.secretId.trim() : '';
  const secretKey = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';
  const region = typeof body.region === 'string' ? body.region.trim().toLowerCase() : '';
  const voiceRaw = body.voiceId == null ? '' : String(body.voiceId).trim();
  const voiceId = voiceRaw ? parseInt(voiceRaw, 10) : 0;

  if (secretId && !validCredential(secretId)) return jsonResp({ error: 'Invalid secretId' }, 400, hdrs);
  if (secretKey && !validCredential(secretKey)) return jsonResp({ error: 'Invalid secretKey' }, 400, hdrs);
  if (region && !REGION_RE.test(region)) return jsonResp({ error: 'Invalid region' }, 400, hdrs);
  if (voiceRaw && !TTS_VOICE_IDS.includes(voiceId)) return jsonResp({ error: 'Invalid voice' }, 400, hdrs);

  try {
    const existing = await resolveVoiceConfig(env);
    // Empty fields mean "keep what is already saved", so the user can change
    // only the region or the voice without retyping the credentials.
    const nextId = secretId || existing.secretId;
    const nextKey = secretKey || existing.secretKey;

    if (!nextId || !nextKey) {
      return jsonResp({ error: 'Both secretId and secretKey are required' }, 400, hdrs);
    }

    if (secretId) await setSetting(env, TTS_SECRET_ID_SETTING, secretId);
    if (secretKey) await setSetting(env, TTS_SECRET_KEY_SETTING, secretKey);
    if (region) await setSetting(env, TTS_REGION_SETTING, region);
    if (voiceRaw) await setSetting(env, TTS_VOICE_SETTING, String(voiceId));

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
    await deleteSetting(env, TTS_SECRET_ID_SETTING);
    await deleteSetting(env, TTS_SECRET_KEY_SETTING);
    await deleteSetting(env, TTS_REGION_SETTING);
    // Keep the chosen voice — it is harmless without credentials.
    await setSetting(env, TTS_REGION_SETTING, TTS_DEFAULT_REGION);
    return jsonResp({ ok: true, ...(await buildStatus(env)) }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-voice-config] delete failed:', e && e.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
