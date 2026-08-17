import { workspaceCatalogHttpStatus } from "./workspaceCatalog.js";
export function sendWorkspaceRequestError(reply, error, fallbackStatus) {
    return reply.code(workspaceCatalogHttpStatus(error, fallbackStatus)).send({
        error: error instanceof Error ? error.message : String(error),
    });
}
//# sourceMappingURL=workspaceRouteErrors.js.map