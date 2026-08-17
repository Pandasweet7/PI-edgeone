import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { posix as posixPath } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
const defaultCommandTimeoutMs = 15_000;
const defaultProbeTimeoutMs = 15_000;
const defaultPollIntervalMs = 50;
const maxCapturedCommandOutputBytes = 1024 * 1024;
const maxLaunchdProbeFileBytes = 1024 * 1024;
export class SystemdNativeServiceProbe {
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async run(request) {
        if (request.backend.kind !== "systemd") {
            return infrastructureFailure("manager", `Systemd probe cannot validate the ${request.backend.kind} backend.`);
        }
        const uniqueId = safeUniqueId(this.dependencies.createUniqueId());
        const unitName = `pi-web-authoritative-probe-${uniqueId}.service`;
        const outputPrefix = `PI_WEB_PROBE_${uniqueId}`;
        const command = prerequisiteProbeCommand(request.shell.name, request.prerequisites, outputPrefix);
        const args = systemdRunArguments(request, unitName, command);
        const result = await this.dependencies.commandRunner.run("systemd-run", args, this.dependencies.commandTimeoutMs);
        if (result.kind === "timeout" || result.kind === "output-limit") {
            const cleanupFailure = await this.cleanupTimedOutUnit(unitName);
            if (cleanupFailure !== null)
                return cleanupFailure;
            return result.kind === "timeout"
                ? infrastructureFailure("timeout", `Timed out waiting for transient systemd unit ${unitName}.`)
                : infrastructureFailure("manager", `Transient systemd probe ${unitName} exceeded the output limit.`);
        }
        if (result.kind === "spawn-failure") {
            return infrastructureFailure("manager", `Could not start systemd-run: ${result.message}`);
        }
        if (result.status !== 0) {
            return infrastructureFailure("manager", `Transient systemd probe ${unitName} failed: ${firstOutput(result.stderr, result.stdout, `exit status ${String(result.status)}`)}`);
        }
        return parseProbeOutput(result.stdout, request.prerequisites, outputPrefix);
    }
    async cleanupTimedOutUnit(unitName) {
        const stop = await this.dependencies.commandRunner.run("systemctl", ["--user", "stop", unitName], this.dependencies.commandTimeoutMs);
        const inspected = await this.dependencies.commandRunner.run("systemctl", ["--user", "show", unitName, "--property=LoadState", "--value"], this.dependencies.commandTimeoutMs);
        if (inspected.kind === "completed" && inspected.status === 0 && inspected.stdout.trim() === "not-found") {
            return null;
        }
        const details = [
            `stop: ${commandFailureDetail(stop)}`,
            `load state: ${commandFailureDetail(inspected)}`,
        ].join("; ");
        return infrastructureFailure("cleanup", `Could not confirm cleanup of timed-out transient systemd unit ${unitName}: ${details}`);
    }
}
export class LaunchdNativeServiceProbe {
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async run(request) {
        if (request.backend.kind !== "launchd") {
            return infrastructureFailure("manager", `Launchd probe cannot validate the ${request.backend.kind} backend.`);
        }
        const uniqueId = safeUniqueId(this.dependencies.createUniqueId());
        const label = `com.pi-web.authoritative-probe.${String(this.dependencies.uid)}.${uniqueId}`;
        const domain = `gui/${String(this.dependencies.uid)}`;
        const target = `${domain}/${label}`;
        const outputPrefix = `PI_WEB_PROBE_${uniqueId}`;
        let directory = null;
        let bootstrapState = "not-loaded";
        let result;
        try {
            directory = await this.dependencies.fileSystem.createTemporaryDirectory(posixPath.join(tmpdir(), "pi-web-launchd-probe-"));
            const plistPath = posixPath.join(directory, "probe.plist");
            const stdoutPath = posixPath.join(directory, "stdout.log");
            const stderrPath = posixPath.join(directory, "stderr.log");
            const pendingResultPath = posixPath.join(directory, "result.pending");
            const resultPath = posixPath.join(directory, "result.log");
            const command = prerequisiteProbeCommand(request.shell.name, request.prerequisites, outputPrefix, { pendingPath: pendingResultPath, completedPath: resultPath });
            await this.dependencies.fileSystem.writeFile(plistPath, launchdProbePlist(request, label, command, stdoutPath, stderrPath), 0o600);
            const bootstrap = await this.dependencies.commandRunner.run("launchctl", ["bootstrap", domain, plistPath], this.dependencies.commandTimeoutMs);
            if (bootstrap.kind !== "completed" || bootstrap.status !== 0) {
                bootstrapState = bootstrap.kind === "spawn-failure" ? "not-loaded" : "uncertain";
                result = commandInfrastructureFailure("bootstrap launchd probe", bootstrap);
            }
            else {
                bootstrapState = "loaded";
                result = await this.waitForResult(target, resultPath, request.prerequisites, outputPrefix);
            }
        }
        catch (error) {
            result = infrastructureFailure("manager", `Could not prepare launchd probe: ${errorMessage(error)}`);
        }
        const cleanupFailure = await this.cleanup(target, directory, bootstrapState);
        return cleanupFailure ?? result;
    }
    async waitForResult(target, resultPath, prerequisites, outputPrefix) {
        const deadline = this.dependencies.now() + this.dependencies.probeTimeoutMs;
        while (this.dependencies.now() < deadline) {
            const remainingMs = Math.max(0, deadline - this.dependencies.now());
            const boundedRead = await readOptionalFileBounded(this.dependencies.fileSystem, resultPath, remainingMs);
            if (boundedRead.kind === "deadline")
                break;
            if (boundedRead.kind === "read-failure") {
                return infrastructureFailure("manager", `Could not read launchd probe result: ${errorMessage(boundedRead.error)}`);
            }
            if (boundedRead.output !== null)
                return parseProbeOutput(boundedRead.output, prerequisites, outputPrefix);
            const pollDelayMs = Math.min(this.dependencies.pollIntervalMs, Math.max(0, deadline - this.dependencies.now()));
            await this.dependencies.sleep(pollDelayMs);
        }
        return infrastructureFailure("timeout", `Timed out waiting for launchd probe ${target}.`);
    }
    async cleanup(target, directory, bootstrapState) {
        const failures = [];
        const shouldBootout = bootstrapState !== "not-loaded";
        if (shouldBootout) {
            // A failed or timed-out bootstrap may still have loaded the unique label.
            // Bootout is the only race-free cleanup; an explicit not-loaded response
            // is success when bootstrap completion was uncertain.
            const absenceIsSuccess = bootstrapState === "uncertain";
            const bootout = await this.dependencies.commandRunner.run("launchctl", ["bootout", target], this.dependencies.commandTimeoutMs);
            if ((bootout.kind !== "completed" || bootout.status !== 0)
                && !(absenceIsSuccess && launchdTargetNotLoaded(bootout))) {
                failures.push(`bootout failed: ${commandFailureDetail(bootout)}`);
            }
        }
        if (directory !== null) {
            try {
                await this.dependencies.fileSystem.removeDirectory(directory);
            }
            catch (error) {
                failures.push(`temporary-file removal failed: ${errorMessage(error)}`);
            }
        }
        return failures.length === 0
            ? null
            : infrastructureFailure("cleanup", `Launchd probe cleanup failed for ${target}: ${failures.join("; ")}`);
    }
}
export function createNativeServiceAuthoritativeProbe() {
    const commandRunner = new SpawnProbeCommandRunner();
    const common = {
        commandRunner,
        createUniqueId: randomUUID,
        commandTimeoutMs: defaultCommandTimeoutMs,
    };
    const systemd = new SystemdNativeServiceProbe(common);
    const launchd = new LaunchdNativeServiceProbe({
        ...common,
        fileSystem: nodeLaunchdProbeFileSystem,
        uid: userInfo().uid,
        now: performance.now.bind(performance),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        probeTimeoutMs: defaultProbeTimeoutMs,
        pollIntervalMs: defaultPollIntervalMs,
    });
    return {
        run: (request) => request.backend.kind === "systemd" ? systemd.run(request) : launchd.run(request),
    };
}
export function systemdRunArguments(request, unitName, shellCommand) {
    return [
        "--user",
        "--wait",
        "--collect",
        "--pipe",
        "--quiet",
        `--unit=${unitName}`,
        "--property=RuntimeMaxSec=15s",
        "--property=TimeoutStopSec=5s",
        ...Object.entries(request.environment).map(([key, value]) => `--setenv=${key}=${value}`),
        ...(request.workingDirectory === null ? [] : [`--working-directory=${request.workingDirectory}`]),
        "/usr/bin/env",
        escapeSystemdCommandExpansion(request.shell.executable),
        "-lc",
        escapeSystemdCommandExpansion(shellCommand),
    ];
}
function escapeSystemdCommandExpansion(value) {
    return value.replaceAll("$", () => "$$");
}
export function launchdProbePlist(request, label, shellCommand, stdoutPath, stderrPath) {
    const argumentsXml = ["/usr/bin/env", request.shell.executable, "-lc", shellCommand]
        .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
        .join("\n");
    const environmentEntries = Object.entries(request.environment);
    const environmentXml = environmentEntries.length === 0
        ? ""
        : `  <key>EnvironmentVariables</key>\n  <dict>\n${environmentEntries.map(([key, value]) => plistString(key, value, "    ")).join("")}  </dict>\n`;
    const workingDirectoryXml = request.workingDirectory === null
        ? ""
        : plistString("WorkingDirectory", request.workingDirectory);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistString("Label", label)}  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
