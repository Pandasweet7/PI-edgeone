import http from "node:http";
import { WebSocket } from "ws";
import { isHostAbsoluteAgentDir } from "../config.js";
import { parsePiWebRuntimeComponent } from "../shared/piWebStatusParsing.js";
import { sessiondHttpUrl, sessiondSocketPath } from "./config.js";
export class SessionDaemonClient {
    constructor() {
        this.baseUrl = sessiondHttpUrl();
        this.socketPath = sessiondSocketPath();
    }
    async request(method, path, body, options = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (this.baseUrl !== undefined && this.baseUrl !== "") {
            return this.requestUrl(method, path, payload, options.signal);
        }
        return this.requestSocket(method, path, payload, options.signal);
    }
    getActiveAgentProfile() {
        return getSessionDaemonActiveAgentProfile(this);
    }
    connectWebSocket(path) {
        if (this.baseUrl !== undefined && this.baseUrl !== "") {
            const url = new URL(path, this.baseUrl);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return new WebSocket(url);
        }
        return new WebSocket(`ws+unix:${this.socketPath}:${path}`);
    }
    async requestUrl(method, path, payload, signal) {
        const init = { method, ...(signal === undefined ? {} : { signal }) };
        if (payload !== undefined && payload !== "") {
            init.headers = { "content-type": "application/json" };
            init.body = payload;
        }
        const response = await fetch(new URL(path, this.baseUrl), init);
        return {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: await response.text(),
        };
    }
    requestSocket(method, path, payload, signal) {
        return new Promise((resolve, reject) => {
            const request = http.request({
                socketPath: this.socketPath,
                path,
                method,
                ...(signal === undefined ? {} : { signal }),
                headers: payload !== undefined && payload !== ""
                    ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
                    : undefined,
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                response.on("end", () => {
                    resolve({
                        statusCode: response.statusCode ?? 500,
                        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            });
            request.on("error", reject);
            if (payload !== undefined && payload !== "")
                request.write(payload);
            request.end();
        });
    }
}
export async function getSessionDaemonActiveAgentProfile(client) {
    let response;
    try {
        response = await client.request("GET", "/runtime");
    }
    catch (error) {
        return { status: "unavailable", error: errorMessage(error) };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        return { status: "unavailable", error: `session daemon runtime request returned HTTP ${String(response.statusCode)}` };
    }
    let value;
    try {
        value = response.body === "" ? undefined : JSON.parse(response.body);
    }
    catch {
        return { status: "invalid", error: "session daemon runtime response was not valid JSON" };
    }
    const runtime = parsePiWebRuntimeComponent(value);
    if (runtime?.component !== "sessiond") {
        return { status: "invalid", error: "session daemon runtime response was invalid" };
    }
    if (runtime.activeAgentProfile === undefined) {
        return { status: "invalid", error: "session daemon runtime response did not include an active agent profile" };
    }
    if (!isHostAbsoluteAgentDir(runtime.activeAgentProfile.dir)) {
        return { status: "invalid", error: "session daemon active agent profile was not valid for this host" };
    }
    return { status: "available", profile: runtime.activeAgentProfile };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=sessionDaemonClient.js.map