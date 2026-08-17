export async function resolveWorkspaceContext(projects, workspaces, projectId, workspaceId) {
    const project = await projects.requireProject(projectId);
    const workspace = await workspaces.resolve(project.id, workspaceId);
    return { project, workspace, root: workspace.path };
}
//# sourceMappingURL=workspaceContext.js.map