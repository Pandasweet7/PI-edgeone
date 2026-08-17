import { loadEffectiveProjectPathAccess } from "./projectPiWebConfig.js";
export async function pathAccessForWorkspaceContext(context, config) {
    if (config === undefined)
        return undefined;
    const response = await config.read();
    return loadEffectiveProjectPathAccess(context.project.path, response.effectiveConfig);
}
//# sourceMappingURL=effectivePathAccess.js.map