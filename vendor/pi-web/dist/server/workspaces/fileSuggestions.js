import { execFile, spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { sanitizedGitEnv } from "../git/gitEnv.js";
import { createPathAccessPolicy, isAbsoluteishPath, resolvePathAccessTarget } from "./pathAccessPolicy.js";
const execFileAsync = promisify(execFile);
const commandMaxBuffer = 1024 * 1024 * 8;
const maxFilesystemFallbackPaths = 20_000;
const maxFileSuggestions = 80;
class CommandExitError extends Error {
    constructor(file, code, stderr) {
        const codeText = code === null ? "unknown" : String(code);
        super(`${file} exited with code ${codeText}${stderr === "" ? "" : `: ${stderr}`}`);
        this.name = "CommandExitError";
        if (code !== null)
            this.exitCode = code;
    }
}
export function isAbsoluteishFileSuggestionQuery(query = "") {
    return isAbsoluteishPath(fileQueryText(query));
}
export async function listFileSuggestions(cwd, query = "", options = {}, deps = {}) {
    const queryText = fileQueryText(query);
    if (isAbsoluteishFileSuggestionQuery(query)) {
        return (await listPathSuggestions(cwd, queryText, options.pathAccess, deps))
            .filter((file) => options.kind === undefined || file.kind === options.kind)
            .slice(0, maxFileSuggestions);
    }
    const normalizedQuery = normalizeFileQuery(query);
    const command = deps.execFile ?? runCommand;
    const files = await listFilesForScope(cwd, options.scope, command);
    return (await rankFileSuggestionsWithOptionalFzf(cwd, files.filter((file) => options.kind === undefined || file.kind === options.kind), normalizedQuery, fzfRunnerForDependencies(deps))).slice(0, maxFileSuggestions);
}
export async function listPathSuggestions(cwd, prefix = "", pathAccess, deps = {}) {
    const query = fileQueryText(prefix);
    const fzf = fzfRunnerForDependencies(deps);
    if (isAbsoluteishPath(query))
        return listAllowedPathSuggestions(cwd, query, pathAccess, fzf);
    const normalizedPrefix = query.replace(/\\/g, "/");
    const directoryPrefix = normalizedPrefix.endsWith("/") ? normalizedPrefix : dirname(normalizedPrefix) === "." ? "" : `${dirname(normalizedPrefix)}/`;
    const searchPrefix = normalizedPrefix.endsWith("/") ? "" : basename(normalizedPrefix);
    const candidates = await listDirectoryEntrySuggestions(cwd, directoryPrefix);
    return (await rankPathSuggestionsWithOptionalFzf(cwd, candidates, searchPrefix, () => prefixPathSuggestions(candidates, searchPrefix), fzf)).slice(0, maxFileSuggestions);
}
async function listDirectoryEntrySuggestions(cwd, directoryPrefix) {
    const policy = await createPathAccessPolicy(cwd, undefined);
    const resolved = await resolveWorkspaceSuggestionDirectory(policy, directoryPrefix);
    if (resolved === undefined)
        return [];
    const entries = await readdir(resolved.target, { withFileTypes: true });
    const suggestions = [];
    for (const entry of entries.sort(compareDirectoryEntries)) {
        const childPath = appendRequestPath(resolved.displayPath, entry.name);
        const isDirectory = await suggestionEntryIsDirectory(policy, childPath, entry);
        if (isDirectory === undefined)
            continue;
        suggestions.push({ path: `${childPath}${isDirectory ? "/" : ""}`, kind: "other" });
    }
    return suggestions;
}
async function resolveWorkspaceSuggestionDirectory(policy, directoryPrefix) {
    try {
        const resolved = await resolvePathAccessTarget(policy, directoryPrefix);
        return resolved.kind === "workspace" ? resolved : undefined;
    }
    catch (error) {
        if (isPathSuggestionMiss(error))
            return undefined;
        throw error;
    }
}
async function listAllowedPathSuggestions(cwd, query, pathAccess, fzf) {
    const policy = await createPathAccessPolicy(cwd, pathAccess);
    if (policy.allowedRoots.length === 0)
        throw new Error("Absolute paths are not allowed");
    const rootCandidates = allowedRootSuggestionCandidates(policy, query);
    const directoryCandidates = await listAllowedDirectoryEntryCandidates(policy, query);
    return (await rankPathSuggestionsWithOptionalFzf(cwd, mergeSuggestions(rootCandidates, directoryCandidates), query, () => mergeSuggestions(allowedRootPrefixSuggestions(policy, query), prefixPathSuggestions(directoryCandidates, pathSuggestionPrefix(query).searchPrefix)).sort(compareFileSuggestions), fzf)).slice(0, maxFileSuggestions);
}
function allowedRootPrefixSuggestions(policy, query) {
    return allowedRootSuggestionCandidates(policy, query).filter((suggestion) => pathStartsWith(suggestion.path, query));
}
function allowedRootSuggestionCandidates(policy, query) {
    const suggestions = [];
    const seen = new Set();
    for (const root of policy.allowedRoots) {
        for (const displayPath of allowedRootDisplayPaths(root.path, query)) {
            const path = ensureTrailingPathSeparator(displayPath);
            if (hasTrailingPathSeparator(query) && stripTrailingPathSeparators(path) === stripTrailingPathSeparators(query))
                continue;
            if (seen.has(path))
                continue;
            seen.add(path);
            suggestions.push({ path, kind: "other" });
        }
    }
    return suggestions;
}
function allowedRootDisplayPaths(rootPath, query) {
    if (query !== "~" && !query.startsWith("~/") && !query.startsWith("~\\"))
        return [rootPath];
    const home = homedir();
    const homeRelativePath = relative(home, rootPath);
    if (!isInsideRelativePath(homeRelativePath))
        return [rootPath];
    const separator = query.startsWith("~\\") ? "\\" : "/";
    const tildePath = homeRelativePath === "" ? "~" : `~${separator}${homeRelativePath.split(/[\\/]+/u).join(separator)}`;
    return [tildePath, rootPath];
}
async function listAllowedDirectoryEntryCandidates(policy, query) {
    const { directoryPrefix } = pathSuggestionPrefix(query);
    const resolved = await resolveSuggestionDirectory(policy, directoryPrefix);
    if (resolved === undefined)
        return [];
    const entries = await readdir(resolved.target, { withFileTypes: true });
    const suggestions = [];
    for (const entry of entries.sort(compareDirectoryEntries)) {
        const childPath = appendRequestPath(directoryPrefix, entry.name);
        const isDirectory = await suggestionEntryIsDirectory(policy, childPath, entry);
        if (isDirectory === undefined)
            continue;
        suggestions.push({ path: `${childPath}${isDirectory ? "/" : ""}`, kind: "other" });
    }
    return suggestions;
}
async function resolveSuggestionDirectory(policy, directoryPrefix) {
    try {
        const resolved = await resolvePathAccessTarget(policy, directoryPrefix);
        return resolved.kind === "allowed" ? resolved : undefined;
    }
    catch (error) {
        if (isPathSuggestionMiss(error))
            return undefined;
        throw error;
    }
}
async function suggestionEntryIsDirectory(policy, childPath, entry) {
    if (!entry.isSymbolicLink())
        return entry.isDirectory();
    try {
        const resolved = await resolvePathAccessTarget(policy, childPath);
        const result = await stat(resolved.target);
        if (result.isDirectory())
            return true;
        if (result.isFile())
            return false;
        return undefined;
    }
    catch (error) {
        if (isPathSuggestionMiss(error))
            return undefined;
        throw error;
    }
}
function pathSuggestionPrefix(query) {
    if (query === "~" || hasTrailingPathSeparator(query))
        return { directoryPrefix: query, searchPrefix: "" };
    const directory = dirname(query);
    return { directoryPrefix: directory === "." ? "" : directory, searchPrefix: basename(query) };
}
function appendRequestPath(base, name) {
    if (base === "")
        return name;
    if (isAbsolute(base) || win32.isAbsolute(base))
        return join(base, name);
    if (hasTrailingPathSeparator(base))
        return `${base}${name}`;
    return `${base}/${name}`;
}
function pathStartsWith(path, query) {
    return path.toLowerCase().startsWith(query.toLowerCase());
}
function ensureTrailingPathSeparator(path) {
    return hasTrailingPathSeparator(path) ? path : `${path}/`;
}
function hasTrailingPathSeparator(path) {
    return path.endsWith("/") || path.endsWith("\\");
}
function stripTrailingPathSeparators(path) {
    let end = path.length;
    while (end > 1 && (path[end - 1] === "/" || path[end - 1] === "\\"))
        end -= 1;
    return path.slice(0, end);
}
function isInsideRelativePath(path) {
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function isPathSuggestionMiss(error) {
    if (!(error instanceof Error))
        return false;
    return error.message === "Path is outside allowed paths"
        || error.message === "Path does not exist"
        || error.message === "Path traversal is not allowed"
        || error.message === "Path escapes workspace"
        || error.message.startsWith("Path is not absolute:");
}
async function listFilesForScope(cwd, scope, exec) {
    if (scope === "all")
        return listAllFiles(cwd, exec);
    if (scope === "tracked")
        return listTrackedFiles(cwd, exec).catch(() => listPlainFiles(cwd, exec, true));
    return listGitFiles(cwd, exec).catch(() => listPlainFiles(cwd, exec, false));
}
async function listTrackedFiles(cwd, exec) {
    return withDirectories(nulRecords(await git(cwd, ["ls-files", "-z"], exec)), "tracked");
}
async function listGitFiles(cwd, exec) {
    const [trackedResult, untrackedResult] = await Promise.allSettled([
        git(cwd, ["ls-files", "-z"], exec),
        git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], exec),
    ]);
    if (trackedResult.status === "rejected")
        throw trackedResult.reason;
    if (untrackedResult.status === "rejected")
        throw untrackedResult.reason;
    return [
        ...withDirectories(nulRecords(trackedResult.value), "tracked"),
        ...withDirectories(nulRecords(untrackedResult.value), "untracked"),
    ];
}
async function listAllFiles(cwd, exec) {
    const [gitFiles, plainFiles] = await Promise.all([
        listGitFiles(cwd, exec).catch(() => []),
        listPlainFiles(cwd, exec, true),
    ]);
    return mergeSuggestions(gitFiles, plainFiles);
}
async function listPlainFiles(cwd, exec, includeIgnored) {
    try {
        const args = includeIgnored ? ["--files", "--hidden", "--no-ignore", "--glob", "!.git", "--glob", "!.git/**"] : ["--files"];
        const { stdout } = await exec("rg", args, { cwd, maxBuffer: commandMaxBuffer });
        return withDirectories(textLines(stdout), "other");
    }
    catch {
        return withDirectories(await filesystemFiles(cwd), "other");
    }
}
async function filesystemFiles(cwd) {
    const paths = [];
    await collectFilesystemFiles(cwd, "", paths, false);
    return paths;
}
async function collectFilesystemFiles(cwd, relativeDirectory, paths, optionalDirectory) {
    if (paths.length >= maxFilesystemFallbackPaths)
        return;
    const absoluteDirectory = relativeDirectory === "" ? cwd : join(cwd, relativeDirectory);
    let entries;
    try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
    }
    catch (error) {
        if (optionalDirectory)
            return;
        throw error;
    }
    entries.sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (paths.length >= maxFilesystemFallbackPaths)
            return;
        const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name === ".git")
                continue;
            await collectFilesystemFiles(cwd, relativePath, paths, true);
            continue;
        }
        if (entry.isFile() || await isSymlinkedFile(cwd, relativePath, entry.isSymbolicLink()))
            paths.push(relativePath);
    }
}
async function isSymlinkedFile(cwd, relativePath, symbolicLink) {
    if (!symbolicLink)
        return false;
    try {
        return (await stat(join(cwd, relativePath))).isFile();
    }
    catch {
        return false;
    }
}
async function git(cwd, args, exec) {
    const { stdout } = await exec("git", args, { cwd, env: sanitizedGitEnv(), maxBuffer: commandMaxBuffer });
    return stdout;
}
function normalizeFileQuery(query) {
    return fileQueryText(query).toLowerCase();
}
function fileQueryText(query) {
    return query.replace(/^!@/, "").replace(/^@\s?/, "").replace(/^"/, "");
}
function fzfRunnerForDependencies(deps) {
    return deps.fzf ?? (deps.execFile === undefined ? runCommand : undefined);
}
async function rankFileSuggestionsWithOptionalFzf(cwd, files, normalizedQuery, fzf) {
    return rankSuggestionsWithOptionalFzf(cwd, files, normalizedQuery, () => rankFileSuggestions(files, normalizedQuery), fzf);
}
async function rankPathSuggestionsWithOptionalFzf(cwd, candidates, query, fallback, fzf) {
    return rankSuggestionsWithOptionalFzf(cwd, candidates, query, fallback, fzf);
}
async function rankSuggestionsWithOptionalFzf(cwd, candidates, query, fallback, fzf) {
    if (fzf === undefined || query === "" || candidates.length === 0)
        return fallback();
    try {
        return await fzfFilterSuggestions(cwd, candidates, query, fzf);
    }
    catch {
        return fallback();
    }
}
async function fzfFilterSuggestions(cwd, candidates, query, fzf) {
    const byPath = new Map(candidates.map((suggestion) => [suggestion.path, suggestion]));
    const { stdout } = await runFzf(cwd, [...byPath.keys()], query, fzf);
    const suggestions = [];
    const seen = new Set();
    for (const path of nulRecords(stdout)) {
        const suggestion = byPath.get(path);
        if (suggestion === undefined || seen.has(suggestion.path))
            continue;
        seen.add(suggestion.path);
        suggestions.push(suggestion);
    }
    if (suggestions.length === 0 && stdout !== "")
        throw new Error("fzf returned paths outside the gathered suggestions");
    return suggestions;
}
async function runFzf(cwd, candidates, query, fzf) {
    try {
        return await fzf("fzf", ["--filter", query, "--read0", "--print0"], { cwd, maxBuffer: commandMaxBuffer, input: `${candidates.join("\0")}\0` });
    }
    catch (error) {
        if (errorExitCode(error) === 1)
            return { stdout: "" };
        throw error;
    }
}
function prefixPathSuggestions(candidates, searchPrefix) {
    const normalizedSearchPrefix = searchPrefix.toLowerCase();
    return candidates
        .filter((suggestion) => pathSuggestionName(suggestion.path).toLowerCase().startsWith(normalizedSearchPrefix))
        .sort(compareFileSuggestions);
}
function pathSuggestionName(path) {
    const stripped = stripTrailingPathSeparators(path);
    return stripped.split(/[\\/]+/u).filter(Boolean).at(-1) ?? stripped;
}
function rankFileSuggestions(files, normalizedQuery) {
    if (normalizedQuery === "")
        return [...files].sort(compareFileSuggestions);
    return files
        .map((file) => ({ file, score: fileSuggestionScore(file.path, normalizedQuery) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || kindRank(a.file.kind) - kindRank(b.file.kind) || pathDepth(a.file.path) - pathDepth(b.file.path) || compareFileSuggestions(a.file, b.file))
        .map(({ file }) => file);
}
function fileSuggestionScore(path, normalizedQuery) {
    const normalizedPath = normalizeSuggestionPathForSearch(path);
    const name = displayBasename(normalizedPath);
    if (normalizedPath === normalizedQuery)
        return 1000;
    if (name === normalizedQuery)
        return 980;
    if (name.startsWith(normalizedQuery))
        return 900;
    if (normalizedPath.startsWith(normalizedQuery))
        return 850;
    if (name.includes(normalizedQuery))
        return 750;
    if (normalizedPath.includes(normalizedQuery))
        return 650;
    const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => normalizedPath.includes(token))) {
        return 550 + tokens.filter((token) => name.includes(token)).length * 25;
    }
    return isSubsequence(normalizedQuery, normalizedPath) ? 200 : 0;
}
function normalizeSuggestionPathForSearch(path) {
    const lower = path.toLowerCase();
    return lower.endsWith("/") ? lower.slice(0, -1) : lower;
}
function displayBasename(path) {
    return path.split("/").filter(Boolean).at(-1) ?? path;
}
function isSubsequence(needle, haystack) {
    let haystackIndex = 0;
    for (const char of needle) {
        haystackIndex = haystack.indexOf(char, haystackIndex);
        if (haystackIndex === -1)
            return false;
        haystackIndex += char.length;
    }
    return true;
}
function compareFileSuggestions(a, b) {
    return Number(!a.path.endsWith("/")) - Number(!b.path.endsWith("/")) || a.path.localeCompare(b.path);
}
function compareDirectoryEntries(a, b) {
    return Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name);
}
function kindRank(kind) {
    switch (kind) {
        case "tracked": return 0;
        case "untracked": return 1;
        case "other": return 2;
    }
}
function pathDepth(path) {
    return path.split("/").filter(Boolean).length;
}
async function runCommand(file, args, options) {
    const { input, ...execOptions } = options;
    if (input === undefined)
        return execFileAsync(file, args, execOptions);
    return runCommandWithInput(file, args, { ...execOptions, input });
}
async function runCommandWithInput(file, args, options) {
    return await new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd: options.cwd,
            ...(options.env === undefined ? {} : { env: options.env }),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const rejectOnce = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > options.maxBuffer) {
                child.kill();
                rejectOnce(new Error(`${file} stdout exceeded maxBuffer`));
                return;
            }
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes > options.maxBuffer) {
                child.kill();
                rejectOnce(new Error(`${file} stderr exceeded maxBuffer`));
                return;
            }
            stderr += chunk.toString("utf8");
        });
        child.on("error", rejectOnce);
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            if (code === 0) {
                resolve({ stdout });
                return;
            }
            reject(new CommandExitError(file, code, stderr));
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input);
    });
}
function errorExitCode(error) {
    if (error instanceof CommandExitError)
        return error.exitCode;
    if (!(error instanceof Error))
        return undefined;
    if ("exitCode" in error && typeof error.exitCode === "number")
        return error.exitCode;
    if ("code" in error && typeof error.code === "number")
        return error.code;
    return undefined;
}
function textLines(text) {
    return text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => line !== "");
}
function nulRecords(text) {
    return text.split("\0").filter((record) => record !== "");
}
function mergeSuggestions(primary, secondary) {
    const seen = new Set();
    const merged = [];
    for (const suggestion of [...primary, ...secondary]) {
        if (seen.has(suggestion.path))
            continue;
        seen.add(suggestion.path);
        merged.push(suggestion);
    }
    return merged;
}
function withDirectories(paths, kind) {
    const seen = new Set();
    const suggestions = [];
    for (const path of paths) {
        for (const directory of parentDirectories(path))
            add(`${directory}/`);
        add(path);
    }
    return suggestions;
    function add(path) {
        if (seen.has(path))
            return;
        seen.add(path);
        suggestions.push({ path, kind });
    }
}
function parentDirectories(path) {
    const parts = path.split("/").filter(Boolean);
    const directories = [];
    for (let index = 1; index < parts.length; index++) {
        directories.push(parts.slice(0, index).join("/"));
    }
    return directories;
}
//# sourceMappingURL=fileSuggestions.js.map