export function findArchiveCandidateByIdOrPrefix(candidates, sessionId) {
    return candidates.find((candidate) => candidate.id === sessionId) ?? candidates.find((candidate) => candidate.id.startsWith(sessionId));
}
export function planSessionArchiveTree(root, candidates) {
    const targets = sessionArchiveSubtree(root, candidates);
    const unarchivedTargets = targets.filter((target) => !target.archived);
    return {
        targets,
        unarchivedTargets,
        skippedAlreadyArchivedCount: targets.length - unarchivedTargets.length,
    };
}
function sessionArchiveSubtree(root, candidates) {
    const childrenByParentPath = new Map();
    for (const candidate of candidates) {
        if (candidate.parentSessionPath === undefined)
            continue;
        const children = childrenByParentPath.get(candidate.parentSessionPath) ?? [];
        children.push(candidate);
        childrenByParentPath.set(candidate.parentSessionPath, children);
    }
    const result = [];
    const visit = (candidate, seenPaths) => {
        if (seenPaths.has(candidate.path))
            return;
        result.push(candidate);
        const nextSeenPaths = new Set(seenPaths);
        nextSeenPaths.add(candidate.path);
        for (const child of childrenByParentPath.get(candidate.path) ?? [])
            visit(child, nextSeenPaths);
    };
    visit(root, new Set());
    return result;
}
//# sourceMappingURL=sessionArchiveTree.js.map