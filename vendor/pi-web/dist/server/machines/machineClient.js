import { Readable } from "node:stream";
import { WebSocket } from "ws";
export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000;
const REMOTE_RESPONSE_ACCEPT_ENCODING = "gzip, deflate";
const BLOCKED_CONFIGURED_HEADER_NAMES = new Set([
    "host",
    "connection",
    "upgrade",
    "transfer-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "authorization",
    "cookie",
]);
export class RemoteMachineRequestError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "RemoteMachineRequestError";
    }
}
export class RemoteMachineClient {
    constructor(machine, fetchImpl = fetch) {
        this.machine = machine;
        this.fetchImpl = fetchImpl;
    }
    async request(method, path, body, options = {}) {
        const response = await this.fetchResponse(method, path, body, options);
        return {
            statusCode: response.status,
            headers: decodedResponseHeaders(response.headers),
            ...(response.body === null ? {} : { body: readableFromWebResponseBody(response.body) }),
        };
    }
    async requestJson(method, path, body, options = {}) {
        const response = await this.fetchResponse(method, path, body, options);
        const text = await response.text();
        const parsed = text === "" ? undefined : JSON.parse(text);
        return {
            statusCode: response.status,
            headers: decodedResponseHeaders(response.headers),
            body: parsed,
        };
    }
    connectWebSocket(path) {
        const url = this.remoteUrl(path);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return new WebSocket(url, { headers: this.remoteHeaders() });
    }
    async fetchResponse(method, path, body, options) {
        const controller = new AbortController();
        const abortFromParent = () => {
            if (!controller.signal.aborted)
                controller.abort(abortReason(options.signal));
        };
        if (options.signal?.aborted === true)
            abortFromParent();
        else
            options.signal?.addEventListener("abort", abortFromParent, { once: true });
        const timeoutError = new RemoteMachineRequestError("Remote machine request timed out", 504);
        const timeout = setTimeout(() => { controller.abort(timeoutError); }, options.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
        timeout.unref();
        try {
            const requestBody = serializeRequestBody(method, body);
            const init = {
                method,
                headers: this.requestHeaders(body, options),
                signal: controller.signal,
                redirect: "manual",
            };
            if (requestBody !== undefined)
                init.body = requestBody;
            return await this.fetchImpl(this.remoteUrl(path), init);
        }
        catch (error) {
            const reason = controller.signal.reason;
            if (reason instanceof RemoteMachineRequestError)
                throw reason;
            if (options.signal?.aborted === true || controller.signal.aborted || isAbortError(error)) {
                throw new RemoteMachineRequestError("Remote machine request cancelled", 502);
            }
            throw new RemoteMachineRequestError(error instanceof Error ? error.message : String(error), 502);
        }
        finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abortFromParent);
        }
    }
    requestHeaders(body, options) {
        const headers = new Headers(this.remoteHeaders());
        headers.set("accept", "*/*");
        headers.set("accept-encoding", REMOTE_RESPONSE_ACCEPT_ENCODING);
        if (body !== undefined)
            headers.set("content-type", options.contentType ?? defaultContentTypeForBody(body));
        return headers;
    }
    remoteHeaders() {
        return {
            ...(this.machine.token === undefined || this.machine.token === "" ? {} : { authorization: `Bearer ${this.machine.token}` }),
            ...filterConfiguredHeaders(this.machine.headers),
        };
    }
    remoteUrl(path) {
        const url = new URL(this.machine.baseUrl);
        const separator = path.indexOf("?");
        const rawPath = separator === -1 ? path : path.slice(0, separator);
        const rawQuery = separator === -1 ? "" : path.slice(separator + 1);
        const basePath = url.pathname.replace(/\/$/u, "");
        const nextPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        url.pathname = `${basePath}${nextPath}`;
        url.search = rawQuery === "" ? "" : `?${rawQuery}`;
        url.hash = "";
        return url;
    }
}
export function validateConfiguredMachineHeaders(headers) {
    if (headers === undefined)
        return undefined;
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
        const name = key.trim();
        if (name === "")
            throw new Error("Machine header names must not be empty");
        if (typeof value !== "string")
            throw new Error("Machine headers must be strings");
        if (BLOCKED_CONFIGURED_HEADER_NAMES.has(name.toLowerCase()))
            throw new Error(`Machine header is not allowed: ${name}`);
        return [name, value];
    }));
}
function filterConfiguredHeaders(headers) {
    if (headers === undefined)
        return {};
    return Object.fromEntries(Object.entries(headers).filter(([key]) => !BLOCKED_CONFIGURED_HEADER_NAMES.has(key.toLowerCase())));
}
function decodedResponseHeaders(headers) {
    const values = Object.fromEntries(headers.entries());
    const contentEncoding = values["content-encoding"];
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
        // Fetch decodes response bodies but retains headers for the encoded wire
        // representation. The outer HTTP edge must negotiate and frame the decoded body.
        delete values["content-encoding"];
        delete values["content-length"];
    }
    return values;
}
function serializeRequestBody(method, body) {
    if (body === undefined || method === "GET" || method === "HEAD")
        return undefined;
    if (isRawRequestBody(body))
        return body;
    if (ArrayBuffer.isView(body))
        return copyArrayBufferView(body);
    const serialized = JSON.stringify(body);
    return serialized;
}
function defaultContentTypeForBody(body) {
    return isRawRequestBody(body) || ArrayBuffer.isView(body) ? "application/octet-stream" : "application/json";
}
function isRawRequestBody(body) {
    return typeof body === "string"
        || body instanceof URLSearchParams
        || body instanceof Blob
        || body instanceof FormData
        || body instanceof ReadableStream
        || body instanceof ArrayBuffer;
}
function copyArrayBufferView(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
function readableFromWebResponseBody(body) {
    if (body === null)
        throw new Error("Response body is not readable");
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Node fetch returns a web stream that is runtime-compatible with Readable.fromWeb, but DOM and node:stream/web types are not structurally identical in this TS config.
    return Readable.fromWeb(body);
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
function abortReason(signal) {
    const reason = signal?.reason;
    return reason instanceof Error ? reason : new DOMException("Remote machine request cancelled", "AbortError");
}
//# sourceMappingURL=machineClient.js.map