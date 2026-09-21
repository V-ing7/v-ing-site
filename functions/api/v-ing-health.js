/**
 * V-ing Site API — health check
 * GET /api/health
 */
export async function onRequestGet(context) {
  const { env } = context;
  const dbOk = !!env.DB;
  return new Response(JSON.stringify({
    status: 'ok',
    database: dbOk ? 'connected' : 'not configured',
    timestamp: new Date().toISOString()
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
