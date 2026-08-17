import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
class PiPackageRequestValidationError extends Error {
}
export function registerPiPackageRoutes(app, service, prefix = "/api") {
    const routePrefix = normalizeRoutePrefix(prefix);
    app.get(`${routePrefix}/pi-packages`, async (_request, reply) => {
        try {
            return await service.list();
        }
        catch (error) {
            return sendPiPackageError(reply, error);
        }
    });
    app.post(`${routePrefix}/pi-packages/install`, async (request, reply) => {
        try {
            return await service.install(parseRequiredSourceRequest(request.body));
        }
        catch (error) {
            return sendPiPackageError(reply, error);
        }
    });
    app.post(`${routePrefix}/pi-packages/remove`, async (request, reply) => {
        try {
            const body = requireRequestObject(request.body);
            return await service.remove(parseRequiredSource(body["source"]), parseOptionalScope(body["scope"]));
        }
        catch (error) {
            return sendPiPackageError(reply, error);
        }
    });
    app.post(`${routePrefix}/pi-packages/update`, async (request, reply) => {
        try {
            const source = parseOptionalUpdateSource(request.body);
            return source === undefined ? await service.update() : await service.update(source);
        }
        catch (error) {
            return sendPiPackageError(reply, error);
        }
    });
}
function normalizeRoutePrefix(prefix) {
    const normalized = prefix.replace(/\/+$/u, "");
    return normalized === "" ? "/api" : normalized;
}
function parseRequiredSourceRequest(body) {
    const request = requireRequestObject(body);
    if (request["scope"] !== undefined || request["local"] !== undefined) {
        throw new PiPackageRequestValidationError("Pi package install scope is not supported; installs use Pi's default package location");
    }
    return parseRequiredSource(request["source"]);
}
function parseRequiredSource(value) {
    if (typeof value !== "string" || value.trim() === "")
        throw new PiPackageRequestValidationError("Pi package source must be a non-empty string");
    return value.trim();
}
function parseOptionalUpdateSource(body) {
    if (body === undefined)
        return undefined;
    const source = requireRequestObject(body)["source"];
    if (source === undefined)
        return undefined;
    return parseRequiredSource(source);
}
function parseOptionalScope(value) {
    if (value === undefined)
        return undefined;
    if (value !== "user" && value !== "project")
        throw new PiPackageRequestValidationError("Pi package scope must be \"user\" or \"project\"");
    return value;
}
function requireRequestObject(value) {
    if (!isRecord(value))
        throw new PiPackageRequestValidationError("Pi package request body must be an object");
    return value;
}
function sendPiPackageError(reply, error) {
    const status = error instanceof PiPackageRequestValidationError
        ? 400
        : error instanceof ActiveAgentProfileAccessError
            ? 503
            : 500;
    return reply.code(status).send({ error: errorMessage(error) });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=piPackageRoutes.js.map