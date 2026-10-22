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
 *
 * LONG-TERM MEMORY:
 *   - Stored in D1 (env.DB), loaded into the system prompt on every turn.
 *   - New stable facts are distilled from user messages in the background
 *     via context.waitUntil, so streaming latency is unaffected.
 */

import {
  ensureMemoryTable,
  loadMemories,
  buildMemoryBlock,
  saveMemories
} from '../_lib/ai-memory.js';
import { resolveApiKey } from '../_lib/app-settings.js';

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ALLOWED_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
const DEFAULT_SYSTEM_PROMPT =
  '你叫 Vmi，是「微影 V-ing」影视创作工作室的 AI 助手，负责协助创作计划、脚本、分镜、文案与日常影视制作问题。默认使用中文。' +
  '你和用户是熟识的朋友关系：说话自然、有温度，不客套，回答仍然简洁、具体、可执行。' +
  '如果对话里给出了长期记忆，那就是你本来就知道的事——在真正相关的时候像老朋友一样自然带出（例如「你上次说……」），不要逐条罗列、不要生硬复述；记忆里没有的事不要假装记得，可以直接问。';

// Interface-control tools. Definitions live on the server so the browser can
// only ask for a boolean flag — it cannot inject arbitrary tool schemas.
// Execution still happens client-side against a strict whitelist.
const DEFAULT_SYSTEM_PROMPT_WITH_TOOLS = DEFAULT_SYSTEM_PROMPT +
  ' 你还可以直接操作网站界面：切换页面、切换工作台标签、切换深浅主题、切换中英文、滚动页面，以及修改主播日报（更新拍摄/剪辑数量、修改主播名字、新增或删除主播）。' +
  '当用户的要求属于这些操作时，必须先调用对应的工具，再简短说明结果；不要在没有调用工具的情况下声称已经完成操作。' +
  '主播日报位于「工作台 → 日报」标签页，修改后会自动保存。';

const VIEWS = ['home', 'about', 'works', 'links', 'workspace', 'contact'];
const WS_TABS = ['plan', 'unified', 'storyboard', 'console', 'agent', 'card', 'settings'];
const VIEW_LABELS = {
  home: '首页', about: '关于', works: '作品', links: '联动', workspace: '工作台', contact: '联系'
};
const TAB_LABELS = {
  plan: '计划表', unified: '日报', storyboard: '摄影表', console: '指令', agent: '智能体', card: '名片',
  settings: '设置'
};

// Tell the model what the UI currently looks like so it does not fire a tool
// call for a state that is already in place.
function buildPageStateLine(state, toolsEnabled) {
  if (!toolsEnabled || !state || typeof state !== 'object') return '';
  const parts = [];
  if (VIEWS.includes(state.view)) parts.push('页面=' + (VIEW_LABELS[state.view] || state.view));
  if (WS_TABS.includes(state.tab)) parts.push('工作台标签=' + (TAB_LABELS[state.tab] || state.tab));
  if (state.theme === 'dark' || state.theme === 'light') parts.push('主题=' + (state.theme === 'dark' ? '深色' : '浅色'));
  if (state.lang === 'zh' || state.lang === 'en') parts.push('语言=' + (state.lang === 'zh' ? '中文' : '英文'));
  let line = '当前界面状态：' + parts.join('，') +
    '。如果用户要求的界面变化与当前状态已经一致，不要调用工具，直接简短说明即可。';
  if (state.streamers && typeof state.streamers === 'object') {
    const list = Object.entries(state.streamers)
      .map(([k, v]) => `${v.name || k}（拍摄 ${v.shoot ?? '?'} / 剪辑 ${v.edit ?? '?'}）`)
      .join('、');
    line += '\n当前主播日报：' + list + '。';
  }
  return line;
}

