// Generated from pi-web-plugins/workspace-tasks/config.ts. Do not edit directly.
export const TASKS_CONFIG_PATH = ".pi-web/tasks.json";
export const TASKS_CONFIG_VERSION = 1;
const taskIdPattern = /^[a-z][a-z0-9.-]*$/u;
export function parseTasksConfigText(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    return parseTasksConfig(parsed);
}
export function parseTasksConfig(value) {
    if (!isRecord(value))
        return invalid("Config must be an object");
    if (value["version"] !== TASKS_CONFIG_VERSION)
        return invalid("Config version must be 1");
    const tasks = value["tasks"];
    if (!Array.isArray(tasks))
        return invalid("Config tasks must be an array");
    const ids = new Set();
    const parsedTasks = [];
    for (const [index, task] of tasks.entries()) {
        const parsedTask = parseTask(task, index);
        if (!parsedTask.ok)
            return parsedTask;
        if (ids.has(parsedTask.task.id))
            return invalid(`Duplicate task id: ${parsedTask.task.id}`);
        ids.add(parsedTask.task.id);
        parsedTasks.push(parsedTask.task);
    }
    return { ok: true, config: { version: TASKS_CONFIG_VERSION, tasks: parsedTasks } };
}
function parseTask(value, index) {
    const label = `Task ${String(index + 1)}`;
    if (!isRecord(value))
        return invalid(`${label} must be an object`);
    const id = requireNonEmptyString(value, "id", label);
    if (!id.ok)
        return id;
    if (!taskIdPattern.test(id.value))
        return invalid(`${label} id must match ${taskIdPattern.source}`);
    const title = requireNonEmptyString(value, "title", label);
    if (!title.ok)
        return title;
    const command = requireNonEmptyString(value, "command", label);
    if (!command.ok)
        return command;
    const description = optionalNonEmptyString(value, "description", label);
    if (!description.ok)
        return description;
    const group = optionalNonEmptyString(value, "group", label);
    if (!group.ok)
        return group;
    const confirm = value["confirm"];
    if (confirm !== undefined && typeof confirm !== "boolean")
        return invalid(`${label} confirm must be a boolean`);
    return {
        ok: true,
        task: {
            id: id.value,
            title: title.value,
            command: command.value,
            ...(description.value === undefined ? {} : { description: description.value }),
            ...(group.value === undefined ? {} : { group: group.value }),
            confirm: confirm ?? false,
        },
    };
}
function requireNonEmptyString(record, key, label) {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "")
        return invalid(`${label} ${key} must be a non-empty string`);
    return { ok: true, value };
}
function optionalNonEmptyString(record, key, label) {
    const value = record[key];
    if (value === undefined)
        return { ok: true, value: undefined };
    if (typeof value !== "string" || value.trim() === "")
        return invalid(`${label} ${key} must be a non-empty string when provided`);
    return { ok: true, value };
}
function invalid(error) {
    return { ok: false, error };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
