import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { normalizeRelativePath } from "./pathSafety.js";
export async function createPathAccessPolicy(workspaceRootPath, pathAccess, options = {}) {
    return {
        workspaceRoot: await canonicalDirectory(workspaceRootPath, "Workspace path"),
        allowedRoots: await resolveAllowedRoots(pathAccess?.allowedPaths ?? [], options),
    };
}
export async function resolveWorkspacePathAccessTarget(rootPath, requestedPath, pathAccess, options = {}) {
    const request = requestedPath ?? "";
    const workspaceRoot = await canonicalDirectory(rootPath, "Workspace path");
    const allowedRoots = isAbsoluteishPath(request) ? await resolveAllowedRoots(pathAccess?.allowedPaths ?? [], options) : [];
    return resolvePathAccessTarget({ workspaceRoot, allowedRoots }, requestedPath, options);
}
export async function resolvePathAccessTarget(policy, requestedPath, options = {}) {
    const request = requestedPath ?? "";
    if (isAbsoluteishPath(request))
        return resolveAllowedTarget(policy, request, options);
    const displayPath = normalizeRelativePath(request);
    const target = await canonicalExistingPath(resolve(policy.workspaceRoot, displayPath));
    ensureInside(policy.workspaceRoot, target, "Path escapes workspace");
    return { kind: "workspace", root: policy.workspaceRoot, target, displayPath };
}
export function isAbsoluteishPath(path) {
    return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || isAbsolute(path) || win32.isAbsolute(path);
}
async function resolveAllowedRoots(allowedPaths, options) {
    const roots = [];
    for (const source of allowedPaths) {
        const expanded = expandAbsoluteishPath(source, options, `Allowed path must be absolute or start with ~: ${source}`);
        const realPath = await canonicalDirectory(expanded, `Allowed path ${source}`);
        if (roots.some((root) => root.realPath === realPath))
            continue;
        roots.push({ source, path: expanded, realPath });
    }
    return roots;
}
async function resolveAllowedTarget(policy, request, options) {
    if (policy.allowedRoots.length === 0)
        throw new Error("Absolute paths are not allowed");
    const displayPath = expandAbsoluteishPath(request, options, `Path is not absolute: ${request}`);
    const target = await canonicalExistingPath(displayPath);
    const root = policy.allowedRoots.find((allowedRoot) => isInsideOrSame(allowedRoot.realPath, target));
    if (root === undefined)
        throw new Error("Path is outside allowed paths");
    return { kind: "allowed", root: root.realPath, target, displayPath };
}
function expandAbsoluteishPath(path, options, relativeMessage) {
    const home = options.homeDir ?? homedir();
    if (path === "~")
        return home;
    if (path.startsWith("~/") || path.startsWith("~\\"))
        return resolve(home, path.slice(2));
    if (isAbsolute(path))
        return resolve(path);
    if (win32.isAbsolute(path))
        throw new Error(`Absolute path is not valid on this host: ${path}`);
    throw new Error(relativeMessage);
}
async function canonicalDirectory(path, label) {
    const canonical = await canonicalExistingPath(path, `${label} does not exist`);
    const result = await stat(canonical);
    if (!result.isDirectory())
        throw new Error(`${label} must be a directory`);
    return canonical;
}
async function canonicalExistingPath(path, missingMessage = "Path does not exist") {
    try {
        return await realpath(path);
    }
    catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT"))
            throw new Error(missingMessage, { cause: error });
        throw error;
    }
}
function ensureInside(root, target, message) {
    if (!isInsideOrSame(root, target))
        throw new Error(message);
}
function isInsideOrSame(root, target) {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function isNodeErrorWithCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
//# sourceMappingURL=pathAccessPolicy.js.map