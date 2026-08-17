import { loadPiWebConfig, parseAgentConfig, parseUploadsConfig, resolveEffectivePiWebConfig, savePiWebConfig } from "../config.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";
export const SELECTED_MACHINE_CONFIG_KEYS = [
    "plugins",
    "pathAccess",
    "uploads",
    "maxUploadBytes",
    "spawnSessions",
    "subsessions",
    "askUser",
    "agent",
];
const SELECTED_MACHINE_CONFIG_KEY_SET = new Set(SELECTED_MACHINE_CONFIG_KEYS);
export function createFilePiWebConfigService(options = {}) {
    return {
        read: () => currentPiWebConfigResponse(options),
        write: (config) => {
            savePiWebConfig(config, options);
            return currentPiWebConfigResponse(options);
        },
    };
}
export function currentPiWebConfigResponse(options = {}) {
    const loaded = loadPiWebConfig(options);
    const effective = resolveEffectivePiWebConfig(loaded, options);
    const env = options.env ?? process.env;
    return {
        path: loaded.path,
        exists: loaded.exists,
        config: loaded.config,
        effectiveConfig: effective.config,
        envOverrides: piWebConfigEnvOverrides(env),
    };
}
export function registerConfigRoutes(app, service = createFilePiWebConfigService()) {
    app.get("/api/config", async (_request, reply) => {
        try {
            return await service.read();
        }
        catch (error) {
            return reply.code(500).send({ error: errorMessage(error) });
        }
    });
    app.put("/api/config", async (request, reply) => {
        try {
            return await service.write(parseConfigRequest(request.body?.config));
        }
        catch (error) {
            const status = isConfigValidationError(error) ? 400 : 500;
            return reply.code(status).send({ error: errorMessage(error) });
        }
    });
}
export function registerLocalMachineConfigRoutes(app, service = createFilePiWebConfigService()) {
    app.get("/api/machines/local/config", async (_request, reply) => {
        try {
            return selectedMachineConfigResponse(await service.read());
        }
        catch (error) {
            return reply.code(500).send({ error: errorMessage(error) });
        }
    });
    app.put("/api/machines/local/config", async (request, reply) => {
        try {
            const current = await service.read();
            const patch = parseSelectedMachineConfigRequest(request.body?.config);
            return selectedMachineConfigResponse(await service.write(mergeSelectedMachineConfig(current.config, patch)));
        }
        catch (error) {
            const status = isConfigValidationError(error) ? 400 : 500;
            return reply.code(status).send({ error: errorMessage(error) });
        }
    });
}
export function parseSelectedMachineConfigRequest(value, agentPathHost = "current") {
    if (!isRecord(value))
        throw new Error("PI WEB selected-machine config update must include a config object");
    for (const key of Object.keys(value)) {
        if (!SELECTED_MACHINE_CONFIG_KEY_SET.has(key))
            throw new Error(`PI WEB selected-machine config key is not allowed: ${key}`);
    }
    try {
        return pickSelectedMachineConfig(parseConfigRequest(value, agentPathHost));
    }
    catch (error) {
        throw new Error(selectedMachineConfigErrorMessage(error), { cause: error });
    }
}
export function mergeSelectedMachineConfig(current, patch) {
    return { ...current, ...pickSelectedMachineConfig(patch) };
}
export function selectedMachineConfigResponse(response) {
    return {
        ...response,
        config: pickSelectedMachineConfig(response.config),
        effectiveConfig: pickSelectedMachineConfig(response.effectiveConfig),
    };
}
export function parsePiWebConfigResponseBody(value, source = "PI WEB config response") {
    const record = requireResponseRecord(value, source);
    return {
        path: requireResponseString(record, "path", source),
        exists: requireResponseBoolean(record, "exists", source),
        config: parseConfigRequest(record["config"], "portable"),
        effectiveConfig: parseConfigRequest(record["effectiveConfig"], "portable"),
        envOverrides: parsePiWebConfigEnvOverridesResponse(record["envOverrides"], source),
    };
}
function parseConfigRequest(value, agentPathHost = "current") {
    if (!isRecord(value))
        throw new Error("PI WEB config update must include a config object");
    const config = {};
    const host = value["host"];
    const port = value["port"];
    const allowedHosts = value["allowedHosts"];
    const shortcuts = value["shortcuts"];
    const plugins = value["plugins"];
    const pathAccess = value["pathAccess"];
    const uploads = value["uploads"];
    const maxUploadBytes = value["maxUploadBytes"];
    const spawnSessions = value["spawnSessions"];
    const subsessions = value["subsessions"];
    const askUser = value["askUser"];
    const agent = value["agent"];
    if (host !== undefined) {
        if (typeof host !== "string")
            throw new Error("PI WEB config host must be a string");
        config.host = host;
    }
    if (port !== undefined) {
        if (typeof port !== "number")
            throw new Error("PI WEB config port must be a number");
        config.port = port;
    }
    if (allowedHosts !== undefined)
        config.allowedHosts = parseAllowedHostsRequest(allowedHosts);
    if (shortcuts !== undefined)
        config.shortcuts = parseShortcutsRequest(shortcuts);
    if (plugins !== undefined)
        config.plugins = parsePluginsRequest(plugins);
    if (pathAccess !== undefined)
        config.pathAccess = parsePathAccessRequest(pathAccess);
    if (uploads !== undefined)
        config.uploads = parseUploadsConfig(uploads, "request");
    if (maxUploadBytes !== undefined)
        config.maxUploadBytes = parseMaxUploadBytesRequest(maxUploadBytes);
    if (spawnSessions !== undefined) {
        if (typeof spawnSessions !== "boolean")
            throw new Error("PI WEB config spawnSessions must be a boolean");
        config.spawnSessions = spawnSessions;
    }
    if (subsessions !== undefined) {
        if (typeof subsessions !== "boolean")
            throw new Error("PI WEB config subsessions must be a boolean");
        config.subsessions = subsessions;
    }
    if (askUser !== undefined) {
        if (typeof askUser !== "boolean")
            throw new Error("PI WEB config askUser must be a boolean");
        config.askUser = askUser;
    }
    if (agent !== undefined)
        config.agent = parseAgentRequest(agent, agentPathHost);
    return config;
}
function pickSelectedMachineConfig(config) {
    return {
        ...(config.plugins !== undefined ? { plugins: config.plugins } : {}),
        ...(config.pathAccess !== undefined ? { pathAccess: config.pathAccess } : {}),
        ...(config.uploads !== undefined ? { uploads: config.uploads } : {}),
        ...(config.maxUploadBytes !== undefined ? { maxUploadBytes: config.maxUploadBytes } : {}),
        ...(config.spawnSessions !== undefined ? { spawnSessions: config.spawnSessions } : {}),
        ...(config.subsessions !== undefined ? { subsessions: config.subsessions } : {}),
        ...(config.askUser !== undefined ? { askUser: config.askUser } : {}),
        ...(config.agent !== undefined ? { agent: config.agent } : {}),
    };
}
function selectedMachineConfigErrorMessage(error) {
    const message = errorMessage(error);
    if (message.startsWith("PI WEB config "))
        return `PI WEB selected-machine config ${message.slice("PI WEB config ".length)}`;
    return `PI WEB selected-machine config ${message}`;
}
function parseAllowedHostsRequest(value) {
    if (value === true)
        return true;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error("PI WEB config allowedHosts must be true or an array of strings");
    }
    return value;
}
function parseShortcutsRequest(value) {
    if (!isRecord(value))
        throw new Error("PI WEB config shortcuts must be an object");
    return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
        if (shortcut !== null && (typeof shortcut !== "string" || shortcut === ""))
            throw new Error("PI WEB config shortcut values must be non-empty strings or null");
        return [actionId, shortcut];
    }));
}
function parsePathAccessRequest(value) {
    if (!isRecord(value))
        throw new Error("PI WEB config pathAccess must be an object");
    const allowedPaths = value["allowedPaths"];
    return {
        ...(allowedPaths === undefined ? {} : { allowedPaths: parseAllowedPathsRequest(allowedPaths) }),
    };
}
function parseAllowedPathsRequest(value) {
    if (!isNonEmptyStringArray(value)) {
        throw new Error("PI WEB config pathAccess.allowedPaths must be an array of non-empty strings");
    }
    return value;
}
function isNonEmptyStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}
function parseMaxUploadBytesRequest(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Error("PI WEB config maxUploadBytes must be a positive integer");
    return value;
}
function parseAgentRequest(value, pathHost) {
    return parseAgentConfig(value, "request", pathHost);
}
function parsePluginsRequest(value) {
    if (!isRecord(value) || Array.isArray(value))
        throw new Error("PI WEB config plugins must be an object");
    return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
        if (!isPiWebPluginId(pluginId))
            throw new Error("PI WEB config plugin ids are invalid");
        if (!isRecord(config) || Array.isArray(config))
            throw new Error("PI WEB config plugin entries must be objects");
        const enabled = config["enabled"];
        if (enabled !== undefined && typeof enabled !== "boolean")
            throw new Error("PI WEB config plugin enabled values must be booleans");
        const settings = config["settings"];
        if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings)))
            throw new Error("PI WEB config plugin settings must be objects");
        return [pluginId, config];
    }));
}
function parsePiWebConfigEnvOverridesResponse(value, source) {
    const record = requireResponseRecord(value, `${source} envOverrides`);
    return {
        host: requireResponseBoolean(record, "host", source),
        port: requireResponseBoolean(record, "port", source),
        allowedHosts: requireResponseBoolean(record, "allowedHosts", source),
        spawnSessions: requireResponseBoolean(record, "spawnSessions", source),
        subsessions: requireResponseBoolean(record, "subsessions", source),
        askUser: requireResponseBoolean(record, "askUser", source),
    };
}
function requireResponseRecord(value, source) {
    if (!isRecord(value))
        throw new Error(`${source} must be an object`);
    return value;
}
function requireResponseString(record, key, source) {
    const value = record[key];
    if (typeof value !== "string")
        throw new Error(`${source} field must be a string: ${key}`);
    return value;
}
function requireResponseBoolean(record, key, source) {
    const value = record[key];
    if (typeof value !== "boolean")
        throw new Error(`${source} field must be a boolean: ${key}`);
    return value;
}
function piWebConfigEnvOverrides(env) {
    return {
        host: isEnvSet(env["PI_WEB_HOST"]),
        port: isEnvSet(env["PI_WEB_PORT"]) || isEnvSet(env["PORT"]),
        allowedHosts: isEnvSet(env["PI_WEB_ALLOWED_HOSTS"]),
        spawnSessions: isEnvSet(env["PI_WEB_SPAWN_SESSIONS"]),
        subsessions: isEnvSet(env["PI_WEB_SUBSESSIONS"]),
        askUser: isEnvSet(env["PI_WEB_ASK_USER"]),
    };
}
function isEnvSet(value) {
    return value !== undefined && value !== "";
}
function isConfigValidationError(error) {
    return error instanceof Error && (error.message.startsWith("PI WEB config") || error.message.startsWith("PI WEB selected-machine config"));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=configRoutes.js.map