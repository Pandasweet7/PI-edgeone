/**
 * Sandbox diagnostics route. Open /api/debug after deployment to check whether
 * the pi-web sidecar (gateway + session daemon) can start inside the Makers
 * sandbox. This route intentionally starts the sidecar for the current
 * conversation so a cold sandbox is fully exercised.
 *
 * REMOVE THIS ROUTE for production (it leaks environment details).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPiWebSidecar, piWebHomeFor } from '../_pi-web-sidecar.ts'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function tailLog(path: string, bytes = 3_000): string {
  try {
    const raw = readFileSync(path, 'utf8')
    return raw.length > bytes ? raw.slice(-bytes) : raw
  } catch {
    return '(no log file)'
  }
}

function lsSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return ['(missing)'] }
}

export async function onRequest(context: any): Promise<Response> {
  const fsProbe = {
    cwd: process.cwd(),
    codeRootTop: lsSafe(process.cwd()),
    vendorDir: lsSafe(join(process.cwd(), 'vendor')),
    vendorPiWebDistServer: lsSafe(join(process.cwd(), 'vendor', 'pi-web', 'dist', 'server')).slice(0, 8),
    nodeModulesPiWeb: lsSafe(join(process.cwd(), 'node_modules', '@jmfederico', 'pi-web')).slice(0, 8),
    sessiondViaNodeModules: existsSync(join(process.cwd(), 'node_modules', '@jmfederico', 'pi-web', 'dist', 'server', 'sessiond.js')),
    sessiondViaVendor: existsSync(join(process.cwd(), 'vendor', 'pi-web', 'dist', 'server', 'sessiond.js')),
  }
  const toolProbe: Record<string, string> = {}
  const report: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    envProbe: {
      AI_GATEWAY_API_KEY: context?.env?.AI_GATEWAY_API_KEY ? '(set)' : '(missing)',
      AI_GATEWAY_BASE_URL: context?.env?.AI_GATEWAY_BASE_URL ?? '(missing)',
      AI_GATEWAY_MODEL: context?.env?.AI_GATEWAY_MODEL ?? '(missing)',
    },
    toolProbe,
    tmpWritable: false,
  }
  for (const tool of ['npm', 'git']) {
    try {
      toolProbe[tool] = execFileSync(tool, ['--version'], { timeout: 5_000 }).toString().trim()
    } catch (error) {
      toolProbe[tool] = `UNAVAILABLE: ${String(error).slice(0, 120)}`
    }
  }
  try {
    execFileSync('bash', ['-c', `echo ok > /tmp/pi-web-debug-probe && cat /tmp/pi-web-debug-probe`], { timeout: 5_000 })
    report.tmpWritable = true
  } catch {
    report.tmpWritable = false
  }

  const conversationId = context?.conversation_id ?? 'debug'
  try {
    const sidecar = await getPiWebSidecar(context, conversationId)
    report.sidecar = {
      status: 'READY',
      port: sidecar.port,
      home: sidecar.home,
    }
    try {
      const health = await fetch(`http://127.0.0.1:${sidecar.port}/api/pi-web/status?refresh=1`, { signal: AbortSignal.timeout(5_000) })
      report.gatewayStatus = await health.json()
    } catch (error) {
      report.gatewayStatus = `probe failed: ${String(error).slice(0, 200)}`
    }
  } catch (error) {
    report.sidecar = { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
  }

  report.fs = fsProbe

  const home = piWebHomeFor(conversationId)
  report.logs = {
    sessiond: tailLog(join(home, 'pi-web', 'logs', 'sessiond.log')),
    gateway: tailLog(join(home, 'pi-web', 'logs', 'gateway.log')),
  }
  return jsonResponse(report)
}
