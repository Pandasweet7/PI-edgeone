import { isSessionActive } from "../../shared/activity.js";
/**
 * In-memory record of which working directories currently have session or
 * terminal activity.
 *
 * It publishes nothing itself: attribution and roll-up belong to the machine
 * status projection, which this service notifies whenever the record changes.
 */
export class WorkspaceActivityService {
    constructor(onChanged) {
        this.onChanged = onChanged;
        this.sessions = new Map();
        this.terminals = new Map();
    }
    applySessionStatus(cwd, status) {
        const previousCwd = this.sessions.get(status.sessionId)?.cwd;
        const record = this.sessions.get(status.sessionId) ?? { cwd };
        record.cwd = cwd;
        record.status = status;
        if (!isSessionActive(status) && record.activity?.phase === "active")
            delete record.activity;
        this.sessions.set(status.sessionId, record);
        this.pruneIdleSession(status.sessionId);
        this.notifyChangedCwds(previousCwd, cwd);
    }
    applySessionActivity(cwd, activity) {
        const previousCwd = this.sessions.get(activity.sessionId)?.cwd;
        const record = this.sessions.get(activity.sessionId) ?? { cwd };
        record.cwd = cwd;
        record.activity = activity;
        this.sessions.set(activity.sessionId, record);
        this.pruneIdleSession(activity.sessionId);
        this.notifyChangedCwds(previousCwd, cwd);
    }
    removeSession(sessionId, cwd) {
        const previousCwd = this.sessions.get(sessionId)?.cwd ?? cwd;
        this.sessions.delete(sessionId);
        this.notifyCwd(previousCwd);
    }
    reconcileSessionActivity(cwd, sessionIds) {
        const knownSessionIds = new Set(sessionIds);
        let changed = false;
        for (const [sessionId, record] of this.sessions.entries()) {
            if (record.cwd !== cwd || knownSessionIds.has(sessionId))
                continue;
            this.sessions.delete(sessionId);
            changed = true;
        }
        if (changed)
            this.notifyCwd(cwd);
    }
    updateTerminal(terminal) {
        const previousCwd = this.terminals.get(terminal.id)?.cwd;
        if (terminal.exited)
            this.terminals.delete(terminal.id);
        else
            this.terminals.set(terminal.id, { cwd: terminal.cwd });
        this.notifyChangedCwds(previousCwd, terminal.cwd);
    }
    removeTerminal(terminalId, cwd) {
        const previousCwd = this.terminals.get(terminalId)?.cwd ?? cwd;
        this.terminals.delete(terminalId);
        this.notifyCwd(previousCwd);
    }
    snapshot() {
        return { workspaces: this.activeCwds().map((cwd) => this.summaryForCwd(cwd)) };
    }
    pruneIdleSession(sessionId) {
        const record = this.sessions.get(sessionId);
        if (record !== undefined && !isSessionActive(record.status, record.activity))
            this.sessions.delete(sessionId);
    }
    notifyChangedCwds(previousCwd, cwd) {
        this.notifyCwd(previousCwd);
        if (previousCwd !== cwd)
            this.notifyCwd(cwd);
    }
    /**
     * The listener recomputes the whole projection, so it is told that something
     * changed rather than which cwd changed. Repeated notifications are harmless:
     * the projection publishes only when the computed tree actually differs.
     */
    notifyCwd(cwd) {
        if (cwd === undefined || cwd === "")
            return;
        this.onChanged?.();
    }
    activeCwds() {
        const cwds = new Set();
        for (const record of this.sessions.values()) {
            if (isSessionActive(record.status, record.activity))
                cwds.add(record.cwd);
        }
        for (const record of this.terminals.values())
            cwds.add(record.cwd);
        return [...cwds].sort((a, b) => a.localeCompare(b));
    }
    summaryForCwd(cwd) {
        return {
            cwd,
            hasSessionActivity: [...this.sessions.values()].some((record) => record.cwd === cwd && isSessionActive(record.status, record.activity)),
            hasTerminalActivity: [...this.terminals.values()].some((terminal) => terminal.cwd === cwd),
        };
    }
}
//# sourceMappingURL=workspaceActivityService.js.map