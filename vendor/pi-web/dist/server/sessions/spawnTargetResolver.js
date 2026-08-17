import { cwdPathsEqual } from "../workingDirectory.js";
import { RegisteredProjectWorkspaceCwds } from "../workspaces/projectWorkspaceCwds.js";
/**
 * Default resolver composing the project registry and live provider resolution.
 * It finds the registered project whose current workspace set contains the
 * spawning session's cwd, then validates the requested target against that set.
 */
export class ProjectScopedSpawnTargetResolver {
    constructor(deps) {
        this.projectWorkspaces = new RegisteredProjectWorkspaceCwds(deps);
    }
    async resolveSpawnTarget(spawningCwd, requestedCwd) {
        const allowedCwds = await this.projectWorkspaces.forCwd(spawningCwd);
        if (allowedCwds === undefined)
            return { allowed: false, reason: "not-registered" };
        const target = requestedCwd === undefined || requestedCwd === "" ? spawningCwd : requestedCwd;
        const match = allowedCwds.find((path) => cwdPathsEqual(path, target));
        if (match === undefined)
            return { allowed: false, reason: "out-of-project", allowedCwds };
        return { allowed: true, cwd: match };
    }
}
//# sourceMappingURL=spawnTargetResolver.js.map