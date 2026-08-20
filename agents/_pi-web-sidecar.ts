import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { openSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { startLocalGatewayProxy, type LocalGatewayProxy } from './_gateway-proxy.ts'
import { reinstallMissingPackages } from './_packages.ts'
import { captureSnapshot, isSnapshotEmpty, readSnapshotFromStore, restoreSnapshot, writeSnapshotToStore, type PiWebSnapshot } from './_store.ts'

// Side-effect import of the vendored package name: EdgeOne's agent dependency
// sync only ships packages reachable through the import graph. The marker main
// is a no-op module, but it puts @jmfederico/pi-web into the agent bundle so
// the sidecar can spawn it from node_modules at runtime.
import '@jmfederico/pi-web'

// The PI WEB runtime is vendored into this template (scripts/prepare-pi-web.mjs):
//   vendor/pi-web/dist/server/index.js   gateway process
//   vendor/pi-web/dist/server/sessiond.js session daemon
// Resolve the template root (the deployed code root) alongside the vendored
// runtime directory. The Makers deployment does not ship the repository's
// vendor/ tree into the sandbox — only node_modules makes it. Build copies the
// vendored runtime into node_modules/@jmfederico/pi-web (prepare-pi-web.mjs).
interface ResolvedRuntime { root: string, runtimeDir: string }

const resolvedRuntime = resolveRuntime()
const templateRoot = resolvedRuntime.root
const piWebRuntimeDir = resolvedRuntime.runtimeDir

function resolveRuntime(): ResolvedRuntime {
  const candidates = [
    process.env.PI_WEB_TEMPLATE_ROOT,
    process.cwd(),
    dirname(dirname(fileURLToPath(import.meta.url))),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', '@jmfederico', 'pi-web', 'dist', 'server', 'sessiond.js'))) {
      return { root: candidate, runtimeDir: join(candidate, 'node_modules', '@jmfederico', 'pi-web') }
    }
    if (existsSync(join(candidate, 'vendor', 'pi-web', 'dist', 'server', 'sessiond.js'))) {
      return { root: candidate, runtimeDir: join(candidate, 'vendor', 'pi-web') }
    }
  }
  return { root: process.cwd(), runtimeDir: join(process.cwd(), 'vendor', 'pi-web') }
}

export interface PiWebSidecar {
  conversationId: string
  home: string
  port: number
  children: ChildProcess[]
  gateway: LocalGatewayProxy
  lastUsedAt: number
  context: any
  close(): Promise<void>
}

const sidecars = new Map<string, Promise<PiWebSidecar>>()
// The platform reclaims idle conversation instances after ~5 minutes; sweep
// just before that so we snapshot and shut down gracefully instead of being
// killed. Keep the value under the platform idle window.
const SIDECAR_IDLE_MS = 4 * 60_000
const SNAPSHOT_DEBOUNCE_MS = 3_000

// Environment variables that may carry BYOK credentials and must be forwarded
// from the deployment environment (context.env) into the sidecar processes.
// Keys only ever live in the deployment env; nothing here writes them to the
// store or to files.
const FORWARD_ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'DEEPSEEK_', 'GOOGLE_', 'GEMINI_', 'MISTRAL_', 'GROQ_', 'CEREBRAS_', 'XAI_', 'OPENROUTER_', 'HUGGINGFACE_', 'HF_', 'FIREWORKS_', 'TOGETHER_', 'BASETEN_', 'KIMI_', 'MINIMAX_', 'ZAI_', 'NVIDIA_', 'CLOUDFLARE_', 'AZURE_OPENAI_', 'LLAMACPP_']
const FORWARD_ENV_SUFFIXES = ['_API_KEY', '_TOKEN', '_KEY']

