import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const conversations = new Map()
const store = {
  async getConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;if(!conversations.has(id)){const e=new Error('nf');e.code='MemoryNotFoundError';throw e}return conversations.get(id)},
  async updateConversation(arg){const id=typeof arg==='string'?arg:arg?.conversationId;const metadata=typeof arg==='string'?arg.metadata??{}:arg?.metadata??{};const ex=conversations.get(id)??{id,metadata:{}};ex.metadata={...ex.metadata,...metadata};conversations.set(id,ex)},
  async appendMessage(){},
}
const ctx = { conversation_id:'conv-port', env:{AI_GATEWAY_API_KEY:'k',AI_GATEWAY_BASE_URL:'https://ai-gateway.edgeone.link/v1',AI_GATEWAY_MODEL:'@makers/deepseek-v4-flash',PATH:process.env.PATH}, store, utils:{abortActiveRun:async()=>{}} }
const { getPiWebSidecar, stopPiWebSidecar, piWebHomeFor } = await import('../agents/_pi-web-sidecar.ts')
function modelsPort(home){ try { const m=JSON.parse(readFileSync(join(home,'pi-agent','models.json'),'utf8')); const b=m.providers['edgeone-makers'].baseUrl; return b.match(/:(\d+)\//)?.[1] } catch(e){ return 'ERR:'+e.message } }
function gwPort(s){ return s.gateway.baseUrl.match(/:(\d+)\//)?.[1] }
for (let i=0;i<2;i++){
  const s = await getPiWebSidecar(ctx,'conv-port')
  const mp = modelsPort(s.home), gp = gwPort(s)
  console.log(`run${i+1}: models.json port=${mp} gatewayProxy port=${gp} match=${mp===gp}`)
  await stopPiWebSidecar(ctx,'conv-port')
}
process.exit(0)
