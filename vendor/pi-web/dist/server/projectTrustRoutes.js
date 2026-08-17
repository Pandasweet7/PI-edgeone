import { realpathSync } from "node:fs";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expandUserPath } from "./projects/directorySuggestions.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
/**
 * Read/write per-project Pi trust for a workspace. The workspace path is
 * resolved server-side from the project/workspace ids, so a client can only
 * set trust for a path PI WEB already manages — never an arbitrary path.
 */
export function registerProjectTrustRoutes(app, projects, workspaces, deps, prefix = "/api") {
    const route = `${prefix}/projects/:projectId/workspaces/:workspaceId/trust`;
    async function describe(path) {
        const agentDir = await deps.agentDir();
        const decision = new ProjectTrustStore(agentDir).get(path);
        const trusted = decision ?? SettingsManager.create(path, agentDir).getDefaultProjectTrust() === "always";
        return { path, decision, trusted };
    }
    /**
     * Resolve a raw path to the canonical directory a trust decision keys on:
     * `~`/relative expansion plus symlink resolution, falling back to the
     * expanded path when the directory does not exist yet. Uses the same
     * tolerant sync resolution as the SDK's `ProjectTrustStore` when keying
     * `trust.json`, so reads always hit decisions written by the store. (Async
     * `realpath` uses the native Windows resolution, which expands 8.3 short
     * names such as `RUNNER~1` to their long form and would miss keys stored
     * under the short form.)
     */
    function resolveDecidedPath(raw) {
        const expanded = expandUserPath(raw.trim());
        try {
            return realpathSync(expanded);
        }
        catch {
            return expanded;
        }
    }
    // Read-only existing-decision lookup for a path the client is about to add:
    // server-resolved (never trusted verbatim) and read exclusively through the
    // shared ProjectTrustStore, so no arbitrary client path reaches the store's
    // key space or any filesystem read.
    app.get(`${prefix}/projects/trust`, async (request, reply) => {
        const raw = request.query.path ?? "";
        if (raw.trim() === "") {
            return reply.code(400).send({ error: "path is required" });
        }
        try {
            return await describe(resolveDecidedPath(raw));
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get(route, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            return await describe(context.root);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.put(route, async (request, reply) => {
        if (typeof request.body.trusted !== "boolean") {
            return reply.code(400).send({ error: "trusted must be a boolean" });
        }
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            const agentDir = await deps.agentDir();
            // Writes go through the SDK store's file lock; an EACCES here (e.g. a
            // read-only, admin-controlled trust.json) surfaces to the client rather
            // than being swallowed.
            new ProjectTrustStore(agentDir).set(context.root, request.body.trusted);
            return await describe(context.root);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
}
//# sourceMappingURL=projectTrustRoutes.js.map