function envValue(context: any, key: string): string {
  const value = context.env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function forwardedEnv(context: any): Record<string, string> {
  const result: Record<string, string> = {}
  const source: Record<string, string> = context.env ?? {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const matches = FORWARD_ENV_PREFIXES.some(prefix => key.startsWith(prefix)) ||
      (FORWARD_ENV_SUFFIXES.some(suffix => key.endsWith(suffix)) && !key.startsWith('AI_GATEWAY_'))
    if (matches) result[key] = value
  }
  return result
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'default'
}

export function piWebHomeFor(conversationId: string): string {
  return join('/tmp', 'piweb-makers', safeSegment(conversationId))
}

/**
 * Deterministic per-user conversation id for cross-browser persistence.
 * The Makers platform scopes `context.store` (and the agent's sticky routing)
 * by `context.conversation_id`, which the browser sets to its own random UUID
 * via the makers-conversation-id header — so a second browser/device would see
 * an empty, isolated conversation. Derive a stable id from the authenticated
 * deployment identity instead, so every browser of the same user shares ONE
 * persisted conversation (sessions, projects, workspace files).
 */
export function stableConversationId(context: any): string {
  const env = context?.env ?? {}
  const seed = String(env.SITE_USERNAME || env.AI_GATEWAY_API_KEY || 'pi-web-makers')
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'u' + (h >>> 0).toString(16).padStart(8, '0')
}

const MAKERS_PROVIDER = 'edgeone-makers'
const MAKERS_GATEWAY_API_KEY_ENV = 'MAKERS_GATEWAY_API_KEY'
const DEFAULT_MAKERS_MODEL = '@makers/deepseek-v4-flash'
const MAKERS_MODELS: Array<{ id: string; name: string; reasoning?: boolean }> = [
  { id: '@makers/hy3', name: 'Hy-3' },
  { id: '@makers/hy3-preview', name: 'Hy-3-Preview' },
  { id: '@makers/deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: true },
  { id: '@makers/deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning: true },
  { id: '@makers/minimax-m3', name: 'MiniMax-M3' },
  { id: '@makers/minimax-m2.7', name: 'MiniMax-M2.7' },
  { id: '@makers/kimi-k2.6', name: 'Kimi-K2.6' },
]

/** Seed pi's custom provider catalog pointing at the local gateway adapter. */
async function writeAgentModels(home: string, gatewayBaseUrl: string, defaultModel: string): Promise<void> {
  const modelsPath = join(home, 'pi-agent', 'models.json')
  const existing = await readExistingModels(modelsPath)
  const catalog = [...MAKERS_MODELS]
  if (!catalog.some(model => model.id === defaultModel)) catalog.unshift({ id: defaultModel, name: defaultModel })
  const models = catalog.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.reasoning === true ? { reasoning: true } : {}),
    contextWindow: 1_000_000,
    maxTokens: 256_000,
    compat: model.reasoning === true ? { thinkingFormat: 'deepseek' } : undefined,
  }))
  // Always rewrite the edgeone-makers provider with the CURRENT gateway proxy
  // port: the local gateway proxy binds a fresh random port on every sidecar
  // start, so a persisted/old models.json pointing at a previous port would
  // make the agent's model requests fail with APIConnectionError.
  const next = {
    ...(existing ?? {}),
    providers: {
      ...(existing?.providers ?? {}),
      [MAKERS_PROVIDER]: {
        api: 'openai-completions',
        baseUrl: gatewayBaseUrl,
        apiKey: 'makers-proxy',
        models,
      },
    },
  }
  await mkdir(join(home, 'pi-agent'), { recursive: true })
  await writeFile(modelsPath, JSON.stringify(next, null, 2))
}

async function readExistingModels(path: string): Promise<{ providers?: Record<string, unknown> } | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path, 'utf8')) as { providers?: Record<string, unknown> }
  } catch {
    return undefined
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!port) throw new Error('Could not allocate a PI WEB gateway port.')
  return port
}

function piWebServerPath(): string {
  return join(piWebRuntimeDir, 'dist', 'server', 'index.js')
}

function piWebSessiondPath(): string {
  return join(piWebRuntimeDir, 'dist', 'server', 'sessiond.js')
}

/** Open an append-mode fd children inherit as stdout/stderr. */
function logFd(path: string): number {
  return openSync(path, 'a')
}

/** Read the tail of a child log for error diagnostics. */
async function tailFile(path: string, maxBytes = 6_000): Promise<string> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.length > maxBytes ? raw.slice(-maxBytes) : raw
  } catch {
    return '(no log)'
  }
}

const execFileAsync = promisify(execFile)

/** node fs.cp is ~20x slower than coreutils cp on big trees; prefer cp with a graceful fallback. */
async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  try {
    await execFileAsync('cp', ['-r', `${src}/.`, dest + '/'], { timeout: 120_000 })
  } catch {
    try { await cp(src, dest, { recursive: true }) } catch { /* best effort */ }
  }
}

