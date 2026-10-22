/**
 * Shared long-term memory helpers for the workspace AI.
 * Stored in the project's D1 database (env.DB) — no extra service required.
 */

const MAX_ROWS = 200;
const MAX_MOMENTS = 8;
const MAX_CONTENT_CHARS = 200;
const MAX_BLOCK_CHARS = 2400;

export async function ensureMemoryTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      source TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();
  // UNIQUE makes duplicate writes a no-op instead of piling up.
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_content ON ai_memory(content)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_ai_memory_updated ON ai_memory(updated_at DESC)'
  ).run();
}

export function mapRow(row) {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function loadMemories(env, limit) {
  const res = await env.DB.prepare(
    'SELECT id, content, kind, source, created_at, updated_at FROM ai_memory ORDER BY updated_at DESC LIMIT ?'
  ).bind(limit || 40).all();
  return (res.results || []).map(mapRow);
}

// Build the block injected into the system prompt. Oldest entries are dropped
// when the budget is exceeded so a long memory list cannot blow up the prompt.
export function buildMemoryBlock(rows) {
  if (!rows || !rows.length) return '';
  const lines = [];
  let used = 0;
  for (const row of rows) {
    const line = '- ' + row.content;
    if (used + line.length > MAX_BLOCK_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return '[你记得的事]\n下面是你和用户以前聊到过的信息。像老朋友一样，在真正相关的时候自然带出（例如「你上次说……」），' +
    '不要逐条复述，也不要编造没有记录的内容：\n' + lines.join('\n');
}

export async function saveMemories(env, items, source) {
  let saved = 0;
  const now = Date.now();
  for (const item of items || []) {
    if (!item || typeof item.content !== 'string') continue;
    const content = item.content.trim().slice(0, MAX_CONTENT_CHARS);
    if (content.length < 3) continue;
    const kind = ['fact', 'preference', 'profile', 'project', 'moment'].includes(item.kind)
      ? item.kind
      : 'fact';
    try {
      const res = await env.DB.prepare(
        'INSERT OR IGNORE INTO ai_memory (content, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(content, kind, source || 'auto', now, now).run();
      if (res.meta && res.meta.changes) saved++;
    } catch (e) {
      // Ignore single-item failures (e.g. duplicate races) and keep going.
    }
  }
  // Keep the table bounded — drop the least recently touched entries.
  await env.DB.prepare(
    `DELETE FROM ai_memory WHERE id NOT IN (
       SELECT id FROM ai_memory ORDER BY updated_at DESC LIMIT ${MAX_ROWS}
     )`
  ).run();
  // "What is going on right now" goes stale fast, so keep only the newest few
  // moment entries instead of letting old moods pile up.
  await env.DB.prepare(
    `DELETE FROM ai_memory WHERE kind = 'moment' AND id NOT IN (
       SELECT id FROM ai_memory WHERE kind = 'moment' ORDER BY updated_at DESC LIMIT ${MAX_MOMENTS}
     )`
  ).run();
  return saved;
}
