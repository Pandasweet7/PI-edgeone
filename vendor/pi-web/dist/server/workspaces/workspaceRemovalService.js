import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { workspaceDeletionMetadata } from "../../shared/workspaceDeletion.js";
import { requireWorkspaceRemovalPrecondition, WORKSPACE_REMOVAL_OPERATION_TIMEOUT_MS, } from "../../shared/workspaceRemovalProtocol.js";
import { WorkspaceProviderRemovalError, } from "./workspaceProviderRegistry.js";
import { composeWorktreePreRemoveCommand, realWorktreePreRemoveHookProbe, worktreePreRemoveHookPath, } from "./worktreePreRemoveHook.js";
export class WorkspaceRemovalError extends Error {
    constructor(message, statusCode = 400, options = {}) {
        super(message, options);
        this.statusCode = statusCode;
        this.name = "WorkspaceRemovalError";
    }
}
/**
 * Sessiond-owned removal orchestration. Providers validate and plan their native
 * operation; the host retains generic path safety, terminal lifetime, and the
 * visible command-run contract.
 */
export class WorkspaceRemovalService {
    constructor(providers, terminals, options = {}) {
        this.providers = providers;
        this.terminals = terminals;
        this.flights = new Map();
        this.timeoutMs = positiveInteger(options.timeoutMs ?? WORKSPACE_REMOVAL_OPERATION_TIMEOUT_MS, "timeoutMs");
        this.preRemoveHook = options.preRemoveHook ?? realWorktreePreRemoveHookProbe;
    }
    async remove(project, workspaceId, precondition, signal) {
        let expectedPrecondition;
        try {
            expectedPrecondition = requireWorkspaceRemovalPrecondition(precondition);
        }
        catch (error) {
            throw new WorkspaceRemovalError(errorMessage(error), 400, { cause: error });
        }
        throwIfAborted(signal);
        const key = removalFlightKey(project.id, workspaceId);
        const currentFlight = this.flights.get(key);
        if (currentFlight !== undefined) {
            if (currentFlight.precondition !== expectedPrecondition) {
                throw new WorkspaceRemovalError("Workspace removal is already in progress with a different confirmation", 409);
            }
            return await this.waitForFlight(currentFlight, signal);
        }
        const controller = new AbortController();
        const promise = this.executeRemoval(project, workspaceId, expectedPrecondition, controller.signal);
        const flight = {
            precondition: expectedPrecondition,
            controller,
            promise,
            waiters: 0,
            settled: false,
        };
        this.flights.set(key, flight);
        void promise.then(() => { this.finishFlight(key, flight); }, () => { this.finishFlight(key, flight); });
        return await this.waitForFlight(flight, signal);
    }
    async executeRemoval(project, workspaceId, precondition, flightSignal) {
        try {
            return await runBoundedRemoval(this.timeoutMs, flightSignal, async (signal) => {
                const current = await this.providers.resolveRemoval(project, workspaceId, signal);
                throwIfAborted(signal);
                const { target, commandWorkspace } = validateCurrentRemoval(project, workspaceId, precondition, current);
                const plan = await current.prepare();
                throwIfAborted(signal);
                // Probe the repo-provided hook before any side effect, so an unexpected
                // filesystem failure aborts before terminals are closed.
                const hookPath = worktreePreRemoveHookPath(commandWorkspace.path);
                let hookExecutable;
                try {
                    hookExecutable = await this.preRemoveHook.isExecutable(hookPath);
                }
                catch (error) {
                    throw new WorkspaceRemovalError(`Failed to inspect the workspace pre-remove hook: ${errorMessage(error)}`, 500, { cause: error });
                }
                const command = hookExecutable
                    ? composeWorktreePreRemoveCommand(hookPath, target.path, plan.command)
                    : plan.command;
                throwIfAborted(signal);
                try {
                    this.terminals.closeForCwd(target.path);
                }
                catch (error) {
                    throw new WorkspaceRemovalError(`Failed to close workspace terminals: ${errorMessage(error)}`, 400, { cause: error });
                }
                throwIfAborted(signal);
                try {
                    return this.terminals.runCommand({
                        origin: "core",
                        projectId: project.id,
                        workspaceId: commandWorkspace.id,
                        cwd: commandWorkspace.path,
                        title: plan.title,
                        command,
                        metadata: workspaceDeletionMetadata(target),
                    });
                }
                catch (error) {
                    throw new WorkspaceRemovalError(`Failed to start workspace removal: ${errorMessage(error)}`, 400, { cause: error });
                }
            });
        }
        catch (error) {
            if (error instanceof WorkspaceRemovalDeadlineError) {
                throw new WorkspaceRemovalError(error.message, 504, { cause: error });
            }
            throw error;
        }
    }
    waitForFlight(flight, signal) {
        throwIfAborted(signal);
        flight.waiters += 1;
        return new Promise((resolvePromise, rejectPromise) => {
            let finished = false;
            const finish = (callback) => {
                if (finished)
                    return;
                finished = true;
                signal?.removeEventListener("abort", onAbort);
                flight.waiters -= 1;
                callback();
                if (flight.waiters === 0
                    && !flight.settled
                    && !flight.controller.signal.aborted) {
                    flight.controller.abort(new DOMException("Workspace removal request cancelled", "AbortError"));
                }
            };
            const onAbort = () => {
                finish(() => { rejectPromise(abortError(signal)); });
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            flight.promise.then((run) => { finish(() => { resolvePromise(run); }); }, (error) => { finish(() => { rejectPromise(asError(error)); }); });
        });
    }
    finishFlight(key, flight) {
        flight.settled = true;
        if (this.flights.get(key) === flight)
            this.flights.delete(key);
    }
}
export function workspaceRemovalHttpStatus(error, fallback = 500) {
    if (error instanceof WorkspaceRemovalError || error instanceof WorkspaceProviderRemovalError) {
        return error.statusCode;
    }
    return fallback;
}
function validateCurrentRemoval(project, workspaceId, precondition, current) {
    const target = current.workspaces.find((workspace) => workspace.id === workspaceId);
    if (target?.id !== current.target.id || target.path !== current.target.path) {
        throw new WorkspaceRemovalError("Workspace is no longer current", 409);
    }
    if (target.projectId !== project.id) {
        throw new WorkspaceRemovalError("Workspace does not belong to the registered project", 409);
    }
    if (target.provider?.pluginId !== current.ownerPluginId) {
        throw new WorkspaceRemovalError("Workspace owner is no longer current", 409);
    }
    if (target.removal === undefined || !target.provider.capabilities.remove) {
        throw new WorkspaceRemovalError("Workspace removal is not available", 409);
    }
    if (target.removal.precondition !== precondition) {
        throw new WorkspaceRemovalError("Workspace removal confirmation is stale; review the current workspace and confirm again", 409);
    }
    if (target.isMain)
        throw new WorkspaceRemovalError("The main workspace cannot be removed");
    const targetPath = requireAbsolutePath(target.path, "Workspace path");
    const projectPath = requireAbsolutePath(project.path, "Project path");
    if (parse(targetPath).root === targetPath) {
        throw new WorkspaceRemovalError("The filesystem root cannot be removed as a workspace");
    }
    if (targetPath === projectPath) {
        throw new WorkspaceRemovalError("A workspace cannot remove the registered project itself");
    }
    if (isPathAncestor(targetPath, projectPath)) {
        throw new WorkspaceRemovalError("A workspace containing the registered project cannot be removed");
    }
    const candidates = current.workspaces.filter((workspace) => {
        if (workspace.id === target.id || workspace.projectId !== project.id)
            return false;
        const candidatePath = requireAbsolutePath(workspace.path, "Command workspace path");
        return candidatePath !== targetPath && !isSameOrAncestor(targetPath, candidatePath);
    });
    const commandWorkspace = candidates.find((workspace) => workspace.isMain) ?? candidates[0];
    if (commandWorkspace === undefined) {
        throw new WorkspaceRemovalError("A current non-target command workspace is required", 409);
    }
    return { target, commandWorkspace };
}
async function runBoundedRemoval(timeoutMs, parentSignal, operation) {
    const controller = new AbortController();
    const abortFromParent = () => { controller.abort(abortError(parentSignal)); };
    if (parentSignal.aborted)
        abortFromParent();
    else
        parentSignal.addEventListener("abort", abortFromParent, { once: true });
    const timeoutError = new WorkspaceRemovalDeadlineError(`Workspace removal timed out after ${String(timeoutMs)}ms`);
    const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
    timeout.unref();
    const deadline = controller.signal.aborted
        ? Promise.reject(abortError(controller.signal))
        : new Promise((_resolve, rejectPromise) => {
            controller.signal.addEventListener("abort", () => { rejectPromise(abortError(controller.signal)); }, { once: true });
        });
    const result = controller.signal.aborted
        ? new Promise(() => { })
        : Promise.resolve().then(() => operation(controller.signal));
    try {
        return await Promise.race([result, deadline]);
    }
    finally {
        clearTimeout(timeout);
        parentSignal.removeEventListener("abort", abortFromParent);
        if (!controller.signal.aborted) {
            controller.abort(new DOMException("Workspace removal completed", "AbortError"));
        }
    }
}
function removalFlightKey(projectId, workspaceId) {
    return JSON.stringify([projectId, workspaceId]);
}
function requireAbsolutePath(value, label) {
    if (!isAbsolute(value))
        throw new WorkspaceRemovalError(`${label} must be absolute`);
    return resolve(value);
}
function isPathAncestor(ancestor, descendant) {
    const value = relative(ancestor, descendant);
    return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function isSameOrAncestor(ancestor, descendant) {
    return ancestor === descendant || isPathAncestor(ancestor, descendant);
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw abortError(signal);
}
function abortError(signal) {
    const reason = signal?.reason;
    return reason instanceof Error ? reason : new Error("Workspace removal request cancelled", { cause: reason });
}
function positiveInteger(value, key) {
    if (!Number.isInteger(value) || value <= 0)
        throw new Error(`${key} must be a positive integer`);
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error), { cause: error });
}
class WorkspaceRemovalDeadlineError extends Error {
    constructor() {
        super(...arguments);
        this.name = "TimeoutError";
    }
}
//# sourceMappingURL=workspaceRemovalService.js.map