// Mirrors pi-packages.txt. Vendor tree not shipped into the Makers sandbox,
// so this list doubles as the cold-start fallback: sidecar seeds settings.json
// with it and _packages.ts re-installs everything online on first boot. Keep
// the default list small: the sandbox /tmp is a small TMPFS and a full
// extension set (~550MB of node_modules) triggers ENOSPC at first boot — see
// README "Sandbox storage budget". Additional packages install cleanly from
// the UI's Settings → Pi packages when the user wants them.
const DEFAULT_PACKAGE_SOURCES = [
  'npm:pi-mcp-adapter@^2.26.0',
  'npm:pi-subagents@^0.50.0',
  'npm:pi-web-access@^0.23.0',
]

/**
 * Copy build-time vendored packages (vendor/pi-packages/{npm,git}) into the
 * conversation's agent dir and seed settings.json `packages` so PI WEB lists
 * them as installed. First-copy semantics: once an npm/ or git/ tree exists in
 * the sandbox, later boots leave it alone (snapshots + _packages.ts handle the
 * rest of the lifecycle). The settings list is seeded from vendor/pi-packages
 * when present, otherwise from DEFAULT_PACKAGE_SOURCES.
 */
async function seedVendorPackages(home: string): Promise<void> {
  const vendorRoot = join(templateRoot, 'vendor', 'pi-packages')
  const sourcesPath = join(vendorRoot, 'sources.json')
  let sources = DEFAULT_PACKAGE_SOURCES
  let vendorPresent = false
  if (existsSync(sourcesPath)) {
    try {
      sources = (JSON.parse(await readFile(sourcesPath, 'utf8')) as { sources?: string[] }).sources ?? DEFAULT_PACKAGE_SOURCES
      vendorPresent = true
    } catch { /* fall back */ }
  }
  const agentDir = join(home, 'pi-agent')
  if (vendorPresent) {
    for (const kind of ['npm', 'git'] as const) {
      const src = join(vendorRoot, kind)
      const dest = join(agentDir, kind)
      if (existsSync(src) && !existsSync(dest)) {
        await copyTree(src, dest)
      }
    }
  }
  const settingsPath = join(agentDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown> } catch { /* start fresh */ }
  const existing = Array.isArray(settings.packages) ? settings.packages as unknown[] : []
  const existingKeys = new Set(existing.map(entry => typeof entry === 'string' ? entry : (entry as { source?: unknown })?.source).filter((s): s is string => typeof s === 'string'))
  const missing = sources.filter(s => !existingKeys.has(s))
  if (missing.length > 0) {
    settings.packages = [...existing, ...missing]
    try { await writeFile(settingsPath, JSON.stringify(settings, null, 2)) } catch { /* best effort */ }
  }
}

