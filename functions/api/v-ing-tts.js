/**
 * V-ing Site API — Edge TTS proxy
 * GET /api/v-ing-tts?voice=<short name>&text=<text>
 *
 * Turns text into MP3 through Microsoft Edge's public read-aloud endpoint so
 * the browser gets a single audio stream and never talks to Microsoft itself.
 *
 * WHY A SERVER PROXY:
 *   - The endpoint is a WebSocket protocol; doing it in the browser would need
 *     a chunk of protocol code plus CORS workarounds.
 *   - Keeping it server-side lets us whitelist voices and cap text length, so
 *     the endpoint cannot be used as a free text-to-speech engine for anything.
 *
 * RESPONSE: audio/mpeg. Cached at the edge for a day (same text → same bytes).
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = '1-' + CHROMIUM_VERSION;
const WSS_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN;

// Only the voices offered on the audition page (plus a couple of fallbacks).
const VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural',
  'zh-TW-HsiaoChenNeural',
  'zh-TW-HsiaoYuNeural',
  'zh-HK-HiuMaanNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunxiaNeural'
];

const MAX_TEXT_CHARS = 600;
const RATE_WINDOW = 60000;
const RATE_LIMIT = 20; // 20 clips / minute / IP

const rateStore = new Map();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff'
  };
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
  return record.count <= RATE_LIMIT;
}

function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

// Windows-style GMT string used by the protocol for X-Timestamp.
function gmtDateString() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

// Token derived from the current time (rounded to 5 minutes) + client token.
async function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const stamp = String(ticks * 10000000);
  const data = new TextEncoder().encode(stamp + TRUSTED_CLIENT_TOKEN);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
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
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    "<voice name='" + voice + "'>" +
    "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
    escapeXml(text) +
    '</prosody></voice></speak>';
}

async function synthesize(text, voice) {
  const gec = await secMsGec();
  const url = WSS_URL + '&ConnectionId=' + uuid() +
    '&Sec-MS-GEC=' + gec + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION;

  const res = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
        ' (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'muid=' + uuid().toUpperCase() + ';'
    }
  });

  if (res.status !== 101 || !res.webSocket) {
    throw new Error('ws handshake failed: ' + res.status);
  }

  const ws = res.webSocket;
  ws.accept();

  const audio = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tts timeout')), 20000);
    ws.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.indexOf('Path:turn.end') !== -1) {
          clearTimeout(timer);
          resolve();
        }
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes.length < 2) return;
      const headerLength = (bytes[0] << 8) | bytes[1];
      if (2 + headerLength > bytes.length) return;
      const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLength));
      if (header.indexOf('Path:audio') === -1) return;
      const chunk = bytes.subarray(2 + headerLength);
      if (chunk.length) audio.push(chunk);
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    });
  });

  ws.send(
    'X-Timestamp:' + gmtDateString() + '\r\n' +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":' +
    '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );

  ws.send(
    'X-RequestId:' + uuid() + '\r\n' +
    'Content-Type:application/ssml+xml\r\n' +
    'X-Timestamp:' + gmtDateString() + 'Z\r\n' +
    'Path:ssml\r\n\r\n' +
    buildSsml(text, voice)
  );

  try {
    await done;
  } finally {
    try { ws.close(); } catch (e) { /* already closed */ }
  }

  if (!audio.length) throw new Error('empty audio');

  const total = audio.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of audio) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const voice = url.searchParams.get('voice') || VOICES[0];
  const text = (url.searchParams.get('text') || '').trim().slice(0, MAX_TEXT_CHARS);

  if (!VOICES.includes(voice)) {
    return new Response(JSON.stringify({ error: 'Unknown voice' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  if (!text) {
    return new Response(JSON.stringify({ error: 'Empty text' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  if (!checkRateLimit(getClientIP(request))) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    const audio = await synthesize(text, voice);
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.length),
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders()
      }
    });
  } catch (e) {
    console.error('[v-ing-tts]', voice, e && e.message);
    return new Response(JSON.stringify({ error: 'TTS unavailable', detail: String(e && e.message).slice(0, 120) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}
