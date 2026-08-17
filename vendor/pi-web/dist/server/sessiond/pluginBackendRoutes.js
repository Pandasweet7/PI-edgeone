import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { parsePluginBackendRequestEnvelope, PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES, PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES, requirePluginBackendOperation, serializeBoundedPluginBackendJson, } from "../../shared/pluginBackendProtocol.js";
import { WorkspaceProviderRequestError, } from "../workspaces/workspaceProviderRegistry.js";
/** JSON-only sessiond boundary for the active owner of one current workspace. */
export function registerPluginBackendRoutes(app, dependencies, prefix = "/plugin-backends") {
    app.post(`${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation`, { bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES }, async (request, reply) => {
        const { pluginId, projectId, workspaceId } = request.params;
        let operation = request.params.operation;
        let envelope;
        try {
            if (!isPiWebPluginId(pluginId))
                throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
            operation = requirePluginBackendOperation(operation);
            if (projectId === "")
                throw new Error("Project id is required");
            if (workspaceId === "")
                throw new Error("Workspace id is required");
            envelope = parsePluginBackendRequestEnvelope(request.body);
        }
        catch (error) {
            return attributedError(reply, 400, boundedErrorMessage(error), "invalid-request", pluginId, operation);
        }
        let project;
        try {
            project = await dependencies.projects.requireProject(projectId);
        }
        catch (error) {
            const message = boundedErrorMessage(error);
            return attributedError(reply, message === "Project not found" ? 404 : 500, message, message === "Project not found" ? "project-not-found" : "project-resolution-failed", pluginId, operation);
        }
        try {
            const result = await dependencies.backends.request({
                pluginId,
                moduleRevision: envelope.revision,
                project,
                workspaceId,
                operation,
                input: envelope.input,
            });
            const serialized = serializeBoundedPluginBackendJson(result, `Server plugin ${pluginId} operation ${operation} result`, PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES);
            return await reply.type("application/json; charset=utf-8").send(serialized);
        }
        catch (error) {
            return await pluginBackendRequestFailed(reply, error, pluginId, operation);
        }
        finally {
            dependencies.onWorkspacesMutated();
        }
    });
}
function pluginBackendRequestFailed(reply, error, pluginId, operation) {
    if (error instanceof WorkspaceProviderRequestError) {
        return attributedError(reply, error.statusCode, error.message, error.code, pluginId, operation);
    }
    return attributedError(reply, 502, `Plugin backend request failed: ${boundedErrorMessage(error)}`, "request-failed", pluginId, operation);
}
function attributedError(reply, statusCode, message, code, pluginId, operation) {
    return reply.code(statusCode).send({ error: message, code, pluginId, operation });
}
function boundedErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}
//# sourceMappingURL=pluginBackendRoutes.js.map