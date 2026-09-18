/**
 * V-ing Site API — health check
 * GET /api/health
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const env = context && context.env ? context.env : {};
  return new Response(JSON.stringify({
    ok: true,
    service: 'v-ing-pages-api',
    envKeys: Object.keys(env),
    hasGH: !!env.GH_TOKEN,
    hasWS: !!env.WS_PASSWORD,
    hasCF: !!env.CF_TOKEN,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
