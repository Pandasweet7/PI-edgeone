import { cwdPathsEqual } from "../workingDirectory.js";
export class RegisteredProjectWorkspaceCwds {
    constructor(deps) {
        this.deps = deps;
    }
    async forCwd(cwd) {
        const projects = await this.deps.projects.list();
        for (const project of projects) {
            const workspaces = await this.deps.workspaces.list(project);
            const paths = workspaces.map((workspace) => workspace.path);
            if (paths.some((path) => cwdPathsEqual(path, cwd)))
                return paths;
        }
        return undefined;
    }
}
//# sourceMappingURL=projectWorkspaceCwds.js.map