import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadPiWebConfig, piWebDataDir } from "../config.js";
import { isPiWebPluginId, isReservedPiWebPluginId } from "../shared/pluginIds.js";
function defaultDirectoryEntryNamesProvider(directoryPath) {
    return readdir(directoryPath);
}
export class DefaultPiPackageProvider {
    constructor(cwd, agentDir) {
        this.cwd = cwd;
        this.agentDir = agentDir;
    }
    listPackages() {
        return this.createPackageManager().listConfiguredPackages();
    }
    getInstalledPath(source, scope) {
        return this.createPackageManager().getInstalledPath(source, scope);
    }
    createPackageManager() {
        return new DefaultPackageManager({
            cwd: this.cwd,
            agentDir: this.agentDir,
            settingsManager: SettingsManager.create(this.cwd, this.agentDir),
        });
    }
}
/**
 * Process-neutral package discovery shared by browser serving and sessiond's
 * startup activator. Catalog reads never import or execute plugin code.
 */
export class PiWebPluginCatalog {
    constructor(options = {}) {
        const cwd = options.cwd ?? process.cwd();
        this.roots = options.roots ?? defaultPluginRoots(cwd);
        this.agentDir = options.agentDir;
        this.agentDirProvider = options.agentDirProvider;
        const packageProvider = options.packageProvider;
        this.staticPackageProvider = packageProvider === false || packageProvider === undefined ? undefined : packageProvider;
        this.packageProviderForAgentDir = packageProvider === false || packageProvider !== undefined
            ? undefined
            : (agentDir) => new DefaultPiPackageProvider(cwd, agentDir);
        this.configProvider = options.configProvider ?? (() => loadPiWebConfig({ cwd }).config);
        this.directoryEntryNamesProvider = options.directoryEntryNamesProvider ?? defaultDirectoryEntryNamesProvider;
        this.warningSink = options.warningSink ?? ((message) => { console.warn(message); });
    }
    async snapshot(options = {}) {
        const config = await this.configProvider();
        const diagnostics = [];
        const plugins = await this.discoverPlugins(this.reporter(diagnostics), options.scope);
        return {
            plugins: plugins.map((plugin) => applyDesiredState(plugin, config)),
            diagnostics,
        };
    }
    /**
     * Resolve the catalog winner for browser asset serving. A known local winner
     * remains readable even when active Pi-package discovery is unavailable.
     */
    async browserPlugin(pluginId) {
        if (!isPiWebPluginId(pluginId) || isReservedPiWebPluginId(pluginId))
            return undefined;
        const report = this.reporter([]);
        const localRecords = new Map();
        for (const plugin of await this.discoverLocalPlugins(report))
            addUnique(localRecords, plugin, report);
        const local = localRecords.get(pluginId);
        if (local !== undefined)
            return local.browserModule === undefined ? undefined : local;
        const packageProvider = await this.currentPackageProvider();
        if (packageProvider === undefined)
            return undefined;
        const packageRecords = new Map();
        for (const plugin of await this.discoverPiPackagePlugins(packageProvider, report))
            addUnique(packageRecords, plugin, report);
        const plugin = packageRecords.get(pluginId);
        return plugin?.browserModule === undefined ? undefined : plugin;
    }
    reporter(diagnostics) {
        return (source, error, details = {}) => {
            const message = error instanceof Error ? error.message : String(error);
            diagnostics.push({
                code: details.code ?? "invalid-package",
                source,
                message,
                ...(details.pluginId === undefined ? {} : { pluginId: details.pluginId }),
            });
            this.warningSink(`Skipping PI WEB plugin from ${source}: ${message}`);
        };
    }
    async discoverPlugins(report, scope) {
        const records = new Map();
        for (const plugin of await this.discoverLocalPlugins(report, scope))
            addUnique(records, plugin, report);
        const packageProvider = scope === "bundled" ? undefined : await this.currentPackageProvider();
        if (packageProvider !== undefined) {
            for (const plugin of await this.discoverPiPackagePlugins(packageProvider, report)) {
                if (scope === undefined || plugin.scope === scope)
                    addUnique(records, plugin, report);
            }
        }
        return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    async currentPackageProvider() {
        if (this.staticPackageProvider !== undefined)
            return this.staticPackageProvider;
        if (this.packageProviderForAgentDir === undefined)
            return undefined;
        return this.packageProviderForAgentDir(await this.currentAgentDir());
    }
    async currentAgentDir() {
        if (this.agentDirProvider !== undefined)
            return await this.agentDirProvider();
        if (this.agentDir !== undefined)
            return this.agentDir;
        throw new Error("Pi package plugin discovery requires an explicit active agent directory");
    }
    async discoverLocalPlugins(report, scope) {
        const plugins = [];
        for (const root of this.roots) {
            if (scope === undefined || root.scope === scope) {
                plugins.push(...await discoverLocalRoot(root, report, this.directoryEntryNamesProvider));
            }
        }
        return plugins;
    }
    async discoverPiPackagePlugins(packageProvider, report) {
        const plugins = [];
        for (const configuredPackage of packageProvider.listPackages()) {
            const root = configuredPackage.installedPath ?? packageProvider.getInstalledPath(configuredPackage.source, configuredPackage.scope);
            if (root === undefined)
                continue;
            try {
                plugins.push(...await discoverPackageRoot(root, configuredPackage, this.directoryEntryNamesProvider));
            }
            catch (error) {
                report(configuredPackage.source, error);
            }
        }
        return plugins;
    }
}
export function defaultPluginRoots(cwd) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = join(moduleDir, "..", "..");
    return [
        { path: bundledPluginRoot(packageRoot), source: "bundled", scope: "bundled" },
        ...sourceCheckoutPluginRoots(cwd),
        { path: join(piWebDataDir(), "plugins"), source: "local", scope: "local" },
    ];
}
function bundledPluginRoot(packageRoot) {
    return join(packageRoot, "dist", "pi-web-plugins");
}
function sourceCheckoutPluginRoots(cwd) {
    const pluginsRoot = join(cwd, "plugins");
    if (!existsSync(join(cwd, "src", "server", "index.ts")) || !existsSync(pluginsRoot))
        return [];
    return [{ path: pluginsRoot, source: "dev", scope: "local" }];
}
async function discoverLocalRoot(root, report, directoryEntryNamesProvider) {
    if (!existsSync(root.path))
        return [];
    const entries = await readdir(root.path, { withFileTypes: true }).catch(() => []);
    const plugins = [];
    for (const entry of entries) {
        if (!isPiWebPluginId(entry.name))
            continue;
        const pluginRoot = join(root.path, entry.name);
        const pluginStat = entry.isDirectory() ? undefined : entry.isSymbolicLink() ? await stat(pluginRoot).catch(() => undefined) : undefined;
        if (!entry.isDirectory() && pluginStat?.isDirectory() !== true)
            continue;
        try {
            plugins.push(...await discoverLocalPlugin(pluginRoot, root, directoryEntryNamesProvider));
        }
        catch (error) {
            report(pluginRoot, error);
        }
    }
    return plugins;
}
async function discoverLocalPlugin(root, localRoot, directoryEntryNamesProvider) {
    const config = await readPiWebPackageConfig(root);
    if (config === undefined)
        return [];
    const plugins = await discoverPluginEntries(root, config, directoryEntryNamesProvider);
    return plugins.map((plugin) => ({ ...plugin, source: localRoot.source, scope: localRoot.scope }));
}
async function discoverPackageRoot(root, configuredPackage, directoryEntryNamesProvider) {
    const config = await readPiWebPackageConfig(root);
    if (config === undefined)
        return [];
    const plugins = await discoverPluginEntries(root, config, directoryEntryNamesProvider);
    return plugins.map((plugin) => ({ ...plugin, source: configuredPackage.source, scope: configuredPackage.scope }));
}
async function discoverPluginEntries(root, config, directoryEntryNamesProvider) {
    const packageRoot = await realpath(root);
    const revision = await computePiWebPluginPackageRevision(packageRoot);
    const plugins = [];
    for (const entry of config.plugins) {
        const browserRoot = entry.browserRoot === undefined
            ? undefined
            : await discoverBrowserRoot(packageRoot, entry.id, entry.browserRoot, directoryEntryNamesProvider);
        const browserModule = entry.module === undefined
            ? undefined
            : await discoverModule(packageRoot, entry.id, "browser", entry.module, revision, directoryEntryNamesProvider, browserRoot);
        const serverModule = entry.serverModule === undefined
            ? undefined
            : await discoverModule(packageRoot, entry.id, "server", entry.serverModule, revision, directoryEntryNamesProvider);
        plugins.push({
            id: entry.id,
            packageRoot,
            ...(browserRoot === undefined ? {} : { browserRoot }),
            ...(browserModule === undefined ? {} : { browserModule }),
            ...(serverModule === undefined ? {} : { serverModule }),
            machineSpecific: entry.machineSpecific,
        });
    }
    return plugins;
}
async function discoverBrowserRoot(packageRoot, pluginId, path, directoryEntryNamesProvider) {
    const candidate = resolve(packageRoot, path);
    const [entryStat, directoryPath] = await Promise.all([
        stat(candidate).catch(() => undefined),
        realpath(candidate).catch(() => undefined),
    ]);
    if (entryStat?.isDirectory() !== true || directoryPath === undefined)
        throw new Error(`PI WEB plugin browser root not found for ${pluginId}: ${path}`);
    if (!isWithin(packageRoot, directoryPath))
        throw new Error(`PI WEB plugin browser root escapes its package for ${pluginId}: ${path}`);
    const excludedDirectory = excludedArtifactDirectory(packageRoot, directoryPath);
    if (excludedDirectory !== undefined) {
        throw new Error(`PI WEB plugin browser root resolves inside excluded ${excludedDirectory} directory for ${pluginId}: ${path}`);
    }
    const pathSegments = path === "." ? [] : path.split("/");
    await validateBrowserDirectoryPrefixes(packageRoot, pluginId, "browser root", path, pathSegments);
    await validateBrowserPathSpelling(packageRoot, pluginId, "browser root", path, pathSegments, directoryEntryNamesProvider);
    return { path, directoryPath };
}
async function discoverModule(packageRoot, pluginId, kind, path, revision, directoryEntryNamesProvider, browserRoot) {
    if (!isSafeRelativeModulePath(path))
        throw new Error(`Unsafe PI WEB plugin ${kind} module path for ${pluginId}: ${path}`);
    const candidate = resolve(packageRoot, path);
    const [entryStat, filePath] = await Promise.all([
        stat(candidate).catch(() => undefined),
        realpath(candidate).catch(() => undefined),
    ]);
    if (entryStat?.isFile() !== true || filePath === undefined)
        throw new Error(`PI WEB plugin ${kind} module not found for ${pluginId}: ${path}`);
    if (!isWithin(packageRoot, filePath))
        throw new Error(`PI WEB plugin ${kind} module escapes its package for ${pluginId}: ${path}`);
    const excludedDirectory = excludedArtifactDirectory(packageRoot, dirname(filePath));
    if (excludedDirectory !== undefined) {
        throw new Error(`PI WEB plugin ${kind} module resolves inside excluded ${excludedDirectory} directory for ${pluginId}: ${path}`);
    }
    if (browserRoot !== undefined && (!isLogicalPathWithin(browserRoot.path, path) || !isWithin(browserRoot.directoryPath, filePath))) {
        throw new Error(`PI WEB plugin browser module is outside browser root for ${pluginId}: ${path}`);
    }
    if (kind === "browser") {
        const pathSegments = path.split("/");
        await validateBrowserDirectoryPrefixes(packageRoot, pluginId, "browser module", path, pathSegments.slice(0, -1));
        await validateBrowserPathSpelling(packageRoot, pluginId, "browser module", path, pathSegments, directoryEntryNamesProvider);
    }
    return { path, filePath, revision };
}
async function validateBrowserPathSpelling(packageRoot, pluginId, kind, entryPath, pathSegments, directoryEntryNamesProvider) {
    let directoryPath = packageRoot;
    for (const segment of pathSegments) {
        const entryNames = await directoryEntryNamesProvider(directoryPath);
        if (!entryNames.includes(segment)) {
            throw new Error(`PI WEB plugin ${kind} path does not exactly match package directory entries for ${pluginId}: ${entryPath}`);
        }
        directoryPath = join(directoryPath, segment);
    }
}
async function validateBrowserDirectoryPrefixes(packageRoot, pluginId, kind, entryPath, directorySegments) {
    const canonicalAncestors = new Set([packageRoot]);
    let candidate = packageRoot;
    for (const segment of directorySegments) {
        candidate = join(candidate, segment);
        const [entryStat, directoryPath] = await Promise.all([
            stat(candidate).catch(() => undefined),
            realpath(candidate).catch(() => undefined),
        ]);
        if (entryStat?.isDirectory() !== true || directoryPath === undefined) {
            throw new Error(`PI WEB plugin ${kind} path cannot be traversed for ${pluginId}: ${entryPath}`);
        }
        if (!isWithin(packageRoot, directoryPath)) {
            throw new Error(`PI WEB plugin ${kind} path escapes its package for ${pluginId}: ${entryPath}`);
        }
        const excludedDirectory = excludedArtifactDirectory(packageRoot, directoryPath);
        if (excludedDirectory !== undefined) {
            throw new Error(`PI WEB plugin ${kind} path resolves inside excluded ${excludedDirectory} directory for ${pluginId}: ${entryPath}`);
        }
        // Keep discovery aligned with the artifact scanner, which skips a logical
        // directory cycle instead of capturing entries hidden behind that path.
        if ([...canonicalAncestors].some((ancestor) => isWithin(directoryPath, ancestor))) {
            throw new Error(`PI WEB plugin ${kind} path revisits a canonical ancestor for ${pluginId}: ${entryPath}`);
        }
        canonicalAncestors.add(directoryPath);
    }
}
export const PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES = 4_096;
export const PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const EXCLUDED_ARTIFACT_DIRECTORIES = new Set([".git", "node_modules"]);
export async function computePiWebPluginPackageRevision(packageRoot) {
    return (await scanPiWebPluginPackage(packageRoot)).revision;
}
export async function readPiWebPluginPackageArtifact(packageRoot, browserRoot) {
    const files = new Map();
    const result = await scanPiWebPluginPackage(packageRoot, { browserRoot, files });
    return { ...result, files };
}
async function scanPiWebPluginPackage(packageRoot, capture) {
    const canonicalRoot = await realpath(packageRoot);
    const hash = createHash("sha256");
    const state = { entries: 0, byteLength: 0, ...(capture === undefined ? {} : { capture }) };
    await hashPackageDirectory(hash, canonicalRoot, canonicalRoot, "", new Set(), state);
    return { revision: `sha256:${hash.digest("hex")}`, byteLength: state.byteLength };
}
async function hashPackageDirectory(hash, packageRoot, directory, logicalDirectory, ancestors, state) {
    const canonicalDirectory = await realpath(directory);
    if (!isWithin(packageRoot, canonicalDirectory)
        || excludedArtifactDirectory(packageRoot, canonicalDirectory) !== undefined
        || ancestors.has(canonicalDirectory))
        return;
    const nextAncestors = new Set(ancestors).add(canonicalDirectory);
    const entries = await boundedDirectoryEntries(directory, state);
    for (const entry of entries) {
        const logicalPath = logicalDirectory === "" ? entry.name : `${logicalDirectory}/${entry.name}`;
        const candidate = join(directory, entry.name);
        const canonicalPath = await realpath(candidate).catch(() => undefined);
        if (canonicalPath === undefined || !isWithin(packageRoot, canonicalPath)) {
            updatePackageHash(hash, "unavailable", logicalPath);
            continue;
        }
        const candidateStat = await stat(candidate).catch(() => undefined);
        if (candidateStat?.isDirectory() === true) {
            if (EXCLUDED_ARTIFACT_DIRECTORIES.has(entry.name)
                || excludedArtifactDirectory(packageRoot, canonicalPath) !== undefined) {
                updatePackageHash(hash, "excluded-directory", logicalPath);
                continue;
            }
            updatePackageHash(hash, "directory", logicalPath, relative(packageRoot, canonicalPath));
            await hashPackageDirectory(hash, packageRoot, candidate, logicalPath, nextAncestors, state);
            continue;
        }
        if (candidateStat?.isFile() === true) {
            if (excludedArtifactDirectory(packageRoot, dirname(canonicalPath)) !== undefined) {
                updatePackageHash(hash, "excluded-directory", logicalPath);
                continue;
            }
            const remainingBytes = PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES - state.byteLength;
            const content = await readBoundedPackageFile(candidate, remainingBytes);
            state.byteLength += content.byteLength;
            if (state.capture !== undefined
                && isLogicalPathWithin(state.capture.browserRoot.path, logicalPath)
                && isWithin(state.capture.browserRoot.directoryPath, canonicalPath)) {
                state.capture.files.set(logicalPath, content);
            }
            updatePackageHash(hash, "file", logicalPath, relative(packageRoot, canonicalPath), content);
            continue;
        }
        updatePackageHash(hash, "other", logicalPath);
    }
}
async function boundedDirectoryEntries(directory, state) {
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) {
        state.entries += 1;
        if (state.entries > PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES) {
            throw new Error(`PI WEB plugin package exceeds the ${String(PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES)} artifact entry limit`);
        }
        entries.push(entry);
    }
    return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
