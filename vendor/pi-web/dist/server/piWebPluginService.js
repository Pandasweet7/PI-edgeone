import { PI_WEB_PLUGIN_LIFECYCLE_VERSION } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";
import { PiWebPluginCatalog, readPiWebPluginPackageArtifact, } from "./piWebPluginCatalog.js";
import { reconcilePiWebPluginLifecycle } from "./piWebPluginLifecycle.js";
import { WorkspaceCatalogProtocolError } from "./workspaces/workspaceCatalog.js";
export { DefaultPiPackageProvider, PiWebPluginCatalog, } from "./piWebPluginCatalog.js";
const BROWSER_ARTIFACT_CACHE_MAX_ENTRIES = 32;
const BROWSER_ARTIFACT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Browser manifest and asset adapter over the process-neutral package catalog. */
export class PiWebPluginService {
    constructor(options = {}) {
        this.browserArtifacts = new Map();
        this.browserArtifactBytes = 0;
        this.catalog = options.catalog ?? new PiWebPluginCatalog(options);
        this.runtimeProvider = options.runtimeProvider;
        this.recoveryProvider = options.recoveryProvider;
    }
    async manifest() {
        const lifecycle = await this.lifecycle();
        const plugins = [];
        for (const { plugin, backendRevision } of lifecycle.browserPlugins) {
            const artifact = await this.captureBrowserArtifact(plugin, backendRevision);
            if (artifact === undefined)
                continue;
            plugins.push({
                id: plugin.id,
                module: browserModuleUrl(plugin),
                ...(backendRevision === undefined ? {} : { backendRevision }),
                source: plugin.source,
                scope: plugin.scope,
                machineSpecific: plugin.machineSpecific,
            });
        }
        return { lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, plugins };
    }
    async plugins() {
        return (await this.lifecycle()).response;
    }
    async readAsset(pluginId, assetPath, browserRevision) {
        if (!isPiWebPluginId(pluginId))
            return undefined;
        let artifact = this.browserArtifacts.get(pluginId);
        if (artifact !== undefined && !await this.cachedArtifactIsActive(artifact))
            artifact = undefined;
        artifact ??= await this.loadBrowserArtifact(pluginId);
        if (artifact === undefined)
            return undefined;
        if (browserRevision !== undefined && assetPath === artifact.entryPath && artifact.revision !== browserRevision)
            return undefined;
        const content = artifact.files.get(assetPath);
        if (content === undefined)
            return undefined;
        this.touchBrowserArtifact(artifact);
        return { content, contentType: contentTypeFor(assetPath) };
    }
    async loadBrowserArtifact(pluginId) {
        try {
            const lifecycle = await this.lifecycle();
            const browserPlugin = lifecycle.browserPlugins.find(({ plugin }) => plugin.id === pluginId);
            if (browserPlugin === undefined)
                return undefined;
            return await this.captureBrowserArtifact(browserPlugin.plugin, browserPlugin.backendRevision);
        }
        catch (error) {
            const localPlugin = await this.catalog.browserPlugin(pluginId);
            if (localPlugin?.serverModule !== undefined)
                throw error;
            return localPlugin === undefined ? undefined : await this.captureBrowserArtifact(localPlugin);
        }
    }
    async captureBrowserArtifact(plugin, backendRevision) {
        const module = plugin.browserModule;
        if (module === undefined)
            return undefined;
        const browserRoot = plugin.browserRoot;
        if (browserRoot === undefined)
            throw new Error(`PI WEB plugin has no browser root: ${plugin.id}`);
        const cached = this.browserArtifacts.get(plugin.id);
        if (cached !== undefined) {
            const matches = cached.revision === module.revision
                && cached.entryPath === module.path
                && cached.entryFilePath === module.filePath
                && cached.browserRootPath === browserRoot.path
                && cached.browserRootDirectoryPath === browserRoot.directoryPath
                && cached.packageRoot === plugin.packageRoot
                && cached.backendRevision === backendRevision;
            if (matches) {
                this.touchBrowserArtifact(cached);
                return cached;
            }
        }
        const packageArtifact = await readPiWebPluginPackageArtifact(plugin.packageRoot, browserRoot).catch(() => undefined);
        if (packageArtifact?.revision !== module.revision || !packageArtifact.files.has(module.path))
            return undefined;
        const artifact = {
            pluginId: plugin.id,
            revision: module.revision,
            entryPath: module.path,
            entryFilePath: module.filePath,
            browserRootPath: browserRoot.path,
            browserRootDirectoryPath: browserRoot.directoryPath,
            packageRoot: plugin.packageRoot,
            ...(backendRevision === undefined ? {} : { backendRevision }),
            files: packageArtifact.files,
            byteLength: packageArtifact.byteLength,
        };
        this.cacheBrowserArtifact(artifact);
        return artifact;
    }
    async cachedArtifactIsActive(artifact) {
        if (artifact.backendRevision === undefined)
            return true;
        const runtime = await this.loadRuntime();
        if (runtime.status !== "available")
            return false;
        const record = runtime.snapshot.records.find(({ pluginId }) => pluginId === artifact.pluginId);
        const health = runtime.snapshot.health.find(({ pluginId }) => pluginId === artifact.pluginId);
        return record?.state === "active"
            && record.moduleRevision === artifact.backendRevision
            && record.browserRevision === artifact.revision
            && health?.health.status !== "unhealthy";
    }
    cacheBrowserArtifact(artifact) {
        const current = this.browserArtifacts.get(artifact.pluginId);
        if (current !== undefined) {
            this.browserArtifacts.delete(artifact.pluginId);
            this.browserArtifactBytes -= current.byteLength;
        }
        while (this.browserArtifacts.size >= BROWSER_ARTIFACT_CACHE_MAX_ENTRIES
            || this.browserArtifactBytes + artifact.byteLength > BROWSER_ARTIFACT_CACHE_MAX_BYTES) {
            const oldest = this.browserArtifacts.values().next().value;
            if (oldest === undefined)
                break;
            this.browserArtifacts.delete(oldest.pluginId);
            this.browserArtifactBytes -= oldest.byteLength;
        }
        this.browserArtifacts.set(artifact.pluginId, artifact);
        this.browserArtifactBytes += artifact.byteLength;
    }
    touchBrowserArtifact(artifact) {
        if (this.browserArtifacts.get(artifact.pluginId) !== artifact)
            return;
        this.browserArtifacts.delete(artifact.pluginId);
        this.browserArtifacts.set(artifact.pluginId, artifact);
    }
    async lifecycle() {
        const desired = await this.catalog.snapshot();
        const [runtime, desiredSafeStart] = await Promise.all([this.loadRuntime(), this.loadDesiredSafeStart()]);
        return reconcilePiWebPluginLifecycle(desired, runtime, browserModuleUrl, desiredSafeStart);
    }
    async loadDesiredSafeStart() {
        if (this.recoveryProvider === undefined)
            return undefined;
        return (await this.recoveryProvider()).safeStart ?? "off";
    }
    async loadRuntime() {
        if (this.runtimeProvider === undefined) {
            return { status: "unavailable", message: "Session daemon server-plugin runtime is unavailable" };
        }
        try {
            return { status: "available", snapshot: await this.runtimeProvider.providerRuntime() };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                status: error instanceof WorkspaceCatalogProtocolError ? "incompatible" : "unavailable",
                message,
            };
        }
    }
}
function browserModuleUrl(plugin) {
    const browserModule = plugin.browserModule;
    if (browserModule === undefined)
        throw new Error(`PI WEB plugin has no browser module: ${plugin.id}`);
    const path = browserModule.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `/pi-web-plugins/${encodeURIComponent(plugin.id)}/${path}?${pluginModuleQuery(plugin.id, browserModule.revision)}`;
}
function pluginModuleQuery(pluginId, revision) {
    const params = new URLSearchParams({ v: revision });
    const dockerMode = pluginId === "updates" ? dockerModeFromEnv() : undefined;
    if (dockerMode !== undefined)
        params.set("piWebDockerMode", dockerMode);
    return params.toString();
}
function dockerModeFromEnv() {
    if (!isTruthyEnv("PI_WEB_DOCKER_RUNTIME"))
        return undefined;
    const mode = process.env["PI_WEB_DOCKER_MODE"];
    if (mode === "runtime" || mode === "dev")
        return mode;
    if (firstNonEmptyEnv("PI_WEB_DOCKER_DEV_REPO_ROOT") !== undefined)
        return "dev";
    if (firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR") !== undefined)
        return "runtime";
    return undefined;
}
function firstNonEmptyEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value !== "")
            return value;
    }
    return undefined;
}
function isTruthyEnv(key) {
    const value = process.env[key];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
function contentTypeFor(path) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith(".js") || lowerPath.endsWith(".mjs"))
        return "application/javascript; charset=utf-8";
    if (lowerPath.endsWith(".json"))
        return "application/json; charset=utf-8";
    if (lowerPath.endsWith(".css"))
        return "text/css; charset=utf-8";
    if (lowerPath.endsWith(".html"))
        return "text/html; charset=utf-8";
    if (lowerPath.endsWith(".svg"))
        return "image/svg+xml";
    return "application/octet-stream";
}
//# sourceMappingURL=piWebPluginService.js.map