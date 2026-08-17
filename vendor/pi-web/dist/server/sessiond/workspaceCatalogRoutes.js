/** Internal sessiond protocol; browser-facing routes consume it through a typed client. */
export function registerWorkspaceCatalogRoutes(app, dependencies, prefix = "/workspace-catalog") {
    app.get(`${prefix}/provider-runtime`, () => dependencies.providerRuntime);
    app.get(`${prefix}/projects/:projectId/workspaces`, async (request, reply) => {
        try {
            const project = await dependencies.projects.requireProject(request.params.projectId);
            return await dependencies.workspaces.resolve(project);
        }
        catch (error) {
            return catalogRequestFailed(reply, error);
        }
    });
    app.get(`${prefix}/projects/:projectId/workspaces/:workspaceId`, async (request, reply) => {
        try {
            const project = await dependencies.projects.requireProject(request.params.projectId);
            const resolution = await dependencies.workspaces.resolve(project);
            const workspace = resolution.workspaces.find((candidate) => candidate.id === request.params.workspaceId);
            if (workspace === undefined)
                return await reply.code(404).send({ error: "Workspace not found" });
            return workspace;
        }
        catch (error) {
            return catalogRequestFailed(reply, error);
        }
    });
}
function catalogRequestFailed(reply, error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
}
//# sourceMappingURL=workspaceCatalogRoutes.js.map