async function readBoundedPackageFile(filePath, remainingBytes) {
    const handle = await open(filePath, "r");
    const chunks = [];
    let byteLength = 0;
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytesRead;
        do {
            ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength));
            if (bytesRead > 0) {
                byteLength += bytesRead;
                if (byteLength > remainingBytes) {
                    throw new Error(`PI WEB plugin package exceeds the ${String(PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES)} byte artifact limit`);
                }
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
        } while (bytesRead > 0);
    }
    finally {
        await handle.close();
    }
    return Buffer.concat(chunks, byteLength);
}
function updatePackageHash(hash, ...values) {
    for (const value of values) {
        const content = typeof value === "string" ? Buffer.from(value) : value;
        hash.update(String(content.byteLength));
        hash.update(":");
        hash.update(content);
        hash.update(";");
    }
}
async function readPiWebPackageConfig(root) {
    const packagePath = join(root, "package.json");
    const canonicalPackagePath = await realpath(packagePath).catch(() => undefined);
    if (canonicalPackagePath === undefined)
        return undefined;
    const packageRoot = await realpath(root);
    if (!isWithin(packageRoot, canonicalPackagePath)) {
        throw new Error(`PI WEB plugin package metadata escapes its package: ${packagePath}`);
    }
    const excludedDirectory = excludedArtifactDirectory(packageRoot, dirname(canonicalPackagePath));
    if (excludedDirectory !== undefined) {
        throw new Error(`PI WEB plugin package metadata resolves inside excluded ${excludedDirectory} directory: ${packagePath}`);
    }
    const content = await readFile(canonicalPackagePath, "utf8").catch(() => undefined);
    if (content === undefined)
        return undefined;
    const parsed = JSON.parse(content);
    if (!isRecord(parsed))
        return undefined;
    const piWeb = parsed["piWeb"];
    if (!isRecord(piWeb))
        return undefined;
    const plugins = parsePluginEntries(piWeb, packagePath);
    if (plugins.length === 0)
        return undefined;
    return { plugins };
}
function parsePluginEntries(piWeb, packagePath) {
    if (piWeb["plugin"] !== undefined) {
        throw new Error(`Unsupported PI WEB plugin metadata in ${packagePath}: use piWeb.plugins with { id, module?, browserRoot?, serverModule?, machineSpecific? } entries`);
    }
    const plugins = piWeb["plugins"];
    if (plugins === undefined)
        return [];
    if (!Array.isArray(plugins))
        throw new Error(`PI WEB plugins must be an array in ${packagePath}`);
    return plugins.map((entry, index) => {
        if (!isRecord(entry))
            throw new Error(`PI WEB plugin entry ${String(index + 1)} must be an object in ${packagePath}`);
        const id = entry["id"];
        if (typeof id !== "string" || !isPiWebPluginId(id))
            throw new Error(`Invalid PI WEB plugin id in ${packagePath}: ${String(id)}`);
        if (isReservedPiWebPluginId(id))
            throw new Error(`Reserved PI WEB plugin id in ${packagePath}: ${id}`);
        const module = parseOptionalModule(entry["module"], "browser", packagePath, id);
        const serverModule = parseOptionalModule(entry["serverModule"], "server", packagePath, id);
        if (module === undefined && serverModule === undefined)
            throw new Error(`PI WEB plugin ${id} must declare module or serverModule in ${packagePath}`);
        const browserRoot = parseBrowserRoot(entry["browserRoot"], packagePath, id, module !== undefined);
        const configuredMachineSpecific = parseMachineSpecific(entry["machineSpecific"], packagePath, id);
        if (module !== undefined && serverModule !== undefined && configuredMachineSpecific === false) {
            throw new Error(`PI WEB plugin ${id} has browser and server modules and must be machine-specific in ${packagePath}`);
        }
        const machineSpecific = configuredMachineSpecific ?? (module !== undefined && serverModule !== undefined);
        return {
            id,
            ...(browserRoot === undefined ? {} : { browserRoot }),
            ...(module === undefined ? {} : { module }),
            ...(serverModule === undefined ? {} : { serverModule }),
            machineSpecific,
        };
    });
}
function parseOptionalModule(value, kind, packagePath, pluginId) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value === "")
        throw new Error(`Invalid PI WEB plugin ${kind} module for ${pluginId} in ${packagePath}`);
    return value;
}
function parseBrowserRoot(value, packagePath, pluginId, hasBrowserModule) {
    if (value === undefined) {
        if (hasBrowserModule)
            throw new Error(`PI WEB plugin ${pluginId} with a browser module must declare browserRoot in ${packagePath}`);
        return undefined;
    }
    if (!hasBrowserModule)
        throw new Error(`PI WEB plugin ${pluginId} must not declare browserRoot without a browser module in ${packagePath}`);
    if (typeof value !== "string" || value === "")
        throw new Error(`Invalid PI WEB plugin browserRoot for ${pluginId} in ${packagePath}`);
    if (!isSafeRelativeBrowserRootPath(value))
        throw new Error(`Unsafe PI WEB plugin browser root for ${pluginId}: ${value}`);
    return value;
}
function parseMachineSpecific(value, packagePath, pluginId) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new Error(`Invalid PI WEB plugin machineSpecific value for ${pluginId} in ${packagePath}: ${formatUnknownValue(value)}`);
    return value;
}
function applyDesiredState(plugin, config) {
    const pluginConfig = config.plugins?.[plugin.id];
    const settings = { ...(pluginConfig?.settings ?? {}) };
    return {
        ...plugin,
        enabled: pluginConfig?.enabled !== false,
        settings,
        settingsRevision: pluginSettingsRevision(settings),
    };
}
function pluginSettingsRevision(settings) {
    const canonical = JSON.stringify(canonicalJson(settings));
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return value.map(canonicalJson);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]));
}
function addUnique(records, plugin, report) {
    if (records.has(plugin.id)) {
        report(plugin.source, `Duplicate PI WEB plugin id: ${plugin.id}`, { code: "duplicate-id", pluginId: plugin.id });
        return;
    }
    records.set(plugin.id, plugin);
}
const WINDOWS_DRIVE_QUALIFIER = /^[A-Za-z]:/u;
function isSafeRelativeModulePath(path) {
    if (path === "" || path.includes("\\") || hasControlCharacter(path) || isAbsolute(path) || win32.isAbsolute(path) || WINDOWS_DRIVE_QUALIFIER.test(path))
        return false;
    return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !EXCLUDED_ARTIFACT_DIRECTORIES.has(segment));
}
function isSafeRelativeBrowserRootPath(path) {
    if (path === ".")
        return true;
    return isSafeRelativeModulePath(path) && path.split("/").every((segment) => segment !== "" && segment !== ".");
}
function isLogicalPathWithin(root, candidate) {
    return root === "." || candidate.startsWith(`${root}/`);
}
function excludedArtifactDirectory(packageRoot, directoryPath) {
    const relativeDirectory = relative(packageRoot, directoryPath);
    if (relativeDirectory === "")
        return undefined;
    return relativeDirectory.split(sep).find((segment) => EXCLUDED_ARTIFACT_DIRECTORIES.has(segment));
}
function hasControlCharacter(value) {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 32 || code === 127)
            return true;
    }
    return false;
}
function formatUnknownValue(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === null || value === undefined)
        return String(value);
    try {
        return JSON.stringify(value);
    }
    catch {
        return Object.prototype.toString.call(value);
    }
}
const nativePathPlatform = { isAbsolute, relative, sep };
export function isWithin(root, candidate, pathPlatform = nativePathPlatform) {
    const rel = pathPlatform.relative(root, candidate);
    // Windows returns an absolute relative() result when the paths are on different volumes.
    return rel === "" || (!pathPlatform.isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(pathPlatform.sep));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=piWebPluginCatalog.js.map