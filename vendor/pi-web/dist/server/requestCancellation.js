/**
 * Turns an inbound HTTP disconnect into cooperative cancellation for a bounded
 * downstream operation. A normal completed response never aborts the signal.
 */
export function requestCancellation(request, reply) {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort(new DOMException("HTTP request cancelled", "AbortError"));
        }
    };
    const abortOnPrematureResponseClose = () => {
        if (!reply.raw.writableEnded)
            abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortOnPrematureResponseClose);
    // Node auto-destroys the request stream once its body has been fully read, so
    // `request.raw.destroyed` alone does not mean the client went away. Only an
    // incomplete request stream, or a response closed before it was written, is a
    // real disconnect that happened before this cancellation was installed.
    if ((request.raw.destroyed && !request.raw.complete) || (reply.raw.destroyed && !reply.raw.writableEnded))
        abort();
    return {
        signal: controller.signal,
        dispose() {
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abortOnPrematureResponseClose);
        },
    };
}
//# sourceMappingURL=requestCancellation.js.map