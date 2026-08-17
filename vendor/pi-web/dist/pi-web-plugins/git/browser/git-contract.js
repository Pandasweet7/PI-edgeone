// Generated from pi-web-plugins/git/browser/git-contract.ts. Do not edit directly.
export const GIT_STATUS_OPERATION = "status";
export const GIT_DIFF_OPERATION = "diff";
export function parseGitStatusResponse(value) {
    const record = requireRecord(value, "Git status response");
    const branch = optionalString(record, "branch");
    const upstream = optionalString(record, "upstream");
    const ahead = optionalNumber(record, "ahead");
    const behind = optionalNumber(record, "behind");
    return {
        isGitRepo: requireBoolean(record, "isGitRepo"),
        hash: requireString(record, "hash"),
        ...(branch === undefined ? {} : { branch }),
        ...(upstream === undefined ? {} : { upstream }),
        ...(ahead === undefined ? {} : { ahead }),
        ...(behind === undefined ? {} : { behind }),
        files: requireArray(record, "files").map(parseGitStatusFile),
        submodules: record["submodules"] === undefined ? [] : requireStringArray(record["submodules"], "submodules"),
    };
}
export function parseGitDiffResponse(value) {
    const record = requireRecord(value, "Git diff response");
    const path = optionalString(record, "path");
    return {
        ...(path === undefined ? {} : { path }),
        staged: requireBoolean(record, "staged"),
        hash: requireString(record, "hash"),
        diff: requireString(record, "diff"),
        truncated: requireBoolean(record, "truncated"),
    };
}
function parseGitStatusFile(value) {
    const record = requireRecord(value, "Git status file");
    const oldPath = optionalString(record, "oldPath");
    const submoduleFromCommit = optionalString(record, "submoduleFromCommit");
    const submoduleToCommit = optionalString(record, "submoduleToCommit");
    return {
        path: requireString(record, "path"),
        ...(oldPath === undefined ? {} : { oldPath }),
        index: parseGitFileState(record["index"]),
        workingTree: parseGitFileState(record["workingTree"]),
        ...(submoduleFromCommit === undefined ? {} : { submoduleFromCommit }),
        ...(submoduleToCommit === undefined ? {} : { submoduleToCommit }),
    };
}
function parseGitFileState(value) {
    switch (value) {
        case "unmodified":
        case "modified":
        case "added":
        case "deleted":
        case "renamed":
        case "copied":
        case "untracked":
        case "ignored":
        case "conflicted":
            return value;
        default:
            throw new Error("Invalid Git file state");
    }
}
function requireRecord(value, label) {
    if (!isRecord(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function requireArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value))
        throw new Error(`Expected array field: ${key}`);
    return value;
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== "string")
        throw new Error(`Expected string field: ${key}`);
    return value;
}
function requireBoolean(record, key) {
    const value = record[key];
    if (typeof value !== "boolean")
        throw new Error(`Expected boolean field: ${key}`);
    return value;
}
function optionalString(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`Expected string field: ${key}`);
    return value;
}
function optionalNumber(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`Expected number field: ${key}`);
    return value;
}
function requireStringArray(value, key) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
        throw new Error(`Expected string array field: ${key}`);
    return value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
