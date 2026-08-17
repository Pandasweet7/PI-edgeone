import { parsePiWebRuntimeResponse } from "../../shared/piWebStatusParsing.js";
import { getPiWebRuntime } from "../piWebStatus.js";
import { DEFAULT_REMOTE_HEALTH_TIMEOUT_MS, RemoteMachineClient, validateConfiguredMachineHeaders } from "./machineClient.js";
import { MachineStore } from "./machineStore.js";
const LOCAL_MACHINE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const DEFAULT_HEALTH_CACHE_TTL_MS = 5_000;
export class MachineService {
    constructor(store = new MachineStore(), deps = {}) {
        this.store = store;
        this.deps = deps;
        this.healthCache = new Map();
        this.runtimeCache = new Map();
    }
    async list() {
        return [localMachine(), ...(await this.store.list()).map(publicMachine)];
    }
    async get(id) {
        if (id === "local")
            return localMachine();
        const machine = (await this.store.list()).find((stored) => stored.id === id);
        return machine === undefined ? undefined : publicMachine(machine);
    }
    async add(input) {
        const name = validateName(input.name);
        const baseUrl = validateBaseUrl(input.baseUrl);
        const stored = await this.store.add({ name, baseUrl, ...optionalSecrets(input) });
        return publicMachine(stored);
    }
    async update(id, input) {
        if (id === "local")
            throw new Error("Local machine cannot be changed");
        const patch = {};
        if (input.name !== undefined)
            patch.name = validateName(input.name);
        if (input.baseUrl !== undefined)
            patch.baseUrl = validateBaseUrl(input.baseUrl);
        if (input.token !== undefined)
            patch.token = input.token;
        if (input.headers !== undefined)
            patch.headers = validateHeaders(input.headers);
        const stored = await this.store.update(id, patch);
        if (stored !== undefined) {
            this.healthCache.delete(id);
            this.runtimeCache.delete(id);
        }
        return stored === undefined ? undefined : publicMachine(stored);
    }
    async remove(id) {
        if (id === "local")
            throw new Error("Local machine cannot be deleted");
        const removed = await this.store.remove(id);
        if (removed) {
            this.healthCache.delete(id);
            this.runtimeCache.delete(id);
        }
        return removed;
    }
    async storedRemote(id) {
        if (id === "local")
            return undefined;
        return (await this.store.list()).find((machine) => machine.id === id);
    }
    async remoteClient(id) {
        const machine = await this.storedRemote(id);
        return machine === undefined ? undefined : this.clientFor(machine);
    }
    async health(id) {
        const cached = this.healthCache.get(id);
        const now = this.now().getTime();
        if (cached !== undefined && cached.expiresAt > now)
            return cached.health;
        const health = id === "local" ? await this.localHealth() : await this.remoteHealth(id);
        if (health === undefined)
            return undefined;
        this.healthCache.set(id, { expiresAt: now + (this.deps.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS), health });
        return health;
    }
    async runtime(id, refresh = false) {
        const cached = this.runtimeCache.get(id);
        const now = this.now().getTime();
        if (!refresh && cached !== undefined && cached.expiresAt > now)
            return cached.runtime;
        const runtime = id === "local" ? await this.localRuntime() : await this.remoteRuntime(id);
        if (runtime === undefined)
            return undefined;
        this.runtimeCache.set(id, { expiresAt: now + (this.deps.runtimeCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS), runtime });
        return runtime;
    }
    async localHealth() {
        const checkedAt = this.now().toISOString();
        try {
            const runtime = await (this.deps.localRuntime ?? getPiWebRuntime)();
            return {
                machineId: "local",
                ok: true,
                checkedAt,
                status: "online",
                web: componentStatusFromRuntime(runtime.components.web),
                sessiond: componentStatusFromRuntime(runtime.components.sessiond),
            };
        }
        catch (error) {
            return { machineId: "local", ok: false, checkedAt, status: "error", error: errorMessage(error) };
        }
    }
    async remoteHealth(id) {
        const machine = await this.storedRemote(id);
        if (machine === undefined)
            return undefined;
        const checkedAt = this.now().toISOString();
        try {
            const response = await this.clientFor(machine).requestJson("GET", "/api/pi-web/status", undefined, { timeoutMs: DEFAULT_REMOTE_HEALTH_TIMEOUT_MS });
            if (response.statusCode >= 200 && response.statusCode < 300 && isPiWebStatusResponse(response.body)) {
                return { machineId: id, ok: true, checkedAt, status: "online", web: response.body.components.web, sessiond: response.body.components.sessiond };
            }
            return { machineId: id, ok: false, checkedAt, status: "error", error: `Remote health returned HTTP ${String(response.statusCode)}` };
        }
        catch (error) {
            return { machineId: id, ok: false, checkedAt, status: "offline", error: errorMessage(error) };
        }
    }
    async localRuntime() {
        const checkedAt = this.now().toISOString();
        try {
            return machineRuntime("local", checkedAt, await (this.deps.localRuntime ?? getPiWebRuntime)());
        }
        catch (error) {
            return { machineId: "local", ok: false, checkedAt, error: errorMessage(error) };
        }
    }
    async remoteRuntime(id) {
        const machine = await this.storedRemote(id);
        if (machine === undefined)
            return undefined;
        const checkedAt = this.now().toISOString();
        try {
            const response = await this.clientFor(machine).requestJson("GET", "/api/pi-web/runtime", undefined, { timeoutMs: DEFAULT_REMOTE_HEALTH_TIMEOUT_MS });
            const runtime = parsePiWebRuntimeResponse(response.body);
            if (response.statusCode >= 200 && response.statusCode < 300 && runtime !== undefined)
                return machineRuntime(id, checkedAt, runtime);
            return { machineId: id, ok: false, checkedAt, error: `Remote runtime returned HTTP ${String(response.statusCode)}` };
        }
        catch (error) {
            return { machineId: id, ok: false, checkedAt, error: errorMessage(error) };
        }
    }
    clientFor(machine) {
        return this.deps.remoteClientFactory?.(machine) ?? new RemoteMachineClient(machine);
    }
    now() {
        return this.deps.now?.() ?? new Date();
    }
}
export function localMachine() {
    return { id: "local", name: "Local", kind: "local", createdAt: LOCAL_MACHINE_TIMESTAMP, updatedAt: LOCAL_MACHINE_TIMESTAMP };
}
function publicMachine(machine) {
    return { id: machine.id, name: machine.name, kind: "remote", baseUrl: machine.baseUrl, createdAt: machine.createdAt, updatedAt: machine.updatedAt };
}
function validateName(value) {
    const name = value?.trim();
    if (name === undefined || name === "")
        throw new Error("Machine name is required");
    return name;
}
function validateBaseUrl(value) {
    const raw = value?.trim();
    if (raw === undefined || raw === "")
        throw new Error("Machine baseUrl is required");
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error("Machine baseUrl must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Machine baseUrl must use http or https");
    if (url.username !== "" || url.password !== "")
        throw new Error("Machine baseUrl must not include credentials");
    if (url.search !== "" || url.hash !== "")
        throw new Error("Machine baseUrl must not include query or hash");
    return url.href.replace(/\/$/u, "");
}
function optionalSecrets(input) {
    return {
        ...(input.token === undefined ? {} : { token: input.token }),
        ...(input.headers === undefined ? {} : { headers: validateHeaders(input.headers) }),
    };
}
function validateHeaders(value) {
    return validateConfiguredMachineHeaders(value) ?? {};
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function componentStatusFromRuntime(runtime) {
    return {
        component: runtime.component,
        label: runtime.label,
        ...(runtime.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }),
        ...(runtime.piVersion === undefined ? {} : { piVersion: runtime.piVersion }),
        stale: false,
        available: runtime.available,
        ...(runtime.error === undefined ? {} : { error: runtime.error }),
    };
}
function machineRuntime(machineId, checkedAt, runtime) {
    const deprecatedAgentInputs = mergeComponentDeprecatedAgentInputs(runtime.components);
    return {
        machineId,
        ok: true,
        checkedAt,
        packageName: runtime.packageName,
        generatedAt: runtime.generatedAt,
        components: runtime.components,
        capabilities: runtime.capabilities,
        ...(deprecatedAgentInputs.length === 0 ? {} : { deprecatedAgentInputs }),
    };
}
/**
 * Per-machine union of the web and session daemon deprecated-input reports,
 * deduplicated by input: the config file is read by both processes, and the
 * same env var can reach both, so identical reports collapse into one warning
 * attributed to the machine rather than one per component.
 */
function mergeComponentDeprecatedAgentInputs(components) {
    const seen = new Set();
    const merged = [];
    for (const component of [components.web, components.sessiond]) {
        for (const input of component.deprecatedAgentInputs ?? []) {
            const key = `${input.source}\n${input.name}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(input);
        }
    }
    return merged;
}
function isPiWebStatusResponse(value) {
    if (!isRecord(value))
        return false;
    const components = value["components"];
    if (!isRecord(components))
        return false;
    return isPiWebComponentStatus(components["web"]) && isPiWebComponentStatus(components["sessiond"]);
}
function isPiWebComponentStatus(value) {
    if (!isRecord(value))
        return false;
    const component = value["component"];
    return (component === "web" || component === "sessiond")
        && typeof value["label"] === "string"
        && typeof value["stale"] === "boolean"
        && typeof value["available"] === "boolean";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=machineService.js.map