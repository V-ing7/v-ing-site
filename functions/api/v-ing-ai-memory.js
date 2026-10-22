/**
 * V-ing Site API — AI long-term memory
 *
 *   GET    /api/v-ing-ai-memory          list memories
 *   POST   /api/v-ing-ai-memory          add one memory { content, kind }
 *   DELETE /api/v-ing-ai-memory?id=123   remove one
 *   DELETE /api/v-ing-ai-memory?all=1    remove all
 *
 * All methods require the workspace password in the X-Password header.
 * Stored in D1 (env.DB). Nothing is sent to third parties.
 */

import {
  ensureMemoryTable,
  loadMemories,
  mapRow,
  saveMemories
} from '../_lib/ai-memory.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const RATE_WINDOW = 60000;
const RATE_LIMIT = 60;
const MAX_CONTENT_CHARS = 200;
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
    await ensureMemoryTable(env);
    const memories = await loadMemories(env, 200);
    return jsonResp({ memories, count: memories.length }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-memory] read failed:', e && e.message);
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
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_CONTENT_CHARS) {
    return jsonResp({ error: 'Invalid content' }, 400, hdrs);
  }
  try {
    await ensureMemoryTable(env);
    const saved = await saveMemories(env, [{ content, kind: body.kind }], 'manual');
    const memories = await loadMemories(env, 200);
    return jsonResp({ ok: true, saved, memories, count: memories.length }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-memory] write failed:', e && e.message);
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

  const url = new URL(request.url);
  const all = url.searchParams.get('all') === '1';
  const id = Number(url.searchParams.get('id'));

  try {
    await ensureMemoryTable(env);
    if (all) {
      await env.DB.prepare('DELETE FROM ai_memory').run();
    } else if (Number.isFinite(id) && id > 0) {
      await env.DB.prepare('DELETE FROM ai_memory WHERE id = ?').bind(id).run();
    } else {
      return jsonResp({ error: 'Missing id' }, 400, hdrs);
    }
    const memories = await loadMemories(env, 200);
    return jsonResp({ ok: true, memories, count: memories.length }, 200, hdrs);
  } catch (e) {
    console.error('[v-ing-ai-memory] delete failed:', e && e.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
