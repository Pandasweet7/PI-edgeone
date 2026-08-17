export const WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION = 1;
export function createWorkspaceProviderRuntimeSnapshot(records, health, safeStart, diagnostics = []) {
    return Object.freeze({
        protocolVersion: WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION,
        ...(safeStart === undefined ? {} : { safeStart }),
        records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
        health: Object.freeze(health.map((inspection) => Object.freeze({
            ...inspection,
            health: Object.freeze({ ...inspection.health }),
        }))),
        diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
    });
}
export class WorkspaceCatalogUnavailableError extends Error {
    constructor() {
        super(...arguments);
        this.name = "WorkspaceCatalogUnavailableError";
    }
}
export class WorkspaceCatalogProtocolError extends Error {
    constructor() {
        super(...arguments);
        this.name = "WorkspaceCatalogProtocolError";
    }
}
export class WorkspaceCatalogRequestError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "WorkspaceCatalogRequestError";
    }
}
/** Preserve route-specific legacy status codes while making authority failures explicit. */
export function workspaceCatalogHttpStatus(error, fallbackStatus) {
    if (error instanceof WorkspaceCatalogUnavailableError)
        return 503;
    if (error instanceof WorkspaceCatalogProtocolError)
        return 502;
    if (error instanceof WorkspaceCatalogRequestError) {
        if (error.statusCode === 503)
            return 503;
        if (error.statusCode >= 500)
            return 502;
    }
    return fallbackStatus;
}
//# sourceMappingURL=workspaceCatalog.js.map