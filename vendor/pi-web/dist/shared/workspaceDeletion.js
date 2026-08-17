export const workspaceDeleteOperation = "workspace.delete";
export const workspaceDeleteOperationMetadataKey = "pi.operation";
export const targetWorkspaceIdMetadataKey = "target.workspaceId";
const targetWorkspacePathMetadataKey = "target.workspacePath";
export function workspaceDeletionMetadata(workspace) {
    return {
        [workspaceDeleteOperationMetadataKey]: workspaceDeleteOperation,
        [targetWorkspaceIdMetadataKey]: workspace.id,
        [targetWorkspacePathMetadataKey]: workspace.path,
    };
}
//# sourceMappingURL=workspaceDeletion.js.map