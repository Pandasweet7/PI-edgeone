import { isAbsolute, relative } from "node:path";
import { canonicalizeStoredCwd } from "../workingDirectory.js";
const DEFAULT_WORKSPACE_TOPOLOGY_TTL_MS = 15_000;
/**
 * Caches the project/workspace topology so status recomputation never triggers
 * one workspace provider listing per status change. Listing runs at most once
 * per cache window, and one in-flight load is shared by concurrent callers.
 */
export class CachedWorkspaceAttribution {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.topologyTtlMs = dependencies.topologyTtlMs ?? DEFAULT_WORKSPACE_TOPOLOGY_TTL_MS;
        this.now = dependencies.now ?? (() => Date.now());
    }
    async attribute(cwds) {
        const requested = [...new Set(cwds)].filter((cwd) => cwd !== "");
        if (requested.length === 0)
            return new Map();
        const workspaces = await this.topology();
        const attributions = new Map();
        for (const cwd of requested) {
            const canonical = canonicalizeStoredCwd(cwd);
            const owner = workspaces.find((workspace) => containsCwd(workspace.path, canonical));
            if (owner !== undefined)
                attributions.set(cwd, owner.attribution);
        }
        return attributions;
    }
    invalidate() {
        this.cache = undefined;
    }
    topology() {
        const cached = this.cache;
        if (cached !== undefined && this.now() - cached.loadedAt < this.topologyTtlMs)
            return cached.workspaces;
        const entry = { loadedAt: this.now(), workspaces: this.loadTopology() };
        this.cache = entry;
        return entry.workspaces;
    }
    /**
     * Never rejects: a listing failure is logged and leaves the affected project
     * without workspaces for this window, so its cwds fall to the unattributed
     * bucket instead of failing the whole status projection.
     */
    async loadTopology() {
        let projects;
        try {
            projects = await this.dependencies.projects.list();
        }
        catch (error) {
            this.dependencies.logger.warn({ err: error }, "workspace attribution could not list projects");
            return [];
        }
        const listed = await Promise.all(projects.map((project) => this.listWorkspaces(project)));
        // Deepest first, so a cwd inside a nested workspace is attributed to that
        // workspace rather than to the workspace containing it.
        return listed.flat().sort((left, right) => right.depth - left.depth);
    }
    async listWorkspaces(project) {
        try {
            const workspaces = await this.dependencies.workspaces.list(project);
            return workspaces.map((workspace) => attributedWorkspacePath(workspace));
        }
        catch (error) {
            this.dependencies.logger.warn({ err: error, projectId: project.id }, "workspace attribution could not list workspaces for a project");
            return [];
        }
    }
}
function attributedWorkspacePath(workspace) {
    const path = canonicalizeStoredCwd(workspace.path);
    return {
        path,
        depth: path.split(/[\\/]+/).filter((segment) => segment !== "").length,
        // A workspace carries its own project id, so a worktree outside the
        // project directory is still attributed to its project.
        attribution: { projectId: workspace.projectId, workspaceId: workspace.id },
    };
}
/** Segment-aware containment, so `/srv/wt1` never claims `/srv/wt10`. */
function containsCwd(workspacePath, cwd) {
    if (workspacePath === cwd)
        return true;
    const rel = relative(workspacePath, cwd);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
//# sourceMappingURL=workspaceAttribution.js.map