/**
 * Build-time package vendor: read pi-packages.txt and install the npm sources
 * into vendor/pi-packages/npm (git sources into vendor/pi-packages/git) so the
 * sandbox needs no network at runtime to serve the pre-installed set.
 *
 * Re-running is incremental: npm handles installed packages as no-ops.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const listPath = join(templateRoot, 'pi-packages.txt')
const vendorRoot = join(templateRoot, 'vendor', 'pi-packages')

function parseSources(path) {
  if (!existsSync(path)) return { npm: [], git: [] }
  const npm = []
  const git = []
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('npm:')) npm.push(line.slice(4))
    else if (line.startsWith('git:')) git.push(normalizeGit(line.slice(4)))
    else npm.push(line)
  }
  return { npm, git }
}

function normalizeGit(spec) {
  const t = spec.trim()
  return /^(git@|https?:\/\/|ssh:\/\/)/u.test(t) ? t : `https://${t}`
}

const { npm, git } = parseSources(listPath)
console.log(`[prepare-packages] ${npm.length} npm source(s), ${git.length} git source(s)`)

if (npm.length > 0) {
  const npmRoot = join(vendorRoot, 'npm')
  mkdirSync(npmRoot, { recursive: true })
  if (!existsSync(join(npmRoot, 'package.json'))) {
    writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'pi-packages-preinstall', private: true }, null, 2))
  }
  console.log(`[prepare-packages] npm install ${npm.length} package(s) into vendor/pi-packages/npm …`)
  execFileSync('npm', ['install', ...npm, '--prefix', npmRoot, '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], { stdio: 'inherit' })
}

for (const spec of git) {
  const name = spec.replace(/\.git$/u, '').split('/').pop()
  const target = join(vendorRoot, 'git', name)
  if (existsSync(target)) {
    console.log(`[prepare-packages] git package already vendored: ${name} (skipping; delete to refresh)`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  execFileSync('git', ['clone', '--depth', '1', spec, target], { stdio: 'inherit' })
  if (existsSync(join(target, 'package.json'))) {
    execFileSync('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' })
  }
}

// Record the exact source lines so the sidecar can seed settings.json.
const sources = readFileSync(listPath, 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line !== '' && !line.startsWith('#'))
writeFileSync(join(vendorRoot, 'sources.json'), JSON.stringify({ sources }, null, 2))
console.log(`[prepare-packages] vendored sources -> vendor/pi-packages/sources.json`)
