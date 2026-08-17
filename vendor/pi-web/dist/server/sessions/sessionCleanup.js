const DAY_MS = 24 * 60 * 60 * 1000;
export function normalizeSessionCleanupRequest(record) {
    const projectCwds = optionalProjectCwds(record);
    return {
        thresholds: normalizeSessionCleanupThresholds(record),
        ...(projectCwds === undefined ? {} : { projectCwds }),
    };
}
export function normalizeSessionCleanupThresholds(record) {
    const thresholds = {};
    const archiveIdleDays = optionalDayThreshold(record, "archiveIdleDays");
    const deleteArchivedDays = optionalDayThreshold(record, "deleteArchivedDays");
    if (archiveIdleDays !== undefined)
        thresholds.archiveIdleDays = archiveIdleDays;
    if (deleteArchivedDays !== undefined)
        thresholds.deleteArchivedDays = deleteArchivedDays;
    return thresholds;
}
export function planSessionCleanup(input) {
    const thresholds = copyThresholds(input.thresholds);
    const archiveCutoff = cutoffTime(input.now, thresholds.archiveIdleDays);
    const deleteCutoff = cutoffTime(input.now, thresholds.deleteArchivedDays);
    const archivedIds = new Set(input.archivedRecords.map((record) => record.sessionId));
    const includedCwds = input.projectCwds === undefined ? undefined : new Set(input.projectCwds);
    const busySessionIds = new Set((input.activeSessions ?? []).filter((session) => session.hasActiveWork).map((session) => session.sessionId));
    const skippedBusy = new Set();
    const archiveInputs = [];
    const deleteRecords = [];
    if (archiveCutoff !== undefined) {
        for (const session of uniqueSessionsById(input.sessions)) {
            if (archivedIds.has(session.id))
                continue;
            if (includedCwds !== undefined && !includedCwds.has(session.cwd))
                continue;
            if (!isBefore(session.modified, archiveCutoff))
                continue;
            if (busySessionIds.has(session.id)) {
                skippedBusy.add(session.id);
                continue;
            }
            archiveInputs.push(archiveInputFromListEntry(session));
        }
    }
    if (deleteCutoff !== undefined) {
        for (const record of input.archivedRecords) {
            if (includedCwds !== undefined && !includedCwds.has(record.cwd))
                continue;
            if (!isTimestampBefore(record.archivedAt, deleteCutoff))
                continue;
            if (busySessionIds.has(record.sessionId)) {
                skippedBusy.add(record.sessionId);
                continue;
            }
            deleteRecords.push(record);
        }
    }
    return {
        ...summarizeSessionCleanupTargets({ archiveInputs, deleteRecords, thresholds, generatedAt: input.now.toISOString(), skippedBusySessionIds: [...skippedBusy] }),
        archiveInputs,
        deleteRecords,
        skippedBusySessionIds: [...skippedBusy].sort(),
    };
}
export function summarizeSessionCleanupTargets(input) {
    const projectsByCwd = new Map();
    let archiveCount = 0;
    let deleteCount = 0;
    for (const session of input.archiveInputs) {
        archiveCount += 1;
        projectSummary(projectsByCwd, session.cwd).archiveCount += 1;
    }
    for (const record of input.deleteRecords) {
        deleteCount += 1;
        projectSummary(projectsByCwd, record.cwd).deleteCount += 1;
    }
    const skippedBusySessionIds = [...new Set(input.skippedBusySessionIds ?? [])].sort();
    return {
        generatedAt: input.generatedAt,
        thresholds: copyThresholds(input.thresholds),
        projects: [...projectsByCwd.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)),
        totals: { archiveCount, deleteCount },
        ...(skippedBusySessionIds.length === 0 ? {} : { skippedBusySessionIds }),
    };
}
export function summarizeSessionCleanupExecution(input) {
    return {
        ...summarizeSessionCleanupTargets(input),
        archivedSessionIds: input.archiveInputs.map((session) => session.sessionId),
        deletedSessionIds: input.deleteRecords.map((record) => record.sessionId),
    };
}
function optionalDayThreshold(record, field) {
    const value = record[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new Error(`${field} field must be a non-negative integer`);
    return value;
}
function optionalProjectCwds(record) {
    const value = record["projectCwds"];
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
        throw new Error("projectCwds field must be an array of strings");
    return [...new Set(value)];
}
function cutoffTime(now, days) {
    return days === undefined ? undefined : now.getTime() - days * DAY_MS;
}
function isBefore(value, cutoff) {
    const time = value.getTime();
    return Number.isFinite(time) && time < cutoff;
}
function isTimestampBefore(value, cutoff) {
    const time = Date.parse(value);
    return Number.isFinite(time) && time < cutoff;
}
function uniqueSessionsById(sessions) {
    const sessionsById = new Map();
    for (const session of sessions) {
        const existing = sessionsById.get(session.id);
        if (existing === undefined || session.modified.getTime() > existing.modified.getTime())
            sessionsById.set(session.id, session);
    }
    return [...sessionsById.values()];
}
function archiveInputFromListEntry(session) {
    return {
        sessionId: session.id,
        cwd: session.cwd,
        path: session.path,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        ...(session.name === undefined ? {} : { name: session.name }),
        ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
    };
}
function projectSummary(projectsByCwd, cwd) {
    const existing = projectsByCwd.get(cwd);
    if (existing !== undefined)
        return existing;
    const created = { cwd, archiveCount: 0, deleteCount: 0 };
    projectsByCwd.set(cwd, created);
    return created;
}
function copyThresholds(thresholds) {
    const copy = {};
    if (thresholds.archiveIdleDays !== undefined)
        copy.archiveIdleDays = thresholds.archiveIdleDays;
    if (thresholds.deleteArchivedDays !== undefined)
        copy.deleteArchivedDays = thresholds.deleteArchivedDays;
    return copy;
}
//# sourceMappingURL=sessionCleanup.js.map