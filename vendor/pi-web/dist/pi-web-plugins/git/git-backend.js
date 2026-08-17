// Generated from pi-web-plugins/git/git-backend.ts. Do not edit directly.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { GIT_DIFF_OPERATION, GIT_STATUS_OPERATION, } from "./browser/git-contract.js";
export { GIT_DIFF_OPERATION, GIT_STATUS_OPERATION } from "./browser/git-contract.js";
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_LOCAL_ENV_VARS = Object.freeze([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_WORK_TREE",
]);
/** Dispatch the Git-owned status/diff schema through the provider's public request seam. */
export async function requestGitBackend(activationContext, request) {
    const runGit = createGitRunner(activationContext, request.signal);
    if (request.operation === GIT_STATUS_OPERATION) {
        requireStatusInput(request.input);
        return statusProviderResponse(await gitStatusWithRunner(runGit, request.workspace.path));
    }
    if (request.operation === GIT_DIFF_OPERATION) {
        return diffProviderResponse(await gitDiffWithRunner(runGit, request.workspace.path, parseDiffInput(request.input)));
    }
    throw new Error(`Unsupported Git workspace backend operation: ${request.operation}`);
}
export async function gitStatus(context, cwd, signal) {
    return gitStatusWithRunner(createGitRunner(context, signal), cwd);
}
async function gitStatusWithRunner(runGit, cwd) {
    const result = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
    if (result.code !== 0)
        return { isGitRepo: false, hash: hash(result.stdout + result.stderr), files: [], submodules: [] };
    const parsed = parseStatus(result.stdout, { deferSubmodules: true });
    return expandSubmodules(runGit, cwd, parsed, result.stdout);
}
/**
 * Merge each dirty submodule's own changes into the flat file list. A moved
 * commit pointer becomes a single entry keyed by the submodule path (carrying
 * the short SHAs for display); modified/untracked content is listed as regular
 * entries under `<submodule>/<inner path>`. A plain `-dirty` pointer (commit
 * unchanged) is intentionally not surfaced as a pointer entry.
 */
