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

// TTS voices allowed by the synthesis endpoint. 101xxx premium voices are
// covered by the 800 万字符 free pack; 5xxxxx/6xxxxx LLM and 4xxxxx/5xxxxx/
// 60xxxxx super-natural LLM voices bill separately at LLM rates.
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
  { id: 101021, name: '智瑞', desc: '新闻男声 · 成熟稳重' },
  { id: 101019, name: '智彤', desc: '粤语女声 · 粤语内容' },
  { id: 101054, name: '智友', desc: '通用男声 · 平实可靠' },
  { id: 101015, name: '智萌', desc: '男童声 · 活泼可爱' },
  { id: 101050, name: 'WeJack', desc: '英文男声 · 纯英文内容' },
  { id: 501001, name: '智兰', desc: '大模型资讯女声 · 播报自然' },
  { id: 501002, name: '智菊', desc: '大模型阅读女声 · 适合长文' },
  { id: 501004, name: '月华', desc: '大模型聊天女声 · 亲切自然' },
  { id: 601009, name: '爱小芊', desc: '大模型聊天女声 · 情感丰富' },
  { id: 601010, name: '爱小娇', desc: '大模型聊天女声 · 娇俏活泼' },
  { id: 601012, name: '爱小璟', desc: '大模型特色女声 · 辨识度高' },
  { id: 601013, name: '爱小伊', desc: '大模型阅读女声 · 温柔安静' },
  { id: 501009, name: 'WeWinny', desc: '大模型外语女声 · 纯英文' },
  { id: 501000, name: '智斌', desc: '大模型阅读男声 · 适合长文' },
  { id: 501003, name: '智宇', desc: '大模型阅读男声 · 沉稳清晰' },
  { id: 501005, name: '飞镜', desc: '大模型聊天男声 · 自然随性' },
  { id: 501006, name: '千嶂', desc: '大模型聊天男声 · 低沉磁性' },
  { id: 501007, name: '浅草', desc: '大模型聊天男声 · 清爽干净' },
  { id: 601008, name: '爱小豪', desc: '大模型聊天男声 · 情感丰富' },
  { id: 601011, name: '爱小川', desc: '大模型聊天男声 · 阳光随和' },
  { id: 601014, name: '爱小简', desc: '大模型聊天男声 · 简洁干练' },
  { id: 501008, name: 'WeJames', desc: '大模型外语男声 · 纯英文' },
  { id: 402001, name: '云小团', desc: '超自然甜美女声 · 温柔撒娇' },
  { id: 402000, name: '云晓芙', desc: '超自然聊天女声 · 自然对话' },
  { id: 403001, name: '云小和', desc: '超自然聊天女声 · 轻松亲和' },
  { id: 502001, name: '智小柔', desc: '超自然聊天女声 · 温柔细腻' },
  { id: 502003, name: '智小敏', desc: '超自然聊天女声 · 机敏利落' },
  { id: 502004, name: '智小满', desc: '超自然营销女声 · 热情活力' },
  { id: 602003, name: '爱小悠', desc: '超自然聊天女声 · 悠然治愈' },
  { id: 602005, name: '专业梓欣', desc: '超自然聊天女声 · 专业大方' },
  { id: 603001, name: '潇湘妹妹', desc: '超自然特色女声 · 江南婉约' },
  { id: 603004, name: '温柔小柠', desc: '超自然聊天女声 · 清新温柔' },
  { id: 603007, name: '邻家女孩', desc: '超自然聊天女声 · 邻家亲切' },
  { id: 403005, name: '云雅琴', desc: '超自然女老师 · 沉稳知性' },
  { id: 403000, name: '云小朵', desc: '超自然女童声 · 天真烂漫' },
  { id: 603002, name: '软萌心心', desc: '超自然男童声 · 软萌可爱' },
  { id: 403008, name: '云小洋', desc: '超自然机灵男童 · 调皮灵动' },
  { id: 502007, name: '智小虎', desc: '超自然聊天童声 · 元气十足' },
  { id: 403006, name: 'YunMia', desc: '超自然美音女助手 · 中英双语' },
  { id: 402002, name: '云大围', desc: '超自然磁性男声 · 低沉有质感' },
  { id: 403002, name: '云小帅', desc: '超自然解说男声 · 磁性解说' },
  { id: 403003, name: '云小天', desc: '超自然校园男声 · 青春阳光' },
  { id: 403004, name: '云大川', desc: '超自然男老师 · 活力开朗' },
  { id: 502005, name: '智小解', desc: '超自然解说男声 · 热血激昂' },
  { id: 502006, name: '智小悟', desc: '超自然聊天男声 · 沉稳智慧' },
  { id: 602004, name: '暖心阿灿', desc: '超自然聊天男声 · 暖心大叔' },
  { id: 603000, name: '懂事少年', desc: '超自然特色男声 · 阳光少年' },
  { id: 603003, name: '随和老李', desc: '超自然聊天男声 · 随和幽默' },
  { id: 603005, name: '知心大林', desc: '超自然聊天男声 · 知心大哥' },
  { id: 603006, name: '沉稳青叔', desc: '超自然聊天男声 · 沉稳磁性' },
  { id: 403007, name: 'YunLeo', desc: '超自然美音男助手 · 中英双语' }
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
