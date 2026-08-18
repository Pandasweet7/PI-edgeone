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

    return next();
  } catch {
    return unauthorized();
  }
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