async function expandSubmodules(runGit, cwd, parsed, topRaw) {
    // Fan out concurrently — one `git status` per dirty submodule plus one
    // `git rev-parse` per unstaged pointer move — then concatenate in input
    // order so the file list and hash are identical to a serial pass.
    const canonicalRoot = parsed.submodules.length === 0 ? undefined : await canonicalPath(cwd);
    const expanded = await Promise.all(parsed.submodules.map(async (sub) => {
        const location = canonicalRoot === undefined
            ? undefined
            : await validatedSubmodule(runGit, cwd, canonicalRoot, sub.path);
        return { path: sub.path, ...(await expandSubmodule(runGit, sub, location)) };
    }));
    const files = [...parsed.files];
    const dirtySubmodulePaths = [];
    let extraForHash = "";
    for (const part of expanded) {
        dirtySubmodulePaths.push(part.path);
        files.push(...part.files);
        extraForHash += part.extraForHash;
    }
    return {
        isGitRepo: true,
        hash: hash(topRaw + extraForHash),
        ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
        ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
        ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
        ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
        files,
        submodules: dirtySubmodulePaths,
    };
}
/** Expand one dirty submodule: the pointer entry first, then its inner files. */
async function expandSubmodule(runGit, sub, location) {
    const files = [];
    let extraForHash = "";
    if (sub.commitChanged) {
        files.push({
            path: sub.path,
            index: sub.index,
            workingTree: sub.workingTree,
            submoduleFromCommit: displayFromCommit(sub.headOid),
            submoduleToCommit: short(await resolveSubmoduleToCommit(runGit, location?.cwd, sub)),
        });
    }
    if ((sub.hasModifiedContent || sub.hasUntrackedContent) && location !== undefined) {
        const inner = await runGit(location.cwd, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
        if (inner.code === 0) {
            extraForHash = `\0${sub.path}\0${inner.stdout}`;
            const innerFiles = parseStatus(inner.stdout, { deferSubmodules: false }).files;
            for (const file of innerFiles) {
                files.push({
                    ...file,
                    path: `${sub.path}/${file.path}`,
                    ...(file.oldPath === undefined ? {} : { oldPath: `${sub.path}/${file.oldPath}` }),
                });
            }
        }
        // non-zero exit: uninitialized / unreadable submodule — skip silently
    }
    return { files, extraForHash };
}
async function resolveSubmoduleToCommit(runGit, cwd, sub) {
    // Staged pointer moves already expose the new commit as the index OID; an
    // unstaged move only records the old OID, so read the validated submodule's
    // HEAD. An unavailable checkout cannot safely supply a different pointer.
    if (sub.indexOid !== sub.headOid || cwd === undefined)
        return sub.indexOid;
    const head = await runGit(cwd, ["rev-parse", "HEAD"]);
    const resolved = head.stdout.trim();
    return head.code === 0 && resolved !== "" ? resolved : sub.indexOid;
}
export async function gitDiff(context, cwd, options, signal) {
    return gitDiffWithRunner(createGitRunner(context, signal), cwd, options);
}
async function gitDiffWithRunner(runGit, cwd, options) {
    const staged = options.staged === true;
    let path;
    if (options.path !== undefined && options.path !== "")
        path = normalizeRelativePath(options.path);
    if (path !== undefined) {
        const owner = await submoduleForPath(runGit, cwd, path);
        if (owner !== undefined)
            return submoduleDiff(runGit, owner, path, staged);
    }
    const args = ["diff", "--no-ext-diff", "--color=never"];
    if (staged)
        args.push("--cached");
    if (path !== undefined)
        args.push("--", path);
    const result = await runGit(cwd, args);
    if (result.code !== 0)
        throw new Error(result.stderr.trim() || "git diff failed");
    if (!staged && path !== undefined && result.stdout === "" && await isUntracked(runGit, cwd, path)) {
        const untracked = await runGit(cwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", path]);
        if (untracked.code !== 0 && untracked.code !== 1)
            throw new Error(untracked.stderr.trim() || "git diff failed");
        return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
    }
    return { ...(path === undefined ? {} : { path }), staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}
/**
 * Run the diff inside the owning submodule's working tree, since `git diff` at
 * the superproject root never shows content changes below a submodule boundary.
 * The response path stays the full superproject-relative path so the viewer and
 * the selected row line up.
 */
async function submoduleDiff(runGit, owner, path, staged) {
    const subCwd = owner.cwd;
    const rel = normalizeRelativePath(path.slice(owner.path.length + 1));
    const args = ["diff", "--no-ext-diff", "--color=never"];
    if (staged)
        args.push("--cached");
    args.push("--", rel);
    const result = await runGit(subCwd, args);
    if (result.code !== 0)
        throw new Error(result.stderr.trim() || "git diff failed");
    if (!staged && result.stdout === "" && await isUntracked(runGit, subCwd, rel)) {
        const untracked = await runGit(subCwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", rel]);
        if (untracked.code !== 0 && untracked.code !== 1)
            throw new Error(untracked.stderr.trim() || "git diff failed");
        return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
    }
    return { path, staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}
async function isUntracked(runGit, cwd, path) {
    const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
    return result.code === 0 && result.stdout.split("\0").includes(path);
}
/** Configured direct-submodule paths (depth 1), read from `.gitmodules`. */
async function configuredSubmodulePaths(runGit, cwd) {
    // `-z` emits `<key>\n<value>\0` records; keys may themselves contain spaces
    // (`submodule.my sub.path`), so splitting lines at the first space mangles
    // paths with spaces in them.
    const result = await runGit(cwd, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..+\\.path$"]);
    if (result.code !== 0)
        return [];
    const paths = [];
    for (const record of result.stdout.split("\0")) {
        if (record === "")
            continue;
        const newlineAt = record.indexOf("\n");
        if (newlineAt === -1)
            continue;
        try {
            const path = normalizeRelativePath(record.slice(newlineAt + 1));
            if (path !== "")
                paths.push(path);
        }
        catch {
            // A malformed repository path is not eligible for submodule routing.
        }
    }
    return [...new Set(paths)];
}
/** The validated gitlink that strictly contains `path`, if any (longest match wins). */
async function submoduleForPath(runGit, cwd, path) {
    if (!path.includes("/"))
        return undefined;
    const candidates = (await configuredSubmodulePaths(runGit, cwd))
        .filter((sub) => path.startsWith(`${sub}/`))
        .sort((left, right) => right.length - left.length);
    if (candidates.length === 0)
        return undefined;
    const canonicalRoot = await canonicalPath(cwd);
    if (canonicalRoot === undefined)
        return undefined;
    for (const candidate of candidates) {
        const validated = await validatedSubmodule(runGit, cwd, canonicalRoot, candidate);
        if (validated !== undefined)
            return validated;
    }
    return undefined;
}
/**
 * Confirm that repository-controlled `.gitmodules` data names an index
 * gitlink and that its checkout resolves strictly below the workspace root.
 * Commands use the resolved checkout rather than following the configured
 * path as a symlink.
 */
async function validatedSubmodule(runGit, cwd, canonicalRoot, path) {
    const index = await runGit(cwd, ["ls-files", "--stage", "-z", "--", path]);
    if (index.code !== 0 || !hasGitlink(index.stdout, path))
        return undefined;
    const candidate = await canonicalPath(join(cwd, path));
    if (candidate === undefined || !isStrictDescendant(canonicalRoot, candidate))
        return undefined;
    return { path, cwd: candidate };
}
function hasGitlink(raw, path) {
    return raw.split("\0").some((record) => {
        const separator = record.indexOf("\t");
        if (separator === -1 || record.slice(separator + 1) !== path)
            return false;
        return record.slice(0, separator).split(" ")[0] === "160000";
    });
}
async function canonicalPath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return undefined;
    }
}
function isStrictDescendant(root, candidate) {
    const relation = relative(root, candidate);
    return relation !== ""
        && relation !== ".."
        && !relation.startsWith(`..${sep}`)
        && !isAbsolute(relation);
}
function parseStatus(raw, options) {
    const records = raw.split("\0").filter((record) => record !== "");
    const files = [];
    const submodules = [];
    let branch;
    let upstream;
    let ahead;
    let behind;
    for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record === undefined)
            continue;
        if (record.startsWith("# branch.head "))
            branch = normalizeBranch(record.slice("# branch.head ".length));
        else if (record.startsWith("# branch.upstream "))
            upstream = record.slice("# branch.upstream ".length);
        else if (record.startsWith("# branch.ab ")) {
            const match = /\+(\d+) -(\d+)/.exec(record);
            if (match) {
                ahead = Number(match[1]);
                behind = Number(match[2]);
            }
        }
        else if (record.startsWith("? "))
            files.push({ path: record.slice(2), index: "untracked", workingTree: "untracked" });
        else if (record.startsWith("! "))
            files.push({ path: record.slice(2), index: "ignored", workingTree: "ignored" });
        else if (record.startsWith("1 ")) {
            const parts = record.split(" ");
            const sub = parts[2];
            const path = parts.slice(8).join(" ");
            const index = stateFor(parts[1]?.[0]);
            const workingTree = stateFor(parts[1]?.[1]);
            // A deleted gitlink has no pointer move or inner content to expand (a
            // staged deletion even reports the index OID as all zeros), so keep it
            // as a plain row instead of deferring it as a submodule.
            if (options.deferSubmodules && sub?.startsWith("S") === true && index !== "deleted" && workingTree !== "deleted") {
                const headOid = parts[6] ?? "";
                const indexOid = parts[7] ?? "";
                submodules.push({
                    path,
                    index,
                    workingTree,
                    // `c` only flags unstaged moves (submodule HEAD left the index OID);
                    // a staged move leaves HEAD == index, so compare the recorded OIDs.
                    commitChanged: sub[1] === "C" || headOid !== indexOid,
                    hasModifiedContent: sub[2] === "M",
                    hasUntrackedContent: sub[3] === "U",
                    headOid,
                    indexOid,
                });
            }
            else {
                files.push({ path, index, workingTree });
            }
        }
        else if (record.startsWith("2 ")) {
            const parts = record.split(" ");
            const path = parts.slice(9).join(" ");
            const oldPath = records[i + 1];
            i += 1;
            files.push({ path, ...(oldPath === undefined ? {} : { oldPath }), index: stateFor(parts[1]?.[0]), workingTree: stateFor(parts[1]?.[1]) });
        }
        else if (record.startsWith("u ")) {
            const parts = record.split(" ");
            files.push({ path: parts.slice(10).join(" "), index: "conflicted", workingTree: "conflicted" });
        }
    }
    return { isGitRepo: true, ...(branch === undefined ? {} : { branch }), ...(upstream === undefined ? {} : { upstream }), ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), files, submodules };
}
function stateFor(code) {
    if (code === undefined)
        return "unmodified";
    switch (code) {
        case ".": return "unmodified";
        case "M": return "modified";
        case "A": return "added";
        case "D": return "deleted";
        case "R": return "renamed";
        case "C": return "copied";
        case "U": return "conflicted";
        default: return "unmodified";
    }
}
function normalizeBranch(value) {
    return value === "(detached)" ? undefined : value;
}
function short(oid) {
    return oid.slice(0, 7);
}
/** A newly staged submodule records an all-zero head OID; display the pointer as `new → <sha>`. */
function displayFromCommit(headOid) {
    return /^0+$/.test(headOid) ? "new" : short(headOid);
}
function hash(value) {
    return createHash("sha1").update(value).digest("hex");
}
function statusProviderResponse(status) {
    return {
        isGitRepo: status.isGitRepo,
        hash: status.hash,
        ...(status.branch === undefined ? {} : { branch: status.branch }),
        ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
        ...(status.ahead === undefined ? {} : { ahead: status.ahead }),
        ...(status.behind === undefined ? {} : { behind: status.behind }),
        files: status.files.map((file) => ({
            path: file.path,
            ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
            index: file.index,
            workingTree: file.workingTree,
            ...(file.submoduleFromCommit === undefined ? {} : { submoduleFromCommit: file.submoduleFromCommit }),
            ...(file.submoduleToCommit === undefined ? {} : { submoduleToCommit: file.submoduleToCommit }),
        })),
        submodules: status.submodules,
    };
}
function diffProviderResponse(diff) {
    return {
        ...(diff.path === undefined ? {} : { path: diff.path }),
        staged: diff.staged,
        hash: diff.hash,
        diff: diff.diff,
        truncated: diff.truncated,
    };
}
function createGitRunner(context, signal) {
    return async (cwd, args) => commandResult(await context.execFile({
        file: "git",
        args,
        cwd,
        unsetEnv: GIT_LOCAL_ENV_VARS,
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        signal,
    }), args);
}
function commandResult(result, args) {
    const command = `git ${args.join(" ")}`;
    if (result.signal !== null)
        throw new Error(`${command} ended from signal ${result.signal}`);
    if (result.exitCode === null)
        throw new Error(`${command} ended without an exit code`);
    return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.stdoutTruncated,
    };
}
function requireStatusInput(input) {
    if (input !== null)
        throw new Error("Git status input must be null");
}
function parseDiffInput(input) {
    if (!isRecord(input))
        throw new Error("Git diff input must be an object");
    const unsupported = Object.keys(input).find((key) => key !== "path" && key !== "staged");
    if (unsupported !== undefined)
        throw new Error(`Git diff input contains an unsupported field: ${unsupported}`);
    const path = input["path"];
    const staged = input["staged"];
    if (path !== undefined && typeof path !== "string")
        throw new Error("Git diff input path must be a string");
    if (staged !== undefined && typeof staged !== "boolean")
        throw new Error("Git diff input staged must be a boolean");
    return {
        ...(path === undefined ? {} : { path }),
        ...(staged === undefined ? {} : { staged }),
    };
}
function normalizeRelativePath(input) {
    const value = input ?? "";
    if (value === "" || value === ".")
        return "";
    if (isAbsolute(value))
        throw new Error("Absolute paths are not allowed");
    const parts = value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === ".."))
        throw new Error("Path traversal is not allowed");
    return parts.join("/");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
