// EdgeOne Functions middleware — HTTP Basic Auth gate for the whole site.
// Drop this file next to edgeone.json; EdgeOne auto-loads it as a request
// middleware that runs before every matched route (static assets + /api/*).
//
// Configure credentials via environment variables in the EdgeOne console:
//   SITE_USERNAME  (required)
//   SITE_PASSWORD  (required)
// If either is unset, every request is rejected with 401.

export const config = {
  matcher: ['/:path*'],
};

export async function middleware(context) {
  const { request, next, env } = context;

  const auth = request.headers.get('Authorization');

  if (!auth || !auth.startsWith('Basic ')) {
    return unauthorized();
  }

  try {
    const encoded = auth.slice(6);
    const decoded = atob(encoded);
    const separator = decoded.indexOf(':');

    if (separator === -1) {
      return unauthorized();
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (
      username !== env.SITE_USERNAME ||
      password !== env.SITE_PASSWORD
    ) {
      return unauthorized();
    }

    // Derive a stable conversation id from the authenticated identity so that
    // ALL browsers/devices logging in as the same user share ONE persistent
    // workspace/sessions. The browser's own makers-web-conversation-id (a
    // random UUID held in that browser's localStorage/cookie) would otherwise
    // strand every browser in its own isolated, empty conversation — the exact
    // symptom "switch browser and the dialogue is gone".
    const stableId = stableConversationId(username, env);
    // Keep the browser's original id around so the agent can migrate that
    // browser's previously-persisted state into the unified conversation on
    // first boot (a one-time, best-effort migration).
    const originalId = request.headers.get('makers-conversation-id') || '';
    return next({
      headers: {
        'makers-conversation-id': stableId,
        'x-makers-original-conversation-id': originalId,
        authorization: auth,
      },
    });
  } catch {
    return unauthorized();
  }
}

/**
 * FNV-1a 32-bit hash of a stable per-deployment identity → hex → a valid
 * makers-conversation-id (6-36 chars, [0-9a-zA-Z-_.]). Deterministic for a
 * given username, so every request from the same user converges on one
 * conversation regardless of browser or device.
 */
function stableConversationId(username, env) {
  const seed =
    username ||
    env.SITE_USERNAME ||
    env.AI_GATEWAY_API_KEY ||
    'pi-web-makers';
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'u' + (h >>> 0).toString(16).padStart(8, '0');
}

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Private Site"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