// Distils durable facts from what the user said. Runs out-of-band, after every
// turn, so the user never has to say "remember this".
const MEMORY_EXTRACT_PROMPT =
  '你是朋友之间的记忆整理器。从「最近用户消息」里挑出能让下次聊天自然接上的信息：怎么称呼用户、他最近的状态或情绪、正在做的事与项目进展、喜好和忌讳、约好的事或他托付的事，以及他明确要求记住的内容。' +
  '不要记录寒暄、天气、一次性数字、密码或证件号等敏感信息，也不要记录助手说过的话。' +
  '「已有记忆」里含义相同的不要重复输出；若新信息推翻了旧的，输出更新后的版本。' +
  '每条用第三人称陈述，像给朋友写的备注一样简短，不超过 60 字。' +
  'kind 取值：profile（身份/称呼）、preference（喜好与忌讳）、project（正在做的事）、moment（近况与情绪）、fact（其他）。' +
  '只输出 JSON：{"memories":[{"content":"...","kind":"profile|preference|project|moment|fact"}]}；没有可记的就输出 {"memories":[]}。';

const ALLOWED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: '切换到网站的某个页面视图。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: VIEWS, description: '目标页面：home 首页、about 关于、works 作品、links 联动、workspace 工作台、contact 联系' }
        },
        required: ['view']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_tab',
      description: '在工作台中切换到某个标签页（会同时把页面切到工作台）。',
      parameters: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: WS_TABS, description: 'plan 计划表、unified 日报、storyboard 摄影表、console 指令、agent 智能体、card 名片、settings 设置' }
        },
        required: ['tab']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_theme',
      description: '切换网站的深浅色主题。',
      parameters: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['dark', 'light'], description: 'dark 深色，light 浅色' }
        },
        required: ['theme']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_language',
      description: '切换网站界面语言。',
      parameters: {
        type: 'object',
        properties: {
          lang: { type: 'string', enum: ['zh', 'en'], description: 'zh 中文，en 英文' }
        },
        required: ['lang']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll_to',
      description: '在当前页面滚动到顶部或底部。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['top', 'bottom'], description: 'top 顶部，bottom 底部' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_streamer',
      description: '修改主播日报：更新某位主播的拍摄/剪辑数量、修改名字、新增或删除主播。修改前会自动保存快照以便撤销。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set_count', 'rename', 'add', 'remove'], description: 'set_count 修改数字；rename 修改名字；add 新增主播；remove 删除主播' },
          name: { type: 'string', description: '主播当前名字（add 时表示新主播名字）' },
          field: { type: 'string', enum: ['shoot', 'edit'], description: 'set_count 时指定 shoot 拍摄或 edit 剪辑' },
          value: { type: 'number', description: 'set_count 时的新数值' },
          newName: { type: 'string', description: 'rename 时指定新名字' }
        },
        required: ['action', 'name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undo_streamer_change',
      description: '撤销最近一次 AI 对主播日报的修改，最多可撤销 10 次。'
    }
  }
];

// --- Limits ---
const RATE_WINDOW = 60000;      // 60s window
const RATE_LIMIT = 12;          // 12 requests / minute / IP
const MAX_BODY_BYTES = 200000;  // ~200KB request body
const MAX_MESSAGES = 60;        // includes assistant tool_calls + tool results
const MAX_MESSAGE_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;
const MAX_TOOL_CALLS = 6;

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

    // Tool result produced by the browser after executing a whitelisted action.
    if (role === 'tool') {
      if (typeof item.tool_call_id !== 'string' || !item.tool_call_id) {
        return { error: 'Invalid tool message' };
      }
      const content = typeof item.content === 'string' ? item.content : '';
      if (content.length > MAX_MESSAGE_CHARS) return { error: 'Message too long' };
      totalChars += content.length;
      messages.push({ role: 'tool', tool_call_id: item.tool_call_id, content });
      continue;
    }

    // Assistant turn that requested tools. Content may legitimately be empty.
    if (role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      if (item.tool_calls.length > MAX_TOOL_CALLS) return { error: 'Too many tool calls' };
      const calls = [];
      for (const tc of item.tool_calls) {
        if (!tc || tc.type !== 'function' || !tc.function) return { error: 'Invalid tool call' };
        const name = tc.function.name;
        const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}';
        if (typeof name !== 'string' || !name || name.length > 64) return { error: 'Invalid tool call' };
        if (args.length > 2000) return { error: 'Tool arguments too long' };
        calls.push({ id: String(tc.id || ''), type: 'function', function: { name, arguments: args } });
      }
      const content = typeof item.content === 'string' ? item.content : '';
      totalChars += content.length;
      messages.push({ role: 'assistant', content, tool_calls: calls });
      continue;
    }

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

  const toolsEnabled = body.tools_enabled === true;

  // Always keep a server-owned system prompt at the top unless the client
  // already supplied one.
  if (messages[0].role !== 'system') {
    let systemContent = toolsEnabled ? DEFAULT_SYSTEM_PROMPT_WITH_TOOLS : DEFAULT_SYSTEM_PROMPT;
    const stateLine = buildPageStateLine(body.page_state, toolsEnabled);
    if (stateLine) systemContent += '\n\n' + stateLine;
    messages.unshift({ role: 'system', content: systemContent });
  }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'deepseek-chat';
  return {
    messages,
    model,
    stream: true,
    toolsEnabled,
    temperature: clampNumber(body.temperature, 0, 1.5, 1),
    max_tokens: clampNumber(body.max_tokens, 1, 4096, 2048)
  };
}

