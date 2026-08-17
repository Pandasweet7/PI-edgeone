import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager, VERSION as PI_CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import { effectivePiWebCapabilities, WEB_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { piWebDockerCommand } from "../docker/piWebDockerCommandPlan.js";
import { parsePiWebRuntimeComponent } from "../shared/piWebStatusParsing.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { isHostAbsoluteAgentDir, loadPiWebConfig, PI_CODING_AGENT_DIR_ENV } from "../config.js";
import { createPiWebReleaseLookupCache } from "./piWebReleaseLookupCache.js";
const PI_WEB_PACKAGE_NAME = "@jmfederico/pi-web";
const PI_WEB_NPM_SOURCE = `npm:${PI_WEB_PACKAGE_NAME}`;
const DEFAULT_VERSION = "0.0.0-dev";
const VERSION_CHECK_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);
const serviceRefs = {
    sessiond: {
        id: "sessiond",
        systemdName: "pi-web-sessiond.service",
        launchdLabel: "com.pi-web.sessiond",
        launchdPlistName: "com.pi-web.sessiond.plist",
    },
    web: {
        id: "web",
        systemdName: "pi-web.service",
        launchdLabel: "com.pi-web.web",
        launchdPlistName: "com.pi-web.web.plist",
    },
    uiDev: {
        id: "uiDev",
        systemdName: "pi-web-ui-dev.service",
        launchdLabel: "com.pi-web.ui-dev",
        launchdPlistName: "com.pi-web.ui-dev.plist",
    },
};
const startServiceOrder = ["sessiond", "web", "uiDev"];
// Restart web/UI before sessiond: when the restart command runs in a pi-web
// terminal (owned by sessiond), restarting sessiond kills the command, so any
// services listed after it would never be restarted.
const restartServiceOrder = ["web", "uiDev", "sessiond"];
const latestReleaseLookupCache = createPiWebReleaseLookupCache(fetchLatestNpmVersion);
const runtimePackageInfo = readPackageInfoSync();
export function getPiWebRuntimeComponent(component, capabilities = [], deprecatedAgentInputs = []) {
    return {
        component,
        label: component === "web" ? "Web/UI" : "Session daemon",
        runtimeVersion: runtimePackageInfo?.version ?? DEFAULT_VERSION,
        piVersion: PI_CODING_AGENT_VERSION,
        available: true,
        capabilities: [...capabilities],
        ...(deprecatedAgentInputs.length === 0 ? {} : { deprecatedAgentInputs }),
    };
}
/**
 * The web component's runtime report with deprecated-input detection contained
 * at the component boundary: a malformed config file must not blank the whole
 * runtime report (the endpoint has no error handler, and federation peers
 * would mark the machine failed). Version and capabilities stay intact and
 * only the undetectable web-sourced deprecated inputs are omitted; the failure
 * travels through the component error channel, the same channel
 * `unavailableSessiondRuntime` uses for the daemon.
 */
