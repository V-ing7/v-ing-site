/**
 * 微影 V-ing PWA 客户端
 * - 注册 Service Worker
 * - 订阅 SSE 实时推送
 * - 收到更新时通知 iframe 内的原网站刷新数据
 * - 离线兜底：SSE 失败时回退到 30 秒轮询
 */
(function () {
  'use strict';

  const badge = document.getElementById('sync-badge');
  const badgeText = document.getElementById('sync-text');
  const offlineBanner = document.getElementById('offline-banner');
  const iframe = document.getElementById('webview');

  let lastUpdated = null;        // 客户端持有的最新时间戳
  let sseReconnectDelay = 1000;   // 断线重连延迟（指数退避）
  let pollTimer = null;          // 兜底轮询计时器
  let badgeHideTimer = null;

  // ---------- Service Worker 注册 ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[V-ing PWA] SW 注册失败:', err);
      });
    });
  }

  // ---------- UI 辅助 ----------
  function showBadge(text, type) {
    badgeText.textContent = text;
    badge.classList.remove('live', 'warn');
    if (type === 'live') badge.classList.add('live');
    else if (type === 'warn') badge.classList.add('warn');
    badge.classList.add('show');
    clearTimeout(badgeHideTimer);
    badgeHideTimer = setTimeout(() => badge.classList.remove('show'), 3000);
  }

  function showOffline(show) {
    offlineBanner.classList.toggle('show', show);
  }

  // ---------- 通知 iframe 刷新 ----------
  // 原网站 (index.html + app.js) 暴露了 window.__vingSync() 全局函数，
  // 调用它会从 D1 拉取最新数据并刷新 UI（含编辑模式冲突处理）。
  // PWA 通过 iframe.contentWindow 直接调用，无需修改原网站代码。
  function notifyIframeUpdate(newLastUpdated) {
    lastUpdated = newLastUpdated;
    showBadge('数据已更新', 'live');
    try {
      // 优先调用原网站的同步函数
      const w = iframe.contentWindow;
      if (w && typeof w.__vingSync === 'function') {
        w.__vingSync();
      } else {
        // iframe 还没加载完成，回退到 postMessage
        w.postMessage({
          type: 'ving-remote-update',
          lastUpdated: newLastUpdated,
          source: 'sse'
        }, '*');
      }
    } catch (e) {
      // 跨域或 iframe 未就绪，静默
    }
  }

  // ---------- 兜底轮询（SSE 不可用时） ----------
  function startFallbackPolling() {
    stopFallbackPolling();
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/v-ing-data', { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return;
        const json = await res.json();
        if (json.lastUpdated && json.lastUpdated !== lastUpdated && (!lastUpdated || json.lastUpdated > lastUpdated)) {
          notifyIframeUpdate(json.lastUpdated);
        }
      } catch (e) {
        // 网络异常静默
      }
    }, 30000);
  }

  function stopFallbackPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- SSE 实时订阅 ----------
  function connectSSE() {
    const url = lastUpdated
      ? `/api/v-ing-stream?since=${encodeURIComponent(lastUpdated)}`
      : '/api/v-ing-stream';
    let es;
    try {
      es = new EventSource(url, { withCredentials: false });
    } catch (e) {
      console.warn('[V-ing PWA] SSE 不可用，启动兜底轮询');
      startFallbackPolling();
      return;
    }

    const reconnect = () => {
      if (es) { try { es.close(); } catch (e) {} }
      stopFallbackPolling();
      showBadge(`重连中 ${Math.round(sseReconnectDelay / 1000)}s`, 'warn');
      setTimeout(() => {
        sseReconnectDelay = Math.min(sseReconnectDelay * 1.5, 30000);
        connectSSE();
      }, sseReconnectDelay);
    };

    es.addEventListener('open', () => {
      sseReconnectDelay = 1000; // 重置退避
      stopFallbackPolling();
      showBadge('实时同步', 'live');
      showOffline(false);
    });

    es.addEventListener('ready', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.lastUpdated) lastUpdated = data.lastUpdated;
      } catch (err) {}
    });

    es.addEventListener('update', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.lastUpdated && data.lastUpdated !== lastUpdated) {
          notifyIframeUpdate(data.lastUpdated);
        }
      } catch (err) {}
    });

    es.addEventListener('heartbeat', () => {
      // 心跳保持连接，无操作
    });

    es.addEventListener('end', (e) => {
      // 服务端关闭，立即重连
      try { es.close(); } catch (e) {}
      setTimeout(() => connectSSE(), 500);
    });

    es.addEventListener('error', () => {
      // 浏览器会自动重连 EventSource，但保险起见做兜底
      if (es.readyState === EventSource.CLOSED) {
        reconnect();
      } else {
        // 仍在自动重连中
        showBadge('重连中', 'warn');
      }
    });

    // 监听网络离线
    window.addEventListener('offline', () => {
      showOffline(true);
      showBadge('离线', 'warn');
    });
    window.addEventListener('online', () => {
      showOffline(false);
      try { es.close(); } catch (e) {}
      connectSSE();
    });
  }

  // ---------- 监听 iframe 内的网站消息 ----------
  // 原网站（app.js）保存数据后可以通知 PWA（如果原网站支持 postMessage）
  // 这里也监听原网站加载完成后的 lastUpdated
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'ving-last-updated') {
      // 原网站告知当前 lastUpdated
      if (e.data.lastUpdated && (!lastUpdated || e.data.lastUpdated > lastUpdated)) {
        lastUpdated = e.data.lastUpdated;
      }
    }
    if (e.data.type === 'ving-saved') {
      // 原网站告知刚保存，更新本地 lastUpdated
      lastUpdated = e.data.lastUpdated || new Date().toISOString();
      showBadge('已保存', 'live');
    }
  });

  // ---------- 启动 ----------
  // 先获取一次当前 lastUpdated，再启动 SSE
  fetch('/api/v-ing-data', { headers: { 'Accept': 'application/json' } })
    .then((res) => res.json())
    .then((json) => {
      if (json.lastUpdated) lastUpdated = json.lastUpdated;
      connectSSE();
    })
    .catch(() => {
      // 网络异常也启动 SSE，让 SSE 自己处理
      connectSSE();
    });

  // iOS Safari 默认不支持 beforeinstallprompt，PWA 通过手动「添加到主屏幕」安装
  // 这里在桌面 Chrome/Edge 提示安装
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // 可以在这里显示自定义安装按钮（暂不实现）
  });

  console.log('[V-ing PWA] 启动完成，SSE 客户端已加载');
})();
