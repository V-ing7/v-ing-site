/**
 * V-ing Site API — SSE 实时数据流
 * GET /api/v-ing-stream?since=ISO_TIMESTAMP
 *
 * 客户端建立长连接，服务端每 5 秒查一次 D1，
 * 若 last_updated 比 since 新则推送 update 事件。
 * 单连接最长 25 秒后关闭，客户端自动重连（EventSource 原生支持）。
 *
 * D1 binding: env.DB（与 v-ing-data.js 共用）
 * 不需要密码（只读 last_updated 和 content 字段）。
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const POLL_INTERVAL_MS = 5000;   // 5 秒轮询一次 D1
const MAX_LIFETIME_MS = 25000;   // 单连接最长 25 秒（Cloudflare Workers 限制 30 秒）

function corsOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

async function fetchD1Snapshot(env) {
  const result = await env.DB.prepare(
    'SELECT content, last_updated FROM site_data WHERE id = 1'
  ).first();
  if (!result) return null;
  return {
    lastUpdated: result.last_updated,
    content: result.content
  };
}

export async function onRequestOptions(context) {
  const { request } = context;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin(request),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '';
  const origin = corsOrigin(request);

  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
    });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        if (closed) return;
        try {
          const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(msg));
        } catch (e) {
          // controller 已关闭
        }
      };

      // 立即查一次并发初始状态
      try {
        const snap = await fetchD1Snapshot(env);
        if (snap) {
          const dataLastUpdated = snap.lastUpdated;
          const shouldPush = !since || dataLastUpdated > since;
          if (shouldPush) {
            send('update', {
              lastUpdated: dataLastUpdated,
              source: 'd1',
              timestamp: Date.now()
            });
          } else {
            send('ready', { lastUpdated: dataLastUpdated, since: since });
          }
        } else {
          send('ready', { lastUpdated: null, since: since });
        }
      } catch (e) {
        send('error', { message: 'Initial fetch failed' });
      }

      // 轮询循环（async loop）
      const startTime = Date.now();
      let lastSentUpdate = null;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // 客户端断开时清理
      try {
        request.signal?.addEventListener('abort', () => {
          closed = true;
          try { controller.close(); } catch (e) {}
        });
      } catch (e) {}

      // 启动轮询循环（不 await，让 start 立即返回）
      (async () => {
        while (!closed) {
          await sleep(POLL_INTERVAL_MS);
          if (closed) break;
          if (Date.now() - startTime > MAX_LIFETIME_MS) {
            send('end', { reason: 'lifetime', lastUpdated: lastSentUpdate });
            try { controller.close(); } catch (e) {}
            closed = true;
            break;
          }
          try {
            const snap = await fetchD1Snapshot(env);
            if (snap) {
              const dataLastUpdated = snap.lastUpdated;
              if (dataLastUpdated && (!since || dataLastUpdated > since) && dataLastUpdated !== lastSentUpdate) {
                send('update', {
                  lastUpdated: dataLastUpdated,
                  source: 'd1',
                  timestamp: Date.now()
                });
                lastSentUpdate = dataLastUpdated;
              } else {
                send('heartbeat', { time: Date.now() });
              }
            }
          } catch (e) {
            send('heartbeat', { time: Date.now(), error: 'poll failed' });
          }
        }
      })();
    },
    cancel() {
      closed = true;
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin
    }
  });
}
