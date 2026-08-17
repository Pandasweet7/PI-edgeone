import { randomUUID } from "node:crypto";
import { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, } from "../../shared/apiTypes.js";
export { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES } from "../../shared/apiTypes.js";
/**
 * Daemon-owned, bounded, in-memory notification state.
 *
 * The store deliberately knows nothing about Fastify, Pi session persistence,
 * sockets, or browser state. Runtime generations are opaque capabilities: once
 * a generation is replaced or cleared, stale extension callbacks become no-ops.
 */
export class SessionNotificationStore {
    constructor(options = {}) {
        this.statesBySessionId = new Map();
        this.bindings = new Map();
        this.lastInboxRevisionBySessionId = new Map();
        this.lastOverflowWatermarkBySessionId = new Map();
        this.catalogRevision = 0;
        this.nextOrder = 0;
        this.daemonInstanceId = options.daemonInstanceId ?? randomUUID();
        this.now = options.now ?? (() => new Date());
    }
    registerSession(sessionId, cwd) {
        requireIdentity(sessionId, cwd);
        const mutations = this.clearSession(sessionId, "replacement");
        const generation = Symbol(`notifications:${sessionId}`);
        const bucket = emptyBucket(generation);
        const projection = {
            sessionId,
            cwd,
            inboxRevision: this.lastInboxRevisionBySessionId.get(sessionId) ?? 0,
            overflowWatermark: this.lastOverflowWatermarkBySessionId.get(sessionId) ?? 0,
            buckets: [bucket],
        };
        const state = {
            activeGeneration: generation,
            activeProjection: projection,
            activeBucket: bucket,
        };
        this.statesBySessionId.set(sessionId, state);
        this.bindings.set(generation, { state, role: "active" });
        return { generation, mutations };
    }
    currentGeneration(sessionId, cwd) {
        const state = this.statesBySessionId.get(sessionId);
        if (state?.activeProjection.sessionId !== sessionId || state.activeProjection.cwd !== cwd || state.candidate !== undefined)
            return undefined;
        return state.activeGeneration;
    }
    beginReplacement(activeGeneration, target) {
        requireIdentity(target.sessionId, target.cwd);
        const binding = this.bindings.get(activeGeneration);
        if (binding?.role !== "active")
            throw new Error("Notification runtime generation is no longer active");
        const state = binding.state;
        if (state.candidate !== undefined)
            throw new Error("Notification runtime replacement is already in progress");
        const sameIdentity = state.activeProjection.sessionId === target.sessionId && state.activeProjection.cwd === target.cwd;
        let projection;
        if (sameIdentity) {
            projection = state.activeProjection;
        }
        else {
            const existing = this.statesBySessionId.get(target.sessionId);
            if (existing !== undefined && existing !== state)
                throw new Error("Notification target session is already registered");
            projection = {
                sessionId: target.sessionId,
                cwd: target.cwd,
                inboxRevision: this.lastInboxRevisionBySessionId.get(target.sessionId) ?? 0,
                overflowWatermark: this.lastOverflowWatermarkBySessionId.get(target.sessionId) ?? 0,
                buckets: [],
            };
            this.statesBySessionId.set(target.sessionId, state);
        }
        const generation = Symbol(`notifications:${target.sessionId}:candidate`);
        const bucket = emptyBucket(generation);
        projection.buckets.push(bucket);
        state.candidate = { generation, projection, bucket };
        this.bindings.set(generation, { state, role: "candidate" });
        return generation;
    }
    beginReplacementForSession(sessionId, cwd) {
        const generation = this.currentGeneration(sessionId, cwd);
        return generation === undefined ? undefined : this.beginReplacement(generation, { sessionId, cwd });
    }
    commitReplacement(candidateGeneration) {
        const binding = this.requireCandidate(candidateGeneration);
        const state = binding.state;
        const candidate = state.candidate;
        if (candidate === undefined)
            return [];
        const oldProjection = state.activeProjection;
        const sameProjection = oldProjection === candidate.projection;
        const before = sameProjection ? projectionFingerprint(oldProjection) : undefined;
        const mutations = [];
        this.bindings.delete(state.activeGeneration);
        if (sameProjection) {
            oldProjection.buckets = [candidate.bucket];
        }
        else {
            mutations.push(...this.clearProjection(oldProjection, "replacement"));
            this.statesBySessionId.delete(oldProjection.sessionId);
        }
        state.activeGeneration = candidate.generation;
        state.activeProjection = candidate.projection;
        state.activeBucket = candidate.bucket;
        delete state.candidate;
        this.bindings.set(candidate.generation, { state, role: "active" });
        this.statesBySessionId.set(candidate.projection.sessionId, state);
        if (sameProjection && before !== projectionFingerprint(candidate.projection)) {
            mutations.push(this.mutation(candidate.projection, { kind: "resync" }));
        }
        return mutations;
    }
    abortReplacement(candidateGeneration, survivingGeneration = "prior") {
        const binding = this.requireCandidate(candidateGeneration);
        const state = binding.state;
        const candidate = state.candidate;
        if (candidate === undefined)
            return [];
        const oldProjection = state.activeProjection;
        const oldGeneration = state.activeGeneration;
        const oldBucket = state.activeBucket;
        const candidateProjection = candidate.projection;
        const sameProjection = oldProjection === candidateProjection;
        const targetProjection = sameProjection || survivingGeneration === "prior" ? oldProjection : candidateProjection;
        const before = projectionFingerprint(targetProjection);
        const oldEntries = [...oldBucket.entries];
        const candidateEntries = [...candidate.bucket.entries];
        const oldDiscardedCount = oldBucket.discardedCount;
        const candidateDiscardedCount = candidate.bucket.discardedCount;
        const mutations = [];
        if (!sameProjection) {
            const sourceProjection = survivingGeneration === "candidate" ? oldProjection : candidateProjection;
            mutations.push(...this.clearProjection(sourceProjection, "replacement"));
            this.statesBySessionId.delete(sourceProjection.sessionId);
            const transferredDiscardedCount = survivingGeneration === "candidate" ? oldDiscardedCount : candidateDiscardedCount;
            targetProjection.overflowWatermark = addSafe(targetProjection.overflowWatermark, transferredDiscardedCount, "Notification overflow watermark exhausted");
        }
        const merged = [...oldEntries, ...candidateEntries].sort((left, right) => left.order - right.order);
        const overflow = Math.max(0, merged.length - SESSION_NOTIFICATION_LIMIT);
        const targetGeneration = survivingGeneration === "candidate" ? candidate.generation : oldGeneration;
        const targetBucket = survivingGeneration === "candidate" ? candidate.bucket : oldBucket;
        targetBucket.entries = overflow === 0 ? merged : merged.slice(overflow);
        targetBucket.discardedCount = addSafe(oldDiscardedCount, candidateDiscardedCount, "Notification discarded count exhausted");
        addDiscardedCount(overflow, targetProjection, targetBucket);
        targetProjection.buckets = [targetBucket];
        this.bindings.delete(survivingGeneration === "candidate" ? oldGeneration : candidate.generation);
        state.activeGeneration = targetGeneration;
        state.activeProjection = targetProjection;
        state.activeBucket = targetBucket;
        delete state.candidate;
        this.statesBySessionId.set(targetProjection.sessionId, state);
        this.bindings.set(targetGeneration, { state, role: "active" });
        if (before !== projectionFingerprint(targetProjection)) {
            mutations.push(this.mutation(targetProjection, { kind: "resync" }));
        }
        return mutations;
    }
    addNotification(generation, message, severity) {
        const binding = this.bindings.get(generation);
        if (binding === undefined)
            return { mutations: [] };
        const { state } = binding;
        // Once the replacement runner is bound, old callbacks are stale. Suppressing
        // them also keeps generation overflow ordered as a bounded suffix.
        if (binding.role === "active" && state.candidate !== undefined)
            return { mutations: [] };
        const projection = binding.role === "candidate" ? state.candidate?.projection : state.activeProjection;
        const bucket = binding.role === "candidate" ? state.candidate?.bucket : state.activeBucket;
        if (projection === undefined || bucket === undefined)
            return { mutations: [] };
        const previouslyRetained = retainedEntries(projection);
        const order = incrementSafe(this.nextOrder, "Notification order exhausted");
        this.nextOrder = order;
        const truncatedMessage = truncateSessionNotificationMessage(message);
        const notification = Object.freeze({
            id: `${this.daemonInstanceId}:${String(order)}`,
            message: truncatedMessage.message,
            truncated: truncatedMessage.truncated,
            severity: normalizeSeverity(severity),
            receivedAt: this.now().toISOString(),
            order,
        });
        bucket.entries.push(notification);
        const bucketEviction = bucket.entries.length > SESSION_NOTIFICATION_LIMIT ? bucket.entries.shift() : undefined;
        if (bucketEviction !== undefined)
            addDiscardedCount(1, projection, bucket);
        const retainedIds = new Set(retainedEntries(projection).map((entry) => entry.id));
        const projectionEviction = previouslyRetained.find((entry) => !retainedIds.has(entry.id));
        const delta = {
            kind: "added",
            notification,
            ...(projectionEviction === undefined ? {} : { evictedNotificationId: projectionEviction.id }),
        };
        return { notification, mutations: [this.mutation(projection, delta)] };
    }
    catalogSnapshot() {
        const sessions = uniqueProjections(this.statesBySessionId.values())
            .map((projection) => this.summary(projection))
            .filter((summary) => summary.retainedCount > 0 || summary.discardedCount > 0);
        return {
            daemonInstanceId: this.daemonInstanceId,
            catalogRevision: this.catalogRevision,
            sessions,
        };
    }
    inboxSnapshot(sessionId, cwd) {
        return this.snapshot(this.requireProjection(sessionId, cwd));
    }
    dismissNotification(sessionId, cwd, daemonInstanceId, notificationId) {
        const projection = this.requireProjection(sessionId, cwd);
        if (daemonInstanceId !== this.daemonInstanceId)
            return { snapshot: this.snapshot(projection), mutations: [] };
        const previouslyRetained = retainedEntries(projection);
        const previouslyRetainedIds = new Set(previouslyRetained.map((entry) => entry.id));
        const before = projectionFingerprint(projection);
        let dismissed = false;
        for (const bucket of projection.buckets) {
            const index = bucket.entries.findIndex((entry) => entry.id === notificationId);
            if (index === -1)
                continue;
            bucket.entries.splice(index, 1);
            dismissed = true;
            break;
        }
        if (!dismissed)
            return { snapshot: this.snapshot(projection), mutations: [] };
        if (projection.buckets.every((bucket) => bucket.entries.length === 0))
            clearDiscardedCount(projection);
        const newlyRevealed = retainedEntries(projection).some((entry) => !previouslyRetainedIds.has(entry.id));
        const after = projectionFingerprint(projection);
        if (!previouslyRetainedIds.has(notificationId) && before === after) {
            return { snapshot: this.snapshot(projection), mutations: [] };
        }
        const delta = newlyRevealed
            ? { kind: "resync" }
            : { kind: "dismissed", notificationIds: [notificationId] };
        const mutation = this.mutation(projection, delta);
        return { snapshot: this.snapshot(projection), mutations: [mutation] };
    }
    dismissAll(sessionId, cwd, daemonInstanceId, throughOrder, throughOverflowWatermark) {
        const projection = this.requireProjection(sessionId, cwd);
        if (daemonInstanceId !== this.daemonInstanceId)
            return { snapshot: this.snapshot(projection), mutations: [] };
        const visibleIds = new Set(retainedEntries(projection).map((entry) => entry.id));
        const dismissedIds = [];
        for (const bucket of projection.buckets) {
            bucket.entries = bucket.entries.filter((entry) => {
                if (entry.order > throughOrder)
                    return true;
                if (visibleIds.has(entry.id))
                    dismissedIds.push(entry.id);
                return false;
            });
        }
        const acknowledgedOverflow = acknowledgeDiscardedThrough(projection, throughOverflowWatermark);
        if (dismissedIds.length === 0 && acknowledgedOverflow === 0)
            return { snapshot: this.snapshot(projection), mutations: [] };
        const mutation = this.mutation(projection, { kind: "dismissed", notificationIds: dismissedIds });
        return { snapshot: this.snapshot(projection), mutations: [mutation] };
    }
    clearGeneration(generation, reason) {
        const binding = this.bindings.get(generation);
        return binding === undefined ? [] : this.clearSession(binding.state.activeProjection.sessionId, reason);
    }
    clearSessionIdentity(sessionId, cwd, reason) {
        const state = this.statesBySessionId.get(sessionId);
        if (state === undefined)
            return [];
        const projection = state.activeProjection.sessionId === sessionId ? state.activeProjection : state.candidate?.projection;
        if (projection?.sessionId !== sessionId)
            return [];
        if (projection.cwd !== cwd)
            throw new Error("Session cwd mismatch");
        return this.clearSession(sessionId, reason);
    }
    clearSession(sessionId, reason) {
        const state = this.statesBySessionId.get(sessionId);
        if (state === undefined)
            return [];
        const projections = state.candidate === undefined
            ? [state.activeProjection]
            : uniqueProjectionList([state.activeProjection, state.candidate.projection]);
        const mutations = projections.flatMap((projection) => this.clearProjection(projection, reason));
        this.statesBySessionId.delete(state.activeProjection.sessionId);
        if (state.candidate !== undefined) {
            this.statesBySessionId.delete(state.candidate.projection.sessionId);
            this.bindings.delete(state.candidate.generation);
        }
        this.bindings.delete(state.activeGeneration);
        return mutations;
    }
    clearAll(reason = "service-dispose") {
        const states = new Set(this.statesBySessionId.values());
        const mutations = [];
        for (const state of states)
            mutations.push(...this.clearSession(state.activeProjection.sessionId, reason));
        this.statesBySessionId.clear();
        this.bindings.clear();
        this.lastInboxRevisionBySessionId.clear();
        this.lastOverflowWatermarkBySessionId.clear();
        return mutations;
    }
    requireCandidate(candidateGeneration) {
        const binding = this.bindings.get(candidateGeneration);
        if (binding?.role !== "candidate")
            throw new Error("Notification replacement generation is no longer active");
        return binding;
    }
    requireProjection(sessionId, cwd) {
        const state = this.statesBySessionId.get(sessionId);
        if (state === undefined)
            throw new Error("Session not found");
        const projection = state.activeProjection.sessionId === sessionId
            ? state.activeProjection
            : state.candidate?.projection.sessionId === sessionId
                ? state.candidate.projection
                : undefined;
        if (projection === undefined)
            throw new Error("Session not found");
        if (projection.cwd !== cwd)
            throw new Error("Session cwd mismatch");
        return projection;
    }
    clearProjection(projection, reason) {
        const wasVisible = retainedEntries(projection).length > 0 || discardedCount(projection) > 0;
        for (const bucket of projection.buckets) {
            bucket.entries = [];
            bucket.discardedCount = 0;
        }
        return wasVisible ? [this.mutation(projection, { kind: "cleared", reason })] : [];
    }
    mutation(projection, delta) {
        projection.inboxRevision = incrementSafe(projection.inboxRevision, "Notification inbox revision exhausted");
        this.lastInboxRevisionBySessionId.set(projection.sessionId, projection.inboxRevision);
        this.lastOverflowWatermarkBySessionId.set(projection.sessionId, projection.overflowWatermark);
        this.catalogRevision = incrementSafe(this.catalogRevision, "Notification catalog revision exhausted");
        const summary = this.summary(projection);
        const common = {
            daemonInstanceId: this.daemonInstanceId,
            catalogRevision: this.catalogRevision,
            summary,
        };
        return {
            sessionId: projection.sessionId,
            inboxEvent: { type: "notifications.inbox", ...common, dismissThrough: dismissThrough(projection), delta },
            summaryEvent: { type: "notifications.summary", ...common },
        };
    }
    summary(projection) {
        const notifications = retainedEntries(projection);
        const highestSeverity = highestSeverityOf(notifications);
        return {
            sessionId: projection.sessionId,
            cwd: projection.cwd,
            inboxRevision: projection.inboxRevision,
            retainedCount: notifications.length,
            discardedCount: discardedCount(projection),
            ...(highestSeverity === undefined ? {} : { highestSeverity }),
        };
    }
    snapshot(projection) {
        const notifications = retainedEntries(projection).reverse();
        return {
            daemonInstanceId: this.daemonInstanceId,
            catalogRevision: this.catalogRevision,
            summary: this.summary(projection),
            notifications,
            dismissThrough: dismissThrough(projection),
        };
    }
}
export function truncateSessionNotificationMessage(message, maxBytes = SESSION_NOTIFICATION_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new Error("maxBytes must be a non-negative safe integer");
    const encoder = new TextEncoder();
    if (encoder.encode(message).byteLength <= maxBytes)
        return { message, truncated: false };
    let bytes = 0;
    let truncated = "";
    for (const codePoint of message) {
        const codePointBytes = encoder.encode(codePoint).byteLength;
        if (bytes + codePointBytes > maxBytes)
            break;
        truncated += codePoint;
        bytes += codePointBytes;
    }
    return { message: truncated, truncated: true };
}
function emptyBucket(generation) {
    return { generation, entries: [], discardedCount: 0 };
}
function normalizeSeverity(value) {
    return value === "warning" || value === "error" ? value : "info";
}
function retainedEntries(projection) {
    return projection.buckets
        .flatMap((bucket) => bucket.entries)
        .sort((left, right) => left.order - right.order)
        .slice(-SESSION_NOTIFICATION_LIMIT);
}
function discardedCount(projection) {
    return projection.buckets.reduce((total, bucket) => total + bucket.discardedCount, 0);
}
function highestSeverityOf(notifications) {
    let highest;
    for (const notification of notifications) {
        if (notification.severity === "error")
            return "error";
        if (notification.severity === "warning")
            highest = "warning";
        else
            highest ??= "info";
    }
    return highest;
}
function addDiscardedCount(count, projection, bucket) {
    if (count === 0)
        return;
    projection.overflowWatermark = addSafe(projection.overflowWatermark, count, "Notification overflow watermark exhausted");
    bucket.discardedCount = addSafe(bucket.discardedCount, count, "Notification discarded count exhausted");
}
function clearDiscardedCount(projection) {
    for (const bucket of projection.buckets)
        bucket.discardedCount = 0;
}
function acknowledgeDiscardedThrough(projection, throughWatermark) {
    const count = discardedCount(projection);
    if (count === 0)
        return 0;
    const firstWatermark = projection.overflowWatermark - count + 1;
    const acknowledged = Math.max(0, Math.min(count, throughWatermark - firstWatermark + 1));
    let remaining = acknowledged;
    for (const bucket of projection.buckets) {
        if (remaining === 0)
            break;
        const removed = Math.min(bucket.discardedCount, remaining);
        bucket.discardedCount -= removed;
        remaining -= removed;
    }
    return acknowledged;
}
function dismissThrough(projection) {
    const entries = retainedEntries(projection);
    return {
        order: entries.at(-1)?.order ?? 0,
        overflowWatermark: projection.overflowWatermark,
    };
}
function projectionFingerprint(projection) {
    return JSON.stringify({
        ids: retainedEntries(projection).map((entry) => entry.id),
        discardedCount: discardedCount(projection),
    });
}
function uniqueProjections(states) {
    const projections = [];
    for (const state of new Set(states)) {
        projections.push(state.activeProjection);
        if (state.candidate !== undefined && state.candidate.projection !== state.activeProjection)
            projections.push(state.candidate.projection);
    }
    return projections;
}
function uniqueProjectionList(projections) {
    return [...new Set(projections)];
}
function requireIdentity(sessionId, cwd) {
    if (sessionId === "")
        throw new Error("sessionId must not be empty");
    if (cwd === "")
        throw new Error("cwd must not be empty");
}
function incrementSafe(value, message) {
    return addSafe(value, 1, message);
}
function addSafe(value, increment, message) {
    const next = value + increment;
    if (!Number.isSafeInteger(next))
        throw new Error(message);
    return next;
}
//# sourceMappingURL=sessionNotificationStore.js.map