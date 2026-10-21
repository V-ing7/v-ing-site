/**
 * V-ing Site API — DeepSeek AI proxy (workspace assistant)
 * POST /api/v-ing-ai   — stream a DeepSeek chat completion
 *
 * SECURITY:
 *   - The DeepSeek key lives ONLY in the server environment
 *     (env.DEEPSEEK_API_KEY). It is never sent to the browser.
 *   - Requests must carry the workspace password in the X-Password header,
 *     verified with the same timing-safe comparison as /api/v-ing-verify.
 *     Unlocked-workspace users only.
 *   - Per-IP rate limiting, body size / message count / length caps.
 *   - Upstream errors are logged server-side and returned as generic text.
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ALLOWED_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
const DEFAULT_SYSTEM_PROMPT =
  '你是「微影 V-ing」影视创作工作室的 AI 助手，负责协助创作计划、脚本、分镜、文案与日常影视制作问题。回答简洁、具体、可执行，默认使用中文。';

// --- Limits ---
const RATE_WINDOW = 60000;      // 60s window
const RATE_LIMIT = 12;          // 12 requests / minute / IP
const MAX_BODY_BYTES = 200000;  // ~200KB request body
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;

const rateStore = new Map();

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  return {
    allowed: record.count <= RATE_LIMIT,
    retryAfter: Math.ceil((RATE_WINDOW - (now - record.windowStart)) / 1000)
  };
}

// Timing-safe XOR comparison — identical to v-ing-verify.js so one password
// unlocks both the workspace UI and this API.
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

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Normalise + validate the client payload. Returns { messages, model, ... }
// or { error } describing why it was rejected.
function normalizePayload(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { error: 'Invalid messages' };
  }
  if (body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return { error: 'Message count out of range' };
  }

  let totalChars = 0;
  const messages = [];
  for (const item of body.messages) {
    if (!item || typeof item !== 'object') return { error: 'Invalid message' };
    const role = item.role;
    const content = item.content;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      return { error: 'Invalid role' };
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { error: 'Invalid content' };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: 'Message too long' };
    }
    totalChars += content.length;
    messages.push({ role, content });
  }
  if (totalChars > MAX_TOTAL_CHARS) return { error: 'Conversation too long' };

  // Always keep a server-owned system prompt at the top unless the client
  // already supplied one.
  if (messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'deepseek-chat';
  return {
    messages,
    model,
    stream: true,
    temperature: clampNumber(body.temperature, 0, 1.5, 1),
    max_tokens: clampNumber(body.max_tokens, 1, 4096, 2048)
  };
}

function sseError(message, status) {
  const payload = 'data: ' + JSON.stringify({ error: message }) + '\n\n' + 'data: [DONE]\n\n';
  return new Response(payload, {
    status: status || 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform'
    }
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders(context.request));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  if (!env.DEEPSEEK_API_KEY) {
    return jsonResp({ error: 'AI not configured' }, 503, hdrs);
  }

  const rl = checkRateLimit(getClientIP(request));
  if (!rl.allowed) {
    return jsonResp(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      429,
      { ...hdrs, 'Retry-After': String(rl.retryAfter) }
    );
  }

  if (!checkPassword(request, env)) {
    return jsonResp({ error: 'Unauthorized' }, 403, hdrs);
  }

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

  const payload = normalizePayload(body);
  if (payload.error) {
    return jsonResp({ error: payload.error }, 400, hdrs);
  }

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        stream: payload.stream,
        temperature: payload.temperature,
        max_tokens: payload.max_tokens
      })
    });
  } catch (e) {
    console.error('[v-ing-ai] upstream fetch failed:', e && e.message);
    return jsonResp({ error: 'Upstream unavailable' }, 502, hdrs);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('[v-ing-ai] upstream', upstream.status, detail.slice(0, 500));
    // Do not leak upstream error bodies (may contain key/quota details).
    return jsonResp({ error: 'Upstream error' }, 502, hdrs);
  }

  // Pass the SSE stream through untouched; the browser parser handles it.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...hdrs,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
