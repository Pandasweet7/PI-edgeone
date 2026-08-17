// Generated from pi-web-plugins/git/browser/gitFileList.ts. Do not edit directly.
import { pointerName, segmentName } from "./gitFileShared.js";
/**
 * Group the flat changed-file list for list view. Unlike the tree, submodule
 * contents are flattened: each submodule becomes one expandable group holding
 * its pointer row and its changed files, and everything else stays a flat list.
 */
export function buildGitFileList(files, submodules = []) {
    const submoduleSet = new Set(submodules);
    const pointers = new Map();
    const grouped = new Map();
    for (const submodule of submodules)
        grouped.set(submodule, []);
    const flat = [];
    for (const file of files) {
        if (submoduleSet.has(file.path)) {
            pointers.set(file.path, { name: pointerName(file), file });
            continue;
        }
        const owner = ownerSubmodule(file.path, submodules);
        if (owner !== undefined) {
            grouped.get(owner)?.push({ path: file.path, relativePath: file.path.slice(owner.length + 1), file });
            continue;
        }
        flat.push(file);
    }
    const groups = submodules
        .map((submodule) => {
        const pointer = pointers.get(submodule);
        const inner = grouped.get(submodule) ?? [];
        return { path: submodule, name: segmentName(submodule), ...(pointer === undefined ? {} : { pointer }), files: [...inner].sort((left, right) => left.relativePath.localeCompare(right.relativePath)) };
    })
        .sort((left, right) => left.name.localeCompare(right.name));
    return { submodules: groups, files: flat };
}
function ownerSubmodule(path, submodules) {
    let best;
    for (const submodule of submodules) {
        if (submodule !== "" && path.startsWith(`${submodule}/`) && (best === undefined || submodule.length > best.length))
            best = submodule;
    }
    return best;
}
