import { PI_WEB_PLUGIN_LIFECYCLE_VERSION, } from "../shared/apiTypes.js";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS, pluginDisableRecoveryCommand } from "../shared/pluginRecoveryCommands.js";
/** Pure desired/active reconciliation shared by the manifest and diagnostics API. */
export function reconcilePiWebPluginLifecycle(desired, runtime, browserModuleUrl, desiredSafeStart) {
    const activeSnapshot = runtime.status === "available" ? runtime.snapshot : undefined;
    const desiredById = new Map(desired.plugins.map((plugin) => [plugin.id, plugin]));
    const recordsById = new Map(activeSnapshot?.records.map((record) => [record.pluginId, record]) ?? []);
    const healthById = new Map(activeSnapshot?.health.map((inspection) => [inspection.pluginId, inspection]) ?? []);
    const diagnostics = publicDiagnostics(desired.diagnostics, activeSnapshot?.diagnostics ?? []);
    const conflictIds = new Set(diagnostics.flatMap((diagnostic) => diagnostic.kind === "conflict" && diagnostic.pluginId !== undefined ? [diagnostic.pluginId] : []));
    const pluginIds = new Set([...desiredById.keys(), ...recordsById.keys()]);
    const browserPlugins = [];
    const activeSafeStart = activeSnapshot?.safeStart ?? "off";
    const effectiveDesiredSafeStart = desiredSafeStart ?? activeSafeStart;
    const plugins = [...pluginIds]
        .sort((left, right) => left.localeCompare(right))
        .map((pluginId) => {
        const plugin = desiredById.get(pluginId);
        const record = recordsById.get(pluginId);
        const server = plugin?.serverModule !== undefined || record !== undefined
            ? serverInfo(pluginId, plugin, record, healthById.get(pluginId), runtime.status, activeSafeStart, effectiveDesiredSafeStart)
            : undefined;
        if (plugin?.browserModule !== undefined && shouldPublishBrowserPlugin(plugin, server)) {
            browserPlugins.push({
                plugin,
                ...(server?.activeRevision === undefined ? {} : { backendRevision: server.activeRevision }),
            });
        }
        if (plugin !== undefined) {
            return {
                id: plugin.id,
                ...(plugin.browserModule === undefined ? {} : { module: browserModuleUrl(plugin) }),
                source: plugin.source,
                scope: plugin.scope,
                machineSpecific: plugin.machineSpecific,
                enabled: plugin.enabled,
                discovered: true,
                conflict: conflictIds.has(plugin.id),
                ...(server === undefined ? {} : { server }),
            };
        }
        if (record === undefined || server === undefined)
            throw new Error(`Missing active server plugin record: ${pluginId}`);
        return {
            id: record.pluginId,
            source: record.source,
            scope: record.scope,
            machineSpecific: record.machineSpecific,
            enabled: false,
            discovered: false,
            conflict: conflictIds.has(record.pluginId),
            server,
        };
    });
    const safeStartRestartRequired = desiredSafeStart === undefined
        ? false
        : runtime.status === "available"
            ? desiredSafeStart !== (activeSnapshot?.safeStart ?? "off")
            : desiredSafeStart !== "off";
    const restartRequired = safeStartRestartRequired || plugins.some((plugin) => plugin.server?.restartRequired === true);
    return {
        response: {
            lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION,
            plugins,
            diagnostics,
            serverRuntime: {
                status: runtime.status,
                ...(activeSnapshot?.safeStart === undefined ? {} : { safeStart: activeSnapshot.safeStart }),
                ...(desiredSafeStart === undefined ? {} : { desiredSafeStart }),
                restartRequired,
                ...(runtime.status === "available" ? {} : { message: runtime.message }),
                recovery: PI_WEB_PLUGIN_RECOVERY_COMMANDS,
            },
        },
        browserPlugins: Object.freeze(browserPlugins),
    };
}
function serverInfo(pluginId, desired, active, health, runtimeStatus, activeSafeStart, desiredSafeStart) {
    const staleRevision = revisionsAreStale(desired, active);
    const state = runtimeStatus !== "available"
        ? "unknown"
        : active?.state ?? (desired !== undefined && !serverEnabledForSafeStart(desired, activeSafeStart) ? "disabled" : "missing");
    const restartRequired = runtimeStatus === "available" && serverRestartRequired(desired, active, staleRevision, desiredSafeStart);
    const phase = active?.phase ?? health?.phase;
    const message = active?.message ?? health?.error;
    return {
        state,
        ...(desired?.serverModule === undefined ? {} : { desiredRevision: desired.serverModule.revision }),
        ...(active === undefined ? {} : { activeRevision: active.moduleRevision }),
        ...(phase === undefined ? {} : { phase }),
        ...(message === undefined ? {} : { message }),
        ...(health === undefined ? {} : {
            health: {
                status: health.health.status,
                ...(health.health.message === undefined ? {} : { message: health.health.message }),
            },
        }),
        staleRevision,
        restartRequired,
        disableCommand: pluginDisableRecoveryCommand(pluginId),
    };
}
function serverRestartRequired(desired, active, staleRevision, desiredSafeStart) {
    if (desired === undefined) {
        if (active === undefined)
            return false;
        return active.state !== "disabled";
    }
    const shouldBeActive = serverEnabledForSafeStart(desired, desiredSafeStart);
    if (active === undefined)
        return shouldBeActive;
    if (!shouldBeActive)
        return active.state !== "disabled";
    if (staleRevision)
        return true;
    return active.state !== "active";
}
function serverEnabledForSafeStart(plugin, safeStart) {
    return plugin.enabled
        && safeStart !== "none"
        && (safeStart !== "bundled-only" || plugin.scope === "bundled");
}
function shouldPublishBrowserPlugin(plugin, server) {
    if (plugin.browserModule === undefined)
        return false;
    if (server === undefined)
        return plugin.enabled;
    if (plugin.serverModule === undefined)
        return false;
    return server.state === "active"
        && !server.staleRevision
        && server.health?.status !== "unhealthy";
}
function revisionsAreStale(desired, active) {
    if (desired === undefined)
        return false;
    if (active === undefined)
        return false;
    const browserRevision = desired.browserModule?.revision;
    return desired.serverModule?.revision !== active.moduleRevision
        || (browserRevision !== undefined && browserRevision !== active.browserRevision)
        || desired.settingsRevision !== active.settingsRevision
        || desired.source !== active.source
        || desired.scope !== active.scope
        || desired.machineSpecific !== active.machineSpecific;
}
function publicDiagnostics(desired, active) {
    return [
        ...desired.map((diagnostic) => publicDiagnostic(diagnostic, "desired")),
        ...active.map((diagnostic) => publicDiagnostic(diagnostic, "active")),
    ];
}
function publicDiagnostic(diagnostic, snapshot) {
    return {
        kind: diagnostic.code === "duplicate-id" ? "conflict" : "discovery",
        snapshot,
        source: diagnostic.source,
        message: diagnostic.message,
        ...(diagnostic.pluginId === undefined ? {} : { pluginId: diagnostic.pluginId }),
    };
}
//# sourceMappingURL=piWebPluginLifecycle.js.map