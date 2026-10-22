/**
 * Shared key/value settings helpers stored in D1 (env.DB).
 *
 * Used by the Vmi settings panel so the DeepSeek key can be replaced at
 * runtime without editing Cloudflare environment variables. The value never
 * leaves the server — the browser only ever receives a masked hint.
 */

const SETTINGS_TABLE = 'app_settings';
export const AI_KEY_SETTING = 'deepseek_api_key';

// Tencent Cloud TTS config. SecretId and SecretKey are stored separately so
// either half can be replaced without retyping the other.
export const TTS_SECRET_ID_SETTING = 'tencent_tts_secret_id';
export const TTS_SECRET_KEY_SETTING = 'tencent_tts_secret_key';
export const TTS_REGION_SETTING = 'tencent_tts_region';
export const TTS_VOICE_SETTING = 'tencent_tts_voice';

export const TTS_DEFAULT_REGION = 'ap-guangzhou';
export const TTS_DEFAULT_VOICE = 101001;

// 精品音色（中文）— covered by the 800 万字符 free pack in the TTS console.
export const TTS_VOICES = [
  { id: 101001, name: '智瑜', desc: '情感女声 · 温暖自然，最接近小爱' },
  { id: 101011, name: '智燕', desc: '新闻女声 · 清晰、播报感' },
  { id: 101027, name: '智梅', desc: '通用女声 · 平稳亲和' },
  { id: 101026, name: '智希', desc: '通用女声 · 语气轻快' },
  { id: 101055, name: '智付', desc: '通用女声 · 干净利落' },
  { id: 101016, name: '智甜', desc: '女童声 · 小女孩音色' },
  { id: 101004, name: '智云', desc: '通用男声 · 沉稳' },
  { id: 101030, name: '智柯', desc: '通用男声 · 日常口语' },
  { id: 101013, name: '智辉', desc: '新闻男声 · 专业播音' },
  { id: 101021, name: '智瑞', desc: '新闻男声 · 成熟稳重' }
];

export const TTS_VOICE_IDS = TTS_VOICES.map(v => v.id);

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

// Tencent Cloud TTS config. A pair stored in D1 wins over the environment;
// half a pair is discarded rather than mixed with the env pair, because a
// SecretId from one account never validates against another account's key.
export async function resolveVoiceConfig(env) {
  let secretId = '';
  let secretKey = '';
  let region = '';
  let voiceId = '';
  let source = 'env';
  let updatedAt = null;

  if (env.DB) {
    const rows = await Promise.all([
      getSetting(env, TTS_SECRET_ID_SETTING),
      getSetting(env, TTS_SECRET_KEY_SETTING),
      getSetting(env, TTS_REGION_SETTING),
      getSetting(env, TTS_VOICE_SETTING)
    ]);
    if (rows[0] && rows[0].value) {
      secretId = rows[0].value;
      source = 'custom';
      updatedAt = rows[0].updatedAt;
    }
    if (rows[1] && rows[1].value) secretKey = rows[1].value;
    if (rows[2] && rows[2].value) region = rows[2].value;
    if (rows[3] && rows[3].value) voiceId = rows[3].value;
    if ((secretId && !secretKey) || (!secretId && secretKey)) {
      secretId = '';
      secretKey = '';
    }
  }

  if (!secretId && env.TENCENT_TTS_SECRET_ID && env.TENCENT_TTS_SECRET_KEY) {
    secretId = env.TENCENT_TTS_SECRET_ID;
    secretKey = env.TENCENT_TTS_SECRET_KEY;
    source = 'env';
  }

  if (!region) region = env.TENCENT_TTS_REGION || TTS_DEFAULT_REGION;
  if (!voiceId) voiceId = env.TENCENT_TTS_VOICE || '';

  const parsed = parseInt(voiceId, 10);
  const voice = TTS_VOICE_IDS.includes(parsed) ? parsed : TTS_DEFAULT_VOICE;

  return {
    secretId,
    secretKey,
    region,
    voiceId: voice,
    source: (secretId && secretKey) ? source : 'none',
    updatedAt,
    hasKey: !!(secretId && secretKey)
  };
}
