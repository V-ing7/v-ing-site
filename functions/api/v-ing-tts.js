/**
 * V-ing Site API — Tencent Cloud TTS proxy
 * GET /api/v-ing-tts?voice=<101001>&text=<text>
 *
 * Reads the Tencent SecretId/SecretKey from D1 (or env) and returns one MP3.
 * The credentials never reach the browser; the browser only asks for a voice
 * and some text. Requests are signed with TC3-HMAC-SHA256 per the Tencent
 * Cloud API v3 spec.
 *
 * The endpoint sits behind the workspace password so it cannot be used as a
 * free TTS engine for arbitrary sites, plus a per-IP rate limit on top.
 */

import { resolveVoiceConfig, TTS_VOICE_IDS } from '../_lib/app-settings.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const TTS_HOST = 'tts.tencentcloudapi.com';
const TTS_SERVICE = 'tts';
const TTS_ACTION = 'TextToVoice';
const TTS_VERSION = '2019-08-23';

const MAX_TEXT_CHARS = 600;
const RATE_WINDOW = 60000;
const RATE_LIMIT = 60; // 60 clips / minute / IP (audition page plays 10 quickly)

const rateStore = new Map();
const encoder = new TextEncoder();

// Durable server-side audio cache. One row per (voice, text) pair so that
// repeated requests return the stored clip instead of re-consuming
// Tencent TTS characters.
const TTS_CACHE_TABLE = 'tts_cache';

async function ensureCacheTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${TTS_CACHE_TABLE} (
      hash TEXT PRIMARY KEY,
      audio BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run();
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Password',
    'Access-Control-Max-Age': '86400',
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

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

// TC3-HMAC-SHA256 signing. `host` is part of the canonical request but must
// not be set on the outgoing Request — fetch derives it from the URL.
async function buildAuthHeaders(config, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';

  const canonicalRequest = [
    'POST',
    '/',
    '',
    'content-type:' + contentType,
    'host:' + TTS_HOST,
    '',
    'content-type;host',
    await sha256Hex(payload)
  ].join('\n');

  const credentialScope = date + '/' + TTS_SERVICE + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const secretDate = await hmac(encoder.encode('TC3' + config.secretKey), date);
  const secretService = await hmac(secretDate, TTS_SERVICE);
  const secretSigning = await hmac(secretService, 'tc3_request');
  const signature = toHex(await hmac(secretSigning, stringToSign));

  return {
    'Content-Type': contentType,
    'X-TC-Action': TTS_ACTION,
    'X-TC-Version': TTS_VERSION,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': config.region,
    'Authorization': 'TC3-HMAC-SHA256 Credential=' + config.secretId + '/' +
      credentialScope + ', SignedHeaders=content-type;host, Signature=' + signature
  };
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const url = new URL(request.url);
  const voiceParam = parseInt(url.searchParams.get('voice') || '', 10);
  const text = (url.searchParams.get('text') || '').trim().slice(0, MAX_TEXT_CHARS);

  if (!TTS_VOICE_IDS.includes(voiceParam)) return jsonResp({ error: 'Unknown voice' }, 400, hdrs);
  if (!text) return jsonResp({ error: 'Empty text' }, 400, hdrs);
  if (!checkRateLimit(getClientIP(request)).allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }
  if (!checkPassword(request, env)) return jsonResp({ error: 'Unauthorized' }, 403, hdrs);

  const config = await resolveVoiceConfig(env);
  if (!config.hasKey) {
    return jsonResp({ error: 'Voice not configured' }, 503, hdrs);
  }

  // Cloud cache lookup: a previous synthesis of the same voice+text pair
  // is returned without calling Tencent, so characters are never
  // consumed twice for the same content.
  let cachedAudio = null;
  if (env.DB) {
    try {
      await ensureCacheTable(env);
      const row = await env.DB
        .prepare('SELECT audio FROM tts_cache WHERE hash = ?')
        .bind(await sha256Hex(voiceParam + '|' + text))
        .first();
      if (row && row.audio) {
        const bytes = new Uint8Array(row.audio);
        if (bytes.byteLength > 0) cachedAudio = bytes;
      }
    } catch (e) {
      console.error('[v-ing-tts] cache read failed:', e && e.message);
    }
  }
  if (cachedAudio) {
    return new Response(cachedAudio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(cachedAudio.byteLength),
        'Cache-Control': 'private, max-age=600',
        'X-Cache': 'HIT',
        ...hdrs
      }
    });
  }

  // Only parameters accepted by TextToVoice (2019-08-23). Pitch/ProjectId
  // are not part of this action and made Tencent reject every request with
  // UnknownParameter — "The parameter `Pitch` is not recognized."
  const payload = JSON.stringify({
    Text: text,
    SessionId: 'v-ing-' + Date.now(),
    VoiceType: voiceParam,
    Speed: 0,
    Volume: 0,
    Codec: 'mp3',
    SampleRate: 16000
  });

  let upstream;
  try {
    upstream = await fetch('https://' + TTS_HOST, {
      method: 'POST',
      headers: await buildAuthHeaders(config, payload),
      body: payload,
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    console.error('[v-ing-tts] upstream failed:', e && e.message);
    return jsonResp({ error: 'Upstream unavailable' }, 502, hdrs);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    console.error('[v-ing-tts] invalid response:', upstream.status);
    return jsonResp({ error: 'Voice synthesis failed', upstreamStatus: upstream.status }, 502, hdrs);
  }

  const result = (data && data.Response) || {};

  // Tencent returns HTTP 200 even for API-level failures; the Error object is
  // the only signal, so it has to be inspected explicitly.
  if (result.Error) {
    const code = String(result.Error.Code || '');
    const message = String(result.Error.Message || '').slice(0, 200);
    const requestId = String(result.RequestId || '');
    console.error('[v-ing-tts]', code, message, requestId);
    if (/AuthFailure|Signature|SecretId/i.test(code)) {
      return jsonResp({ error: 'Invalid voice key', code, requestId }, 503, hdrs);
    }
    if (/Arrears|NoFreeAmount|LimitExceeded|ResourceUnavailable|UserNotRegistered/i.test(code)) {
      return jsonResp({ error: 'Voice quota exceeded', code, requestId }, 503, hdrs);
    }
    return jsonResp({ error: 'Voice synthesis failed', code, message, requestId }, 502, hdrs);
  }

  if (!result.Audio) {
    const requestId = String(result.RequestId || '');
    console.error('[v-ing-tts] empty audio, requestId:', requestId);
    return jsonResp({ error: 'Voice synthesis failed', requestId }, 502, hdrs);
  }

  let audio;
  try {
    audio = base64ToBytes(result.Audio);
  } catch (e) {
    return jsonResp({ error: 'Voice synthesis failed', requestId: String(result.RequestId || '') }, 502, hdrs);
  }

  // Store the clip for future repeats. Oversized blobs and requests
  // without a database are skipped; a failed write never affects the
  // response that is already ready.
  if (env.DB && audio.byteLength <= 700000 && typeof context.waitUntil === 'function') {
    context.waitUntil(
      env.DB.prepare(
        'INSERT OR REPLACE INTO tts_cache (hash, audio, created_at) VALUES (?, ?, ?)'
      )
        .bind(await sha256Hex(voiceParam + '|' + text), audio, Date.now())
        .run()
        .catch(e => console.error('[v-ing-tts] cache write failed:', e && e.message))
    );
  }

  return new Response(audio, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audio.byteLength),
      // private: keeps the clip out of the shared edge cache
      'Cache-Control': 'private, max-age=600',
      'X-Cache': 'MISS',
      ...hdrs
    }
  });
}
