// Generated from pi-web-plugins/git/browser/gitRoute.ts. Do not edit directly.
const legacyDiffNamespace = "core.workspace.git";
const diffQueryKey = "diff";
export function createGitDiffRoute(panelContributionId) {
    const namespace = panelContributionId.replaceAll(":", ".");
    const key = `${namespace}--${diffQueryKey}`;
    const legacyKey = `${legacyDiffNamespace}--${diffQueryKey}`;
    return {
        matches: routeMatchesWorkspace,
        read: () => {
            const params = new URLSearchParams(window.location.search);
            return nonEmpty(params.get(key)) ?? nonEmpty(params.get(legacyKey));
        },
        write: (path, options) => {
            const url = new URL(window.location.href);
            url.searchParams.delete(key);
            url.searchParams.delete(legacyKey);
            if (path !== undefined && path !== "")
                url.searchParams.set(key, path);
            commitUrl(url, options?.replace === true);
        },
    };
}
function routeMatchesWorkspace(context) {
    const params = new URLSearchParams(window.location.search);
    return (params.get("machine") ?? "local") === context.machine.id
        && params.get("project") === context.workspace.projectId
        && params.get("workspace") === context.workspace.id;
}
function nonEmpty(value) {
    return value === null || value === "" ? undefined : value;
}
function commitUrl(url, replace) {
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current)
        return;
    if (replace)
        window.history.replaceState({}, "", url);
    else
        window.history.pushState({}, "", url);
}
