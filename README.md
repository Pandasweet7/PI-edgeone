# PI WEB on EdgeOne Makers

Run the [PI Coding Agent](https://pi.dev) with its official [PI WEB](https://pi-web.dev) UI on [EdgeOne Makers](https://edgeone.ai/makers) — fork the DeepSeek Harness deployment pattern: static SPA + Makers agent functions + a per-conversation sidecar running the real pi-web gateway and session daemon.

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=https://github.com/Pandasweet7/PI-edgeone)

## What you get

- **Full PI WEB UI** — projects, workspaces, sessions, chat, files, settings, Pi package manager — minus the Terminal tab (node-pty is unavailable in the Makers sandbox).
- **Per-conversation isolation** — the browser generates a sticky `makers-conversation-id`; each conversation gets its own pi-web gateway + session daemon pair on `127.0.0.1`.
- **Makers Models** — the model picker lists the built-in `@makers/*` catalog through a local gateway adapter (`AI_GATEWAY_*` env).
- **BYOK** — bring your own Anthropic / OpenAI / DeepSeek / … keys via **environment variables only**. Keys never enter the web UI, never touch the conversation store, and are not part of any snapshot.
- **Cold-start persistence** — settings, session histories, and workspace text files are snapshotted into the conversation store and restored when the sandbox is reclaimed (Makers recycles idle instances after ~5 minutes).
- **Pi Packages** — install extensions/skills/prompts/themes from [pi.dev/packages](https://pi.dev/packages) in the UI or by template presets; missing packages are re-installed automatically after cold starts.

## Architecture

```text
browser (PI WEB SPA, served from public/)
  │  fetch patched to send makers-conversation-id
  ▼
EdgeOne Makers (agents/)
  ├─ api/proxy         POST/GET/…  → pi-web gateway on 127.0.0.1:PORT
  ├─ api/proxy-sse     EventSource → gateway WebSocket re-framed as SSE
  ├─ _pi-web-sidecar   spawns pi-web-server + pi-web-sessiond per conversation
  ├─ _gateway-proxy    local OpenAI-compatible adapter → AI_GATEWAY_BASE_URL
  ├─ _store            snapshot/restore of settings + sessions + workspace
  └─ _packages         reinstall configured Pi Packages after cold start
```

The PI WEB client is built from a fork of [jmfederico/pi-web](https://github.com/jmfederico/pi-web) with `VITE_MAKERS_PROXY=1`:

- every `api/…` URL is folded onto `api/proxy?target=…` (Makers routes statically; no wildcard routes needed),
- the two event downlinks (session events / global events) use EventSource instead of WebSocket,
- the Terminal panel is disabled.

## Deploy

1. Fork this repository (or click the Deploy button).
2. In the Makers console set the environment variables (see `.env.example`):
   - `AI_GATEWAY_API_KEY` — Makers Models API key (**required**)
   - `AI_GATEWAY_BASE_URL` — default `https://ai-gateway.edgeone.link/v1`
   - `AI_GATEWAY_MODEL` — default `@makers/deepseek-v4-flash`
   - any of the BYOK variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …)
3. Deploy. Open the site, create a project/workspace, start a session.

## Local development

```bash
# 1. Build the PI WEB fork with the Makers client:
#    cd /path/to/pi-web-fork
#    VITE_MAKERS_PROXY=1 npm run build

# 2. Vendor the build into this template (public/ + vendor/pi-web):
PI_WEB_DIST=/path/to/pi-web-fork/dist npm run prepare:pi-web

# 2b. Pre-install the Pi Packages from pi-packages.txt (recommended):
npm run prepare:packages

# 3. Local smoke test (no EdgeOne account needed):
node --experimental-strip-types scripts/smoke-test.mjs
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Yes | Makers Models key, or any OpenAI-compatible key |
| `AI_GATEWAY_BASE_URL` | No | Gateway base URL (`https://ai-gateway.edgeone.link/v1`) |
| `AI_GATEWAY_MODEL` | No | Default model (`@makers/deepseek-v4-flash`) |
| `ANTHROPIC_API_KEY` … | No | BYOK keys, see `.env.example` for the full list |

## Installing Pi Packages (extensions from pi.dev/packages)

Three ways, from most convenient to most deterministic:

### 1. In the UI (requires sandbox network access)

Open **Settings → Pi packages** in PI WEB, enter a source, and install:

```text
npm:@scope/package-name
npm:@scope/package-name@1.2.3
git:github.com/user/repo
git:github.com/user/repo@v1
https://github.com/user/repo
```

The install runs `npm install` / `git clone` inside the conversation sandbox, so it needs the sandbox to reach the npm registry and git remotes. The installed list is written to `settings.json`, which **is** part of the snapshot.

> ⚠️ The package *code* (under `~/.pi/agent/npm` and `~/.pi/agent/git`) is **not** snapshotted — it is large. On a cold start the sidecar re-installs every configured package that is missing from disk automatically (see `agents/_packages.ts`). This takes a few seconds to a minute per cold start, depending on package count.

### 2. Pre-install in the template (offline, deterministic) — ship your extension set

This template already includes a preset flow:

1. Edit [`pi-packages.txt`](pi-packages.txt) — one source per line (`npm:name@version` or `git:...`). It is pre-populated with a ready-made set (pi-mcp-adapter, pi-subagents, pi-web-access, plannotator, dynamic-workflows, …).
2. Run `npm run prepare:packages` at build time — installs everything into `vendor/pi-packages/` (`--omit=dev`); runtime needs no sandbox network for these packages.
3. On boot the sidecar copies the vendored tree into `~/.pi/agent` and merges the sources into `settings.json`. UI installs/removals afterwards still work; snapshots keep the list; cold starts re-install anything missing.

> The vendored tree for the sample list is ~550 MB. Shrink `pi-packages.txt` before `prepare:packages` if deploy size matters.

### 3. Seed the settings file

Pre-configure `~/.pi/agent/settings.json` with the desired `packages` array in `agents/_pi-web-sidecar.ts` (or in the snapshot). The first cold start installs them through `_packages.ts` — same network requirement as option 1, but the list is committed to the template.

### After installing

- Extensions that only add client-side UI / commands apply to new sessions without a restart.
- Extensions with a `serverModule` (and new model providers) require a session-daemon restart. On Makers this means the sidecar is stopped and restarted — state is restored from the snapshot automatically, but running agent work is interrupted. The UI keeps working; the next conversation turn sees the new extension.

## Persistence scope (snapshot)

| Data | Persisted across cold starts |
|---|---|
| `~/.pi/agent/settings.json` (incl. package list, model config) | ✅ |
| `~/.pi/agent/models.json` (custom providers) | ✅ |
| `~/.pi/agent/sessions/*.jsonl` (session histories) | ✅ |
| workspace text files (≤ 120 files, ≤ 512 KB each) | ✅ |
| `~/.pi-web/config.json` | ✅ |
| BYOK API keys | ❌ (environment variables only, by design) |
| installed package code (`npm/`, `git/`) | ❌ (auto re-installed from `settings.json` + `vendor/pi-packages` on cold start) |
| large / binary workspace files | ❌ (size-bounded snapshot) |

## Security notes

- BYOK keys are deployment secrets: they exist only in the environment, are forwarded to the sidecar processes, and never enter the conversation store or the browser.
- PI WEB has no multi-tenant auth of its own: isolation granularity is the Makers conversation. Do not expose the deployment to untrusted users without a gateway.
- Pi Packages execute arbitrary code. Review sources before installing.

## License

MIT
