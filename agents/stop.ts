import { stableConversationId, stopPiWebSidecar } from './_pi-web-sidecar.ts'

/**
 * POST /stop — snapshot and shut down the conversation's PI WEB sidecar, then
 * abort the active agent run. The browser may also call this when the session
 * list closes; a missing sidecar is a no-op success.
 */
export async function onRequest(context: any): Promise<Response> {
  try {
    const conversationId = stableConversationId(context)
    if (!conversationId) {
      return Response.json({ ok: false, error: 'conversation_id is required' }, { status: 400 })
    }
    await stopPiWebSidecar(context, conversationId)
    try {
      await context.utils?.abortActiveRun?.(conversationId)
    } catch {
      // Best effort; the run may already be finished.
    }
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
