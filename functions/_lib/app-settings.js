/**
 * Shared key/value settings helpers stored in D1 (env.DB).
 *
 * Used by the Vmi settings panel so the DeepSeek key can be replaced at
 * runtime without editing Cloudflare environment variables. The value never
 * leaves the server — the browser only ever receives a masked hint.
 */

const SETTINGS_TABLE = 'app_settings';
export const AI_KEY_SETTING = 'deepseek_api_key';
export const VOICE_KEY_SETTING = 'azure_speech_key';
export const VOICE_REGION_SETTING = 'azure_speech_region';

export async function ensureSettingsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();
}

export async function getSetting(env, key) {
  try {
    await ensureSettingsTable(env);
    const row = await env.DB.prepare(
      `SELECT value, updated_at FROM ${SETTINGS_TABLE} WHERE key = ?`
    ).bind(key).first();
    if (!row) return null;
    return { value: row.value, updatedAt: row.updated_at };
  } catch (e) {
    console.error('[app-settings] read failed:', e && e.message);
    return null;
  }
}

export async function setSetting(env, key, value) {
  await ensureSettingsTable(env);
  await env.DB.prepare(
    `INSERT INTO ${SETTINGS_TABLE} (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}

export async function deleteSetting(env, key) {
  await ensureSettingsTable(env);
  await env.DB.prepare(`DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`).bind(key).run();
}

// Custom key in D1 wins over the environment variable, so replacing a key
// takes effect immediately without a redeploy.
export async function resolveApiKey(env) {
  if (env.DB) {
    const stored = await getSetting(env, AI_KEY_SETTING);
    if (stored && stored.value) {
      return { key: stored.value, source: 'custom' };
    }
  }
  if (env.DEEPSEEK_API_KEY) {
    return { key: env.DEEPSEEK_API_KEY, source: 'env' };
  }
  return { key: '', source: 'none' };
}

// Azure Speech config. Key and region are stored separately because Azure
// rejects a correct key paired with the wrong region.
export async function resolveVoiceConfig(env) {
  let key = '';
  let region = '';
  let source = 'env';
  let updatedAt = null;

  if (env.DB) {
    const storedKey = await getSetting(env, VOICE_KEY_SETTING);
    if (storedKey && storedKey.value) {
      key = storedKey.value;
      source = 'custom';
      updatedAt = storedKey.updatedAt;
    }
    const storedRegion = await getSetting(env, VOICE_REGION_SETTING);
    if (storedRegion && storedRegion.value) region = storedRegion.value;
  }
  if (!key && env.AZURE_SPEECH_KEY) key = env.AZURE_SPEECH_KEY;
  if (!region && env.AZURE_SPEECH_REGION) region = env.AZURE_SPEECH_REGION;
  if (!key) source = 'none';

  return { key, region, source, updatedAt };
}
