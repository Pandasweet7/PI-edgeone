// Generated from pi-web-plugins/git/browser/gitFileShared.ts. Do not edit directly.
/**
 * Display label for a submodule commit-pointer row: the `<old> → <new>`
 * short-SHA summary, or "commit" when the server did not resolve both ends.
 */
export function pointerName(file) {
    const from = file.submoduleFromCommit;
    const to = file.submoduleToCommit;
    return from !== undefined && to !== undefined ? `${from} → ${to}` : "commit";
}
/** Final segment of a path, used as the display name for tree/list rows. */
export function segmentName(path) {
    const segments = path.split("/");
    const last = segments[segments.length - 1];
    return last ?? path;
}
