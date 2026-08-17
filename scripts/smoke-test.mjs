/**
 * Local smoke test for the Makers sidecar (no EdgeOne account required).
 *
 * Mocks the Makers `context` (conversation id, env, store) and drives the real
 * agents/_pi-web-sidecar.ts: it spawns the vendored pi-web gateway + sessiond,
 * seeds models.json, and exercises the REST proxy path against the gateway.
 *
 *   node --experimental-strip-types scripts/smoke-test.mjs
 */
import { mkdir, rm } from 'node:fs/promises'

// ── mock context.store (in-memory conversation memory) ────────────────────
const conversations = new Map()
const store = {
  async getConversation(arg) {
    const id = typeof arg === 'string' ? arg : arg?.conversationId
    if (!conversations.has(id)) {
      const error = new Error(`Conversation not found: ${id}`)
      error.code = 'MemoryNotFoundError'
      throw error
    }
    return conversations.get(id)
  },
  async updateConversation(arg) {
    const id = typeof arg === 'string' ? arg : arg?.conversationId
    const metadata = typeof arg === 'string' ? arg.metadata ?? {} : arg?.metadata ?? {}
    const existing = conversations.get(id) ?? { id, metadata: {} }
    existing.metadata = { ...existing.metadata, ...metadata }
    conversations.set(id, existing)
  },
  async appendMessage(arg) {
    const id = typeof arg === 'string' ? arg : arg?.conversationId
    if (!conversations.has(id)) conversations.set(id, { id, metadata: {} })
  },
}

const context = {
  conversation_id: 'smoke-conv-123',
  env: {
    AI_GATEWAY_API_KEY: 'test-gateway-key',
    AI_GATEWAY_BASE_URL: 'https://ai-gateway.edgeone.link/v1',
    AI_GATEWAY_MODEL: '@makers/deepseek-v4-flash',
    ANTHROPIC_API_KEY: 'placeholder-for-tests-only',
    OPENAI_API_KEY: 'placeholder-for-tests-only',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  },
  store,
  request: { headers: {}, method: 'GET', url: '/api/proxy', query: {} },
  utils: { abortActiveRun: async () => { console.log('  [mock] abortActiveRun called') } },
}

const { getPiWebSidecar, stopPiWebSidecar } = await import('../agents/_pi-web-sidecar.ts')

async function main() {
  console.log('== smoke: start sidecar ==')
  const sidecar = await getPiWebSidecar(context)
  console.log(`  sidecar up: home=${sidecar.home} port=${sidecar.port}`)

  // ── verify models.json was seeded with the edgeone-makers provider ───────
  const { readFile } = await import('node:fs/promises')
  const models = JSON.parse(await readFile(`${sidecar.home}/pi-agent/models.json`, 'utf8'))
  const provider = models.providers?.['edgeone-makers']
  if (!provider) throw new Error('models.json missing edgeone-makers provider')
  console.log(`  models.json: edgeone-makers baseUrl=${provider.baseUrl} models=${provider.models.length}`)
  if (!provider.baseUrl.includes(String(sidecar.gateway.baseUrl))) throw new Error('provider baseUrl does not point at gateway')

  // ── verify the gateway is actually reachable ─────────────────────────────
  const status = await fetch(`http://127.0.0.1:${sidecar.port}/api/pi-web/status`)
  if (!status.ok) throw new Error(`gateway status ${status.status}`)
  const statusJson = await status.json()
  const webAvailable = statusJson.components?.web?.available
  const sessiondAvailable = statusJson.components?.sessiond?.available
  console.log(`  gateway /api/pi-web/status: web=${webAvailable} sessiond=${sessiondAvailable}`)

  // ── exercise the REST proxy path (list sessions via the gateway) ────────
  const sessions = await fetch(`http://127.0.0.1:${sidecar.port}/api/machines/local/sessions`, {
    headers: { accept: 'application/json' },
  })
  console.log(`  gateway GET /api/machines/local/sessions -> ${sessions.status}`)

  // ── snapshot round-trip: capture, store, restore into a fresh home ──────
  const { captureSnapshot, writeSnapshotToStore, readSnapshotFromStore, restoreSnapshot } = await import('../agents/_store.ts')
  const snapshot = await captureSnapshot(sidecar.home)
  await writeSnapshotToStore(context, 'smoke-conv-123', snapshot)
  const restored = await readSnapshotFromStore(context, 'smoke-conv-123')
  console.log(`  snapshot round-trip: sessions=${Object.keys(restored.sessions).length} workspace=${Object.keys(restored.workspace).length} config=${restored.configJson !== null}`)

  const freshHome = '/tmp/piweb-smoke-restore'
  await rm(freshHome, { recursive: true, force: true })
  await mkdir(freshHome, { recursive: true })
  await restoreSnapshot(freshHome, restored)
  const restoredConfig = await readFile(`${freshHome}/pi-web/config.json`, 'utf8')
  console.log(`  restore: config.json present=${restoredConfig.length > 0}`)

  // ── stop (snapshot + kill) ──────────────────────────────────────────────
  const stopped = await stopPiWebSidecar(context, 'smoke-conv-123')
  console.log(`  stopPiWebSidecar -> ${stopped}`)
  console.log('== smoke PASSED ==')
}

main().catch(error => {
  console.error('SMOKE FAILED:', error)
  process.exit(1)
})
