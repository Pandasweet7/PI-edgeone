import { normalizeRequestCwd } from "../workingDirectory.js";
import { parseTerminalSize } from "./terminalSize.js";
export function registerTerminalRoutes(app, terminals, prefix = "") {
    app.get(`${prefix}/terminals`, (request, reply) => {
        if (request.query.cwd === undefined || request.query.cwd === "")
            return reply.code(400).send({ error: "cwd query parameter is required" });
        try {
            return terminals.list(normalizeRequestCwd(request.query.cwd));
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/terminals`, (request, reply) => {
        try {
            return terminals.create({ ...request.body, cwd: normalizeRequestCwd(request.body.cwd) });
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.delete(`${prefix}/terminals`, (request, reply) => {
        if (request.query.cwd === undefined || request.query.cwd === "")
            return reply.code(400).send({ error: "cwd query parameter is required" });
        try {
            terminals.closeForCwd(normalizeRequestCwd(request.query.cwd));
            return { closed: true };
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/terminal-command-runs`, (request, reply) => {
        try {
            return terminals.runCommand({ ...request.body, cwd: normalizeRequestCwd(request.body.cwd) });
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get(`${prefix}/terminal-command-runs`, (request, reply) => {
        try {
            return terminals.listCommandRuns(parseCommandRunFilter(request.query));
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/terminal-command-runs/:runId/cancel`, (request, reply) => {
        try {
            return terminals.cancelCommandRun(request.params.runId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get(`${prefix}/terminal-command-runs/:runId`, (request, reply) => {
        const run = terminals.getCommandRun(request.params.runId);
        if (run === undefined)
            return reply.code(404).send({ error: "Terminal command run not found" });
        return run;
    });
    app.post(`${prefix}/terminals/:terminalId/continue`, (request, reply) => {
        try {
            return terminals.continue(request.params.terminalId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.delete(`${prefix}/terminals/:terminalId`, (request) => {
        terminals.close(request.params.terminalId);
        return { closed: true };
    });
    app.get(`${prefix}/terminals/:terminalId/socket`, { websocket: true }, (socket, request) => {
        let detach = () => undefined;
        try {
            const initialSize = parseTerminalSize(request.query.cols, request.query.rows);
            if (initialSize !== undefined)
                terminals.resize(request.params.terminalId, initialSize.cols, initialSize.rows);
            detach = terminals.attach(request.params.terminalId, {
                output: (data, replay) => { socket.send(JSON.stringify({ type: "output", data, replay })); },
                exit: (exitCode) => { socket.send(JSON.stringify({ type: "exit", exitCode })); },
            });
        }
        catch (error) {
            socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
            socket.close();
            return;
        }
        socket.on("message", (data) => {
            try {
                const message = parseClientMessage(data);
                if (message.type === "input")
                    terminals.write(request.params.terminalId, message.data);
                if (message.type === "resize")
                    terminals.resize(request.params.terminalId, message.cols, message.rows);
            }
            catch (error) {
                socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
            }
        });
        socket.on("close", () => { detach(); });
        socket.on("error", () => { detach(); });
    });
}
function parseCommandRunFilter(query) {
    const metadata = query.metadata === undefined || query.metadata === "" ? undefined : parseMetadataFilter(query.metadata);
    const statuses = query.statuses === undefined || query.statuses === "" ? undefined : query.statuses.split(",").filter((status) => status !== "").map(parseCommandRunStatus);
    return {
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
        ...(query.terminalId === undefined ? {} : { terminalId: query.terminalId }),
        ...(statuses === undefined ? {} : { statuses }),
        ...(metadata === undefined ? {} : { metadata }),
    };
}
function parseCommandRunStatus(value) {
    if (value !== "queued" && value !== "running" && value !== "succeeded" && value !== "failed")
        throw new Error(`Invalid command run status: ${value}`);
    return value;
}
function parseMetadataFilter(value) {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed) || Array.isArray(parsed))
        throw new Error("metadata filter must be an object");
    return Object.fromEntries(Object.entries(parsed).map(([key, metadataValue]) => {
        if (typeof metadataValue !== "string")
            throw new Error(`metadata filter value must be a string: ${key}`);
        return [key, metadataValue];
    }));
}
function parseClientMessage(data) {
    const value = JSON.parse(rawDataToString(data));
    if (!isRecord(value) || typeof value["type"] !== "string")
        throw new Error("Invalid terminal message");
    if (value["type"] === "input" && typeof value["data"] === "string")
        return { type: "input", data: value["data"] };
    if (value["type"] === "resize" && typeof value["cols"] === "number" && typeof value["rows"] === "number")
        return { type: "resize", cols: value["cols"], rows: value["rows"] };
    throw new Error("Invalid terminal message");
}
function rawDataToString(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString("utf8");
    if (Array.isArray(data))
        return Buffer.concat(data).toString("utf8");
    return data.toString("utf8");
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=terminalRoutes.js.map