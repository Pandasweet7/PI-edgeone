/** Quiesces ingress, disposes consumers, then tears down plugin providers and dependencies. */
export async function runSessionDaemonShutdown(options) {
    const { dependencies } = options;
    const operations = [
        ["quiesce server", () => dependencies.quiesceServer()],
        ["dispose terminals", () => dependencies.terminals.dispose()],
        ["dispose catalog refresher", () => dependencies.catalogRefresher.dispose()],
        ["dispose sessions", () => dependencies.sessions.dispose()],
        ["close server", () => dependencies.closeServer()],
        ["stop server plugins", () => dependencies.serverPlugins.stop()],
        ["dispose auth", () => dependencies.auth.dispose()],
        ["flush session unread state", () => dependencies.unreadStore.flush()],
    ];
    for (const [operation, run] of operations) {
        try {
            await run();
        }
        catch (error) {
            options.onFailure?.();
            options.logger.error({ err: error, operation }, "session daemon shutdown operation failed");
        }
    }
}
//# sourceMappingURL=sessionDaemonShutdown.js.map