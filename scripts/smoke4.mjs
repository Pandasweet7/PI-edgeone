// Local end-to-end of the SSE bridge: boot sidecar through the proxy route,
// create a session, then subscribe to the session-events stream via
// api/proxy-sse and read the raw SSE bytes for 15s to verify frames arrive.
const conversations = new Map()
const store = {
  async getConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;if(!conversations.has(id)){const e=new Error(`Conversation not found: ${id}`);e.code='MemoryNotFoundError';throw e}return conversations.get(id)},
  async updateConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;const metadata=typeof arg==='string'?arg.metadata??{}:arg?.metadata??{};const ex=conversations.get(id)??{id,metadata:{}};ex.metadata={...ex.metadata,...metadata};conversations.set(id,ex)},
  async appendMessage(){},
}
const abort = new AbortController()
const baseContext = { conversation_id:'conv-sse', env:{AI_GATEWAY_API_KEY:'k',AI_GATEWAY_BASE_URL:'https://ai-gateway.edgeone.link/v1',AI_GATEWAY_MODEL:'@makers/deepseek-v4-flash',PATH:process.env.PATH}, store, utils:{abortActiveRun:async()=>{}} }
const { onRequest: onRest } = await import('../agents/api/proxy.ts')
const { onRequestGet: onSse } = await import('../agents/api/proxy-sse.ts')
const { stopPiWebSidecar } = await import('../agents/_pi-web-sidecar.ts')

function ctx(method, targetPath, body, query={}) {
  return { ...baseContext, request: {
    method, url: `https://dummy/api/proxy?target=${encodeURIComponent(targetPath)}`,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'makers-conversation-id': 'conv-sse' },
    body: body ?? {}, query: { target: targetPath, ...query },
    signal: abort.signal,
  } }
}
function sseCtx(targetPath, query={}) {
  return { ...baseContext, request: {
    method: 'GET', url: `https://dummy/api/proxy-sse?target=${encodeURIComponent(targetPath)}`,
    headers: { accept: 'text/event-stream', 'makers-conversation-id': 'conv-sse' },
    body: {}, query: { target: targetPath, ...query },
    signal: abort.signal,
  } }
}
// create session
let r = await onRest(ctx('POST','api/machines/local/sessions',{cwd:'/tmp'}))
const session = await r.json()
console.log('session:', session.id, r.status)
// subscribe events stream
const sseResponse = await onSse(sseCtx(`api/machines/local/sessions/${session.id}/events?cwd=/tmp`))
console.log('sse status:', sseResponse.status, sseResponse.headers.get('content-type'))
// read for 15 seconds
const reader = sseResponse.body.getReader()
const decoder = new TextDecoder()
let buf = '', frames = 0, heartbeats = 0
const deadline = Date.now() + 15000
while (Date.now() < deadline) {
  const { value, done } = await Promise.race([reader.read(), new Promise(r=>setTimeout(()=>r({done:false,value:null}),3000))])
  if (done || value === null) { continue }
  buf += decoder.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0,i); buf = buf.slice(i+2)
    if (frame.startsWith(':')) { heartbeats++; continue }
    if (frame.startsWith('data:')) { frames++; if (frames <= 3) console.log('FRAME:', frame.slice(0,180)) }
  }
}
console.log(`frames=${frames} heartbeats=${heartbeats}`)
// fetch messages via REST to cross-check stream health
r = await onRest(ctx('GET',`api/machines/local/sessions/${session.id}/messages?cwd=/tmp`))
console.log('messages:', r.status, (await r.text()).slice(0,120))
await stopPiWebSidecar(baseContext,'conv-sse')
process.exit(0)
