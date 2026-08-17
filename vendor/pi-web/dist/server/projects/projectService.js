import { mkdir, realpath, stat } from "node:fs/promises";
import { expandUserPath } from "./directorySuggestions.js";
export class ProjectService {
    constructor(store) {
        this.store = store;
    }
    list() {
        return this.store.list();
    }
    async add(input) {
        const requestedPath = expandUserPath(input.path);
        if (input.create === true)
            await mkdir(requestedPath, { recursive: true });
        const resolved = await realpath(requestedPath);
        const s = await stat(resolved);
        if (!s.isDirectory())
            throw new Error("Project path must be a directory");
        return this.store.add(input.name === undefined ? { path: resolved } : { name: input.name, path: resolved });
    }
    async close(id) {
        if (!(await this.store.remove(id)))
            throw new Error("Project not found");
    }
    async requireProject(id) {
        const project = await this.store.get(id);
        if (!project)
            throw new Error("Project not found");
        return project;
    }
}
//# sourceMappingURL=projectService.js.map