import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * Snapshot persistence for the EdgeOne Makers build.
 *
 * The Makers sandbox filesystem (/tmp/...) is ephemeral: the platform reclaims
 * an idle conversation instance after ~5 minutes, and a cold start gets a
 * fresh filesystem. To survive cold starts we snapshot the small, high-value
 * state into the conversation store (context.store metadata):
 *
 *   - ~/.pi-web/config.json           (PI WEB gateway/sessiond config)
 *   - ~/.pi/agent/settings.json       (pi agent settings)
 *   - ~/.pi/agent/models.json         (custom providers, incl. edgeone-makers)
 *   - ~/.pi/agent/sessions/*.jsonl    (session histories)
 *   - workspace text files            (user project files, size-bounded)
 *
 * BYOK API keys are NOT part of the snapshot: they only exist in the
 * deployment environment variables, which the sidecar forwards to the child
 * processes. Nothing secret is written to the store.
 */

export const SNAPSHOT_METADATA_KEY = 'piWebSnapshot'
export const SNAPSHOT_VERSION = 1

// Conservative ceiling for a conversation metadata payload. The store is a
// conversation memory; keep the snapshot well under typical limits and degrade
// gracefully (drop workspace files first, then old sessions) when exceeded.
const SNAPSHOT_MAX_BYTES = 512 * 1024
const MAX_WORKSPACE_FILE_BYTES = 512 * 1024
const MAX_WORKSPACE_FILES = 120
const MAX_SESSIONS = 24

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.cache', '.turbo', '.vite', '.pi-web',
  'node_modules', 'dist', 'build', 'coverage', '__pycache__',
])
const IGNORED_FILES = new Set(['.DS_Store'])

export interface PiWebSnapshot {
  version: typeof SNAPSHOT_VERSION
  configJson: string | null
  /**
   * $PI_WEB_DATA_DIR/projects.json — the project/workspace registry. Without
   * it a cold-started gateway knows no projects/workspaces: the UI's stored
   * workspace ids 404, the session list for the workspace comes back empty,
   * and the model picker has no session to query.
   */
  projectsJson: string | null
  agentSettings: string | null
  agentModels: string | null
  sessions: Record<string, string>
  workspace: Record<string, string>
}

export function emptySnapshot(): PiWebSnapshot {
  return { version: SNAPSHOT_VERSION, configJson: null, projectsJson: null, agentSettings: null, agentModels: null, sessions: {}, workspace: {} }
}

export function snapshotByteSize(snapshot: PiWebSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code ?? '') : ''
    if (code === 'ENOENT' || code === 'EISDIR') return null
    throw error
  }
}

async function collectTextFiles(root: string, maxFiles: number, maxBytesPerFile: number): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    if (Object.keys(files).length >= maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (Object.keys(files).length >= maxFiles) return
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name) || IGNORED_FILES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (info.size > maxBytesPerFile) continue
        const content = await readFile(full, 'utf8')
        // Reject binary files: valid text has no NUL bytes in practice.
        if (content.includes('\0')) continue
        files[relative(root, full).split(sep).join('/')] = content
      } catch {
        // Skip unreadable files (permissions, races).
      }
    }
  }
  await walk(root)
  return files
}

/** Capture the high-value state under `home` into a snapshot object. */
export async function captureSnapshot(home: string): Promise<PiWebSnapshot> {
  const snapshot = emptySnapshot()
  snapshot.configJson = await readOptionalFile(join(home, 'pi-web', 'config.json'))
  snapshot.projectsJson = await readOptionalFile(join(home, 'projects.json'))
  snapshot.agentSettings = await readOptionalFile(join(home, 'pi-agent', 'settings.json'))
  // models.json is intentionally NOT snapshotted: its edgeone-makers provider
  // carries the local gateway proxy's port, which is freshly assigned on every
  // sidecar start (see writeAgentModels in _pi-web-sidecar.ts). Persisting it
  // would restore a stale port and break every model call after a cold start.

  const sessionsDir = join(home, 'pi-agent', 'sessions')
  const sessionFiles = await collectSessionFiles(sessionsDir)
  const dated = await Promise.all(sessionFiles.map(async item => {
    try { return { ...item, mtime: (await stat(item.path)).mtimeMs } } catch { return { ...item, mtime: 0 } }
  }))
  dated.sort((a, b) => b.mtime - a.mtime)
  for (const item of dated.slice(0, MAX_SESSIONS)) {
    const content = await readOptionalFile(item.path)
    if (content !== null) snapshot.sessions[item.name] = content
  }

  snapshot.workspace = await collectTextFiles(join(home, 'workspaces'), MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_BYTES)
  return snapshot
}

/** Trim a snapshot until it fits the store ceiling (workspace first, then sessions). */
export function trimSnapshot(snapshot: PiWebSnapshot): PiWebSnapshot {
  if (snapshotByteSize(snapshot) <= SNAPSHOT_MAX_BYTES) return snapshot
  const trimmed = { ...snapshot, workspace: {} }
  if (snapshotByteSize(trimmed) <= SNAPSHOT_MAX_BYTES) return trimmed
  const sessions = { ...snapshot.sessions }
  while (snapshotByteSize({ ...trimmed, sessions }) > SNAPSHOT_MAX_BYTES && Object.keys(sessions).length > 0) {
    // Drop the largest session first to converge fast.
    const largest = Object.keys(sessions).sort((a, b) => sessions[b]!.length - sessions[a]!.length)[0]
    if (largest === undefined) break
    delete sessions[largest]
  }
  return { ...trimmed, sessions }
}