${workingDirectoryXml}${environmentXml}  <key>RunAtLoad</key>
  <true/>
  <key>HardResourceLimits</key>
  <dict>
    <key>FileSize</key>
    <integer>${String(maxLaunchdProbeFileBytes)}</integer>
  </dict>
${plistString("StandardOutPath", stdoutPath)}${plistString("StandardErrorPath", stderrPath)}</dict>
</plist>
`;
}
export class SpawnProbeCommandRunner {
    run(command, args, timeoutMs) {
        return new Promise((resolve) => {
            const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            let capturedBytes = 0;
            let spawnFailure = null;
            let settled = false;
            const finish = (result, terminate) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                if (terminate) {
                    child.kill("SIGKILL");
                    child.stdout.destroy();
                    child.stderr.destroy();
                    child.unref();
                }
                resolve(result);
            };
            const capture = (stream, chunk) => {
                if (settled)
                    return;
                const bytes = Buffer.byteLength(chunk);
                if (capturedBytes + bytes > maxCapturedCommandOutputBytes) {
                    finish({ kind: "output-limit", stdout, stderr }, true);
                    return;
                }
                capturedBytes += bytes;
                if (stream === "stdout")
                    stdout += chunk;
                else
                    stderr += chunk;
            };
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { capture("stdout", chunk); });
            child.stderr.on("data", (chunk) => { capture("stderr", chunk); });
            child.on("error", (error) => { spawnFailure = error.message; });
            const timeout = setTimeout(() => {
                finish({ kind: "timeout", stdout, stderr }, true);
            }, timeoutMs);
            child.on("close", (status) => {
                if (spawnFailure !== null) {
                    finish({ kind: "spawn-failure", message: spawnFailure, stdout, stderr }, false);
                }
                else {
                    finish({ kind: "completed", status: status ?? 1, stdout, stderr }, false);
                }
            });
        });
    }
}
const nodeLaunchdProbeFileSystem = {
    createTemporaryDirectory: (prefix) => mkdtemp(prefix),
    writeFile: (path, contents, mode) => writeFile(path, contents, { encoding: "utf8", mode }),
    readOptionalFile: async (path) => {
        try {
            return await readFile(path, "utf8");
        }
        catch (error) {
            if (isNodeErrorWithCode(error, "ENOENT"))
                return null;
            throw error;
        }
    },
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
};
function readOptionalFileBounded(fileSystem, path, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => { finish({ kind: "deadline" }); }, timeoutMs);
        void fileSystem.readOptionalFile(path).then((output) => { finish({ kind: "read", output }); }, (error) => { finish({ kind: "read-failure", error }); });
    });
}
function prerequisiteProbeCommand(shell, prerequisites, outputPrefix, resultFiles) {
    const markerPath = resultFiles?.pendingPath;
    const checks = prerequisites.map((prerequisite) => {
        const check = nativeServicePrerequisiteShellCheck(shell, prerequisite);
        const encodedId = Buffer.from(prerequisite.id, "utf8").toString("base64");
        const satisfied = markerCommand(shell, outputPrefix, encodedId, "satisfied", markerPath);
        const unsatisfied = markerCommand(shell, outputPrefix, encodedId, "unsatisfied", markerPath);
        return `${check} >/dev/null 2>&1 && ${satisfied} || ${unsatisfied}`;
    }).join("; ") || ":";
    if (resultFiles === undefined)
        return checks;
    const pending = shellQuote(shell, resultFiles.pendingPath);
    const completed = shellQuote(shell, resultFiles.completedPath);
    return `printf '%s' '' > ${pending}; ${checks}; /bin/mv ${pending} ${completed}`;
}
export function nativeServicePrerequisiteShellCheck(shell, prerequisite) {
    switch (prerequisite.kind) {
        case "command-available":
            return externalExecutableShellCheck(shell, prerequisite.command);
        case "node-version":
            return externalExecutableShellCheck(shell, "node", ["-e", nodeVersionCheckScript(prerequisite.minimumVersion)]);
        case "readable-file": {
            const path = shellQuote(shell, prerequisite.path);
            return `test -f ${path} && test -r ${path}`;
        }
        case "package-scripts": {
            const script = "const p=require(process.argv[1]);const names=process.argv.slice(2);process.exit(names.every((name)=>typeof p.scripts?.[name]==='string')?0:1)";
            return externalExecutableShellCheck(shell, "node", ["-e", script, prerequisite.packageJsonPath, ...prerequisite.scripts]);
        }
    }
}
export function nodeVersionCheckScript(minimumVersion) {
    const encodedMinimum = JSON.stringify(minimumVersion);
    return `const version=process.argv[1]??process.versions.node;console.log(process.version);const current=version.split('.').map(Number);const minimum=${encodedMinimum}.split('.').map(Number);const length=Math.max(current.length,minimum.length);let comparison=0;for(let index=0;index<length;index+=1){const left=current[index]??0;const right=minimum[index]??0;if(left!==right){comparison=left>right?1:-1;break}}process.exit(comparison>=0?0:1)`;
}
function externalExecutableShellCheck(shell, command, arguments_ = []) {
    const quotedCommand = shellQuote(shell, command);
    const quotedArguments = arguments_.map((argument) => shellQuote(shell, argument)).join(" ");
    if (shell === "fish") {
        const invocation = quotedArguments === "" ? "" : `; and $pi_web_probe_executable[1] ${quotedArguments}`;
        return `set -l pi_web_probe_executable (command -v ${quotedCommand}); and test (count $pi_web_probe_executable) -eq 1; and string match -q '*/*' -- $pi_web_probe_executable[1]; and test -f $pi_web_probe_executable[1]; and test -x $pi_web_probe_executable[1]${invocation}`;
    }
    const invocation = quotedArguments === "" ? "" : ` && "$pi_web_probe_executable" ${quotedArguments}`;
    return `pi_web_probe_executable=$(command -v ${quotedCommand}) && case "$pi_web_probe_executable" in */*) test -f "$pi_web_probe_executable" && test -x "$pi_web_probe_executable"${invocation};; *) false;; esac`;
}
function markerCommand(shell, outputPrefix, encodedId, status, outputPath) {
    const redirect = outputPath === undefined ? "" : ` >> ${shellQuote(shell, outputPath)}`;
    return `printf '%s\\t%s\\t%s\\n' ${shellQuote(shell, outputPrefix)} ${shellQuote(shell, encodedId)} ${shellQuote(shell, status)}${redirect}`;
}
function parseProbeOutput(stdout, prerequisites, outputPrefix) {
    const expected = new Map(prerequisites.map((prerequisite) => [
        Buffer.from(prerequisite.id, "utf8").toString("base64"),
        prerequisite,
    ]));
    const outcomes = new Map();
    for (const line of stdout.split(/\r?\n/u)) {
        if (!line.startsWith(`${outputPrefix}\t`))
            continue;
        const fields = line.split("\t");
        if (fields.length !== 3) {
            return infrastructureFailure("malformed-output", "Authoritative probe returned a malformed result line.");
        }
        const encodedId = fields[1];
        const status = fields[2];
        const prerequisite = encodedId === undefined ? undefined : expected.get(encodedId);
        if (prerequisite === undefined || (status !== "satisfied" && status !== "unsatisfied")) {
            return infrastructureFailure("malformed-output", "Authoritative probe returned an unexpected result.");
        }
        if (outcomes.has(prerequisite.id)) {
            return infrastructureFailure("malformed-output", `Authoritative probe returned duplicate outcome ${prerequisite.id}.`);
        }
        outcomes.set(prerequisite.id, {
            prerequisiteId: prerequisite.id,
            status,
            detail: status === "satisfied" ? null : unsatisfiedDetail(prerequisite),
        });
    }
    const missing = prerequisites.find((prerequisite) => !outcomes.has(prerequisite.id));
    if (missing !== undefined) {
        return infrastructureFailure("malformed-output", `Authoritative probe returned no outcome for ${missing.id}.`);
    }
    return { kind: "completed", outcomes: [...outcomes.values()] };
}
function unsatisfiedDetail(prerequisite) {
    switch (prerequisite.kind) {
        case "command-available":
            return `${prerequisite.command} did not resolve to an external executable in the native service environment.`;
        case "node-version":
            return `node >= ${prerequisite.minimumVersion} was not available in the native service environment.`;
        case "readable-file":
            return `${prerequisite.path} was not a readable regular file in the native service environment.`;
        case "package-scripts":
            return `${prerequisite.packageJsonPath} did not provide scripts ${prerequisite.scripts.join(", ")} in the native service environment.`;
    }
}
function shellQuote(shell, value) {
    return shell === "fish"
        ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
}
function safeUniqueId(value) {
    const safe = value.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "").slice(0, 48);
    return safe === "" ? "probe" : safe;
}
function launchdTargetNotLoaded(result) {
    if (result.kind !== "completed" || result.status === 0)
        return false;
    return /(?:could not find (?:specified )?service|service not found|no such process)/iu.test(`${result.stderr}\n${result.stdout}`);
}
function plistString(key, value, indent = "  ") {
    return `${indent}<key>${xmlEscape(key)}</key>\n${indent}<string>${xmlEscape(value)}</string>\n`;
}
function xmlEscape(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function commandInfrastructureFailure(action, result) {
    if (result.kind === "timeout")
        return infrastructureFailure("timeout", `Timed out while trying to ${action}.`);
    return infrastructureFailure("manager", `Could not ${action}: ${commandFailureDetail(result)}`);
}
function commandFailureDetail(result) {
    if (result.kind === "timeout")
        return "command timed out";
    if (result.kind === "spawn-failure")
        return result.message;
    if (result.kind === "output-limit")
        return "command output exceeded the capture limit";
    return firstOutput(result.stderr, result.stdout, `exit status ${String(result.status)}`);
}
function infrastructureFailure(reason, message) {
    return { kind: "infrastructure-failure", reason, message };
}
function firstOutput(...values) {
    for (const value of values) {
        const line = value.trim().split(/\r?\n/u).find((candidate) => candidate.trim() !== "");
        if (line !== undefined)
            return line.trim();
    }
    return "no output";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNodeErrorWithCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
//# sourceMappingURL=serviceProbe.js.map