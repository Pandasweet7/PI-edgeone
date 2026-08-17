/**
 * Prune the vendored PI WEB tree so the deployment package stays lean.
 *
 * The vendored runtime (vendor/pi-web) is spawned as sidecar processes; it
 * resolves its imports from this template's node_modules at runtime. Nothing
 * here needs to be bundled by the Makers CLI (the agents/ code only touches the
 * vendor tree by path), so we just drop junk that would bloat the upload.
 */
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(templateRoot, 'vendor', 'pi-web', 'dist')

// docker integration is unusable in the Makers sandbox; everything else in the
// vendored dist is load-bearing at runtime (nativeServices are small and
// referenced by the service-management routes, pi-web-plugins are the built-in
// server plugins).
const candidates = [
  join(vendorRoot, 'docker'),
]

for (const target of candidates) {
  try {
    await rm(target, { recursive: true, force: true })
    console.log(`pruned ${target}`)
  } catch (error) {
    console.warn(`could not prune ${target}:`, error)
  }
}

console.log('vendor prune complete')
