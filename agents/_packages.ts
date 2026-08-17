import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Package restoration for the EdgeOne Makers build.
 *
 * PI WEB installs Pi Packages (extensions, skills, prompts, themes from
 * pi.dev/packages) via its Settings → Pi packages UI. The list of installed
 * packages lives in ~/.pi/agent/settings.json under `packages`, which IS part
 * of the snapshot. The installed code lives in ~/.pi/agent/npm and
 * ~/.pi/agent/git, which is NOT snapshotted (code can be large).
 *
 * On a cold start (Makers reclaims idle instances after ~5 min) the settings
 * list survives but the code is gone. This module re-installs whatever is
 * listed but missing, so the UI and sessions see the configured packages again.
 *
 * Requires the sandbox to reach the npm registry / git remotes. For a fully
 * offline experience, vendor the packages into the template instead (see
 * scripts/prepare-pi-web.mjs / README).
 */

export interface MissingPackage {
  source: string
  kind: 'npm' | 'git'
  spec: string
}

interface ParsedPackage {
  kind: 'npm' | 'git'
  spec: string
  name?: string
}

function parsePackageSource(source: string): ParsedPackage {
  const trimmed = source.trim()
  if (trimmed.startsWith('npm:')) {
    return { kind: 'npm', spec: trimmed.slice(4) }
  }
  if (trimmed.startsWith('git:')) {
    return { kind: 'git', spec: normalizeGitSpec(trimmed.slice(4)) }
  }
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('ssh://') || trimmed.startsWith('git@')) {
    return { kind: 'git', spec: normalizeGitSpec(trimmed) }
  }
  // Bare npm spec (e.g. "@scope/pkg@1.2.3").
  return { kind: 'npm', spec: trimmed }
}

function normalizeGitSpec(spec: string): string {
  const trimmed = spec.trim().replace(/^git\+https:\/\//u, 'https://')
  if (trimmed.startsWith('git@') || trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('ssh://')) {
    return trimmed
  }
  // "github.com/user/repo" without a scheme -> https.
  return `https://${trimmed}`
}

function npmPackageName(spec: string): string {
  if (!spec.startsWith('@')) {
    return spec.split('@')[0]
  }
  // Scoped: @scope/name[@version] — node_modules layout is node_modules/@scope/name.
  const versionAt = spec.indexOf('@', 1)
  return versionAt === -1 ? spec : spec.slice(0, versionAt)
}

function gitRepoDirName(spec: string): string {
  const clean = spec.replace(/\.git$/u, '').replace(/\/+$/u, '')
  return basename(clean)
}

/** Compute which configured packages are missing on disk. */
export function findMissingPackages(agentDir: string): MissingPackage[] {
  const settingsPath = join(agentDir, 'settings.json')
  if (!existsSync(settingsPath)) return []
  let settings: { packages?: unknown }
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: unknown }
  } catch {
    return []
  }
  const packages = settings.packages
  if (!Array.isArray(packages)) return []

  const missing: MissingPackage[] = []
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown })?.source
    if (typeof source !== 'string' || source === '') continue
    const parsed = parsePackageSource(source)
    if (parsed.kind === 'npm') {
      const name = npmPackageName(parsed.spec)
      const target = join(agentDir, 'npm', 'node_modules', name)
      if (!existsSync(target)) missing.push({ source, kind: 'npm', spec: parsed.spec })
    } else {
      const target = join(agentDir, 'git', gitRepoDirName(parsed.spec))
      if (!existsSync(target)) missing.push({ source, kind: 'git', spec: parsed.spec })
    }
  }
  return missing
}

async function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs: number }): Promise<void> {
  await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    env: { ...process.env, NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false' },
  })
}

/** Reinstall configured packages that are missing from disk. */
export async function reinstallMissingPackages(agentDir: string): Promise<{ reinstalled: string[]; failed: Array<{ source: string; error: string }> }> {
  const missing = findMissingPackages(agentDir)
  const reinstalled: string[] = []
  const failed: Array<{ source: string; error: string }> = []

  for (const pkg of missing) {
    try {
      if (pkg.kind === 'npm') {
        mkdirSync(join(agentDir, 'npm'), { recursive: true })
        await runCommand('npm', ['install', pkg.spec, '--prefix', join(agentDir, 'npm'), '--legacy-peer-deps'], { timeoutMs: 180_000 })
      } else {
        const target = join(agentDir, 'git', gitRepoDirName(pkg.spec))
        mkdirSync(dirname(target), { recursive: true })
        await runCommand('git', ['clone', pkg.spec, target], { timeoutMs: 180_000 })
        const packageJson = join(target, 'package.json')
        if (existsSync(packageJson)) {
          await runCommand('npm', ['install', '--omit=dev', '--legacy-peer-deps'], { cwd: target, timeoutMs: 180_000 })
        }
      }
      reinstalled.push(pkg.source)
    } catch (error) {
      failed.push({ source: pkg.source, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { reinstalled, failed }
}
