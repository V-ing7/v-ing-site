/**
 * V-ing Site API — Azure Speech synthesis proxy
 * GET /api/v-ing-tts?voice=<short name>&text=<text>
 *
 * Reads the Azure Speech key/region from D1 (or env) and returns one MP3.
 * The key never reaches the browser; the browser only asks for a voice + text.
 *
 * The endpoint is behind the workspace password so it cannot be used as a free
 * TTS engine for arbitrary sites, plus a per-IP rate limit on top.
 */

import { resolveVoiceConfig } from '../_lib/app-settings.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

// zh-CN voices offered on the audition page.
const VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaochenNeural',
  'zh-CN-XiaohanNeural',
  'zh-CN-XiaomengNeural',
  'zh-CN-XiaoqiuNeural',
  'zh-CN-XiaoyanNeural',
  'zh-CN-XiaoshuangNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural'
];

const MAX_TEXT_CHARS = 600;
const RATE_WINDOW = 60000;
const RATE_LIMIT = 60; // 60 clips / minute / IP (audition page plays 10 quickly)

const rateStore = new Map();

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

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, voice) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
    "<voice name='" + voice + "'>" +
    escapeXml(text) +
    '</voice></speak>';
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const url = new URL(request.url);
  const voice = url.searchParams.get('voice') || VOICES[0];
  const text = (url.searchParams.get('text') || '').trim().slice(0, MAX_TEXT_CHARS);

  if (!VOICES.includes(voice)) return jsonResp({ error: 'Unknown voice' }, 400, hdrs);
  if (!text) return jsonResp({ error: 'Empty text' }, 400, hdrs);
  if (!checkRateLimit(getClientIP(request)).allowed) {
    return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  }
  if (!checkPassword(request, env)) return jsonResp({ error: 'Unauthorized' }, 403, hdrs);

  const config = await resolveVoiceConfig(env);
  if (!config.key || !config.region) {
    return jsonResp({ error: 'Voice not configured' }, 503, hdrs);
  }

  let upstream;
  try {
    upstream = await fetch(
      'https://' + config.region + '.tts.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': config.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'v-ing-site'
        },
        body: buildSsml(text, voice),
        signal: AbortSignal.timeout(20000)
      }
    );
  } catch (e) {
    console.error('[v-ing-tts] upstream failed:', e && e.message);
    return jsonResp({ error: 'Upstream unavailable' }, 502, hdrs);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('[v-ing-tts]', upstream.status, detail.slice(0, 300));
    if (upstream.status === 401 || upstream.status === 403) {
      return jsonResp({ error: 'Invalid voice key' }, 503, hdrs);
    }
    if (upstream.status === 429) {
      return jsonResp({ error: 'Voice quota exceeded' }, 503, hdrs);
    }
    return jsonResp({ error: 'Voice synthesis failed' }, 502, hdrs);
  }

  const audio = await upstream.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audio.byteLength),
      // private: keeps the clip out of the shared edge cache
      'Cache-Control': 'private, max-age=600',
      ...hdrs
    }
  });
}
