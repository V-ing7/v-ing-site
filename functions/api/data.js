/**
 * V-ing Site API — data endpoint (Cloudflare Pages Functions)
 *
 * GET  /api/data  — Read data.json (no auth)
 * PUT  /api/data  — Update data.json (requires X-Password header)
 */

const GH_REPO = 'V-ing7/v-ing-site';
const GH_FILE = 'data.json';
const GH_BRANCH = 'main';
const GH_API_BASE = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Password',
};

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  return pwd === (env.WS_PASSWORD || env.WS_PWD);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const resp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, {
      headers: {
        'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'v-ing-pages-function',
      },
    });
    if (!resp.ok) {
      return jsonResp({ error: 'GitHub API error: ' + resp.status }, 502);
    }
    const json = await resp.json();
    const binary = atob(json.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(decoded);
    return jsonResp({ sha: json.sha, data: data });
  } catch (err) {
    return jsonResp({ error: 'Read failed: ' + err.message }, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!checkPassword(request, env)) {
    return jsonResp({ error: '密码错误，写入被拒绝' }, 403);
  }
  try {
    const body = await request.json();
    const content = JSON.stringify(body.data, null, 2);
    const encoded = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
    const b64 = btoa(binary);

    let payload = {
      message: body.message || ('Update data via API - ' + new Date().toISOString()),
      content: b64,
      branch: GH_BRANCH,
    };
    if (body.sha) payload.sha = body.sha;

    const resp = await fetch(GH_API_BASE, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'v-ing-pages-function',
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 409) {
      return jsonResp({ error: 'SHA conflict (409),请重新获取 sha', conflict: true }, 409);
    }
    if (!resp.ok) {
      const errBody = await resp.text();
      return jsonResp({ error: 'GitHub API error: ' + resp.status, detail: errBody }, 502);
    }
    const json = await resp.json();
    return jsonResp({ sha: json.content ? json.content.sha : null, ok: true });
  } catch (err) {
    return jsonResp({ error: 'Write failed: ' + err.message }, 500);
  }
}
