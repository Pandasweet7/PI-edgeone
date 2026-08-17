import { randomUUID } from "node:crypto";
import { EXTENSION_DIALOG_ID_MAX_LENGTH, EXTENSION_DIALOG_INPUT_MAX_LENGTH, EXTENSION_DIALOG_OPTION_LIMIT, EXTENSION_DIALOG_TEXT_MAX_LENGTH, } from "../../shared/apiTypes.js";
/** Rejected input: the dialog is malformed, or an answer does not fit its kind. */
export class PendingExtensionDialogValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "PendingExtensionDialogValidationError";
    }
}
/**
 * Daemon-owned open-dialog state: the extension dialogs of every session,
 * several per session because each dialog is an independent blocking wait
 * inside extension code — opening one must never supersede another.
 *
 * The store is pure domain logic — no Fastify, no Pi session, no I/O, no
 * timers. It validates dialogs and answers and owns the open/answer/cancel
 * transitions; callers hold the waiting Promise resolvers, publish the
 * returned records and outcomes, and own the timers that turn `timeoutAt`
 * into a `"timeout"` cancel.
 *
 * State is deliberately daemon-lifetime and in-memory. An open dialog is
 * meaningful only while the session runtime whose extension is waiting on it
 * exists, and browsers rehydrate open dialogs from `SessionStatus` rather
 * than from disk.
 */
