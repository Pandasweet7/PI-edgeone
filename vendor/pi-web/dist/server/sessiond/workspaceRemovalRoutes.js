import { parseWorkspaceRemovalRequest, WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES, } from "../../shared/workspaceRemovalProtocol.js";
import { requestCancellation } from "../requestCancellation.js";
import { workspaceRemovalHttpStatus } from "../workspaces/workspaceRemovalService.js";
/** Internal sessiond endpoint for host-orchestrated provider workspace removal. */
export function registerWorkspaceRemovalRoutes(app, dependencies, prefix = "/workspace-removals") {
    app.delete(`${prefix}/projects/:projectId/workspaces/:workspaceId`, { bodyLimit: WORKSPACE_REMOVAL_REQUEST_BODY_MAX_BYTES }, async (request, reply) => {
        let precondition;
        try {
            precondition = parseWorkspaceRemovalRequest(request.body).precondition;
        }
        catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
        let project;
        try {
            project = await dependencies.projects.requireProject(request.params.projectId);
        }
        catch (error) {
            const message = errorMessage(error);
            return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
        }
        const cancellation = requestCancellation(request, reply);
        try {
            return await dependencies.removals.remove(project, request.params.workspaceId, precondition, cancellation.signal);
        }
        catch (error) {
            return await removalRequestFailed(reply, error);
        }
        finally {
            dependencies.onWorkspacesMutated();
            cancellation.dispose();
        }
    });
}
function removalRequestFailed(reply, error) {
    return reply.code(workspaceRemovalHttpStatus(error)).send({ error: errorMessage(error) });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=workspaceRemovalRoutes.js.map