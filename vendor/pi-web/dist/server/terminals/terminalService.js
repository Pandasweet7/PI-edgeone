import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// EdgeOne Makers build: the Makers sandbox does not carry node-pty's native
// module, so terminal creation fails fast under PI_WEB_MAKERS=1 and the module
// is never loaded. On the standard build the native pty is lazy-required so
// nothing changes.
const MAKERS_TERMINALS_DISABLED = process.env["PI_WEB_MAKERS"] === "1";
const requireFromHere = createRequire(import.meta.url);
let ptyModule;
function pty() {
    if (ptyModule === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ptyModule = requireFromHere("node-pty");
    }
    return ptyModule;
}
const MAX_REPLAY_BUFFER = 200_000;
export class TerminalService {
    constructor(events, workspaceActivity) {
        this.events = events;
        this.workspaceActivity = workspaceActivity;
        this.terminals = new Map();
        this.commandRuns = new Map();
    }
    list(cwd) {
        return [...this.terminals.values()]
            .filter((terminal) => terminal.cwd === cwd)
            .map(toInfo);
    }
    closeForCwd(cwd) {
        if (cwd === "")
            throw new Error("cwd is required");
        for (const terminal of [...this.terminals.values()].filter((candidate) => candidate.cwd === cwd))
            this.close(terminal.id);
    }
    create(options) {
        const shell = process.env["SHELL"] ?? "/bin/bash";
        return this.createTerminal({ ...options, shellArgs: interactiveShellArgs(shell) });
    }
    runCommand(options) {
        validateCommandRunOptions(options);
        const commandRunId = randomUUID();
        const terminalId = randomUUID();
        const createdAt = new Date().toISOString();
        const metadata = parseMetadata(options.metadata);
        const queued = {
            id: commandRunId,
            origin: options.origin,
            projectId: options.projectId,
            workspaceId: options.workspaceId,
            terminalId,
            title: options.title,
            command: options.command,
            status: "queued",
            createdAt,
            metadata,
        };
        const running = { ...queued, status: "running", startedAt: new Date().toISOString() };
        this.commandRuns.set(commandRunId, running);
        try {
            this.createTerminal({
                id: terminalId,
                cwd: options.cwd,
                name: options.title,
                ...(options.cols === undefined ? {} : { cols: options.cols }),
                ...(options.rows === undefined ? {} : { rows: options.rows }),
                shellArgs: ["-lc", commandRunShellScript(options.command)],
                commandRunId,
            });
        }
        catch (error) {
            this.commandRuns.delete(commandRunId);
            throw error;
        }
        return copyCommandRun(this.commandRuns.get(commandRunId) ?? running);
    }
    listCommandRuns(filter = {}) {
        return [...this.commandRuns.values()]
            .filter((run) => matchesCommandRunFilter(run, filter))
            .map(copyCommandRun);
    }
    getCommandRun(runId) {
        const run = this.commandRuns.get(runId);
        return run === undefined ? undefined : copyCommandRun(run);
    }
    cancelCommandRun(runId) {
        const run = this.commandRuns.get(runId);
        if (run === undefined)
            throw new Error("Terminal command run not found");
        if (isTerminalCommandRunFinal(run.status))
            return copyCommandRun(run);
        const terminal = this.terminals.get(run.terminalId);
        if (terminal === undefined)
            throw new Error("Terminal not found");
        if (!terminal.exited)
            terminal.pty.write("\x03");
        return copyCommandRun(run);
    }
    get(id) {
        const terminal = this.terminals.get(id);
        return terminal === undefined ? undefined : toInfo(terminal);
    }
    attach(id, handlers) {
        const terminal = this.require(id);
        if (terminal.buffer !== "")
            handlers.output(terminal.buffer, true);
        if (terminal.exited)
            handlers.exit(terminal.exitCode);
        const onOutput = (data) => { handlers.output(data, false); };
        const onExit = (exitCode) => { handlers.exit(exitCode); };
        terminal.events.on("output", onOutput);
        terminal.events.on("exit", onExit);
        return () => {
            terminal.events.off("output", onOutput);
            terminal.events.off("exit", onExit);
        };
    }
    write(id, data) {
        const terminal = this.require(id);
        if (!terminal.exited)
            terminal.pty.write(data);
    }
    resize(id, cols, rows) {
        const terminal = this.require(id);
        if (!terminal.exited && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
            terminal.pty.resize(Math.floor(cols), Math.floor(rows));
        }
    }
    continue(id) {
        const record = this.require(id);
        if (!record.exited)
            return toInfo(record);
        delete record.exitCode;
        delete record.commandRunId;
        record.exited = false;
        const marker = "\r\n[continued in interactive shell]\r\n";
        record.buffer = trimReplayBuffer(record.buffer + marker);
        record.events.emit("output", marker);
        const shell = process.env["SHELL"] ?? "/bin/bash";
        record.pty = pty().spawn(shell, interactiveShellArgs(shell), {
            name: "xterm-256color",
            cwd: record.cwd,
            cols: 100,
            rows: 30,
            env: { ...process.env, TERM: "xterm-256color", PI_WEB_TERMINAL: "1" },
        });
        this.attachPtyEvents(record);
        const info = toInfo(record);
        this.workspaceActivity?.updateTerminal(info);
        this.publish({ type: "terminal.created", terminal: info });
        return info;
    }
    close(id) {
        const terminal = this.terminals.get(id);
        if (terminal === undefined)
            return;
        this.terminals.delete(id);
        terminal.events.removeAllListeners();
        this.workspaceActivity?.removeTerminal(id, terminal.cwd);
        if (!terminal.exited)
            terminal.pty.kill();
        this.publish({ type: "terminal.closed", terminalId: id, cwd: terminal.cwd });
    }
    dispose() {
        for (const id of [...this.terminals.keys()])
            this.close(id);
    }
    createTerminal(options) {
        if (MAKERS_TERMINALS_DISABLED) {
            throw new Error("Terminals are not supported on EdgeOne Makers (node-pty unavailable)");
        }
        if (options.cwd === "")
            throw new Error("cwd is required");
        const id = options.id ?? randomUUID();
        const createdAt = new Date().toISOString();
        const shell = process.env["SHELL"] ?? "/bin/bash";
        const terminal = pty().spawn(shell, options.shellArgs, {
            name: "xterm-256color",
            cwd: options.cwd,
            cols: options.cols ?? 100,
            rows: options.rows ?? 30,
            env: { ...process.env, TERM: "xterm-256color", PI_WEB_TERMINAL: "1" },
        });
        const requestedName = options.name?.trim();
        const record = {
            id,
            cwd: options.cwd,
            name: requestedName !== undefined && requestedName !== "" ? requestedName : `Shell ${String(this.list(options.cwd).length + 1)}`,
            createdAt,
            exited: false,
            pty: terminal,
            buffer: "",
            events: new EventEmitter(),
            ...(options.commandRunId === undefined ? {} : { commandRunId: options.commandRunId }),
        };
        this.attachPtyEvents(record);
        this.terminals.set(id, record);
        const info = toInfo(record);
        this.workspaceActivity?.updateTerminal(info);
        this.publish({ type: "terminal.created", terminal: info });
        return info;
    }
    attachPtyEvents(record) {
        record.pty.onData((data) => {
            record.buffer = trimReplayBuffer(record.buffer + data);
            record.events.emit("output", data);
        });
        record.pty.onExit(({ exitCode }) => {
            record.exited = true;
            record.exitCode = exitCode;
            this.completeCommandRun(record.commandRunId, exitCode);
            record.events.emit("exit", exitCode);
            const info = toInfo(record);
            this.workspaceActivity?.updateTerminal(info);
            this.publish({ type: "terminal.exited", terminal: info });
        });
    }
    completeCommandRun(runId, exitCode) {
        if (runId === undefined)
            return;
        const run = this.commandRuns.get(runId);
        if (run === undefined || isTerminalCommandRunFinal(run.status))
            return;
        const completed = {
            ...run,
            status: exitCode === 0 ? "succeeded" : "failed",
            ...(exitCode === undefined ? {} : { exitCode }),
            completedAt: new Date().toISOString(),
        };
        this.commandRuns.set(runId, completed);
    }
    require(id) {
        const terminal = this.terminals.get(id);
        if (terminal === undefined)
            throw new Error("Terminal not found");
        return terminal;
    }
    publish(event) {
        this.events?.publishRealtime(event);
    }
}
function toInfo(record) {
    return {
        id: record.id,
        cwd: record.cwd,
        name: record.name,
        createdAt: record.createdAt,
        exited: record.exited,
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
        ...(record.commandRunId === undefined ? {} : { commandRunId: record.commandRunId }),
    };
}
function trimReplayBuffer(buffer) {
    if (buffer.length <= MAX_REPLAY_BUFFER)
        return buffer;
    return buffer.slice(buffer.length - MAX_REPLAY_BUFFER);
}
export function interactiveShellArgs(shell) {
    const executable = shell.split(/[\\/]/).at(-1)?.toLowerCase().replace(/^-/, "").replace(/\.exe$/, "");
    // Preserve the existing invocation for arbitrary SHELL values rather than guessing at an unsupported login flag.
    return executable === "bash" || executable === "zsh" || executable === "fish" ? ["-l"] : [];
}
function commandRunShellScript(command) {
    return `printf '%s\\n' ${shellQuote(`$ ${command}`)}\n${command}`;
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function validateCommandRunOptions(options) {
    if (options.origin.trim() === "")
        throw new Error("origin is required");
    if (options.projectId.trim() === "")
        throw new Error("projectId is required");
    if (options.workspaceId.trim() === "")
        throw new Error("workspaceId is required");
    if (options.cwd.trim() === "")
        throw new Error("cwd is required");
    if (options.title.trim() === "")
        throw new Error("title is required");
    if (options.command.trim() === "")
        throw new Error("command is required");
    parseMetadata(options.metadata);
}
function parseMetadata(value) {
    if (value === undefined || value === null)
        return {};
    if (!isRecord(value) || Array.isArray(value))
        throw new Error("metadata must be an object");
    return Object.fromEntries(Object.entries(value).map(([key, metadataValue]) => {
        if (key.trim() === "")
            throw new Error("metadata keys must not be empty");
        if (typeof metadataValue !== "string")
            throw new Error("metadata values must be strings");
        return [key, metadataValue];
    }));
}
function matchesCommandRunFilter(run, filter) {
    if (filter.projectId !== undefined && run.projectId !== filter.projectId)
        return false;
    if (filter.workspaceId !== undefined && run.workspaceId !== filter.workspaceId)
        return false;
    if (filter.terminalId !== undefined && run.terminalId !== filter.terminalId)
        return false;
    if (filter.statuses !== undefined && filter.statuses.length > 0 && !filter.statuses.includes(run.status))
        return false;
    for (const [key, value] of Object.entries(filter.metadata ?? {})) {
        if (run.metadata[key] !== value)
            return false;
    }
    return true;
}
function isTerminalCommandRunFinal(status) {
    return status === "succeeded" || status === "failed";
}
function copyCommandRun(run) {
    return { ...run, metadata: { ...run.metadata } };
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=terminalService.js.map