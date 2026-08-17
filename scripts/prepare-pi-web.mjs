/**
 * Vendor the EdgeOne-Makers build of PI WEB into this template.
 *
 * The PI WEB fork (github.com/jmfederico/pi-web, VITE_MAKERS_PROXY=1 build)
 * compiles to a dist/ directory that contains:
 *   - client/  the browser SPA (deployed as static assets from public/)
 *   - server/  the pi-web gateway process (spawned as a sidecar)
 *   - sessiond/ the session daemon process (spawned as a sidecar)
 *   - shared/ etc. runtime support modules
 *
 * Point PI_WEB_DIST at that build output:
 *
 *   cd /path/to/pi-web-fork
 *   VITE_MAKERS_PROXY=1 npm run build
 *   cd /path/to/pi-web-makers
 *   PI_WEB_DIST=/path/to/pi-web-fork/dist npm run prepare:pi-web
 *
 * The vendored output is committed to the repository so deployment is fully
 * offline: `npm ci` only installs the runtime dependencies listed in this
 * template's package.json; the PI WEB code itself comes from vendor/pi-web.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makersBootstrapScript = `(() => {
  const key = 'makers-web-conversation-id';
  let conversationId = localStorage.getItem(key);
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    localStorage.setItem(key, conversationId);
  }
  window.__MAKERS_CONVERSATION_ID__ = conversationId;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (target.origin !== location.origin || !target.pathname.startsWith('/api')) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    headers.set('makers-conversation-id', conversationId);
    if (input instanceof Request) return nativeFetch(new Request(input, { ...init, headers }));
    return nativeFetch(input, { ...init, headers });
  };
})();`

async function main() {
  const src = process.env.PI_WEB_DIST
  if (!src) {
    // The repository ships the vendored build (public/ + vendor/pi-web), so
    // CI (EdgeOne Pages StaticAssetsBuilder -> npm run build:makers) does not
    // need a source. Only fail when the vendored output is genuinely missing.
    const [publicIndex, serverEntry] = await Promise.all([
      readFile(join(templateRoot, 'public', 'index.html')).then(() => true).catch(() => false),
      readFile(join(templateRoot, 'vendor', 'pi-web', 'dist', 'server', 'sessiond.js')).then(() => true).catch(() => false),
    ])
    if (publicIndex && serverEntry) {
      console.log('[prepare-pi-web] vendored PI WEB already present (public/, vendor/pi-web) — skipping (set PI_WEB_DIST to re-vendor)')
      await mirrorVendorIntoNodeModules(join(templateRoot, 'node_modules', '@jmfederico', 'pi-web'))
      return
    }
    console.error('PI_WEB_DIST is required: point it at the Makers build of the pi-web fork (dist/).')
    process.exit(1)
  }
  const source = resolve(src)
  const client = join(source, 'client')
  const server = join(source, 'server')
  const sessiond = join(source, 'sessiond')
  for (const required of [client, server, sessiond]) {
    try {
      await readFile(join(required, 'index.html')) // client only has index.html
      await readFile(join(server, 'index.js'))
    } catch {
      // Fine, checked below via stat
    }
  }

  const publicDir = join(templateRoot, 'public')
  const vendorDir = join(templateRoot, 'vendor', 'pi-web')

  console.log(`Vendoring PI WEB from ${source}`)
  console.log(`  client   -> ${publicDir}`)
  console.log(`  server+  -> ${vendorDir}`)

  await rm(publicDir, { recursive: true, force: true })
  await rm(vendorDir, { recursive: true, force: true })
  await mkdir(publicDir, { recursive: true })
  await mkdir(vendorDir, { recursive: true })

  await cp(client, publicDir, { recursive: true })
  await cp(source, join(vendorDir, 'dist'), { recursive: true })
  await rm(join(vendorDir, 'dist', 'client'), { recursive: true, force: true })

  // The vendored server is loaded by the agent sidecar; give it a package
  // marker so it can resolve as a package for createRequire if needed. The
  // lightweight main entry lets agent code import the package name so
  // EdgeOne's dependency sync (which follows the import graph) ships it.
  const markerPath = join(vendorDir, 'dist', 'runtime-marker.js')
  await writeFile(markerPath, 'export {}\n')
  await writeFile(join(vendorDir, 'package.json'), JSON.stringify({
    name: '@jmfederico/pi-web',
    version: '0.0.0-makers',
    private: true,
    type: 'module',
    main: 'dist/runtime-marker.js',
  }, null, 2) + '\n')

  // Inject the makers bootstrap into the SPA shell.
  const indexPath = join(publicDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  if (html.includes('makers-web-conversation-id')) {
    console.log('Bootstrap already present in index.html, skipping injection.')
  } else {
    const marker = '</head>'
    if (!html.includes(marker)) {
      console.error('index.html has no </head> marker; bootstrap injection aborted.')
      process.exit(1)
    }
    const injected = html.replace(marker, `  <script>${makersBootstrapScript}</script>\n${marker}`)
    await writeFile(indexPath, injected)
    console.log('Injected makers bootstrap into index.html.')
  }

  console.log('Done. Vendor sizes:')
  const { stat } = await import('node:fs/promises')
  const count = async (dir) => {
    let files = 0
    const walk = async (d) => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(d, entry.name))
        else files += 1
      }
    }
    await walk(dir)
    return files
  }
  const { readdir } = await import('node:fs/promises')
  const publicFiles = await count(publicDir)
  const vendorFiles = await count(vendorDir)
  const statDir = async (dir) => {
    const info = await stat(dir)
    return info.size
  }
  console.log(`  public/  ${publicFiles} files`)
  console.log(`  vendor/  ${vendorFiles} files`)

  // The Makers deployment does NOT ship the repository's vendor/ directory
  // into the agent sandbox — only agent code and node_modules make it. Mirror
  // the vendored server runtime into node_modules/@jmfederico/pi-web so the
  // sidecar can resolve it from the standard module layout too.
  await mirrorVendorIntoNodeModules(join(templateRoot, 'node_modules', '@jmfederico', 'pi-web'))
}

async function mirrorVendorIntoNodeModules(targetDir) {
  const vendorDir = join(templateRoot, 'vendor', 'pi-web')
  try {
    await readFile(join(vendorDir, 'dist', 'server', 'sessiond.js'))
  } catch {
    console.log('No vendored pi-web present yet; node_modules mirror skipped.')
    return
  }
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(join(targetDir, '..', '..'), { recursive: true })
  await cp(vendorDir, targetDir, { recursive: true })
  console.log(`Mirrored vendor/pi-web -> ${targetDir}`)
}

await main()