async function waitForReady(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 60_000
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`PI WEB gateway exited with ${String(child.exitCode)}: ${stderr}`)
    }
    try {
      // ?refresh=1 bypasses the 60s status cache — the first probe typically
      // finds the session daemon still loading extensions (~10s for a vendored
      // package set), and a cached false would block the whole readiness window.
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/pi-web/status?refresh=1`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        // The session daemon boots slightly after the gateway; wait for it so
        // the first client request can create sessions immediately.
        const body = await response.json() as { components?: Record<string, { available?: boolean }> }
        const sessiond = body.components?.sessiond
        if (sessiond?.available === true) return
      }
    } catch {
      // Still booting.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`PI WEB gateway did not become ready: ${stderr}`)
}

async function startSidecar(context: any, conversationId: string): Promise<PiWebSidecar> {
  const [port, gateway] = await Promise.all([
    freePort(),
    startLocalGatewayProxy(context, conversationId),
  ])
  const home = piWebHomeFor(conversationId)
  const defaultModel = envValue(context, 'AI_GATEWAY_MODEL') || DEFAULT_MAKERS_MODEL

  await mkdir(home, { recursive: true })
  // Restore persisted state (settings, sessions, workspace) before booting.
  let snapshot = await readSnapshotFromStore(context, conversationId)
  // One-time migration: state is now keyed by the per-user stable id, but the
  // user's prior dialogue may still be stored under the browser's original
  // random conversation id. If the stable conversation is still empty, carry
  // that old state over. The browser's old id arrives either as the
  // x-makers-original-conversation-id header (middleware rewrite path) or as
  // context.conversation_id directly (no rewrite).
  if (isSnapshotEmpty(snapshot)) {
    const candidates: string[] = []
    const originalHeader = String(context?.request?.headers?.['x-makers-original-conversation-id'] ?? '').trim()
    const ctxId = String(context?.conversation_id ?? '').trim()
    if (originalHeader !== '') candidates.push(originalHeader)
    if (ctxId !== '' && ctxId !== originalHeader) candidates.push(ctxId)
    for (const candidateId of candidates) {
      if (candidateId === conversationId) continue
      const original = await readSnapshotFromStore(context, candidateId)
      if (!isSnapshotEmpty(original)) {
        snapshot = original
        try { await writeSnapshotToStore(context, conversationId, original) } catch { /* best effort */ }
        break
      }
    }
  }
  await restoreSnapshot(home, snapshot)

  // Seed the pre-installed Pi Packages vendored into this template
  // (pi-packages.txt + scripts/prepare-packages.mjs) and merge their sources
  // into settings.json so the UI sees them as installed.
  await seedVendorPackages(home)

  // Re-install configured Pi Packages whose code did not survive the cold
  // start (the settings list is snapshotted; the code under npm/ and git/ is
  // not). Failures are non-fatal: the sidecar still boots and the UI can
  // reinstall from Settings → Pi packages.
  try {
    const agentDir = join(home, 'pi-agent')
    const { reinstalled, failed } = await reinstallMissingPackages(agentDir)
    if (reinstalled.length > 0) console.warn(`[pi-web] reinstalled ${reinstalled.length} missing package(s): ${reinstalled.join(', ')}`)
    if (failed.length > 0) console.warn(`[pi-web] package restore failed for: ${failed.map(item => `${item.source} (${item.error})`).join('; ')}`)
  } catch (error) {
    console.warn('[pi-web] package restore skipped:', error instanceof Error ? error.message : String(error))
  }

  const sessiondSocket = join(home, 'sessiond.sock')
  // Leftover state from a killed instance (socket file + ownership marker)
  // would make the new session daemon wait for a dead owner or fail to bind;
  // unlink both before booting.
  try { await rm(sessiondSocket, { force: true }) } catch { /* best effort */ }
  try { await rm(join(home, 'sessiond-owner.json'), { force: true }) } catch { /* best effort */ }
  const piWebConfig = join(home, 'pi-web', 'config.json')
  await mkdir(join(home, 'pi-web'), { recursive: true })
  await writeFile(piWebConfig, JSON.stringify({
    host: '127.0.0.1',
    port,
    spawnSessions: true,
    subsessions: true,
    askUser: true,
    pathAccess: { allowedPaths: [join(home, 'workspaces')] },
    uploads: { defaultFolder: '.pi-web/uploads' },
    maxUploadBytes: 32 * 1024 * 1024,
  }, null, 2))

  await writeAgentModels(home, gateway.baseUrl, defaultModel)

  const childEnv: Record<string, string> = {
    PATH: typeof context.env?.PATH === 'string' ? context.env.PATH : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: home,
    PI_WEB_MAKERS: '1',
    PI_WEB_CONFIG: piWebConfig,
    PI_WEB_DATA_DIR: home,
    PI_WEB_HOST: '127.0.0.1',
    PI_WEB_PORT: String(port),
    PI_WEB_SESSIOND_SOCKET: sessiondSocket,
    PI_CODING_AGENT_DIR: join(home, 'pi-agent'),
    PI_WEB_SPAWN_SESSIONS: 'true',
    PI_WEB_SUBSESSIONS: 'true',
    PI_WEB_ASK_USER: 'true',
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    NO_COLOR: '1',
    [MAKERS_GATEWAY_API_KEY_ENV]: 'makers-proxy',
    ...forwardedEnv(context),
  }

  const logsDir = join(home, 'pi-web', 'logs')
  await mkdir(logsDir, { recursive: true })
  // Redirect child output straight to files instead of pipes: a killed parent
  // never carries the child's stdio away, and smoke tests / platform logs can
  // inspect the daemon after failures.
  const sessiondFd = logFd(join(logsDir, 'sessiond.log'))
  const gatewayFd = logFd(join(logsDir, 'gateway.log'))

  const sessiond = spawn(process.execPath, [piWebSessiondPath()], {
    cwd: home,
    env: childEnv,
    stdio: ['ignore', sessiondFd, sessiondFd],
  })
  const gatewayProcess = spawn(process.execPath, [piWebServerPath()], {
    cwd: home,
    env: childEnv,
    stdio: ['ignore', gatewayFd, gatewayFd],
  })

  try {
    await waitForReady(gatewayProcess, port)
  } catch (error) {
    await Promise.allSettled([gateway.close(), stopChild(sessiond), stopChild(gatewayProcess)])
    const sessiondTail = await tailFile(join(logsDir, 'sessiond.log'))
    const gatewayTail = await tailFile(join(logsDir, 'gateway.log'))
    const detail = `${error instanceof Error ? error.message : String(error)}\n[sessiond] ${sessiondTail}\n[gateway] ${gatewayTail}`
    throw new Error(detail)
  }

  const sidecar: PiWebSidecar = {
    conversationId,
    home,
    port,
    children: [sessiond, gatewayProcess],
    gateway,
    lastUsedAt: Date.now(),
    context,
    async close() {
      // Snapshot first, then release /tmp (the conversation home holds the
      // installed package tree and logs; the snapshot restores everything that
      // should persist).
      await snapshotNow(sidecar)
      await Promise.allSettled([gateway.close(), stopChild(sessiond), stopChild(gatewayProcess)])
      try { await rm(home, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
  for (const child of [sessiond, gatewayProcess]) {
    child.once('exit', () => {
      const current = sidecars.get(conversationId)
      if (current) void current.then(value => { if (value === sidecar) sidecars.delete(conversationId) })
    })
  }
  return sidecar
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000)),
  ])
}

// Debounced snapshot after mutating requests; one writer per sidecar.
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleSnapshot(conversationId: string, sidecar: PiWebSidecar): void {
  const existing = snapshotTimers.get(conversationId)
  if (existing !== undefined) clearTimeout(existing)
  snapshotTimers.set(conversationId, setTimeout(() => {
    snapshotTimers.delete(conversationId)
    void snapshotNow(sidecar)
  }, SNAPSHOT_DEBOUNCE_MS))
}

async function snapshotNow(sidecar: PiWebSidecar): Promise<void> {
  try {
    const snapshot = await captureSnapshot(sidecar.home)
    await writeSnapshotToStore(sidecar.context, sidecar.conversationId, snapshot)
  } catch (error) {
    console.warn('[pi-web] snapshot failed:', error)
  }
}

function sweepIdleSidecars(): void {
  const cutoff = Date.now() - SIDECAR_IDLE_MS
  for (const [conversationId, pending] of sidecars) {
    void pending.then(sidecar => {
      if (sidecar.lastUsedAt >= cutoff) return
      if (sidecars.get(conversationId) === pending) sidecars.delete(conversationId)
      void sidecar.close()
    }).catch(() => { sidecars.delete(conversationId) })
  }
}

export async function getPiWebSidecar(context: any, conversationIdOverride?: string): Promise<PiWebSidecar> {
  // Prefer the per-user stable id so every browser of the same user converges
  // on one persisted conversation (see stableConversationId). The middleware
  // also rewrites makers-conversation-id, but the browser's own random id must
  // never be used to key the sidecar/state.
  const conversationId = (conversationIdOverride ?? stableConversationId(context)).trim()
  if (!conversationId) throw new Error('makers-conversation-id is required for PI WEB.')
  sweepIdleSidecars()
  let pending = sidecars.get(conversationId)
  if (!pending) {
    pending = startSidecar(context, conversationId)
    sidecars.set(conversationId, pending)
    void pending.catch(() => { if (sidecars.get(conversationId) === pending) sidecars.delete(conversationId) })
  }
  const sidecar = await pending
  sidecar.lastUsedAt = Date.now()
  sidecar.context = context
  return sidecar
}

export async function stopPiWebSidecar(context: any, conversationId: string): Promise<boolean> {
  const pending = sidecars.get(conversationId)
  if (!pending) return false
  sidecars.delete(conversationId)
  const sidecar = await pending
  await sidecar.close()
  return true
}

export { scheduleSnapshot }
