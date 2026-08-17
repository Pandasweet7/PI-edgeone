/** The value an extension's dialog Promise settles with on any close without an answer. */
export function extensionDialogCancelValue(kind) {
    return kind === "confirm" ? false : undefined;
}
/**
 * The auto-cancel delay of one dialog: the sooner of the extension's own
 * `timeout` and the daemon's `extensionDialogsTimeoutMs` default, where `0`
 * (or an invalid extension value, defensively ignored) means "waits forever".
 */
export function effectiveExtensionDialogTimeoutMs(extensionTimeoutMs, daemonDefaultMs) {
    const fromExtension = typeof extensionTimeoutMs === "number" && Number.isFinite(extensionTimeoutMs) && extensionTimeoutMs > 0 ? extensionTimeoutMs : undefined;
    const fromDaemon = daemonDefaultMs > 0 ? daemonDefaultMs : undefined;
    if (fromExtension === undefined)
        return fromDaemon;
    if (fromDaemon === undefined)
        return fromExtension;
    return Math.min(fromExtension, fromDaemon);
}
/**
 * The parked Promise resolvers behind open extension dialogs, plus the timers
 * and signal subscriptions that can end a wait without the browser. Timers use
 * the global `setTimeout`/`clearTimeout` looked up per call, the same seam the
 * rest of the service's timer tests fake.
 *
 * Kept deliberately separate from {@link PendingExtensionDialogStore}: the
 * store owns the domain state every browser sees, the waiters own the one
 * in-memory resolver each open dialog parks inside extension code — state no
 * browser ever observes and that must not survive the runtime. The pairing is
 * the wiring's invariant: every open store record has exactly one parked
 * waiter, and whoever closes the record settles the waiter exactly once.
 */
export class ExtensionDialogWaiters {
    constructor() {
        this.parked = new Map();
    }
    /**
     * Park the extension-facing Promise for a dialog the store just opened. Arms
     * the timeout and signal triggers; both are disarmed when the wait settles,
     * so a settled wait can never be triggered (nor trigger twice).
     */
    park(dialog, triggers = {}) {
        return new Promise((resolve) => {
            const parked = { cancelValue: extensionDialogCancelValue(dialog.kind), resolve };
            if (triggers.timeoutMs !== undefined) {
                const handle = setTimeout(() => { triggers.onTrigger?.("timeout"); }, triggers.timeoutMs);
                parked.cancelArmedTimeout = () => { clearTimeout(handle); };
            }
            if (triggers.signal !== undefined) {
                const signal = triggers.signal;
                const onAbort = () => { triggers.onTrigger?.("cancelled"); };
                signal.addEventListener("abort", onAbort, { once: true });
                parked.removeSignalListener = () => { signal.removeEventListener("abort", onAbort); };
            }
            this.parked.set(dialog.dialogId, parked);
        });
    }
    /** Resolve the parked wait with the user's answer, which the store has already validated and recorded. */
    settleWithAnswer(dialogId, answer) {
        return this.settle(dialogId, (parked) => { parked.resolve(answer); });
    }
    /** Resolve the parked wait with the dialog kind's cancel value after a close without an answer. */
    settleWithCancelValue(dialogId) {
        return this.settle(dialogId, (parked) => { parked.resolve(parked.cancelValue); });
    }
    settle(dialogId, resolveParked) {
        const parked = this.parked.get(dialogId);
        if (parked === undefined)
            return false;
        this.parked.delete(dialogId);
        parked.cancelArmedTimeout?.();
        parked.removeSignalListener?.();
        resolveParked(parked);
        return true;
    }
}
//# sourceMappingURL=extensionDialogWaiters.js.map