import { PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES, PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES, utf8ByteLength, } from "../../shared/pluginBackendProtocol.js";
/** Browser-facing local route; all owner resolution and execution stays in sessiond. */
export function registerPluginBackendProxyRoutes(app, daemon, prefix = "/api/plugin-backends") {
    app.post(`${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation`, { bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES }, async (request, reply) => {
        const path = daemonPluginBackendPath(request.params);
        let upstream;
        try {
            upstream = await daemon.request("POST", path, request.body);
        }
        catch (error) {
            return reply.code(502).send({
                error: `Session daemon unavailable: ${errorMessage(error)}`,
                code: "daemon-unavailable",
                pluginId: request.params.pluginId,
                operation: request.params.operation,
            });
        }
        if (upstream.body === "" || utf8ByteLength(upstream.body) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
            return daemonProtocolError(reply, request.params, "Session daemon plugin backend returned an invalid response size");
        }
        let body;
        try {
            body = JSON.parse(upstream.body);
        }
        catch {
            return daemonProtocolError(reply, request.params, "Session daemon plugin backend returned invalid JSON");
        }
        if (isUnknownPluginBackendRoute(upstream.statusCode, body)) {
            return daemonProtocolError(reply, request.params, "Session daemon does not support plugin backend requests; restart or upgrade the session daemon");
        }
        return await reply
            .code(upstream.statusCode)
            .type("application/json; charset=utf-8")
            .send(upstream.body);
    });
}
function daemonPluginBackendPath(params) {
    return [
        "/plugin-backends",
        encodeURIComponent(params.pluginId),
        "projects",
        encodeURIComponent(params.projectId),
        "workspaces",
        encodeURIComponent(params.workspaceId),
        encodeURIComponent(params.operation),
    ].join("/");
}
function daemonProtocolError(reply, params, message) {
    return reply.code(502).send({
        error: message,
        code: "daemon-protocol-error",
        pluginId: params.pluginId,
        operation: params.operation,
    });
}
function isUnknownPluginBackendRoute(statusCode, body) {
    if (statusCode !== 404 || !isRecord(body))
        return false;
    const error = body["error"];
    const message = body["message"];
    return error === "Not Found" || (typeof message === "string" && /^Route .* not found$/u.test(message));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=pluginBackendProxyRoutes.js.map