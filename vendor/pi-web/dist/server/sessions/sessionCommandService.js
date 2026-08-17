import crypto from "node:crypto";
import { isBuiltinCommand } from "./builtinCommands.js";
export class SessionCommandService {
    constructor(getActive, prompt, events, lifecycle = {}, naming = {}) {
        this.getActive = getActive;
        this.prompt = prompt;
        this.events = events;
        this.lifecycle = lifecycle;
        this.naming = naming;
        this.pendingSelects = new Map();
    }
    async run(sessionId, text) {
        const active = await this.getActive(sessionId);
        const session = active.runtime.session;
        const [name = "", ...args] = text.trim().replace(/^\//, "").split(/\s+/);
        const rest = args.join(" ").trim();
        if (this.lifecycle.isTreeNavigationActive?.(session) === true)
            return treeNavigationActiveUnsupported();
        if (!isBuiltinCommand(name)) {
            if (this.isRuntimeCommand(session, name)) {
                // The command is forwarded to the agent, which expands it (e.g. /skill:*
                // into a skill block) and streams the canonical message back. That is the
                // authoritative feedback, so we don't synthesize an extra "Accepted" line
                // that would only vanish on reload.
                await this.prompt(sessionId, text);
                return { type: "done" };
            }
            return { type: "unsupported", message: `Unknown command: /${name}` };
        }
        if (name === "session")
            return { type: "done", message: formatSessionStats(session) };
        if (name === "name")
            return this.nameSession(active, rest);
        if (name === "compact")
            return this.compact(session, rest);
        if (name === "reload")
            return this.reload(session);
        if (name === "clone")
            return this.clone(active);
        if (name === "fork")
            return this.fork(active);
        if (name === "tree")
            return this.tree(session);
        return { type: "unsupported", message: `/${name} is not implemented in the web UI yet` };
    }
    async respond(sessionId, requestId, value) {
        const pending = this.pendingSelects.get(requestId);
        if (pending?.sessionId !== sessionId)
            return { type: "unsupported", message: "Command request expired" };
        this.pendingSelects.delete(requestId);
        return this.forkEntry(sessionId, value);
    }
    /**
     * Forks the session from a specific tree entry into a new session file, leaving
     * the original session untouched. Shared by the `/fork` select response and the
     * session-tree fork-from-entry path. User entries fork from "before" so their
     * text returns as a prompt draft; every other entry forks "at" so the forked
     * file includes it.
     */
    async forkEntry(sessionId, entryId, options) {
        const active = await this.getActive(sessionId);
        if (this.lifecycle.isTreeNavigationActive?.(active.runtime.session) === true)
            return treeNavigationActiveUnsupported();
        if (this.hasActiveWork(active.runtime.session))
            return forkActiveUnsupported("fork");
        const relatedName = await this.nextRelatedSessionName(active, "fork");
        if (this.lifecycle.isTreeNavigationActive?.(active.runtime.session) === true)
            return treeNavigationActiveUnsupported();
        if (this.hasActiveWork(active.runtime.session))
            return forkActiveUnsupported("fork");
        const result = await this.runSessionReplacement(active.runtime, async () => {
            const session = active.runtime.session;
            if (options !== undefined && session.sessionManager.getLeafId() !== options.expectedLeafId) {
                throw new Error("The session changed since /tree was opened. Reopen /tree and try again.");
            }
            // Resolve the entry kind from the session state protected by the same
            // replacement boundary as the fork, not Pi's text-only /fork selector.
            const position = this.forkPosition(session, entryId);
            const forkResult = await active.runtime.fork(entryId, { position });
            if (!forkResult.cancelled)
                this.tryNameRelatedSession(active.runtime.session, relatedName);
            return forkResult;
        });
        if (result.cancelled)
            return { type: "done", message: "Fork cancelled" };
        return { type: "done", message: "Session forked", session: clientSessionFromRuntime(active.runtime), ...promptDraft(result.selectedText) };
    }
    nameSession(active, name) {
        if (name === "")
            return { type: "unsupported", message: "Usage: /name <session name>" };
        active.runtime.session.setSessionName(name);
        this.publishSessionName(active.runtime.session);
        return { type: "done", message: `Session named: ${name}`, session: clientSessionFromRuntime(active.runtime) };
    }
    compact(session, instructions) {
        this.lifecycle.onCompactionStart?.(session);
        void session.compact(instructions === "" ? undefined : instructions)
            .then((result) => {
            this.events.publish(session.sessionId, {
                type: "command.output",
                level: "success",
                message: formatCompactionResult(result),
            });
            this.lifecycle.onCompactionEnd?.(session, "success");
        })
            .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish(session.sessionId, { type: "command.output", level: "error", message: `Compaction failed: ${message}` });
            this.events.publish(session.sessionId, { type: "session.error", message });
            this.lifecycle.onCompactionEnd?.(session, "error", message);
        });
        return { type: "done", message: "Compaction started…" };
    }
    async reload(session) {
        if (this.hasActiveWork(session))
            return { type: "unsupported", message: "Cannot reload while the session is active. Stop current activity before reloading." };
        if (this.lifecycle.reloadSession === undefined)
            return { type: "unsupported", message: "/reload is not available for this session runtime." };
        try {
            await this.lifecycle.reloadSession(session);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { type: "unsupported", message: `Reload failed: ${message}` };
        }
        return { type: "done", message: "Session runtime resources reloaded. Extensions, skills, prompt templates, themes, and context/system prompt files are refreshed for this session. Reload the browser page separately for PI WEB browser plugin changes." };
    }
    async clone(active) {
        if (this.hasActiveWork(active.runtime.session))
            return forkActiveUnsupported("clone");
        const initialLeafId = active.runtime.session.sessionManager.getLeafId();
        if (initialLeafId === null || initialLeafId === "")
            return { type: "unsupported", message: "Cannot clone: no current session entry" };
        const relatedName = await this.nextRelatedSessionName(active, "copy");
        if (this.lifecycle.isTreeNavigationActive?.(active.runtime.session) === true)
            return treeNavigationActiveUnsupported();
        if (this.hasActiveWork(active.runtime.session))
            return forkActiveUnsupported("clone");
        // The active leaf may have changed while related-session names were loaded.
        // Clone the position that is current when the serialized replacement begins.
        const leafId = active.runtime.session.sessionManager.getLeafId();
        if (leafId === null || leafId === "")
            return { type: "unsupported", message: "Cannot clone: no current session entry" };
        const result = await this.runSessionReplacement(active.runtime, async () => {
            const cloneResult = await active.runtime.fork(leafId, { position: "at" });
            if (!cloneResult.cancelled)
                this.tryNameRelatedSession(active.runtime.session, relatedName);
            return cloneResult;
        });
        if (result.cancelled)
            return { type: "done", message: "Clone cancelled" };
        return { type: "done", message: "Session cloned", session: clientSessionFromRuntime(active.runtime) };
    }
    fork(active) {
        if (this.hasActiveWork(active.runtime.session))
            return forkActiveUnsupported("fork");
        const messages = active.runtime.session.getUserMessagesForForking();
        if (!messages.length)
            return { type: "unsupported", message: "No user messages to fork from" };
        const requestId = crypto.randomUUID();
        this.pendingSelects.set(requestId, { sessionId: active.runtime.session.sessionId, command: "fork" });
        return {
            type: "select",
            requestId,
            title: "Fork from message",
            options: [...messages].reverse().map((message) => ({ value: message.entryId, label: truncate(message.text, 140) })),
        };
    }
    tree(session) {
        if (this.hasActiveWork(session)) {
            return { type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." };
        }
        if (this.lifecycle.getSessionTree === undefined)
            return treeUnavailableUnsupported();
        try {
            const tree = this.lifecycle.getSessionTree(session);
            if (tree === undefined)
                return treeUnavailableUnsupported();
            if (tree.nodes.length === 0)
                return { type: "unsupported", message: "Cannot navigate an empty session tree." };
            return { type: "tree", tree };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { type: "unsupported", message: `Unable to open the session tree: ${message}` };
        }
    }
    hasActiveWork(session) {
        return sessionHasActiveWork(session) || this.lifecycle.hasActiveWork?.(session) === true;
    }
    forkPosition(session, entryId) {
        const treeNode = this.lifecycle.getSessionTree?.(session)?.nodes.find((node) => node.id === entryId);
        if (treeNode !== undefined)
            return treeNode.kind === "user" ? "before" : "at";
        return session.getUserMessagesForForking().some((message) => message.entryId === entryId) ? "before" : "at";
    }
    runSessionReplacement(runtime, operation) {
        const runReplacement = this.lifecycle.runSessionReplacement;
        return runReplacement === undefined ? operation() : runReplacement(runtime.session, operation);
    }
    async nextRelatedSessionName(active, kind) {
        const sourceTitle = relatedSessionSourceTitle(active.runtime.session);
        const sourceName = normalizedName(active.runtime.session.sessionName);
        let existingNames;
        try {
            existingNames = await this.naming.listSessionNames?.(active.runtime.cwd) ?? [];
        }
        catch {
            existingNames = [];
        }
        return uniqueRelatedSessionName(sourceTitle, kind, sourceName === undefined ? existingNames : [...existingNames, sourceName]);
    }
    tryNameRelatedSession(session, name) {
        try {
            session.setSessionName(name);
            this.publishSessionName(session);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish(session.sessionId, { type: "command.output", level: "error", message: `Session created, but naming failed: ${message}` });
        }
    }
    publishSessionName(session) {
        const event = session.sessionName === undefined
            ? { type: "session.name", sessionId: session.sessionId }
            : { type: "session.name", sessionId: session.sessionId, name: session.sessionName };
        this.events.publish(session.sessionId, event);
        this.events.publishGlobal?.(event);
    }
    isRuntimeCommand(session, name) {
        return session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name)
            || session.promptTemplates.some((template) => template.name === name)
            || session.resourceLoader.getSkills().skills.some((skill) => `skill:${skill.name}` === name);
    }
}
function clientSessionFromRuntime(runtime) {
    const session = runtime.session;
    const parentSessionPath = typeof session.sessionManager.getHeader === "function" ? session.sessionManager.getHeader()?.parentSession : undefined;
    return {
        id: session.sessionId,
        path: session.sessionFile ?? "",
        cwd: runtime.cwd,
        ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: session.messages.length,
        firstMessage: "",
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    };
}
function relatedSessionSourceTitle(session) {
    const name = normalizedName(session.sessionName);
    if (name !== undefined)
        return name;
    for (const message of session.messages) {
        const text = normalizedName(extractUserMessageText(message));
        if (text !== undefined)
            return truncate(text, 80);
    }
    return "Untitled session";
}
function uniqueRelatedSessionName(sourceTitle, kind, existingNames) {
    const baseName = stripRelatedSessionSuffix(sourceTitle) || "Untitled session";
    const label = kind === "fork" ? "Fork" : "Copy";
    const usedNames = new Set(existingNames.map(normalizedName).filter(isDefined));
    for (let counter = 1;; counter += 1) {
        const candidate = `${baseName} — ${label} ${String(counter)}`;
        if (!usedNames.has(candidate))
            return candidate;
    }
}
function stripRelatedSessionSuffix(name) {
    return name.replace(/\s+(?:—|-)\s+(?:Fork|Copy|Clone)\s+\d+$/u, "").trim();
}
function extractUserMessageText(message) {
    if (!isRecord(message) || message["role"] !== "user")
        return undefined;
    const content = message["content"];
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return undefined;
    return content.map((part) => {
        if (!isRecord(part) || part["type"] !== "text")
            return "";
        return typeof part["text"] === "string" ? part["text"] : "";
    }).join("");
}
function normalizedName(name) {
    const trimmed = name?.replace(/\s+/g, " ").trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isDefined(value) {
    return value !== undefined;
}
function sessionHasActiveWork(session) {
    return session.isStreaming || session.isBashRunning || session.isCompacting || session.pendingMessageCount > 0;
}
function forkActiveUnsupported(command) {
    return { type: "unsupported", message: `Cannot ${command} while the session is active. Stop current activity before ${command === "fork" ? "forking" : "cloning"}.` };
}
function treeUnavailableUnsupported() {
    return { type: "unsupported", message: "Session tree navigation is not available with this Pi runtime." };
}
function treeNavigationActiveUnsupported() {
    return { type: "unsupported", message: "Cannot run commands while session tree navigation is active. Stop or finish the navigation first." };
}
function promptDraft(text) {
    return text === undefined ? {} : { promptDraft: text };
}
function formatSessionStats(session) {
    const stats = session.getSessionStats();
    return [
        `Session: ${stats.sessionId}`,
        `Messages: ${String(stats.totalMessages)} (${String(stats.userMessages)} user, ${String(stats.assistantMessages)} assistant)`,
        `Tool calls: ${String(stats.toolCalls)}`,
        `Tokens: ↑${String(stats.tokens.input)} ↓${String(stats.tokens.output)} total ${String(stats.tokens.total)}`,
        `Cost: $${stats.cost.toFixed(4)}`,
    ].join("\n");
}
function formatCompactionResult(result) {
    return [
        "Compaction complete.",
        `Tokens before: ${String(result.tokensBefore)}`,
        "",
        result.summary,
    ].join("\n");
}
function truncate(text, maxLength) {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}
//# sourceMappingURL=sessionCommandService.js.map