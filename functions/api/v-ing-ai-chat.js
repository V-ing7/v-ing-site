/**
 * V-ing Site API — AI conversation history
 *
 *   GET    /api/v-ing-ai-chat   load the saved conversation
 *   POST   /api/v-ing-ai-chat   replace it { messages:[{role,content}] }
 *   DELETE /api/v-ing-ai-chat   clear it
 *
 * All methods require the workspace password in the X-Password header.
 * Stored as one JSON value in D1 (env.DB) so the conversation survives a
 * refresh and follows the user to another device. Only plain user/assistant
 * text is kept — tool-call plumbing is dropped before it is written.
 */

import {
  deleteSetting,
  getSetting,
  setSetting
} from '../_lib/app-settings.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const RATE_WINDOW = 60000;
const RATE_LIMIT = 120;
const CHAT_SETTING = 'ai_chat_history';
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 20000;
const MAX_CONTENT_CHARS = 6000;
const ROLES = ['user', 'assistant'];

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

// Keep only the last MAX_MESSAGES user/assistant turns and start the list on a
// user message, so a restored conversation never opens with a dangling reply.
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = [];
  let total = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (!ROLES.includes(item.role)) continue;
    if (typeof item.content !== 'string') continue;
    const content = item.content.trim();
    if (!content) continue;
    if (total + content.length > MAX_TOTAL_CHARS) break;
    total += content.length;
    cleaned.push({ role: item.role, content: content.slice(0, MAX_CONTENT_CHARS) });
  }
  let trimmed = cleaned.slice(-MAX_MESSAGES);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
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
    const stored = await getSetting(env, CHAT_SETTING);
    let messages = [];
    if (stored && stored.value) {
      try {
        messages = sanitizeMessages(JSON.parse(stored.value)) || [];
      } catch (e) {
        messages = [];
      }
    }
    return jsonResp({
      messages,
      count: messages.length,
      updatedAt: stored ? stored.updatedAt : 0
    }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-chat] read failed:', e && e.message);
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ error: 'Invalid JSON' }, 400, hdrs);
  }
  const messages = sanitizeMessages(body && body.messages);
  if (!messages) return jsonResp({ error: 'Invalid messages' }, 400, hdrs);

  try {
    if (!messages.length) {
      await deleteSetting(env, CHAT_SETTING);
    } else {
      await setSetting(env, CHAT_SETTING, JSON.stringify(messages));
    }
    return jsonResp({ ok: true, count: messages.length }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-chat] write failed:', e && e.message);
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
    await deleteSetting(env, CHAT_SETTING);
    return jsonResp({ ok: true, count: 0 }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-chat] delete failed:', e && e.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