export class PendingExtensionDialogStore {
    constructor(options = {}) {
        /** Per-session open dialogs in insertion order, so `pendingDialogs` reads oldest first. */
        this.openBySessionId = new Map();
        this.now = options.now ?? (() => new Date());
        this.createDialogId = options.createDialogId ?? randomUUID;
    }
    /** The session's open dialogs, oldest first, for {@link SessionStatus} projection. */
    pendingDialogs(sessionId) {
        const dialogs = this.openBySessionId.get(requireSessionId(sessionId));
        if (dialogs === undefined)
            return [];
        return [...dialogs.values()].map(cloneDialog);
    }
    open(input) {
        const sessionId = requireSessionId(input.sessionId);
        const kind = requireKind(input.kind);
        const now = this.now();
        const dialog = {
            dialogId: requireId(this.createDialogId(), "dialogId"),
            kind,
            title: requireText(input.title, "dialog title"),
            ...kindFields(kind, input),
            askedAt: now.toISOString(),
            ...timeoutField(input.timeoutMs, now),
            runScoped: input.runScoped,
        };
        const dialogs = this.openBySessionId.get(sessionId) ?? new Map();
        if (dialogs.has(dialog.dialogId)) {
            throw new Error(`Dialog id ${dialog.dialogId} is already open in session ${sessionId}`);
        }
        dialogs.set(dialog.dialogId, dialog);
        this.openBySessionId.set(sessionId, dialogs);
        return cloneDialog(dialog);
    }
    /**
     * Record the user's answer and close the dialog. The answer is validated
     * against the dialog's kind first, so an answer that does not fit leaves the
     * dialog open for the browser to correct.
     */
    answer(sessionId, dialogId, value) {
        const dialog = this.openBySessionId.get(requireSessionId(sessionId))?.get(dialogId);
        if (dialog === undefined)
            return { status: "stale" };
        const answer = validateAnswer(dialog, value);
        return { status: "closed", outcome: this.requireClose(sessionId, dialog, "answered", answer) };
    }
    /** Close the dialog without an answer; the extension's wait settles with its kind's cancel value. */
    cancel(sessionId, dialogId, reason) {
        const dialog = this.openBySessionId.get(requireSessionId(sessionId))?.get(dialogId);
        if (dialog === undefined)
            return { status: "stale" };
        return { status: "closed", outcome: this.requireClose(sessionId, dialog, reason, undefined) };
    }
    requireClose(sessionId, dialog, reason, answer) {
        const dialogs = this.openBySessionId.get(sessionId);
        if (dialogs?.delete(dialog.dialogId) !== true) {
            throw new Error(`Dialog ${dialog.dialogId} of session ${sessionId} disappeared while closing`);
        }
        if (dialogs.size === 0)
            this.openBySessionId.delete(sessionId);
        return {
            dialogId: dialog.dialogId,
            reason,
            ...(answer === undefined ? {} : { answer }),
            askedAt: dialog.askedAt,
            closedAt: this.timestamp(),
        };
    }
    timestamp() {
        return this.now().toISOString();
    }
}
function validateAnswer(dialog, value) {
    switch (dialog.kind) {
        case "confirm":
            if (typeof value !== "boolean")
                throw new PendingExtensionDialogValidationError(`Dialog ${dialog.dialogId} expects a boolean answer`);
            return value;
        case "select":
            if (typeof value !== "string" || dialog.options?.includes(value) !== true) {
                throw new PendingExtensionDialogValidationError(`Dialog ${dialog.dialogId} has no option ${String(value)}`);
            }
            return value;
        case "input":
            if (typeof value !== "string")
                throw new PendingExtensionDialogValidationError(`Dialog ${dialog.dialogId} expects a text answer`);
            if (value.length > EXTENSION_DIALOG_INPUT_MAX_LENGTH) {
                throw new PendingExtensionDialogValidationError(`Answer of dialog ${dialog.dialogId} exceeds its length limit`);
            }
            return value;
    }
}
/** Kind-specific fields of a validated record; irrelevant fields are dropped rather than rejected. */
function kindFields(kind, input) {
    switch (kind) {
        case "confirm": {
            const message = optionalText(input.message, "dialog message");
            return message === undefined ? {} : { message };
        }
        case "select":
            return { options: validateOptions(input.options) };
        case "input": {
            const placeholder = optionalText(input.placeholder, "dialog placeholder");
            return placeholder === undefined ? {} : { placeholder };
        }
    }
}
function validateOptions(options) {
    if (options === undefined || options.length === 0) {
        throw new PendingExtensionDialogValidationError("A select dialog must offer at least one option");
    }
    if (options.length > EXTENSION_DIALOG_OPTION_LIMIT) {
        throw new PendingExtensionDialogValidationError(`A select dialog must not offer more than ${EXTENSION_DIALOG_OPTION_LIMIT.toString()} options`);
    }
    const seen = new Set();
    return options.map((option) => {
        const validated = requireText(option, "select option");
        if (seen.has(validated))
            throw new PendingExtensionDialogValidationError(`Duplicate select option ${validated}`);
        seen.add(validated);
        return validated;
    });
}
function timeoutField(timeoutMs, now) {
    if (timeoutMs === undefined)
        return {};
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new PendingExtensionDialogValidationError("A dialog timeout must be a positive number of milliseconds");
    }
    return { timeoutAt: new Date(now.getTime() + timeoutMs).toISOString() };
}
function cloneDialog(dialog) {
    return { ...dialog, ...(dialog.options === undefined ? {} : { options: [...dialog.options] }) };
}
function requireSessionId(sessionId) {
    if (sessionId === "")
        throw new Error("sessionId must not be empty");
    return sessionId;
}
/** Runtime guard: the input crosses extension code, so the declared kind is checked despite its type. */
function requireKind(kind) {
    if (kind !== "confirm" && kind !== "select" && kind !== "input") {
        throw new PendingExtensionDialogValidationError(`Unknown dialog kind ${kind}`);
    }
    return kind;
}
function requireId(value, field) {
    if (value.trim() === "")
        throw new PendingExtensionDialogValidationError(`${field} must not be empty`);
    if (value.length > EXTENSION_DIALOG_ID_MAX_LENGTH)
        throw new PendingExtensionDialogValidationError(`${field} exceeds its length limit`);
    return value;
}
function requireText(value, field) {
    if (value.trim() === "")
        throw new PendingExtensionDialogValidationError(`${field} must not be empty`);
    if (value.length > EXTENSION_DIALOG_TEXT_MAX_LENGTH)
        throw new PendingExtensionDialogValidationError(`${field} exceeds its length limit`);
    return value;
}
/** Optional cosmetic prose: blank means absent rather than being a validation error. */
function optionalText(value, field) {
    if (value === undefined || value.trim() === "")
        return undefined;
    if (value.length > EXTENSION_DIALOG_TEXT_MAX_LENGTH) {
        throw new PendingExtensionDialogValidationError(`${field} exceeds its length limit`);
    }
    return value;
}
//# sourceMappingURL=pendingExtensionDialogStore.js.map