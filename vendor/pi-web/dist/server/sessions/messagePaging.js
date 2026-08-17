const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
export function pageMessagesAtSafeBoundary(messages, page) {
    const total = messages.length;
    if (page?.before === undefined && page?.limit === undefined)
        return { messages, start: 0, total };
    const before = clampInteger(page.before ?? total, 0, total);
    const limit = clampInteger(page.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const requestedStart = Math.max(0, before - limit);
    const start = expandStartToSafeBoundary(messages, requestedStart);
    return { messages: messages.slice(start, before), start, total };
}
export function expandStartToSafeBoundary(messages, requestedStart) {
    const start = clampInteger(requestedStart, 0, messages.length);
    if (start === 0 || isTurnBoundary(messages[start]))
        return start;
    for (let index = start - 1; index >= 0; index -= 1) {
        if (isTurnBoundary(messages[index]))
            return index;
    }
    return 0;
}
function isTurnBoundary(message) {
    return getString(message, "role") === "user";
}
function getProperty(value, key) {
    if (!isRecord(value))
        return undefined;
    return value[key];
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function getString(value, key) {
    const property = getProperty(value, key);
    return typeof property === "string" ? property : undefined;
}
function clampInteger(value, min, max) {
    if (!Number.isFinite(value))
        return max;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
//# sourceMappingURL=messagePaging.js.map