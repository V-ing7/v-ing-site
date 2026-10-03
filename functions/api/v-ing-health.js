/**
 * V-ing Site API — health check
 * GET /api/v-ing-health
 */

const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const dbOk = !!env.DB;
  return new Response(JSON.stringify({
    status: 'ok',
    database: dbOk ? 'connected' : 'not configured',
    timestamp: new Date().toISOString()
  }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...hdrs }
  });
}
