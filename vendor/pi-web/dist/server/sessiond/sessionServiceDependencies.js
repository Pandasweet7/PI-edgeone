/**
 * Map sessiond's constructed collaborators onto the session service's
 * dependencies.
 *
 * Extracted from `sessiond.ts`, which starts a daemon as an import side effect
 * and so cannot be loaded by a test. This function performs no side effects and
 * constructs nothing, so lifting it changes no startup ordering; it exists only
 * so a test can build a service the way the daemon does and assert what a user
 * is actually told.
 */
export function sessionServiceDependencies(input) {
    return {
        modelRuntime: input.modelRuntime,
        agentDir: input.agentDir,
        archiveStore: input.archiveStore,
        workspaceActivity: input.workspaceActivity,
        logger: input.logger,
        ...(input.spawnTargets === undefined ? {} : { spawnTargets: input.spawnTargets }),
        // Tracked subsessions share the spawn capability's project-scope resolver,
        // so they stay off unless spawning is configured too.
        subsessionsEnabled: input.spawnTargets !== undefined && input.subsessionsEnabled,
        askUserEnabled: input.askUserEnabled,
        appendSystemPromptSections: input.appendSystemPromptSections,
        extensionDialogsTimeoutMs: input.extensionDialogsTimeoutMs,
        notificationStore: input.notificationStore,
        unreadStore: input.unreadStore,
        onUnreadChanged: input.onUnreadChanged,
        // Read-only, so session startup can tell a waiting user that provider
        // model lists are refreshing at the same time.
        catalogRefreshStatus: input.catalogRefreshStatus,
        sessionManager: input.sessionManager,
    };
}
//# sourceMappingURL=sessionServiceDependencies.js.map