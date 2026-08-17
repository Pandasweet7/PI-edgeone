/**
 * Prune the vendored PI WEB tree + node_modules so the deployment package stays
 * under the Makers agent functions size limit (250 MiB).
 *
 * The vendored runtime (vendor/pi-web) is spawned as sidecar processes; it
 * resolves its imports from this template's node_modules at runtime. Nothing
 * here needs to be bundled by the Makers CLI (the agents/ code only touches the
 * vendor tree by path).
 *
 * What we remove:
 *  - *.map source maps across node_modules + vendor/pi-web (~69 MB)
 *  - pi-coding-agent docs/examples/CHANGELOG (~4 MB)
 * pi-web-plugins are the runtime-required built-in server plugins — keep them.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function sizeOf(path) {
  let stats
  try { stats = await lstat(path) } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  if (!stats.isDirectory()) return stats.size
  const entries = await readdir(path)
  const sizes = await Promise.all(entries.map(entry => sizeOf(join(path, entry))))
  return sizes.reduce((total, size) => total + size, 0)
}

async function removeFilesMatching(rootDir, match, label) {
  let bytes = 0
  let files = 0
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        await walk(entryPath)
      } else if (entry.isFile() && match(entry.name)) {
        bytes += await sizeOf(entryPath)
        await rm(entryPath, { force: true })
        files += 1
      }
    }
  }
  await walk(rootDir)
  console.log(`[prune] ${label}: removed ${files} file(s), ${(bytes / 1_048_576).toFixed(1)} MiB`)
}

await removeFilesMatching(join(templateRoot, 'node_modules'), name => name.endsWith('.map'), 'node_modules *.map')
await removeFilesMatching(join(templateRoot, 'vendor', 'pi-web'), name => name.endsWith('.map'), 'vendor/pi-web *.map')

const docsCandidates = [
  join(templateRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'docs'),
  join(templateRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'examples'),
  join(templateRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md'),
]
for (const target of docsCandidates) {
  try {
    await rm(target, { recursive: true, force: true })
    console.log(`[prune] removed ${target}`)
  } catch (error) {
    console.warn(`[prune] could not remove ${target}:`, error)
  }
}

console.log('[prune] complete')
