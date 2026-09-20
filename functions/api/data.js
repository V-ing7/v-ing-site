/**
 * V-ing Site API — data endpoint (Cloudflare Pages Functions)
 *
 * GET  /api/data          — Read data.json (no auth)
 * GET  /api/data?verify=1 — Verify password (SEC-001 fix)
 * PUT  /api/data          — Update data.json (requires X-Password header)
 * Security: Rate limiting + brute-force lockout (v4.0+) + error sanitization (v4.2)
 * Branch protection fallback: PR-based write (v4.3+)
 */

const GH_REPO = 'V-ing7/v-ing-site';
const GH_FILE = 'data.json';
const GH_BRANCH = 'main';
const GH_API_BASE = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;
const SYNC_BRANCH = 'data-sync'; // Branch for PR-based writes (bypasses branch protection)

// Security fix SEC-005: Restrict CORS to specific origins instead of wildcard
const ALLOWED_ORIGINS = [
  'https://v-ing-site.pages.dev',
  'https://v-ing7.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

function getCorsHeader(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0]; // Default to primary origin
}

function corsHeaders(request) {
  const allowOrigin = getCorsHeader(request);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Password',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
}

// --- Security: Rate Limiting & Brute-Force Protection ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;   // 1 minute
const RATE_LIMIT_MAX = 8;          // max PUT requests per minute per IP
const VERIFY_RATE_LIMIT_MAX = 10;  // max verify requests per minute per IP
const LOCKOUT_THRESHOLD = 10;      // failed attempts before lockout
const LOCKOUT_DURATION = 900000;   // 15 minutes lockout

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

function checkRateLimit(ip, maxLimit) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, failures: 0, lockedUntil: 0 };
    rateLimitMap.set(ip, record);
  }
  // Check lockout
  if (record.lockedUntil > now) {
    return { allowed: false, locked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  // Reset window if expired
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.firstAttempt = now;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  return { allowed: record.count <= (maxLimit || RATE_LIMIT_MAX), locked: false };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { count: 0, firstAttempt: now, failures: 0, lockedUntil: 0 };
    rateLimitMap.set(ip, record);
  }
  record.failures++;
  if (record.failures >= LOCKOUT_THRESHOLD) {
    record.lockedUntil = now + LOCKOUT_DURATION;
    record.failures = 0;
  }
  rateLimitMap.set(ip, record);
}

// --- Helpers ---
function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function checkPassword(request, env) {
  const pwd = request.headers.get('X-Password');
  return pwd === (env.WS_PASSWORD || env.WS_PWD);
}

function ghHeaders(env) {
  return {
    'Authorization': 'token ' + (env.GH_TOKEN || env.GITHUB_TOKEN),
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'v-ing-pages-function',
  };
}

/**
 * PR-based write fallback for branch protection (v4.3)
 * When direct commit to main fails with 409 (branch protection),
 * create/update a sync branch, commit there, and merge via PR.
 */
async function writeViaPullRequest(env, body, b64, headers, currentSha) {
  try {
    // 1. Get the latest commit SHA of main
    const mainResp = await fetch(
      'https://api.github.com/repos/' + GH_REPO + '/git/refs/heads/' + GH_BRANCH,
      { headers }
    );
    if (!mainResp.ok) return { ok: false, error: 'Cannot read main ref' };
    const mainData = await mainResp.json();
    const mainSha = mainData.object.sha;

    // 2. Check if sync branch exists
    const branchResp = await fetch(
      'https://api.github.com/repos/' + GH_REPO + '/git/refs/heads/' + SYNC_BRANCH,
      { headers }
    );

    if (branchResp.status === 404) {
      // Create the sync branch from main
      await fetch('https://api.github.com/repos/' + GH_REPO + '/git/refs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: 'refs/heads/' + SYNC_BRANCH, sha: mainSha })
      });
    } else if (branchResp.ok) {
      // Update sync branch to match main (force)
      await fetch('https://api.github.com/repos/' + GH_REPO + '/git/refs/heads/' + SYNC_BRANCH, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: mainSha, force: true })
      });
    }

    // 3. Get the SHA of data.json on the sync branch (after updating branch)
    const syncFileResp = await fetch(
      'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE + '?ref=' + SYNC_BRANCH,
      { headers }
    );
    let syncFileSha = null;
    if (syncFileResp.ok) {
      const syncFileData = await syncFileResp.json();
      syncFileSha = syncFileData.sha;
    }

    // 4. Commit the new data to the sync branch
    const commitPayload = {
      message: body.message || ('Update data via API - ' + new Date().toISOString()),
      content: b64,
      branch: SYNC_BRANCH,
    };
    if (syncFileSha) commitPayload.sha = syncFileSha;

    const commitResp = await fetch(GH_API_BASE, {
      method: 'PUT',
      headers,
      body: JSON.stringify(commitPayload),
    });

    if (!commitResp.ok) {
      const errBody = await commitResp.text();
      return { ok: false, error: 'Commit to sync branch failed: ' + commitResp.status };
    }

    const commitData = await commitResp.json();

    // 5. Check for existing open PR
    const prListResp = await fetch(
      'https://api.github.com/repos/' + GH_REPO + '/pulls?head=' + GH_REPO + ':' + SYNC_BRANCH + '&base=' + GH_BRANCH + '&state=open',
      { headers }
    );
    let prNumber = null;
    if (prListResp.ok) {
      const prList = await prListResp.json();
      if (prList.length > 0) prNumber = prList[0].number;
    }

    // 6. Create PR if none exists
    if (!prNumber) {
      const prResp = await fetch('https://api.github.com/repos/' + GH_REPO + '/pulls', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'chore: data sync update',
          head: SYNC_BRANCH,
          base: GH_BRANCH,
          body: 'Automated data sync via Pages Function API'
        })
      });
      if (prResp.ok) {
        const prData = await prResp.json();
        prNumber = prData.number;
      }
    }

    if (!prNumber) {
      return { ok: false, error: 'Cannot create PR' };
    }

    // 7. Wait for PR to be mergeable (GitHub needs a moment to compute mergeability)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 8. Merge the PR (squash)
    let mergeOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const mergeResp = await fetch(
        'https://api.github.com/repos/' + GH_REPO + '/pulls/' + prNumber + '/merge',
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            merge_method: 'squash',
            commit_title: body.message || 'Update data via API'
          })
        }
      );
      if (mergeResp.ok) {
        mergeOk = true;
        break;
      }
      if (mergeResp.status === 405) {
        // Not mergeable yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        break;
      }
    }

    if (!mergeOk) {
      return { ok: false, error: 'PR merge failed' };
    }

    // 9. Get the new SHA of data.json on main after merge
    const finalResp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, { headers });
    if (finalResp.ok) {
      const finalData = await finalResp.json();
      return { ok: true, sha: finalData.sha };
    }

    return { ok: true, sha: commitData.content ? commitData.content.sha : null };
  } catch (err) {
    return { ok: false, error: 'PR workflow error' };
  }
}

