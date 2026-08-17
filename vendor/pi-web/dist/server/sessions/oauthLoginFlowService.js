import crypto from "node:crypto";
const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RUNNING_TTL_MS = 30 * 60 * 1000;
const noopLogger = { error() { } };
/**
 * AuthInteraction transport shared by OAuth and provider-driven API-key login.
 * The historical class and wire names predate the shared transport and remain
 * unchanged.
 */
export class OAuthLoginFlowService {
    constructor(options = {}) {
        this.flows = new Map();
        this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
        this.runningTtlMs = options.runningTtlMs ?? DEFAULT_RUNNING_TTL_MS;
        this.now = options.now ?? (() => Date.now());
        this.logger = options.logger ?? noopLogger;
    }
    start(options) {
        const flowId = crypto.randomUUID();
        const abort = new AbortController();
        const record = {
            flowId,
            abort,
            pending: undefined,
            state: {
                flowId,
                providerId: options.providerId,
                providerName: options.providerName,
                status: "running",
                progress: [],
            },
        };
        this.flows.set(flowId, record);
        this.scheduleRunningExpiry(record);
        // Adapt the pi-ai AuthInteraction contract onto the web-UI flow state:
        // `prompt()` returns the entered/selected string; `notify()` surfaces
        // out-of-band login events (auth URL, device code, progress).
        const interaction = {
            signal: abort.signal,
            prompt: (prompt) => this.handlePrompt(record, prompt),
            notify: (event) => { this.handleEvent(record, event); },
        };
        void options.runtime.login(options.providerId, options.authType ?? "oauth", interaction).then(() => this.reconcileCommittedLogin(record, options.onComplete), (error) => {
            if (!this.isCurrent(record))
                return;
            this.clearPending(record);
            if (record.state.status !== "running")
                return;
            this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: error instanceof Error ? error.message : String(error) });
        });
        return this.get(flowId);
    }
    get(flowId) {
        const record = this.flows.get(flowId);
        if (record === undefined)
            throw new Error("Login flow not found");
        return cloneState(record.state);
    }
    respond(flowId, requestId, value) {
        const record = this.flows.get(flowId);
        if (record === undefined)
            throw new Error("Login flow not found");
        if (record.state.status !== "running")
            return cloneState(record.state);
        const pending = record.pending;
        if (pending?.requestId !== requestId)
            throw new Error("Login request expired");
        if (!pending.allowEmpty && value.trim() === "")
            throw new Error("A value is required");
        if (pending.allowedValues !== undefined && !pending.allowedValues.has(value))
            throw new Error("Invalid login selection");
        this.clearPending(record);
        this.updateState(record, withoutInteraction(record.state));
        pending.resolve(value);
        return cloneState(record.state);
    }
    cancel(flowId) {
        const record = this.flows.get(flowId);
        if (record === undefined)
            throw new Error("Login flow not found");
        if (record.state.status === "running") {
            record.abort.abort();
            const pending = this.clearPending(record);
            this.markTerminal(record, { ...withoutInteraction(record.state), status: "cancelled", error: "Login cancelled" });
            pending?.reject(new Error("Login cancelled"));
        }
        return cloneState(record.state);
    }
    dispose() {
        for (const record of this.flows.values()) {
            this.clearTimer(record);
            record.abort.abort();
            const pending = this.clearPending(record);
            pending?.reject(new Error("Login cancelled"));
        }
        this.flows.clear();
    }
    handlePrompt(record, prompt) {
        if (prompt.type === "select")
            return this.waitForSelect(record, prompt);
        return this.waitForPrompt(record, prompt);
    }
    handleEvent(record, event) {
        if (!this.isCurrentRunning(record))
            return;
        switch (event.type) {
            case "auth_url":
                this.updateState(record, { ...record.state, auth: { url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) } });
                return;
            case "device_code":
                this.updateState(record, {
                    ...record.state,
                    auth: {
                        url: event.verificationUri,
                        deviceCode: {
                            userCode: event.userCode,
                            ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
                            ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
                        },
                    },
                });
                return;
            case "info":
                this.updateState(record, {
                    ...record.state,
                    progress: [...record.state.progress, event.message],
                    info: [
                        ...(record.state.info ?? []),
                        {
                            message: event.message,
                            ...(event.links === undefined ? {} : {
                                links: event.links.map((link) => ({
                                    url: link.url,
                                    ...(link.label === undefined ? {} : { label: link.label }),
                                })),
                            }),
                        },
                    ],
                });
                return;
            case "progress":
                this.updateState(record, { ...record.state, progress: [...record.state.progress, event.message] });
                return;
        }
    }
    waitForPrompt(record, prompt) {
        return new Promise((resolve, reject) => {
            if (!this.isCurrentRunning(record)) {
                reject(new Error("Login cancelled"));
                return;
            }
            const requestId = crypto.randomUUID();
            const pending = {
                requestId,
                allowEmpty: prompt.type === "text",
                resolve,
                reject,
            };
            record.pending = pending;
            if (!this.bindPromptSignal(record, pending, prompt.signal))
                return;
            const base = withoutInteraction(record.state);
            this.updateState(record, {
                ...base,
                prompt: {
                    requestId,
                    message: prompt.message,
                    promptType: prompt.type,
                    ...(prompt.type === "text" ? { allowEmpty: true } : {}),
                    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
                },
            });
        });
    }
    waitForSelect(record, prompt) {
        return new Promise((resolve, reject) => {
            if (!this.isCurrentRunning(record)) {
                reject(new Error("Login cancelled"));
                return;
            }
            const requestId = crypto.randomUUID();
            const options = prompt.options.map((option) => ({
                value: option.id,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
            }));
            const pending = {
                requestId,
                allowEmpty: false,
                resolve,
                reject,
                allowedValues: new Set(options.map((option) => option.value)),
            };
            record.pending = pending;
            if (!this.bindPromptSignal(record, pending, prompt.signal))
                return;
            const base = withoutInteraction(record.state);
            this.updateState(record, { ...base, select: { requestId, message: prompt.message, options } });
        });
    }
    // A prompt may carry its own AbortSignal (e.g. a manual_code prompt raced
    // against a callback server). When it fires, drop just that pending request
    // and clear the interaction from state — the overall login keeps running.
    bindPromptSignal(record, pending, signal) {
        if (signal === undefined)
            return true;
        const onAbort = () => {
            if (record.pending !== pending)
                return;
            this.clearPending(record);
            if (this.isCurrentRunning(record))
                this.updateState(record, withoutInteraction(record.state));
            pending.reject(new Error("Prompt cancelled"));
        };
        pending.cleanup = () => { signal.removeEventListener("abort", onAbort); };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return false;
        }
        return true;
    }
    clearPending(record) {
        const pending = record.pending;
        record.pending = undefined;
        pending?.cleanup?.();
        return pending;
    }
    // ModelRuntime persists the credential before its post-login refresh. If a
    // cancellation lands during that refresh, the resolved login is committed
    // truth and must supersede the transient cancelled state.
    async reconcileCommittedLogin(record, onComplete) {
        if (this.isCurrent(record))
            this.clearPending(record);
        try {
            await onComplete?.();
        }
        catch (error) {
            this.logErrorNoThrow({ err: error, flowId: record.flowId, providerId: record.state.providerId }, "login completion callback failed");
        }
        if (!this.isCurrent(record))
            return;
        const completed = withoutInteraction(record.state);
        delete completed.error;
        this.markTerminal(record, { ...completed, status: "complete", progress: [...record.state.progress, "Login complete"] });
    }
    isCurrent(record) {
        return this.flows.get(record.flowId) === record;
    }
    isCurrentRunning(record) {
        return this.isCurrent(record) && record.state.status === "running";
    }
    logErrorNoThrow(details, message) {
        try {
            this.logger.error(details, message);
        }
        catch {
            // Logging is post-commit diagnostics and must never change auth truth.
        }
    }
    updateState(record, state) {
        record.state = state;
    }
    markTerminal(record, state) {
        this.updateState(record, state);
        record.terminalAt = this.now();
        this.scheduleTerminalEviction(record);
    }
    scheduleRunningExpiry(record) {
        if (this.runningTtlMs <= 0) {
            this.expireRunningFlow(record);
            return;
        }
        this.setTimer(record, this.runningTtlMs, () => { this.expireRunningFlow(record); });
    }
    scheduleTerminalEviction(record) {
        if (this.terminalTtlMs <= 0) {
            this.flows.delete(record.flowId);
            this.clearTimer(record);
            return;
        }
        this.setTimer(record, this.terminalTtlMs, () => {
            if (this.flows.get(record.flowId) !== record)
                return;
            if (record.terminalAt === undefined)
                return;
            if (this.now() - record.terminalAt < this.terminalTtlMs) {
                this.scheduleTerminalEviction(record);
                return;
            }
            this.flows.delete(record.flowId);
            this.clearTimer(record);
        });
    }
    expireRunningFlow(record) {
        if (!this.isCurrentRunning(record))
            return;
        record.abort.abort();
        const pending = this.clearPending(record);
        this.markTerminal(record, { ...withoutInteraction(record.state), status: "error", error: "Login flow expired" });
        pending?.reject(new Error("Login flow expired"));
    }
    setTimer(record, delayMs, callback) {
        this.clearTimer(record);
        record.cleanupTimer = setTimeout(callback, delayMs);
        unrefTimer(record.cleanupTimer);
    }
    clearTimer(record) {
        if (record.cleanupTimer === undefined)
            return;
        clearTimeout(record.cleanupTimer);
        delete record.cleanupTimer;
    }
}
function withoutInteraction(state) {
    const rest = { ...state };
    delete rest.prompt;
    delete rest.select;
    return rest;
}
function cloneState(state) {
    return {
        ...state,
        progress: [...state.progress],
        ...(state.auth === undefined ? {} : {
            auth: {
                ...state.auth,
                ...(state.auth.deviceCode === undefined ? {} : { deviceCode: { ...state.auth.deviceCode } }),
            },
        }),
        ...(state.prompt === undefined ? {} : { prompt: { ...state.prompt } }),
        ...(state.select === undefined ? {} : { select: { ...state.select, options: state.select.options.map((option) => ({ ...option })) } }),
        ...(state.info === undefined ? {} : {
            info: state.info.map((item) => ({
                ...item,
                ...(item.links === undefined ? {} : { links: item.links.map((link) => ({ ...link })) }),
            })),
        }),
    };
}
function unrefTimer(timer) {
    if (typeof timer !== "object" || !("unref" in timer) || typeof timer.unref !== "function")
        return;
    timer.unref();
}
//# sourceMappingURL=oauthLoginFlowService.js.map