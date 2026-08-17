// Generated from pi-web-plugins/git/browser/gitFileTree.ts. Do not edit directly.
import { pointerName, segmentName } from "./gitFileShared.js";
/**
 * Build a nested directory/file tree from Git's flat changed-file list. The
 * status response already carries every changed path, so this is a pure
 * client-side transform (no lazy per-directory loading like the Files tab).
 *
 * `submodules` lists submodule roots: a directory matching one is marked as a
 * submodule, a file whose path equals one becomes that submodule's pinned
 * commit-pointer row, and files below one nest inside it. Directories sort
 * before files (pointer row first within a submodule), both alphabetically.
 */
export function buildGitFileTree(files, submodules = []) {
    const root = createDirectoryAccumulator("");
    const submoduleSet = new Set(submodules);
    // Ensure a node exists (and is marked) for every submodule, so a submodule
    // whose only change is a moved pointer still renders as an expandable root.
    for (const submodule of submodules)
        ensureDirectory(root, submodule).isSubmodule = true;
    for (const file of files) {
        if (submoduleSet.has(file.path)) {
            const directory = ensureDirectory(root, file.path);
            directory.isSubmodule = true;
            directory.pointer = { kind: "file", name: pointerName(file), path: file.path, file, isSubmodulePointer: true };
            continue;
        }
        const segments = file.path.split("/").filter((segment) => segment.length > 0);
        const name = segments[segments.length - 1];
        if (name === undefined)
            continue;
        let directory = root;
        for (let index = 0; index < segments.length - 1; index += 1) {
            const segment = segments[index];
            if (segment === undefined)
                continue;
            directory = childDirectory(directory, segment);
        }
        directory.files.push({ kind: "file", name, path: file.path, file });
    }
    return finalizeChildren(root);
}
/**
 * Every directory path in the tree, in a stable order. Used to drive the
 * expand-all / collapse-all control and to decide whether the tree is fully
 * expanded. Submodule roots are directories and are included.
 */
export function collectGitFileTreeDirectoryPaths(nodes) {
    const paths = [];
    for (const node of nodes) {
        if (node.kind === "directory") {
            paths.push(node.path);
            paths.push(...collectGitFileTreeDirectoryPaths(node.children));
        }
    }
    return paths;
}
function createDirectoryAccumulator(path) {
    return { path, directories: new Map(), files: [], isSubmodule: false };
}
function childDirectory(parent, segment) {
    const childPath = parent.path.length === 0 ? segment : `${parent.path}/${segment}`;
    const existing = parent.directories.get(childPath);
    if (existing !== undefined)
        return existing;
    const created = createDirectoryAccumulator(childPath);
    parent.directories.set(childPath, created);
    return created;
}
function ensureDirectory(root, path) {
    let directory = root;
    for (const segment of path.split("/").filter((part) => part.length > 0))
        directory = childDirectory(directory, segment);
    return directory;
}
function finalizeChildren(directory) {
    const directories = [...directory.directories.values()]
        .map((child) => ({ kind: "directory", name: segmentName(child.path), path: child.path, ...(child.isSubmodule ? { isSubmodule: true } : {}), children: finalizeChildren(child) }))
        .sort((left, right) => left.name.localeCompare(right.name));
    const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
    return [...(directory.pointer === undefined ? [] : [directory.pointer]), ...directories, ...files];
}
