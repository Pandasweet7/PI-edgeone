const conversations = new Map()
const store = {
  async getConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;if(!conversations.has(id)){const e=new Error(`Conversation not found: ${id}`);e.code='MemoryNotFoundError';throw e}return conversations.get(id)},
  async updateConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;const metadata=typeof arg==='string'?arg.metadata??{}:arg?.metadata??{};const ex=conversations.get(id)??{id,metadata:{}};ex.metadata={...ex.metadata,...metadata};conversations.set(id,ex)},
  async appendMessage(arg){const id=typeof arg==='string'?arg:arg?.conversationId;if(!conversations.has(id))conversations.set(id,{id,metadata:{}})},
}
let abort = new AbortController()
const baseContext = { conversation_id:'conv-p3', env:{AI_GATEWAY_API_KEY:'k',AI_GATEWAY_BASE_URL:'https://ai-gateway.edgeone.link/v1',AI_GATEWAY_MODEL:'@makers/deepseek-v4-flash',PATH:process.env.PATH}, store, utils:{abortActiveRun:async()=>{}} }
const { onRequest } = await import('../agents/api/proxy.ts')
const { stopPiWebSidecar } = await import('../agents/_pi-web-sidecar.ts')

function ctx(method, targetPath, body, query={}) {
  return { ...baseContext, request: {
    method, url: `https://dummy/api/proxy?target=${encodeURIComponent(targetPath)}`,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'makers-conversation-id': 'conv-p3' },
    body: body ?? {}, query: { target: targetPath, ...query },
    signal: abort.signal,
  } }
}
// GET list sessions via proxy
let r = await onRequest(ctx('GET','api/machines/local/sessions?cwd=/tmp'))
console.log('proxy GET sessions ->', r.status, (await r.text()).slice(0,500))
// POST create session via proxy (mutating -> schedules snapshot)
r = await onRequest(ctx('POST','api/machines/local/sessions',{cwd:'/tmp'}))
console.log('proxy POST session ->', r.status, (await r.text()).slice(0,120))
// wait for debounced snapshot to land in store
await new Promise(r=>setTimeout(r,4500))
const conv = conversations.get('conv-p3')
const snap = conv?.metadata?.piWebSnapshot
console.log('snapshot in store:', snap ? `yes (workspace=${Object.keys(snap.workspace||{}).length} sessions=${Object.keys(snap.sessions||{}).length})` : 'NO')
// GET via proxy again (should list created session)
r = await onRequest(ctx('GET','api/machines/local/sessions?cwd=/tmp'))
console.log('proxy GET sessions again ->', r.status, (await r.text()).slice(0,200))
await stopPiWebSidecar(baseContext,'conv-p3')
console.log('smoke3 done')
