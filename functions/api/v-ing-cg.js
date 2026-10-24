/**
 * V-ing Site API — CG 素材库（透明图层 · 视频包装）
 *
 * GET    /api/v-ing-cg            — 列出全部素材（公开，无需密码）
 * PUT    /api/v-ing-cg            — 新增或更新一条素材（需 X-Password）
 * DELETE /api/v-ing-cg?id=<slug>  — 删除一条素材（需 X-Password）
 *
 * 数据存 D1（env.DB）的 cg_assets 表。每条素材除了文件路径，还保留生成时
 * 用的 prompt 与 style 参数，方便以后复现或做变体。
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const TABLE = 'cg_assets';
const MAX_TITLE = 120;
const MAX_TEXT = 4000;
const MAX_PATH = 300;
const ALLOWED_CATEGORIES = ['标题条', '数据卡', '角标', '指针', '转场', '其他'];

/* ---------------- rate limiting (in-memory, per isolate) ---------------- */
const rateStore = new Map();
const WINDOW_MS = 60 * 1000;
const LIMITS = { get: 120, write: 30 };

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';
}

function checkRateLimit(ip, kind) {
  const key = ip + ':' + kind;
  const now = Date.now();
  let rec = rateStore.get(key);
  if (!rec || now - rec.start > WINDOW_MS) {
    rec = { start: now, count: 0 };
    rateStore.set(key, rec);
  }
  rec.count++;
  const limit = LIMITS[kind] || 60;
  return { allowed: rec.count <= limit };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
}

function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
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

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      size TEXT,
      duration REAL,
      webm TEXT,
      frames TEXT,
      mov TEXT,
      poster TEXT,
      tags TEXT,
      prompt TEXT,
      prompt_ios TEXT,
      style TEXT,
      sort INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();

  // 老表没有 prompt_ios 列：CREATE TABLE IF NOT EXISTS 不会补列，只能单独 ADD。
  // 已存在时 SQLite 会报 duplicate column，忽略即可。
  try {
    await env.DB.prepare(`ALTER TABLE ${TABLE} ADD COLUMN prompt_ios TEXT`).run();
  } catch (e) { /* column already exists */ }
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// 文件路径只接受站内 assets/cg/ 或 https 链接，避免把任意 URL / javascript: 写进页面。
function safePath(v) {
  const s = str(v, MAX_PATH);
  if (!s) return '';
  if (/^https:\/\/[^\s]+$/i.test(s)) return s;
  if (/^assets\/cg\/[A-Za-z0-9._-]+$/.test(s)) return s;
  return '';
}

function normalize(input) {
  const id = str(input.id, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    return { error: 'Invalid id (letters, numbers, dash, underscore)' };
  }
  const title = str(input.title, MAX_TITLE);
  if (!title) return { error: 'Title is required' };

  let category = str(input.category, 20) || '其他';
  if (!ALLOWED_CATEGORIES.includes(category)) category = '其他';

  const durationRaw = input.duration;
  const duration = (durationRaw === null || durationRaw === undefined || durationRaw === '')
    ? null
    : Math.max(0, Math.min(600, Number(durationRaw) || 0));

  const sortRaw = Number(input.sort);
  const sort = Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 0;

  return {
    asset: {
      id,
      title,
      category,
      size: str(input.size, 40),
      duration,
      webm: safePath(input.webm),
      frames: safePath(input.frames),
      mov: safePath(input.mov),
      poster: safePath(input.poster),
      tags: str(input.tags, 200),
      prompt: str(input.prompt, MAX_TEXT),
      prompt_ios: str(input.prompt_ios != null ? input.prompt_ios : input.promptIos, MAX_TEXT),
      style: str(input.style, MAX_TEXT),
      sort
    }
  };
}

function rowToAsset(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    size: row.size || '',
    duration: row.duration,
    webm: row.webm || '',
    frames: row.frames || '',
    mov: row.mov || '',
    poster: row.poster || '',
    tags: row.tags || '',
    prompt: row.prompt || '',
    prompt_ios: row.prompt_ios || '',
    style: row.style || '',
    sort: row.sort || 0
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  const rl = checkRateLimit(getClientIP(request), 'get');
  if (!rl.allowed) return jsonResp({ error: 'Too many requests' }, 429, hdrs);

  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 500, hdrs);

  try {
    await ensureTable(env);
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${TABLE} ORDER BY sort ASC, created_at DESC`
    ).all();
    return jsonResp({
      assets: (results || []).map(rowToAsset),
      source: 'd1'
    }, 200, hdrs);
  } catch (err) {
    console.error('[v-ing-cg] list failed:', err && err.message);
    return jsonResp({ error: 'Read failed' }, 500, hdrs);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  const rl = checkRateLimit(getClientIP(request), 'write');
  if (!rl.allowed) return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  if (!checkPassword(request, env)) return jsonResp({ error: 'Forbidden' }, 403, hdrs);
  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 500, hdrs);

  try {
    const body = await request.json().catch(() => null);
    const input = body && body.asset;
    if (!input || typeof input !== 'object') {
      return jsonResp({ error: 'Missing asset field' }, 400, hdrs);
    }

    const normalized = normalize(input);
    if (normalized.error) return jsonResp({ error: normalized.error }, 400, hdrs);
    const a = normalized.asset;

    await ensureTable(env);
    const now = Date.now();

    // created_at 只在首次插入时写入，更新时保留原值
    await env.DB.prepare(
      `INSERT INTO ${TABLE}
         (id, title, category, size, duration, webm, frames, mov, poster, tags, prompt, prompt_ios, style, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         category = excluded.category,
         size = excluded.size,
         duration = excluded.duration,
         webm = excluded.webm,
         frames = excluded.frames,
         mov = excluded.mov,
         poster = excluded.poster,
         tags = excluded.tags,
         prompt = excluded.prompt,
         prompt_ios = excluded.prompt_ios,
         style = excluded.style,
         sort = excluded.sort,
         updated_at = excluded.updated_at`
    ).bind(
      a.id, a.title, a.category, a.size, a.duration,
      a.webm, a.frames, a.mov, a.poster,
      a.tags, a.prompt, a.prompt_ios, a.style, a.sort,
      now, now
    ).run();

    const row = await env.DB.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).bind(a.id).first();
    return jsonResp({ ok: true, asset: row ? rowToAsset(row) : a }, 200, hdrs);
  } catch (err) {
    console.error('[v-ing-cg] save failed:', err && err.message);
    return jsonResp({ error: 'Save failed' }, 500, hdrs);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  const rl = checkRateLimit(getClientIP(request), 'write');
  if (!rl.allowed) return jsonResp({ error: 'Too many requests' }, 429, hdrs);
  if (!checkPassword(request, env)) return jsonResp({ error: 'Forbidden' }, 403, hdrs);
  if (!env.DB) return jsonResp({ error: 'Database not configured' }, 500, hdrs);

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    return jsonResp({ error: 'Invalid id' }, 400, hdrs);
  }

  try {
    await ensureTable(env);
    await env.DB.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id).run();
    return jsonResp({ ok: true, id }, 200, hdrs);
  } catch (err) {
    console.error('[v-ing-cg] delete failed:', err && err.message);
    return jsonResp({ error: 'Delete failed' }, 500, hdrs);
  }
}
