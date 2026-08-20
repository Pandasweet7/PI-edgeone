import { getPiWebSidecar, scheduleSnapshot } from '../_pi-web-sidecar.ts'

function requestPath(context: any): string {
  const value = typeof context.request?.url === 'string' ? context.request.url : '/api/proxy'
  try { return new URL(value, 'http://local').pathname } catch { return '/api/proxy' }
}

/**
 * Decode a base64url-encoded proxy target. The client encodes every API path
 * with `encodeProxyTarget` (base64url) to avoid the EdgeOne CDN's %2F-in-query
 * handling, which breaks the SSL/TLS session. Falls back to URI decoding for
 * older clients that still send `encodeURIComponent` targets.
 */
function decodeTarget(raw: string): string {
  // Pure-JS base64 decoder: works in every JS runtime without depending on
  // atob / Buffer — both of which may be unavailable in sandboxed runtimes.
  const decodeBase64 = (b64: string): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let out = ''
    let buffer = 0
    let bits = 0
    for (const ch of b64) {
      if (ch === '=') break // padding terminator
      const val = chars.indexOf(ch)
      if (val < 0) continue
      buffer = (buffer << 6) | val
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out += String.fromCharCode((buffer >> bits) & 0xff)
      }
    }
    return out
  }

  // New clients send base64url; try that first.
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = decodeBase64(padded)
    if (decoded.startsWith('api/') || decoded.startsWith('./api/')) return decoded
  } catch {
    // Fall through to URI decoding for legacy targets.
  }
  // Legacy clients send encodeURIComponent(path) targets.
  try {
    const decoded = decodeURIComponent(raw)
    return decoded.startsWith('./') ? decoded.slice(2) : decoded
  } catch {
    return raw
  }
}

/**
 * PI WEB client (EdgeOne Makers build) folds every application-relative API
 * path onto this single route: `api/proxy?target=<original api/... path>`.
 * The original HTTP method, headers, and parsed JSON body are preserved, and
 * the request is forwarded to the per-conversation pi-web gateway listening on
 * 127.0.0.1. Mutating requests schedule a store snapshot afterwards.
 */
async function proxy(context: any): Promise<Response> {
  const sidecar = await getPiWebSidecar(context)

  const query = context.request?.query ?? {}
  const target = typeof query.target === 'string' ? decodeTarget(query.target) : ''
  if (!target.startsWith('api/') || target.startsWith('api/proxy')) {
    return Response.json({ error: 'Invalid proxy target' }, { status: 400 })
  }

  const upstreamUrl = new URL(target, `http://127.0.0.1:${String(sidecar.port)}`)
  // Cache-bust: CDN-level caching of the upstream URL (even with cache-control
  // headers on the response) can cause ERR_SSL_PROTOCOL_ERROR when the cached
  // body is served to a different SSL session. A unique timestamp per request
  // bypasses the CDN cache entirely.
  upstreamUrl.searchParams.set('_t', String(Date.now()))
  const urlStr = upstreamUrl.toString()
  const method = String(context.request?.method || 'GET').toUpperCase()

  const forwardedHeaders: Record<string, string> = {
    accept: context.request?.headers?.accept || '*/*',
    // Demand an uncompressed upstream response. Node's fetch negotiates gzip
    // and decompresses the body, but the content-encoding header can leak
    // through; forwarding a plain body with a gzip header kills every large
    // response at the edge (ERR_SSL_PROTOCOL_ERROR / Failed to fetch).
    'accept-encoding': 'identity',
  }
  const contentType = context.request?.headers?.['content-type']
  if (typeof contentType === 'string' && contentType !== '') forwardedHeaders['content-type'] = contentType

  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(context.request?.body ?? {})

  const upstream = await fetch(upstreamUrl, {
    method,
    headers: forwardedHeaders,
    ...(body === undefined ? {} : { body }),
  })

  // Build clean response headers instead of passing the gateway's through:
  // hop-by-hop headers (connection/keep-alive), stale content-encoding and
  // content-length from the upstream break delivery at the EdgeOne edge. The
  // body is fully buffered below, so content-type is the only upstream header
  // worth keeping.
  const contentTypeHeader = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const responseHeaders = new Headers()
  responseHeaders.set('content-type', contentTypeHeader)
  // Prevent CDN from caching dynamic responses.
  responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  responseHeaders.set('pragma', 'no-cache')
  responseHeaders.set('expires', '0')

  const isBinary = !contentTypeHeader.includes('json') && !contentTypeHeader.includes('text') && !contentTypeHeader.includes('event-stream')
  if (isBinary) responseHeaders.set('x-content-type-stream', 'true')

  if (isMutating(method) && upstream.ok) scheduleSnapshot(sidecar.conversationId, sidecar)

  const bytes = new Uint8Array(await upstream.arrayBuffer())
  return new Response(bytes, { status: upstream.status, headers: responseHeaders })
}

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH'
}

export async function onRequest(context: any): Promise<Response> {
  try {
    return await proxy(context)
  } catch (error) {
    return Response.json({
      error: 'PI_WEB_PROXY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}