/** Write a snapshot into the conversation store (merge semantics on metadata). */
export async function writeSnapshotToStore(context: any, conversationId: string, snapshot: PiWebSnapshot): Promise<void> {
  if (!context?.store) return
  const trimmed = trimSnapshot(snapshot)
  await ensureConversation(context, conversationId)
  const metadata = { [SNAPSHOT_METADATA_KEY]: trimmed }
  try {
    await context.store.updateConversation({ conversationId, metadata })
  } catch (firstError) {
    try {
      await context.store.updateConversation(conversationId, { metadata })
    } catch {
      throw firstError
    }
  }
}

/** Read the stored snapshot back, or an empty snapshot when absent/corrupt. */
export async function readSnapshotFromStore(context: any, conversationId: string): Promise<PiWebSnapshot> {
  if (!context?.store) return emptySnapshot()
  try {
    const conversation = await getConversation(context, conversationId)
    const raw = conversation?.metadata?.[SNAPSHOT_METADATA_KEY]
    if (raw === undefined || raw === null || typeof raw !== 'object') return emptySnapshot()
    return normalizeSnapshot(raw as Partial<PiWebSnapshot>)
  } catch {
    return emptySnapshot()
  }
}

function normalizeSnapshot(raw: Partial<PiWebSnapshot>): PiWebSnapshot {
  const snapshot = emptySnapshot()
  if (raw.version === SNAPSHOT_VERSION) {
    snapshot.configJson = typeof raw.configJson === 'string' ? raw.configJson : null
    snapshot.projectsJson = typeof raw.projectsJson === 'string' ? raw.projectsJson : null
    snapshot.agentSettings = typeof raw.agentSettings === 'string' ? raw.agentSettings : null
    snapshot.agentModels = typeof raw.agentModels === 'string' ? raw.agentModels : null
    if (raw.sessions !== null && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
      for (const [key, value] of Object.entries(raw.sessions)) {
        if (typeof value === 'string' && key.endsWith('.jsonl')) snapshot.sessions[key] = value
      }
    }
    if (raw.workspace !== null && typeof raw.workspace === 'object' && !Array.isArray(raw.workspace)) {
      for (const [key, value] of Object.entries(raw.workspace)) {
        if (typeof value === 'string' && !key.includes('\0')) snapshot.workspace[key] = value
      }
    }
  }
  return snapshot
}

/** Restore a snapshot onto the filesystem under `home` (called before starting the sidecar). */
export async function restoreSnapshot(home: string, snapshot: PiWebSnapshot): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeMaybe(join(home, 'pi-web', 'config.json'), snapshot.configJson)
  await writeMaybe(join(home, 'projects.json'), snapshot.projectsJson)
  await writeMaybe(join(home, 'pi-agent', 'settings.json'), snapshot.agentSettings)
  // models.json is rebuilt with the current gateway proxy port at sidecar
  // startup; do not restore a possibly stale one from an older snapshot.
  for (const [name, content] of Object.entries(snapshot.sessions)) {
    if (typeof content !== 'string') continue
    const target = join(home, 'pi-agent', 'sessions', name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  for (const [relPath, content] of Object.entries(snapshot.workspace)) {
    if (typeof content !== 'string') continue
    const target = join(home, 'workspaces', relPath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  // Always ensure the conventional folders exist for a fresh start.
  await mkdir(join(home, 'workspaces'), { recursive: true })
}

async function collectSessionFiles(root: string): Promise<Array<{ name: string; path: string }>> {
  const files: Array<{ name: string; path: string }> = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Key by relative path so restore can recreate the per-cwd subfolder.
        const rel = relative(root, full).split(sep).join('/')
        files.push({ name: rel, path: full })
      }
    }
  }
  await walk(root)
  return files
}

async function writeMaybe(path: string, content: string | null): Promise<void> {
  if (content === null || content === undefined) return
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function isMissingConversation(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'MemoryNotFoundError' || /Conversation not found/i.test(message)
}

async function getConversation(context: any, conversationId: string): Promise<any> {
  try {
    return await context.store.getConversation({ conversationId })
  } catch (firstError) {
    try { return await context.store.getConversation(conversationId) } catch { throw firstError }
  }
}

async function appendBootstrapMessage(context: any, conversationId: string): Promise<void> {
  const payload = {
    conversationId,
    role: 'system' as const,
    content: 'pi-web-makers',
    metadata: { kind: 'piweb-bootstrap' },
  }
  try {
    await context.store.appendMessage(payload)
  } catch (firstError) {
    try {
      await context.store.appendMessage(conversationId, payload)
    } catch {
      throw firstError
    }
  }
}

async function ensureConversation(context: any, conversationId: string): Promise<void> {
  if (!context?.store) return
  try {
    await getConversation(context, conversationId)
  } catch (error) {
    if (!isMissingConversation(error)) throw error
    await appendBootstrapMessage(context, conversationId)
  }
}
