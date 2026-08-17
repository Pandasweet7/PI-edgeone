import { deleteWorkspaceFile, moveWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "./workspaces/fileContentService.js";
import { isAbsoluteishFileSuggestionQuery, listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { listWorkspaceTree } from "./workspaces/fileTreeService.js";
import { readWorkspaceFilePreview } from "./workspaces/filePreviewService.js";
import { workspaceFilePreviewResponsePolicy } from "./workspaces/filePreviewResponsePolicy.js";
import { applyWorkspaceFilePreviewErrorResponsePolicy } from "./workspaces/filePreviewResponseHeaders.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { pathAccessForWorkspaceContext } from "./workspaces/effectivePathAccess.js";
import { sendWorkspaceRequestError } from "./workspaces/workspaceRouteErrors.js";
export function registerWorkspaceExplorerRoutes(app, projects, workspaces, prefix = "/api", options = {}) {
    registerWorkspaceFileContentParsers(app);
    app.get(`${prefix}/projects/:projectId/workspaces/:workspaceId/tree`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            return await listWorkspaceTree(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.get(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            return await readWorkspaceFile(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.put(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            const writeOptions = {
                createDirs: request.query.createDirs !== "false",
                overwrite: request.query.overwrite !== "false",
            };
            return await writeWorkspaceFile(context.root, request.query.path, workspaceWriteBodyToBuffer(request.body), writeOptions);
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.delete(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            return await deleteWorkspaceFile(context.root, request.query.path);
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.post(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/move`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            return await moveWorkspaceFile(context.root, request.query.fromPath, request.query.toPath, {
                createDirs: request.query.createDirs !== "false",
                overwrite: request.query.overwrite === "true",
            });
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.get(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/preview`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            const download = request.query.download === "1" || request.query.download === "true";
            const preview = await readWorkspaceFilePreview(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config), { download });
            const policy = workspaceFilePreviewResponsePolicy(preview.path, { download });
            return await reply
                .header("Content-Type", policy.contentType)
                .header("Cache-Control", "private, max-age=3600")
                .header("Content-Length", String(preview.size))
                .header("Content-Disposition", policy.contentDisposition)
                .header("Content-Security-Policy", policy.contentSecurityPolicy)
                .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
                .header("X-Content-Type-Options", policy.contentTypeOptions)
                .send(preview.body);
        }
        catch (error) {
            applyWorkspaceFilePreviewErrorResponsePolicy(reply);
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
    app.get(`${prefix}/projects/:projectId/workspaces/:workspaceId/files`, async (request, reply) => {
        try {
            const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
            const query = request.query.q ?? "";
            const pathAccess = isAbsoluteishFileSuggestionQuery(query) ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
            if (request.query.mode === "path")
                return await listPathSuggestions(context.root, query, pathAccess);
            return await listFileSuggestions(context.root, query, { kind: request.query.kind, scope: request.query.scope, pathAccess });
        }
        catch (error) {
            return sendWorkspaceRequestError(reply, error, 400);
        }
    });
}
function registerWorkspaceFileContentParsers(app) {
    // Fastify's default parser only handles JSON; workspace file writes need to
    // accept text and arbitrary binary payloads. This route module is registered
    // for both local aliases, so parser registration must tolerate repeats.
    try {
        app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => { done(null, Buffer.from(body)); });
    }
    catch { /* already registered */ }
    try {
        app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
    }
    catch { /* already registered */ }
    try {
        app.addContentTypeParser(/^([a-z]+\/[a-z0-9.+-]+)$/u, { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
    }
    catch { /* already registered */ }
}
/**
 * Normalize a workspace file-write payload to a Buffer.
 *
 * The standard client PUTs the raw file bytes (parsed as Buffer by the custom
 * parsers above). The EdgeOne Makers client cannot send raw bytes — the Makers
 * runtime hands the handler a parsed JSON object — so it PUTs JSON
 * `{ "content": "<base64>" }` instead; this decodes that form back to the
 * original bytes. Any other parsed shape is stringified as a best effort.
 */
function workspaceWriteBodyToBuffer(body) {
    if (Buffer.isBuffer(body))
        return body;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const content = body["content"];
        if (typeof content === "string")
            return Buffer.from(content, "base64");
    }
    if (typeof body === "string")
        return Buffer.from(body);
    return Buffer.from(body === undefined || body === null ? "" : String(body));
}
//# sourceMappingURL=workspaceExplorerRoutes.js.map