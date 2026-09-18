/**
 * V-ing Site API — deploy trigger
 * POST /api/deploy (requires X-Password header)
 */

const CF_ACCOUNT_ID = 'edb10972ff8ae9f58d46aa4bdcee3fca';
const CF_PROJECT = 'v-ing-site';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!checkPassword(request, env)) {
    return jsonResp({ error: '密码错误' }, 403);
  }
  try {
    const cfBase = 'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/pages/projects/' + CF_PROJECT;
    const cfHeaders = {
      'Authorization': 'Bearer ' + (env.CF_TOKEN || env.CF_API_TOKEN),
      'Content-Type': 'application/json',
    };
    const listResp = await fetch(cfBase + '/deployments?per_page=1', { headers: cfHeaders });
    const listData = await listResp.json();
    const items = listData.result;
    if (Array.isArray(items) && items.length > 0) {
      const retryResp = await fetch(cfBase + '/deployments/' + items[0].id + '/retry', {
        method: 'POST',
        headers: cfHeaders,
      });
      const retryData = await retryResp.json();
      if (retryData.success) {
        return jsonResp({ ok: true, message: 'Deployment retried' });
      }
      return jsonResp({ error: 'CF retry failed', detail: retryData.errors }, 502);
    }
    return jsonResp({ error: 'No deployments found' }, 404);
  } catch (err) {
    return jsonResp({ error: 'Deploy failed: ' + err.message }, 500);
  }
}