function webRuntimeComponent(loadConfig) {
    try {
        return getPiWebRuntimeComponent("web", WEB_RUNTIME_CAPABILITIES, loadConfig().deprecatedAgentInputs);
    }
    catch (error) {
        return {
            ...getPiWebRuntimeComponent("web", WEB_RUNTIME_CAPABILITIES),
            error: `Could not check for deprecated agent configuration inputs: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
export async function getPiWebRuntime(daemon = new SessionDaemonClient(), options = {}) {
    const web = webRuntimeComponent(options.loadConfig ?? loadPiWebConfig);
    const sessiond = await getSessiondRuntimeComponent(daemon);
    return {
        packageName: PI_WEB_PACKAGE_NAME,
        generatedAt: new Date().toISOString(),
        components: { web, sessiond },
        capabilities: effectivePiWebCapabilities({ web, sessiond }),
    };
}
export async function getPiWebComponentStatus(component, options = {}) {
    const [installed, installation] = await Promise.all([
        readInstalledPackageInfo(),
        detectPiWebInstallation(options.activeAgentProfile?.dir),
    ]);
    const runtimeVersion = runtimePackageInfo?.version ?? DEFAULT_VERSION;
    const installedVersion = installed?.version;
    return {
        component,
        label: component === "web" ? "Web/UI" : "Session daemon",
        runtimeVersion,
        ...(installedVersion === undefined ? {} : { installedVersion }),
        piVersion: PI_CODING_AGENT_VERSION,
        stale: isInstalledVersionNewer(installedVersion, runtimeVersion),
        available: true,
        installation,
    };
}
export async function getPiWebVersionStatus(daemon = new SessionDaemonClient(), options = {}) {
    const [web, sessiond] = await Promise.all([
        getPiWebComponentStatus("web", options),
        getSessiondComponentStatus(daemon, options),
    ]);
    return {
        packageName: PI_WEB_PACKAGE_NAME,
        generatedAt: new Date().toISOString(),
        components: { web, sessiond },
    };
}
export async function getPiWebStatus(daemon = new SessionDaemonClient(), options = {}) {
    const versionStatus = await getPiWebVersionStatus(daemon, options);
    const { web, sessiond } = versionStatus.components;
    const release = await getLatestReleaseStatus(web.installedVersion ?? web.runtimeVersion ?? DEFAULT_VERSION, options.forceReleaseCheck === true);
    const components = { web, sessiond };
    const commands = await commandsFor(components, {
        activeAgentProfile: options.activeAgentProfile,
        hasCommand: options.hasCommand ?? hasCommand,
    });
    const messages = buildMessages(components, release, commands);
    return {
        ...versionStatus,
        release,
        commands,
        messages,
    };
}
export function comparePackageVersions(leftVersion, rightVersion) {
    const left = parsePackageVersion(leftVersion);
    const right = parsePackageVersion(rightVersion);
    if (left === undefined || right === undefined)
        return undefined;
    if (left.major !== right.major)
        return left.major - right.major;
    if (left.minor !== right.minor)
        return left.minor - right.minor;
    if (left.patch !== right.patch)
        return left.patch - right.patch;
    if (left.prerelease === right.prerelease)
        return 0;
    if (left.prerelease === undefined)
        return 1;
    if (right.prerelease === undefined)
        return -1;
    return left.prerelease.localeCompare(right.prerelease);
}
function readPackageInfoSync() {
    const path = packageJsonPath();
    try {
        return parsePackageInfo(JSON.parse(readFileSync(path, "utf8")), path);
    }
    catch {
        return undefined;
    }
}
async function readInstalledPackageInfo() {
    const path = packageJsonPath();
    try {
        await stat(path);
        return parsePackageInfo(JSON.parse(await readFile(path, "utf8")), path);
    }
    catch {
        return undefined;
    }
}
function packageJsonPath() {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}
function parsePackageInfo(value, path) {
    if (!isRecord(value))
        return undefined;
    const name = value["name"];
    const version = value["version"];
    if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "")
        return undefined;
    return { name, version, path };
}
async function detectPiWebInstallation(agentDir) {
    const docker = detectDockerInstallation();
    if (docker !== undefined)
        return docker;
    const root = packageRootPath();
    const realRoot = await realPathOrSelf(root);
    if (agentDir !== undefined) {
        const piPackage = await detectPiPackageInstallation(realRoot, root, agentDir);
        if (piPackage !== undefined)
            return piPackage;
    }
    const npmGlobal = await detectNpmGlobalInstallation(realRoot, root);
    if (npmGlobal !== undefined)
        return npmGlobal;
    return { kind: "local", path: root };
}
function detectDockerInstallation() {
    if (!isTruthyEnv("PI_WEB_DOCKER_RUNTIME"))
        return undefined;
    const dockerMode = dockerModeFromEnv(process.env["PI_WEB_DOCKER_MODE"]) ?? inferredDockerModeFromRoots();
    const path = dockerRootPathFromEnv(dockerMode);
    return {
        kind: "docker",
        ...(path === undefined ? {} : { path }),
        ...(dockerMode === undefined ? {} : { dockerMode }),
    };
}
function dockerModeFromEnv(value) {
    return value === "runtime" || value === "dev" ? value : undefined;
}
function inferredDockerModeFromRoots() {
    if (firstNonEmptyEnv("PI_WEB_DOCKER_DEV_REPO_ROOT") !== undefined)
        return "dev";
    if (firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR") !== undefined)
        return "runtime";
    return undefined;
}
function dockerRootPathFromEnv(mode) {
    if (mode === "dev")
        return firstNonEmptyEnv("PI_WEB_DOCKER_DEV_REPO_ROOT", "PI_WEB_DOCKER_INSTALL_DIR");
    if (mode === "runtime")
        return firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR", "PI_WEB_DOCKER_DEV_REPO_ROOT");
    return firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR", "PI_WEB_DOCKER_DEV_REPO_ROOT");
}
function firstNonEmptyEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value !== "")
            return value;
    }
    return undefined;
}
function isTruthyEnv(key) {
    const value = process.env[key];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
async function detectPiPackageInstallation(realRoot, displayPath, agentDir) {
    try {
        const packageManager = new DefaultPackageManager({
            cwd: process.cwd(),
            agentDir,
            settingsManager: SettingsManager.create(process.cwd(), agentDir),
        });
        for (const configuredPackage of packageManager.listConfiguredPackages()) {
            const installedPath = configuredPackage.installedPath ?? packageManager.getInstalledPath(configuredPackage.source, configuredPackage.scope);
            if (installedPath === undefined)
                continue;
            const realInstalledPath = await realPathOrSelf(installedPath);
            if (isSameOrWithin(realInstalledPath, realRoot) || isSameOrWithin(realRoot, realInstalledPath)) {
                return { kind: "pi-package", path: displayPath, source: configuredPackage.source, scope: configuredPackage.scope };
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
async function detectNpmGlobalInstallation(realRoot, displayPath) {
    const npmRoot = await npmGlobalRoot();
    if (npmRoot === undefined)
        return undefined;
    const realNpmRoot = await realPathOrSelf(npmRoot);
    if (!isSameOrWithin(realNpmRoot, realRoot))
        return undefined;
    return { kind: "npm-global", path: displayPath, npmRoot };
}
async function npmGlobalRoot() {
    try {
        const { stdout } = await execFileAsync("npm", ["root", "-g"], { encoding: "utf8" });
        const root = stdout.trim();
        return root === "" ? undefined : root;
    }
    catch {
        return undefined;
    }
}
function packageRootPath() {
    return dirname(packageJsonPath());
}
async function realPathOrSelf(path) {
    return realpath(path).catch(() => resolve(path));
}
function isSameOrWithin(parent, candidate) {
    const rel = relative(parent, candidate);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
async function getSessiondRuntimeComponent(daemon) {
    try {
        const upstream = await daemon.request("GET", "/runtime");
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            return unavailableSessiondRuntime(`runtime check returned HTTP ${String(upstream.statusCode)}`);
        }
        const parsed = upstream.body === "" ? undefined : JSON.parse(upstream.body);
        const runtime = parsePiWebRuntimeComponent(parsed);
        if (runtime !== undefined)
            return runtime;
        return unavailableSessiondRuntime("runtime response did not include valid runtime information");
    }
    catch (error) {
        return unavailableSessiondRuntime(error instanceof Error ? error.message : String(error));
    }
}
async function getSessiondComponentStatus(daemon, options = {}) {
    try {
        const upstream = await daemon.request("GET", "/runtime");
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            return unavailableSessiond(`runtime check returned HTTP ${String(upstream.statusCode)}`);
        }
        const parsed = upstream.body === "" ? undefined : JSON.parse(upstream.body);
        const runtime = parsePiWebRuntimeComponent(parsed);
        if (runtime?.available !== true)
            return unavailableSessiond(runtime?.error ?? "runtime response did not include valid runtime information");
        const status = await getPiWebComponentStatus("sessiond", options);
        const runtimeVersion = runtime.runtimeVersion ?? status.runtimeVersion;
        return {
            ...status,
            ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
            // The daemon reports the Pi version it has loaded in its own process;
            // the spread of `status` already carries this process's Pi version as
            // the fallback for daemons that predate Pi version reporting, mirroring
            // the runtimeVersion fallback.
            ...(runtime.piVersion === undefined ? {} : { piVersion: runtime.piVersion }),
            stale: isInstalledVersionNewer(status.installedVersion, runtimeVersion),
            available: true,
        };
    }
    catch (error) {
        return unavailableSessiond(error instanceof Error ? error.message : String(error));
    }
}
function unavailableSessiondRuntime(error) {
    return {
        component: "sessiond",
        label: "Session daemon",
        available: false,
        capabilities: [],
        error,
    };
}
function unavailableSessiond(error) {
    return {
        component: "sessiond",
        label: "Session daemon",
        stale: false,
        available: false,
        error,
    };
}
async function getLatestReleaseStatus(currentVersion, force) {
    const checkedAtMs = Date.now();
    if (skipVersionCheck()) {
        return { packageName: PI_WEB_PACKAGE_NAME, updateAvailable: false, checkedAt: new Date(checkedAtMs).toISOString(), skipped: true };
    }
    return releaseStatusFromCache(await latestReleaseLookupCache.get(currentVersion, { force }), currentVersion);
}
function releaseStatusFromCache(cache, currentVersion) {
    return {
        packageName: PI_WEB_PACKAGE_NAME,
        ...(cache.latestVersion === undefined ? {} : { latestVersion: cache.latestVersion }),
        updateAvailable: cache.latestVersion === undefined ? false : isNewerPackageVersion(cache.latestVersion, currentVersion),
        checkedAt: new Date(cache.checkedAtMs).toISOString(),
        ...(cache.error === undefined ? {} : { error: cache.error }),
    };
}
async function fetchLatestNpmVersion(currentVersion) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PI_WEB_PACKAGE_NAME)}/latest`, {
        headers: {
            accept: "application/json",
            "user-agent": `${PI_WEB_PACKAGE_NAME}/${currentVersion}`,
        },
        signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`npm registry returned HTTP ${String(response.status)}`);
    const data = await response.json();
    const version = isRecord(data) ? data["version"] : undefined;
    if (typeof version !== "string" || version === "")
        throw new Error("npm registry response did not include a version");
    return version;
}
async function commandsFor(components, options) {
    const installation = preferredInstallation(components);
    if (installation?.kind === "docker")
        return dockerCommands(installation);
    const [serviceCommands, cliCommands] = await Promise.all([
        nativeServiceCommands(),
        piWebCliCommands(installation),
    ]);
    const restart = restartCommandFor(installation, serviceCommands, cliCommands);
    const restartWeb = serviceCommands.restartWeb ?? cliCommands.restart;
    const restartSessiond = serviceCommands.restartSessiond ?? cliCommands.restart;
    const status = serviceCommands.status ?? cliCommands.status;
    const update = await updateCommandFor(installation, restart, options);
    return {
        ...(update === undefined ? {} : { update }),
        ...(restart === undefined ? {} : { restart }),
        ...(restartWeb === undefined ? {} : { restartWeb }),
        ...(restartSessiond === undefined ? {} : { restartSessiond }),
        ...(status === undefined ? {} : { status }),
    };
}
function preferredInstallation(components) {
    const web = components.web.installation;
    const sessiond = components.sessiond.installation;
    if (web?.kind === "docker" || sessiond?.kind === "docker")
        return web?.kind === "docker" ? web : sessiond;
    if (web?.kind === "local" || sessiond?.kind === "local")
        return web?.kind === "local" ? web : sessiond;
    return web ?? sessiond;
}
function dockerCommands(installation) {
    return {
        update: piWebDockerCommand(installation.dockerMode, "update"),
        restart: piWebDockerCommand(installation.dockerMode, "restart"),
        restartWeb: piWebDockerCommand(installation.dockerMode, "restart-web"),
        restartSessiond: piWebDockerCommand(installation.dockerMode, "restart-sessiond"),
        status: piWebDockerCommand(installation.dockerMode, "status"),
    };
}
async function piWebCliCommands(installation) {
    if (installation?.kind !== "npm-global" || !(await hasCommand("pi-web")))
        return {};
    return { restart: "pi-web restart", status: "pi-web status" };
}
function restartCommandFor(installation, serviceCommands, cliCommands) {
    if (installation?.kind === "local" || installation?.kind === "pi-package")
        return serviceCommands.restart ?? cliCommands.restart;
    return cliCommands.restart ?? serviceCommands.restart;
}
export async function updateCommandFor(installation, restartCommand, options) {
    if (restartCommand === undefined)
        return undefined;
    if (installation?.kind === "pi-package") {
        const profile = options.activeAgentProfile;
        if (profile === undefined || !isHostAbsoluteAgentDir(profile.dir))
            return undefined;
        if (!(await options.hasCommand("pi")))
            return undefined;
        return `${PI_CODING_AGENT_DIR_ENV}=${shellQuote(profile.dir)} pi update ${shellQuote(installation.source ?? PI_WEB_NPM_SOURCE)} && ${restartCommand}`;
    }
    if (installation?.kind === "local" && installation.path !== undefined) {
        if (!(await hasCommand("npm")) || !(await isGitCheckoutWithUpstream(installation.path)))
            return undefined;
        return `cd ${shellQuote(installation.path)} && git pull --ff-only && npm install && npm run build && ${restartCommand}`;
    }
    if (installation?.kind !== "npm-global" || !(await options.hasCommand("npm")))
        return undefined;
    return `npm install -g ${PI_WEB_PACKAGE_NAME} --allow-scripts=node-pty && ${restartCommand}`;
}
async function nativeServiceCommands() {
    const backend = await nativeServiceBackend();
    if (backend === undefined)
        return {};
    const installed = installedServiceIds(backend);
    if (installed.size === 0)
        return {};
    const web = installedServiceRefs(installed, ["web", "uiDev"]);
    const sessiond = installedServiceRefs(installed, ["sessiond"]);
    const restartable = web.length === 0 ? [] : installedServiceRefs(installed, restartServiceOrder, restartServiceOrder);
    const status = installedServiceRefs(installed);
    return {
        ...(restartable.length === 0 ? {} : { restart: restartNativeServicesCommand(backend, restartable, "pi-web-restart") }),
        ...(web.length === 0 ? {} : { restartWeb: restartNativeServicesCommand(backend, web, "pi-web-restart-web") }),
        ...(sessiond.length === 0 ? {} : { restartSessiond: restartNativeServicesCommand(backend, sessiond, "pi-web-restart-sessiond") }),
        ...(status.length === 0 ? {} : { status: statusNativeServicesCommand(backend, status) }),
    };
}
async function nativeServiceBackend() {
    if (process.platform === "linux" && await hasCommand("systemctl"))
        return "systemd";
    if (process.platform === "darwin" && await hasCommand("launchctl"))
        return "launchd";
    return undefined;
}
function installedServiceIds(backend) {
    return new Set(startServiceOrder.filter((id) => existsSync(serviceFilePath(backend, serviceRefs[id]))));
}
function installedServiceRefs(installed, candidates = startServiceOrder, order = startServiceOrder) {
    return order.filter((id) => candidates.includes(id) && installed.has(id)).map((id) => serviceRefs[id]);
}
function serviceFilePath(backend, ref) {
    return backend === "systemd" ? join(systemdServiceDir(), ref.systemdName) : join(launchdServiceDir(), ref.launchdPlistName);
}
function systemdServiceDir() {
    return join(homedir(), ".config", "systemd", "user");
}
function launchdServiceDir() {
    return join(homedir(), "Library", "LaunchAgents");
}
function restartNativeServicesCommand(backend, refs, systemdUnit) {
    // On systemd, run the restart inside a transient, detached `.service` unit
    // (the default `systemd-run` mode, not `--scope`). A scope would stay a child
    // of the calling shell and die with the terminal; a transient service is
    // reparented to the user service manager, so the restart finishes even when
    // restarting the session daemon kills the pi-web terminal that launched it.
    // `--collect` cleans the unit up afterwards, and the fixed `--unit` name makes
    // logs easy to find with `journalctl --user -u <unit>`.
    if (backend === "systemd") {
        const names = refs.map((ref) => ref.systemdName).join(" ");
        return `systemd-run --user --collect --unit=${systemdUnit} -- systemctl --user restart ${names}`;
    }
    return refs.map((ref) => `launchctl kickstart -k gui/$(id -u)/${ref.launchdLabel}`).join(" && ");
}
function statusNativeServicesCommand(backend, refs) {
    if (backend === "systemd")
        return `systemctl --user status ${refs.map((ref) => ref.systemdName).join(" ")}`;
    return refs.map((ref) => `launchctl print gui/$(id -u)/${ref.launchdLabel}`).join(" && ");
}
async function isGitCheckoutWithUpstream(path) {
    return await hasCommand("git")
        && await commandSucceeds("git", ["-C", path, "rev-parse", "--is-inside-work-tree"])
        && await commandSucceeds("git", ["-C", path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}
function hasCommand(command) {
    return commandSucceeds("/usr/bin/env", ["sh", "-c", `command -v ${shellQuote(command)}`]);
}
async function commandSucceeds(command, args) {
    try {
        await execFileAsync(command, args, { encoding: "utf8" });
        return true;
    }
    catch {
        return false;
    }
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function buildMessages(components, release, commands) {
    const messages = [];
    const installedVersion = components.web.installedVersion ?? components.web.runtimeVersion;
    if (release.updateAvailable && release.latestVersion !== undefined) {
        messages.push({
            id: "update-available",
            severity: "info",
            title: "PI WEB update available",
            body: commands.update === undefined
                ? `PI WEB ${release.latestVersion} is available${installedVersion === undefined ? "" : `; installed version is ${installedVersion}`}. Update PI WEB, then restart the services or processes for this installation.`
                : `PI WEB ${release.latestVersion} is available${installedVersion === undefined ? "" : `; installed version is ${installedVersion}`}. Run the update command to update PI WEB and restart its services.`,
            ...optionalMessageCommand(commands.update),
        });
    }
    if (components.web.stale) {
        const command = commands.restartWeb ?? commands.restart;
        messages.push({
            id: "web-stale",
            severity: "warning",
            title: "Web/UI service restart needed",
            body: command === undefined
                ? `The Web/UI service is running ${formatVersion(components.web.runtimeVersion)}, but ${formatVersion(components.web.installedVersion)} is installed. Restart the Web/UI service or process to use the installed version.`
                : `The Web/UI service is running ${formatVersion(components.web.runtimeVersion)}, but ${formatVersion(components.web.installedVersion)} is installed. Restart the service to use the installed version.`,
            ...optionalMessageCommand(command),
        });
    }
    if (!components.sessiond.available) {
        messages.push({
            id: "sessiond-unavailable",
            severity: "warning",
            title: "Session daemon version unavailable",
            body: commands.status === undefined
                ? `PI WEB could not check the session daemon version${components.sessiond.error === undefined ? "." : `: ${components.sessiond.error}`}. Check the session daemon service or process that runs this installation.`
                : `PI WEB could not check the session daemon version${components.sessiond.error === undefined ? "." : `: ${components.sessiond.error}`}`,
            ...optionalMessageCommand(commands.status),
        });
    }
    else if (components.sessiond.stale) {
        const command = commands.restartSessiond ?? commands.restart;
        messages.push({
            id: "sessiond-stale",
            severity: "warning",
            title: "Session daemon restart needed",
            body: command === undefined
                ? `The session daemon is running ${formatVersion(components.sessiond.runtimeVersion)}, but ${formatVersion(components.sessiond.installedVersion)} is installed. Restart the session daemon service or process to use the installed version.`
                : `The session daemon is running ${formatVersion(components.sessiond.runtimeVersion)}, but ${formatVersion(components.sessiond.installedVersion)} is installed. Restart the daemon to use the installed version.`,
            ...optionalMessageCommand(command),
        });
    }
    return messages;
}
function optionalMessageCommand(command) {
    return command === undefined ? {} : { command };
}
function skipVersionCheck() {
    return ["PI_WEB_SKIP_VERSION_CHECK", "PI_WEB_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_OFFLINE"].some((key) => {
        const value = process.env[key];
        return value !== undefined && value !== "";
    });
}
function isInstalledVersionNewer(installedVersion, runtimeVersion) {
    if (installedVersion === undefined || runtimeVersion === undefined)
        return false;
    return isNewerPackageVersion(installedVersion, runtimeVersion);
}
function isNewerPackageVersion(candidateVersion, currentVersion) {
    const comparison = comparePackageVersions(candidateVersion, currentVersion);
    if (comparison !== undefined)
        return comparison > 0;
    return candidateVersion.trim() !== currentVersion.trim();
}
function parsePackageVersion(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u.exec(version.trim());
    if (match === null)
        return undefined;
    const [, major, minor, patch, prerelease] = match;
    if (major === undefined || minor === undefined || patch === undefined)
        return undefined;
    return {
        major: Number.parseInt(major, 10),
        minor: Number.parseInt(minor, 10),
        patch: Number.parseInt(patch, 10),
        ...(prerelease === undefined ? {} : { prerelease }),
    };
}
function formatVersion(version) {
    return version ?? "unknown";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=piWebStatus.js.map