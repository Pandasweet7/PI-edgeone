import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";
import { randomUUID } from "node:crypto";
function isNodeErrorWithCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
function parseProjectFile(value) {
    if (!isRecord(value) || !Array.isArray(value["projects"]))
        throw new Error("Invalid project file");
    return { projects: value["projects"].map(parseProject) };
}
function parseProject(value) {
    if (!isRecord(value))
        throw new Error("Invalid project");
    const id = value["id"];
    const name = value["name"];
    const path = value["path"];
    const createdAt = value["createdAt"];
    if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof createdAt !== "string")
        throw new Error("Invalid project");
    return { id, name, path, createdAt };
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function defaultProjectStorePath(env = process.env, cwd = process.cwd()) {
    return join(piWebDataDir(env, cwd), "projects.json");
}
export function projectStorePath(env = process.env, cwd = process.cwd()) {
    const configured = env["PI_WEB_PROJECTS_FILE"];
    if (configured === undefined || configured === "")
        return defaultProjectStorePath(env, cwd);
    return resolve(cwd, configured);
}
export class ProjectStore {
    constructor(filePath = projectStorePath()) {
        this.filePath = filePath;
    }
    async list() {
        return (await this.read()).projects;
    }
    async add(input) {
        const data = await this.read();
        const path = input.path;
        const existing = data.projects.find((p) => p.path === path);
        if (existing)
            return existing;
        const trimmedName = input.name?.trim();
        const leafName = path.split("/").filter((part) => part !== "").at(-1);
        const project = {
            id: randomUUID(),
            name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
            path,
            createdAt: new Date().toISOString(),
        };
        data.projects.push(project);
        await this.write(data);
        return project;
    }
    async get(id) {
        return (await this.list()).find((p) => p.id === id);
    }
    async remove(id) {
        const data = await this.read();
        const projects = data.projects.filter((p) => p.id !== id);
        if (projects.length === data.projects.length)
            return false;
        await this.write({ projects });
        return true;
    }
    async read() {
        try {
            const value = JSON.parse(await readFile(this.filePath, "utf8"));
            return parseProjectFile(value);
        }
        catch (error) {
            if (isNodeErrorWithCode(error, "ENOENT"))
                return { projects: [] };
            throw error;
        }
    }
    async write(data) {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    }
}
//# sourceMappingURL=projectStore.js.map