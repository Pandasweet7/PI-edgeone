/**
 * Sandbox diagnostics route. Open /api/debug after deployment to check whether
 * the pi-web sidecar (gateway + session daemon) can start inside the Makers
 * sandbox. This route intentionally starts the sidecar for the current
 * conversation so a cold sandbox is fully exercised.
 *
 * REMOVE THIS ROUTE for production (it leaks environment details).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
  report.tmpDisk = {
    df: (() => { try { return execFileSync('df', ['-h', '/tmp'], { timeout: 5_000 }).toString().trim().split('\n').pop() } catch { return '(df unavailable)' } })(),
    homesDu: (() => { try { return execFileSync('du', ['-sh', '/tmp/piweb-makers', '/tmp/npm-cache'], { timeout: 10_000 }).toString().trim() } catch { return '(du unavailable)' } })(),
  }

  const conversationId = context?.conversation_id ?? 'debug'
  const aiGatewayProbe: Record<string, unknown> = {}
  {
    const baseUrl = String(context?.env?.AI_GATEWAY_BASE_URL ?? '').replace(/\/+$/, '')
    const apiKey = String(context?.env?.AI_GATEWAY_API_KEY ?? '')
    const model = String(context?.env?.AI_GATEWAY_MODEL ?? '') || '@makers/deepseek-v4-flash'
    try {
      const modelsRes = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      aiGatewayProbe.models = { status: modelsRes.status, body: (await modelsRes.text()).slice(0, 300) }
    } catch (error) {
      aiGatewayProbe.models = { error: String(error).slice(0, 200) }
    }
    try {
      const chatRes = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(60_000),
      })
      aiGatewayProbe.chatCompletion = { status: chatRes.status, body: (await chatRes.text()).slice(0, 400) }
    } catch (error) {
      aiGatewayProbe.chatCompletion = { error: String(error).slice(0, 240) }
    }
  }
  report.aiGatewayProbe = aiGatewayProbe
  try {
    const sidecar = await getPiWebSidecar(context, conversationId)
    report.sidecar = {
      status: 'READY',
      port: sidecar.port,
      home: sidecar.home,
    }
    // Probe the same path the agent uses: model traffic through the local
    // gateway proxy (127.0.0.1), NOT the upstream directly. This separates "agent
    // can't reach the local proxy" from "local proxy can't reach upstream".
    const baseUrl = String(context?.env?.AI_GATEWAY_BASE_URL ?? '').replace(/\/+$/, '')
    const model = String(context?.env?.AI_GATEWAY_MODEL ?? '') || '@makers/deepseek-v4-flash'
    try {
      const viaLocal = await fetch(`${sidecar.gateway.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer makers-proxy', 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(60_000),
      })
      report.viaLocalGateway = { url: sidecar.gateway.baseUrl, status: viaLocal.status, body: (await viaLocal.text()).slice(0, 400), upstreamBaseUrl: baseUrl ? '(set)' : '(missing)' }
    } catch (error) {
      report.viaLocalGateway = { url: sidecar.gateway.baseUrl, error: String(error).slice(0, 240) }
    }
    // The agent actually calls the model with stream:true — verify the SSE
    // path (non-streaming already works). Only consume a few frames.
    try {
      const streamRes = await fetch(`${sidecar.gateway.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer makers-proxy', 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 6 }),
        signal: AbortSignal.timeout(45_000),
      })
      if (streamRes.status !== 200 || !streamRes.body) {
        report.viaLocalGatewayStream = { status: streamRes.status, body: (await streamRes.text()).slice(0, 400) }
      } else {
        const reader = streamRes.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && text.length < 600) {
          const { value, done } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
        try { reader.releaseLock() } catch { /* ignore */ }
        report.viaLocalGatewayStream = { status: streamRes.status, frames: text.slice(0, 600) }
      }
    } catch (error) {
      report.viaLocalGatewayStream = { error: String(error).slice(0, 240) }
    }
    // Proxy env vars: if the sandbox forces outbound traffic through a proxy,
    // the session daemon's whitelist-only env propagation may strip them and
    // the agent's model fetch then dies on direct egress.
    report.proxyEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY ? '(set)' : '',
      HTTPS_PROXY: process.env.HTTPS_PROXY ? '(set)' : '',
      ALL_PROXY: process.env.ALL_PROXY ? '(set)' : '',
      NO_PROXY: process.env.NO_PROXY ?? '',
      http_proxy: process.env.http_proxy ? '(set)' : '',
      https_proxy: process.env.https_proxy ? '(set)' : '',
    }
    try {
      const health = await fetch(`http://127.0.0.1:${sidecar.port}/api/pi-web/status?refresh=1`, { signal: AbortSignal.timeout(5_000) })
      report.gatewayStatus = await health.json()
    } catch (error) {
      report.gatewayStatus = `probe failed: ${String(error).slice(0, 200)}`
    }
    // Surface the session daemon's real model list — the exact `models` array
    // the model picker renders from `listModels()`. This is what shows whether
    // the NVIDIA provider's catalog is actually available to the picker.
    try {
      const g = `http://127.0.0.1:${sidecar.port}`
      const ws = encodeURIComponent(join(sidecar.home, 'workspaces'))
      const sessionsRes = await fetch(`${g}/api/machines/local/sessions?cwd=${ws}`, { signal: AbortSignal.timeout(5_000) })
      const sessionsJson = await sessionsRes.json()
      const list = Array.isArray(sessionsJson) ? sessionsJson : (Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [])
      const sid = list[0]?.id
      if (sid) {
        const modelsRes = await fetch(`${g}/api/machines/local/sessions/${sid}/models?cwd=${ws}`, { signal: AbortSignal.timeout(8_000) })
        const modelsJson = await modelsRes.json()
        const models = Array.isArray(modelsJson) ? modelsJson : (Array.isArray(modelsJson?.models) ? modelsJson.models : [])
        const nv = models.filter((m: any) => m?.provider === 'nvidia')
        report.pickerModels = {
          sessionId: sid,
          total: models.length,
          nvidia: nv.length,
          providers: [...new Set(models.map((m: any) => m?.provider).filter(Boolean))],
          sample: models.slice(0, 10).map((m: any) => `${m?.provider}/${m?.id}`),
          nvidiaSample: nv.slice(0, 12).map((m: any) => m?.id),
          raw: models.slice(0, 6),
        }
      } else {
        report.pickerModels = { error: 'no session', sessions: list }
      }
    } catch (error) {
      report.pickerModels = { error: String(error).slice(0, 240) }
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
  // Exactly the provider config the session daemon consumes, and the latest
  // agent session transcript — the session jsonl holds the real
  // APIConnectionError stack when the SDK can't reach the model.
  report.agentConfig = {
    modelsJson: tailLog(join(home, 'pi-agent', 'models.json'), 1_500),
    settingsJson: tailLog(join(home, 'pi-agent', 'settings.json'), 1_200),
  }
  try {
    const sessionsRoot = join(home, 'pi-agent', 'sessions')
    const newest: { file: string, mtime: number }[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.jsonl')) {
          const st = statSync(p)
          newest.push({ file: p, mtime: st.mtimeMs })
        }
      }
    }
    walk(sessionsRoot)
    newest.sort((a, b) => b.mtime - a.mtime)
    report.latestSessionTranscript = newest.slice(0, 1).map(entry => ({ file: entry.file, tail: tailLog(entry.file, 4_000) }))
  } catch (error) {
    report.latestSessionTranscript = `probe failed: ${String(error).slice(0, 160)}`
  }
  return jsonResponse(report)
}
