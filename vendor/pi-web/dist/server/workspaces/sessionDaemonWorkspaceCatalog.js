import { isAbsolute } from "node:path";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { WorkspaceCatalogProtocolError, WorkspaceCatalogRequestError, WorkspaceCatalogUnavailableError, WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION, } from "./workspaceCatalog.js";
const WORKSPACE_CATALOG_PATH = "/workspace-catalog";
/** Narrow web adapter over sessiond's internal workspace-authority protocol. */
export class SessionDaemonWorkspaceCatalog {
    constructor(daemon) {
        this.daemon = daemon;
    }
    async resolveProject(projectId) {
        const value = await this.requestJson(`${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces`);
        return parseWorkspaceProviderResolution(value, projectId);
    }
    async list(projectId) {
        return [...(await this.resolveProject(projectId)).workspaces];
    }
    async resolve(projectId, workspaceId) {
        const value = await this.requestJson(`${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces/${encodedId(workspaceId, "workspace")}`);
        const workspace = parseWorkspace(value, "workspace resolution response");
        if (workspace.projectId !== projectId || workspace.id !== workspaceId) {
            throw protocolError("workspace resolution response did not match the requested project and workspace");
        }
        return workspace;
    }
    async providerRuntime() {
        return parseProviderRuntimeSnapshot(await this.requestJson(`${WORKSPACE_CATALOG_PATH}/provider-runtime`));
    }
    async requestJson(path) {
        let response;
        try {
            response = await this.daemon.request("GET", path);
        }
        catch (error) {
            throw new WorkspaceCatalogUnavailableError(`Session daemon workspace authority unavailable: ${errorMessage(error)}`, { cause: error });
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            if (isUnknownWorkspaceCatalogRoute(response.statusCode, response.body)) {
                throw new WorkspaceCatalogProtocolError("Session daemon does not support workspace authority operations; restart or upgrade the session daemon");
            }
            throw new WorkspaceCatalogRequestError(workspaceCatalogRequestMessage(response.statusCode, response.body), response.statusCode);
        }
        try {
            if (response.body === "")
                return undefined;
            const value = JSON.parse(response.body);
            return value;
        }
        catch (error) {
            throw new WorkspaceCatalogProtocolError("Session daemon workspace authority returned invalid JSON", { cause: error });
        }
    }
}
function parseWorkspaceProviderResolution(value, expectedProjectId) {
    if (!isRecord(value))
        throw protocolError("workspace resolution response must be an object");
    const status = parseWorkspaceProviderResolutionStatus(value["status"]);
    const projectId = requireString(value, "projectId", "workspace resolution response");
    if (projectId !== expectedProjectId)
        throw protocolError("workspace resolution response did not match the requested project");
    const ownerPluginId = optionalPluginId(value, "ownerPluginId", "workspace resolution response");
    if (status === "provider" && ownerPluginId === undefined) {
        throw protocolError("provider workspace resolution must identify its owner");
    }
    if (status === "folder" && ownerPluginId !== undefined) {
        throw protocolError("folder workspace resolution must not identify a provider owner");
    }
    const workspaces = parseWorkspaceList(value["workspaces"], projectId);
    const diagnostics = parseArray(value["diagnostics"], "workspace provider diagnostics", parseWorkspaceProviderDiagnostic);
    return Object.freeze({
        status,
        projectId,
        ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
        workspaces: Object.freeze(workspaces),
        diagnostics: Object.freeze(diagnostics),
    });
}
function parseWorkspaceProviderResolutionStatus(value) {
    if (value === "provider" || value === "folder" || value === "degraded")
        return value;
    throw protocolError("workspace resolution status is invalid");
}
function parseWorkspaceProviderDiagnostic(value, index) {
    const label = `workspace provider diagnostic ${String(index + 1)}`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const code = parseWorkspaceProviderDiagnosticCode(value["code"], label);
    const tier = parseWorkspaceProviderTier(value["tier"], label);
    const pluginId = optionalPluginId(value, "pluginId", label);
    const pluginIds = value["pluginIds"] === undefined
        ? undefined
        : parsePluginIds(value["pluginIds"], `${label} pluginIds`);
    return Object.freeze({
        code,
        message: requireString(value, "message", label),
        tier,
        ...(pluginId === undefined ? {} : { pluginId }),
        ...(pluginIds === undefined ? {} : { pluginIds: Object.freeze(pluginIds) }),
    });
}
function parseWorkspaceProviderDiagnosticCode(value, label) {
    if (value === "probe-failed" || value === "claim-conflict" || value === "list-failed")
        return value;
    throw protocolError(`${label} code is invalid`);
}
function parseWorkspaceProviderTier(value, label) {
    if (value === "primary" || value === "fallback")
        return value;
    throw protocolError(`${label} tier is invalid`);
}
function parsePluginIds(value, label) {
    if (!Array.isArray(value))
        throw protocolError(`${label} must be an array`);
    return value.map((pluginId, index) => {
        if (typeof pluginId !== "string" || !isPiWebPluginId(pluginId)) {
            throw protocolError(`${label} item ${String(index + 1)} is invalid`);
        }
        return pluginId;
    });
}
function parseWorkspaceList(value, projectId) {
    if (!Array.isArray(value) || value.length === 0)
        throw protocolError("workspace list must be a non-empty array");
    const ids = new Set();
    const paths = new Set();
    const workspaces = value.map((item, index) => parseWorkspace(item, `workspace list item ${String(index + 1)}`));
    let mainCount = 0;
    for (const workspace of workspaces) {
        if (workspace.projectId !== projectId)
            throw protocolError("workspace list contained a workspace for another project");
        if (ids.has(workspace.id))
            throw protocolError(`workspace list contained duplicate id: ${workspace.id}`);
        if (paths.has(workspace.path))
            throw protocolError(`workspace list contained duplicate path: ${workspace.path}`);
        ids.add(workspace.id);
        paths.add(workspace.path);
        if (workspace.isMain)
            mainCount += 1;
    }
    if (mainCount !== 1)
        throw protocolError("workspace list must contain exactly one main workspace");
    return workspaces;
}
function parseWorkspace(value, label) {
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const path = requireString(value, "path", label);
    if (!isAbsolute(path))
        throw protocolError(`${label} path must be absolute`);
    const provider = value["provider"] === undefined ? undefined : parseProvider(value["provider"], label);
    const removal = value["removal"] === undefined ? undefined : parseRemoval(value["removal"], label);
    return Object.freeze({
        id: requireString(value, "id", label),
        projectId: requireString(value, "projectId", label),
        path,
        label: requireString(value, "label", label),
        isMain: requireBoolean(value, "isMain", label),
        ...(provider === undefined ? {} : { provider }),
        ...(removal === undefined ? {} : { removal }),
    });
}
function parseProvider(value, workspaceLabel) {
    const label = `${workspaceLabel} provider`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const capabilities = value["capabilities"];
    if (!isRecord(capabilities))
        throw protocolError(`${label} capabilities must be an object`);
    const metadata = value["metadata"] === undefined ? undefined : parseJsonObject(value["metadata"], `${label} metadata`);
    return Object.freeze({
        pluginId: requirePluginId(value, "pluginId", label),
        capabilities: Object.freeze({
            request: requireBoolean(capabilities, "request", `${label} capabilities`),
            remove: requireBoolean(capabilities, "remove", `${label} capabilities`),
        }),
        ...(metadata === undefined ? {} : { metadata }),
    });
}
function parseRemoval(value, workspaceLabel) {
    const label = `${workspaceLabel} removal`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    return Object.freeze({
        actionLabel: requireString(value, "actionLabel", label),
        confirmation: requireString(value, "confirmation", label),
        precondition: requireString(value, "precondition", label),
    });
}
function parseProviderRuntimeSnapshot(value) {
    if (!isRecord(value))
        throw protocolError("provider runtime response must be an object");
    if (value["protocolVersion"] !== WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION) {
        throw protocolError("provider runtime protocol is unsupported; restart or upgrade the session daemon");
    }
    const safeStart = parseSafeStart(value["safeStart"]);
    const records = parseArray(value["records"], "provider runtime records", parseRuntimeRecord);
    const health = parseArray(value["health"], "provider runtime health", parseHealthInspection);
    const diagnostics = parseArray(value["diagnostics"], "provider runtime diagnostics", parseCatalogDiagnostic);
    return Object.freeze({
        protocolVersion: WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION,
        ...(safeStart === undefined ? {} : { safeStart }),
        records: Object.freeze(records),
        health: Object.freeze(health),
        diagnostics: Object.freeze(diagnostics),
    });
}
function parseRuntimeRecord(value, index) {
    const label = `provider runtime record ${String(index + 1)}`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const state = value["state"];
    const scope = value["scope"];
    const phase = value["phase"];
    if (!isRuntimeState(state))
        throw protocolError(`${label} state is invalid`);
    if (scope !== "bundled" && scope !== "local" && scope !== "user" && scope !== "project") {
        throw protocolError(`${label} scope is invalid`);
    }
    if (phase !== undefined && !isLifecyclePhase(phase))
        throw protocolError(`${label} phase is invalid`);
    const name = optionalString(value, "name", label);
    const message = optionalString(value, "message", label);
    const browserRevision = optionalString(value, "browserRevision", label);
    return Object.freeze({
        pluginId: requirePluginId(value, "pluginId", label),
        source: requireString(value, "source", label),
        scope,
        moduleRevision: requireString(value, "moduleRevision", label),
        ...(browserRevision === undefined ? {} : { browserRevision }),
        settingsRevision: requireString(value, "settingsRevision", label),
        machineSpecific: requireBoolean(value, "machineSpecific", label),
        state,
        ...(name === undefined ? {} : { name }),
        ...(phase === undefined ? {} : { phase }),
        ...(message === undefined ? {} : { message }),
    });
}
function parseCatalogDiagnostic(value, index) {
    const label = `provider runtime diagnostic ${String(index + 1)}`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const code = value["code"];
    if (!isCatalogDiagnosticCode(code))
        throw protocolError(`${label} code is invalid`);
    const pluginId = optionalPluginId(value, "pluginId", label);
    return Object.freeze({
        code,
        source: requireString(value, "source", label),
        message: requireString(value, "message", label),
        ...(pluginId === undefined ? {} : { pluginId }),
    });
}
function parseHealthInspection(value, index) {
    const label = `provider runtime health item ${String(index + 1)}`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const phase = value["phase"];
    if (phase !== undefined && phase !== "health")
        throw protocolError(`${label} phase is invalid`);
    const error = optionalString(value, "error", label);
    return Object.freeze({
        pluginId: requirePluginId(value, "pluginId", label),
        health: parseHealth(value["health"], label),
        ...(phase === undefined ? {} : { phase }),
        ...(error === undefined ? {} : { error }),
    });
}
function parseHealth(value, inspectionLabel) {
    const label = `${inspectionLabel} health`;
    if (!isRecord(value))
        throw protocolError(`${label} must be an object`);
    const status = value["status"];
    if (status !== "healthy" && status !== "degraded" && status !== "unhealthy") {
        throw protocolError(`${label} status is invalid`);
    }
    const message = optionalString(value, "message", label);
    const details = value["details"] === undefined ? undefined : parseJsonObject(value["details"], `${label} details`);
    return Object.freeze({
        status,
        ...(message === undefined ? {} : { message }),
        ...(details === undefined ? {} : { details }),
    });
}
function parseSafeStart(value) {
    if (value === undefined)
        return undefined;
    if (value === "bundled-only" || value === "none")
        return value;
    throw protocolError("provider runtime safeStart is invalid");
}
function parseArray(value, label, parse) {
    if (!Array.isArray(value))
        throw protocolError(`${label} must be an array`);
    return value.map(parse);
}
function parseJsonObject(value, label) {
    if (!isRecord(value))
        throw protocolError(`${label} must be a JSON object`);
    const output = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, parseJsonValue(child, label)]));
    Object.freeze(output);
    return output;
}
function parseJsonValue(value, label) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value)) {
        const output = value.map((item) => parseJsonValue(item, label));
        Object.freeze(output);
        return output;
    }
    if (isRecord(value))
        return parseJsonObject(value, label);
    throw protocolError(`${label} must contain only JSON values`);
}
function requireString(record, field, label) {
    const value = record[field];
    if (typeof value !== "string" || value === "")
        throw protocolError(`${label} ${field} must be a non-empty string`);
    return value;
}
function optionalString(record, field, label) {
    const value = record[field];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw protocolError(`${label} ${field} must be a string`);
    return value;
}
function requirePluginId(record, field, label) {
    const value = requireString(record, field, label);
    if (!isPiWebPluginId(value))
        throw protocolError(`${label} ${field} is invalid`);
    return value;
}
function optionalPluginId(record, field, label) {
    const value = optionalString(record, field, label);
    if (value !== undefined && !isPiWebPluginId(value))
        throw protocolError(`${label} ${field} is invalid`);
    return value;
}
function requireBoolean(record, field, label) {
    const value = record[field];
    if (typeof value !== "boolean")
        throw protocolError(`${label} ${field} must be a boolean`);
    return value;
}
function isRuntimeState(value) {
    return value === "active" || value === "failed" || value === "incompatible" || value === "disabled";
}
function isLifecyclePhase(value) {
    return value === "import" || value === "activate" || value === "validate" || value === "start" || value === "health" || value === "stop";
}
function isCatalogDiagnosticCode(value) {
    return value === "invalid-package" || value === "duplicate-id";
}
function encodedId(value, label) {
    if (value === "")
        throw new Error(`${label} id must be a non-empty string`);
    return encodeURIComponent(value);
}
function workspaceCatalogRequestMessage(statusCode, body) {
    const detail = responseError(body);
    if (statusCode < 500 && detail !== undefined)
        return detail;
    return `Session daemon workspace authority returned HTTP ${String(statusCode)}${detail === undefined ? "" : `: ${detail}`}`;
}
function responseError(body) {
    const value = parseResponseBody(body);
    return isRecord(value) && typeof value["error"] === "string" ? value["error"] : undefined;
}
function isUnknownWorkspaceCatalogRoute(statusCode, body) {
    if (statusCode !== 404)
        return false;
    const value = parseResponseBody(body);
    if (!isRecord(value))
        return true;
    const error = value["error"];
    const message = value["message"];
    return error === "Not Found" || (typeof message === "string" && /^Route .* not found$/u.test(message));
}
function parseResponseBody(body) {
    try {
        if (body === "")
            return undefined;
        const value = JSON.parse(body);
        return value;
    }
    catch {
        return undefined;
    }
}
function protocolError(message) {
    return new WorkspaceCatalogProtocolError(`Invalid session daemon workspace authority response: ${message}`);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=sessionDaemonWorkspaceCatalog.js.map