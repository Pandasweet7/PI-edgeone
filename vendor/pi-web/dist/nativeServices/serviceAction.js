export const serviceStartOrder = ["sessiond", "web", "uiDev"];
export const serviceStopOrder = ["web", "uiDev", "sessiond"];
// Restart web/UI before sessiond: when `pi-web restart` runs in a pi-web
// terminal (owned by sessiond), restarting sessiond kills the command, so any
// services handled after it would never be restarted.
export const serviceRestartOrder = ["web", "uiDev", "sessiond"];
const LAUNCHD_UNLOAD_SETTLE_TIMEOUT_MS = 10_000;
const LAUNCHD_UNLOAD_SETTLE_INTERVAL_MS = 250;
const SERVICE_READINESS_TIMEOUT_MS = 30_000;
const SERVICE_READINESS_INTERVAL_MS = 1_000;
/** A service-manager command exited nonzero; carries the exact invocation for diagnosis. */
export class ServiceCommandError extends Error {
    constructor(command, args, status) {
        super(`\`${command} ${args.join(" ")}\` failed with exit status ${String(status)}.`);
        this.name = "ServiceCommandError";
        this.command = command;
        this.args = args;
        this.status = status;
    }
}
export function systemctlUserActionArgs(action, unitNames) {
    return ["--user", action, ...unitNames];
}
export function launchdBootoutArgs(target) {
    return ["bootout", target];
}
export function launchdPrintArgs(target) {
    return ["print", target];
}
export function launchdBootstrapArgs(domain, plistPath) {
    return ["bootstrap", domain, plistPath];
}
export function launchdEnableArgs(target) {
    return ["enable", target];
}
export function launchdKickstartArgs(target) {
    return ["kickstart", target];
}
export function launchdServiceTarget(domain, ref) {
    return `${domain}/${ref.launchdLabel}`;
}
/** Order refs by service id, dropping ids that are not present. */
export function orderServices(refs, order) {
    const byId = new Map(refs.map((ref) => [ref.id, ref]));
    return order.flatMap((id) => {
        const ref = byId.get(id);
        return ref === undefined ? [] : [ref];
    });
}
function orderForAction(action) {
    if (action === "stop")
        return serviceStopOrder;
    if (action === "restart")
        return serviceRestartOrder;
    return serviceStartOrder;
}
/**
 * The running component a service must make responsive: the API-serving
 * services (production web, development UI/API) back the web component; the
 * session daemon backs itself.
 */
export function readinessComponentForService(id) {
    return id === "sessiond" ? "sessiond" : "web";
}
function runChecked(deps, command, args) {
    const status = deps.run(command, args);
    if (status !== 0)
        throw new ServiceCommandError(command, args, status);
}
function launchdServiceLoaded(target, deps) {
    return deps.runQuiet("launchctl", launchdPrintArgs(target)) === 0;
}
/**
 * Wait until launchd has fully unloaded a service after bootout. `launchctl
 * bootout` only requests teardown: the label keeps resolving while launchd
 * unloads asynchronously, and acting on the still-loaded record races the
 * unload (a kickstart can succeed against the dying record just before the
 * label disappears for good). A label that was never loaded settles
 * immediately. Returns false when the label is still loaded after the
 * timeout; the caller then falls back to the checked kickstart path, which
 * keeps the outcome truthful instead of silently losing the service.
 */
export async function settleLaunchdServiceUnload(target, deps, timing = {}) {
    const timeoutMs = timing.launchdUnloadSettleTimeoutMs ?? LAUNCHD_UNLOAD_SETTLE_TIMEOUT_MS;
    const intervalMs = timing.launchdUnloadSettleIntervalMs ?? LAUNCHD_UNLOAD_SETTLE_INTERVAL_MS;
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    for (let poll = 0; poll < maxPolls; poll += 1) {
        if (!launchdServiceLoaded(target, deps))
            return true;
        await deps.sleep(intervalMs);
    }
    return !launchdServiceLoaded(target, deps);
}
/**
 * Start (or kick) one LaunchAgent: bootstrap and enable only when the label
 * is not loaded, then kickstart. Any manager failure throws ServiceCommandError.
 */
export function startLaunchdService(ref, context, deps) {
    const target = launchdServiceTarget(context.domain, ref);
    if (!launchdServiceLoaded(target, deps)) {
        runChecked(deps, "launchctl", launchdBootstrapArgs(context.domain, context.plistPath(ref)));
        runChecked(deps, "launchctl", launchdEnableArgs(target));
    }
    runChecked(deps, "launchctl", launchdKickstartArgs(target));
}
/**
 * Restart one LaunchAgent without racing launchd's asynchronous unload:
 * bootout, wait for the label to disappear, then start. A settle timeout
 * falls through to the start path, whose kickstart is checked, so a stuck
 * unload surfaces as a failure instead of an exit-0-while-gone restart.
 */
export async function restartLaunchdService(ref, context, deps, timing = {}) {
    const target = launchdServiceTarget(context.domain, ref);
    deps.runQuiet("launchctl", launchdBootoutArgs(target));
    await settleLaunchdServiceUnload(target, deps, timing);
    startLaunchdService(ref, context, deps);
}
/**
 * Wait until every service is manager-reported running and its user-facing
 * component responds. Manager state gates the component probe: a service that
 * is not running yet is not probed. Returns the services still unready when
 * the bounded wait expires.
 */
export async function awaitServicesReady(refs, deps, timing = {}) {
    const timeoutMs = timing.readinessTimeoutMs ?? SERVICE_READINESS_TIMEOUT_MS;
    const intervalMs = timing.readinessIntervalMs ?? SERVICE_READINESS_INTERVAL_MS;
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    const pending = new Set(refs);
    for (let poll = 0; poll < maxPolls && pending.size > 0; poll += 1) {
        for (const ref of [...pending]) {
            if (!deps.isServiceRunning(ref))
                continue;
            if (await deps.isComponentReady(readinessComponentForService(ref.id)))
                pending.delete(ref);
        }
        if (pending.size > 0)
            await deps.sleep(intervalMs);
    }
    return [...pending];
}
/**
 * Perform a start/stop/restart against the native service manager, then — for
 * start and restart — verify that each affected service actually becomes
 * ready. systemd restarts are a single synchronous manager job; launchd
 * restarts settle each asynchronous bootout before the bootstrap-vs-kickstart
 * decision. The readiness gate is what makes exit-0-while-not-serving
 * impossible on both backends.
 */
export async function performServiceAction(input, deps, timing = {}) {
    const refs = orderServices(input.refs, orderForAction(input.action));
    if (refs.length === 0)
        return { unreadyServices: [] };
    if (input.backend.kind === "systemd") {
        runChecked(deps, "systemctl", systemctlUserActionArgs(input.action, refs.map((ref) => ref.systemdName)));
    }
    else if (input.action === "stop") {
        for (const ref of refs)
            deps.runQuiet("launchctl", launchdBootoutArgs(launchdServiceTarget(input.launchdContext.domain, ref)));
    }
    else if (input.action === "restart") {
        // Restart each service fully (bootout + settle + start) before moving to
        // the next, so the web/UI services are back up before sessiond is restarted.
        for (const ref of refs)
            await restartLaunchdService(ref, input.launchdContext, deps, timing);
    }
    else {
        for (const ref of refs)
            startLaunchdService(ref, input.launchdContext, deps);
    }
    if (input.action === "stop")
        return { unreadyServices: [] };
    return { unreadyServices: await awaitServicesReady(refs, deps, timing) };
}
//# sourceMappingURL=serviceAction.js.map