// Generated from pi-web-plugins/git/browser/gitFileViewPreference.ts. Do not edit directly.
export const GIT_FILE_VIEW_STORAGE_KEY = "pi-web.gitFileView";
export function parseGitFileView(value) {
    return value === "tree" ? "tree" : "list";
}
export function readGitFileView(storage = browserStorage()) {
    if (storage === undefined)
        return "list";
    try {
        return parseGitFileView(storage.getItem(GIT_FILE_VIEW_STORAGE_KEY));
    }
    catch {
        return "list";
    }
}
export function writeGitFileView(view, storage = browserStorage()) {
    if (storage === undefined)
        return;
    try {
        storage.setItem(GIT_FILE_VIEW_STORAGE_KEY, view);
    }
    catch {
        // Ignore localStorage quota/privacy errors; the chosen view still applies in memory for this tab.
    }
}
function browserStorage() {
    if (typeof window === "undefined")
        return undefined;
    try {
        return window.localStorage;
    }
    catch {
        return undefined;
    }
}
