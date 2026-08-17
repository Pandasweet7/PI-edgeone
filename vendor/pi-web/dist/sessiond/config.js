import { join } from "node:path";
import { piWebDataDir } from "../config.js";
export function sessiondSocketPath(env = process.env) {
    return env["PI_WEB_SESSIOND_SOCKET"] ?? join(piWebDataDir(env), "sessiond.sock");
}
/**
 * Human description of the daemon endpoint: the TCP address when a port is
 * configured, otherwise the socket path. Mirrors the listener selection in
 * the session daemon startup.
 */
export function sessiondEndpointDescription(env = process.env) {
    const port = env["PI_WEB_SESSIOND_PORT"];
    if (port !== undefined && port !== "")
        return `${env["PI_WEB_SESSIOND_HOST"] ?? "127.0.0.1"}:${port}`;
    return sessiondSocketPath(env);
}
export function sessiondHttpUrl() {
    return process.env["PI_WEB_SESSIOND_URL"];
}
//# sourceMappingURL=config.js.map