async function extractMemories(env, apiKey, userText, existingBlock) {
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: MEMORY_EXTRACT_PROMPT },
          {
            role: 'user',
            content: '已有记忆：\n' + (existingBlock || '（无）') +
                     '\n\n最近用户消息：\n' + userText
          }
        ],
        stream: false,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) {
      console.error('[v-ing-ai] memory extract upstream', res.status);
      return;
    }
    const json = await res.json();
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    if (!content) return;
    const parsed = JSON.parse(content);
    const items = Array.isArray(parsed.memories) ? parsed.memories : [];
    if (items.length) await saveMemories(env, items.slice(0, 6), 'auto');
  } catch (e) {
    console.error('[v-ing-ai] memory extract failed:', e && e.message);
  }
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
  const resolvedKey = await resolveApiKey(env);
  if (!resolvedKey.key) {
    return jsonResp({ error: 'AI not configured' }, 503, hdrs);
  }
  const apiKey = resolvedKey.key;

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

  // Load long-term memory into the system prompt. Failures are non-fatal:
  // the assistant still works, it just answers without stored context.
  let memoryBlock = '';
  if (env.DB) {
    try {
      await ensureMemoryTable(env);
      const rows = await loadMemories(env, 60);
      memoryBlock = buildMemoryBlock(rows);
    } catch (e) {
      console.error('[v-ing-ai] memory load failed:', e && e.message);
    }
  }
  if (memoryBlock && payload.messages[0] && payload.messages[0].role === 'system') {
    payload.messages[0].content += '\n\n' + memoryBlock;
  }

  let upstream;
  try {
    const upstreamBody = {
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream,
      temperature: payload.temperature,
      max_tokens: payload.max_tokens
    };
    if (payload.toolsEnabled) {
      upstreamBody.tools = ALLOWED_TOOLS;
      upstreamBody.tool_choice = 'auto';
    }
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    console.error('[v-ing-ai] upstream fetch failed:', e && e.message);
    return jsonResp({ error: 'Upstream unavailable' }, 502, hdrs);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('[v-ing-ai] upstream', upstream.status, detail.slice(0, 500));
    // 401/403 means the stored key is invalid or revoked — surface it as a
    // configuration problem so the settings panel can be pointed at.
    if (upstream.status === 401 || upstream.status === 403) {
      return jsonResp({ error: 'Invalid key' }, 503, hdrs);
    }
    // Do not leak upstream error bodies (may contain key/quota details).
    return jsonResp({ error: 'Upstream error' }, 502, hdrs);
  }

  // Distil durable facts from this turn in the background. waitUntil keeps it
  // off the response path, so the stream is not delayed and a failure here
  // never affects the chat.
  if (env.DB && typeof context.waitUntil === 'function') {
    const recentUserText = payload.messages
      .filter(function (m) { return m.role === 'user'; })
      .slice(-4)
      .map(function (m) { return m.content; })
      .join('\n---\n')
      .slice(0, 2000);
    if (recentUserText) {
      context.waitUntil(extractMemories(env, apiKey, recentUserText, memoryBlock));
    }
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