export async function onRequestOptions(context) {
  const { request } = context;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);

  // Security fix SEC-001: Password verification endpoint
  const url = new URL(request.url);
  if (url.searchParams.get('verify') === '1') {
    const clientIP = getClientIP(request);
    const rl = checkRateLimit(clientIP, VERIFY_RATE_LIMIT_MAX);
    if (rl.locked) {
      return jsonResp({
        error: 'IP locked',
        locked: true,
        retryAfter: rl.retryAfter,
      }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
    }
    if (!rl.allowed) {
      return jsonResp({ error: 'Rate limited' }, 429, hdrs);
    }
    if (checkPassword(request, env)) {
      return jsonResp({ ok: true }, 200, hdrs);
    }
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Invalid password' }, 403, hdrs);
  }

  // Normal data read
  try {
    const resp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, {
      headers: ghHeaders(env),
    });
    if (!resp.ok) {
      // Security fix SEC-004: Sanitize error message — don't leak upstream status
      return jsonResp({ error: 'Failed to read data' }, 502, hdrs);
    }
    const json = await resp.json();
    const binary = atob(json.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(decoded);
    return jsonResp({ sha: json.sha, data: data }, 200, hdrs);
  } catch (err) {
    // Security fix SEC-004: Don't leak internal error details
    return jsonResp({ error: 'Internal error' }, 500, hdrs);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const hdrs = corsHeaders(request);
  const clientIP = getClientIP(request);

  // Security: Rate limit check
  const rl = checkRateLimit(clientIP);
  if (rl.locked) {
    return jsonResp({
      error: 'IP locked',
      locked: true,
      retryAfter: rl.retryAfter,
    }, 429, { ...hdrs, 'Retry-After': String(rl.retryAfter) });
  }
  if (!rl.allowed) {
    return jsonResp({ error: 'Rate limited' }, 429, hdrs);
  }

  // Password check
  if (!checkPassword(request, env)) {
    recordFailedAttempt(clientIP);
    return jsonResp({ error: 'Invalid password' }, 403, hdrs);
  }

  try {
    const body = await request.json();
    const content = JSON.stringify(body.data, null, 2);
    const encoded = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
    const b64 = btoa(binary);

    const headers = ghHeaders(env);

    let payload = {
      message: body.message || ('Update data via API - ' + new Date().toISOString()),
      content: b64,
      branch: GH_BRANCH,
    };
    if (body.sha) payload.sha = body.sha;

    // Try direct commit to main first
    const resp = await fetch(GH_API_BASE, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });

    if (resp.status === 409) {
      // Check if SHA matches (branch protection) or is stale
      const currentFileResp = await fetch(GH_API_BASE + '?ref=' + GH_BRANCH, { headers });
      if (currentFileResp.ok) {
        const currentFile = await currentFileResp.json();
        if (currentFile.sha === body.sha) {
          // SHA matches — it's branch protection, use PR workflow
          const prResult = await writeViaPullRequest(env, body, b64, headers, currentFile.sha);
          if (prResult.ok) {
            return jsonResp({ sha: prResult.sha, ok: true, viaPR: true }, 200, hdrs);
          }
        }
      }
      // SHA mismatch or PR workflow failed
      return jsonResp({ error: 'SHA conflict, please re-fetch', conflict: true }, 409, hdrs);
    }
    if (!resp.ok) {
      // Security fix SEC-004: Don't leak upstream response body
      return jsonResp({ error: 'Failed to update data' }, 502, hdrs);
    }
    const json = await resp.json();
    return jsonResp({ sha: json.content ? json.content.sha : null, ok: true }, 200, hdrs);
  } catch (err) {
    // Security fix SEC-004: Don't leak internal error details
    return jsonResp({ error: 'Internal error' }, 500, hdrs);
  }
}
