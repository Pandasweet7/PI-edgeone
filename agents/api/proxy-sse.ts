import WebSocket from 'ws'
import { getPiWebSidecar } from '../_pi-web-sidecar.ts'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
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
  const target = typeof query.target === 'string' ? decodeURIComponent(query.target) : ''
  const conversationFromQuery = typeof query.conversation === 'string' ? query.conversation : ''
  const conversationId = conversationFromQuery || String(context.conversation_id || '').trim()
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
            }, 20_000)
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
