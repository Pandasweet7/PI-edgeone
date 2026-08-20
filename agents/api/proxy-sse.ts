import WebSocket from 'ws'
import { getPiWebSidecar } from '../_pi-web-sidecar.ts'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * Decode a base64url-encoded proxy target (same as the REST proxy). The client
 * encodes every API path with `encodeProxyTarget` (base64url) to avoid the
 * EdgeOne CDN's %2F-in-query handling, which breaks the SSL/TLS session.
 * Falls back to URI decoding for older clients that still send
 * `encodeURIComponent` targets.
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

  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = decodeBase64(padded)
    if (decoded.startsWith('api/') || decoded.startsWith('./api/')) return decoded
  } catch {
    // Fall through to URI decoding for legacy targets.
  }
  try {
    const decoded = decodeURIComponent(raw)
    return decoded.startsWith('./') ? decoded.slice(2) : decoded
  } catch {
    return raw
  }
}

/**
 * EventSource endpoint for the PI WEB client event downlinks
 * (session events / global events). The Makers runtime carries server-sent
 * events but not WebSockets, so this route opens a WebSocket to the local
 * pi-web gateway for the same path and re-frames every WS frame as an SSE
 * `data:` line, with a comment heartbeat to keep the stream alive.
 */
function eventStream(context: any): Response {
  const query = context.request?.query ?? {}
  const target = typeof query.target === 'string' ? decodeTarget(query.target) : ''
  // Prefer the server-assigned conversation id (the middleware rewrites
  // makers-conversation-id to a stable per-user id). The client's `conversation`
  // query param still carries the browser's original random id, which must NOT
  // be used to key the sidecar — otherwise this SSE route would open a
  // DIFFERENT (empty) sidecar than the REST proxy and stream nothing, so the
  // whole dialogue only appears once the agent finishes.
  const conversationId = String(context.conversation_id || '').trim()
    || (typeof query.conversation === 'string' ? query.conversation : '')
  if (!conversationId || !target.startsWith('api/') || target.startsWith('api/proxy')) {
    return Response.json({ error: 'Invalid SSE target or missing conversation id' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  let socket: WebSocket | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const signal = context.request?.signal as AbortSignal | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamError = (error: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'server-request',
            rpcId: crypto.randomUUID(),
            method: 'stream/error',
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
            },
          })}\n\n`))
        } catch {
          // Browser already disconnected.
        }
        try { controller.close() } catch { /* already cancelled */ }
      }
      try {
        const sidecar = await getPiWebSidecar(context, conversationId)
        socket = new WebSocket(`ws://127.0.0.1:${String(sidecar.port)}/${target}`, {
          headers: { origin: `http://127.0.0.1:${String(sidecar.port)}` },
        })
        const close = (): void => {
          if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
        }
        signal?.addEventListener('abort', close, { once: true })
        socket.once('open', () => {
          try {
            controller.enqueue(encoder.encode(': connected\n\n'))
            heartbeat = setInterval(() => {
              try { controller.enqueue(encoder.encode(': ping\n\n')) } catch { close() }
            }, 5_000)
          } catch { close() }
        })
        socket.on('message', data => {
          try { controller.enqueue(encoder.encode(`data: ${data.toString()}\n\n`)) } catch { close() }
        })
        socket.once('error', streamError)
        socket.once('close', () => {
          if (heartbeat !== undefined) clearInterval(heartbeat)
          signal?.removeEventListener('abort', close)
          try { controller.close() } catch { /* already cancelled */ }
        })
      } catch (error) {
        streamError(error)
      }
    },
    cancel() {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}

export async function onRequestGet(context: any): Promise<Response> {
  try {
    return eventStream(context)
  } catch (error) {
    return Response.json({
      error: 'PI_WEB_SSE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}
