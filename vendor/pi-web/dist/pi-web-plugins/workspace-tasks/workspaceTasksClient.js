// Generated from pi-web-plugins/workspace-tasks/workspaceTasksClient.ts. Do not edit directly.
import { TASKS_CONFIG_PATH, parseTasksConfigText } from "./config.js";
export const tasksConfigMissingMessage = "No workspace tasks configured here.";
export const tasksConfigMissingHint = `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`;
export const tasksConfigUnavailableMessage = "Could not load workspace tasks.";
export const tasksConfigRefreshHint = `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`;
const missingWorkspaceFileError = "Path does not exist";
export async function loadWorkspaceTasksConfig(files) {
    let file;
    try {
        file = await files.readFile(TASKS_CONFIG_PATH);
    }
    catch (error) {
        if (errorMessage(error) === missingWorkspaceFileError)
            return missing();
        return unavailable(`Unable to read ${TASKS_CONFIG_PATH}: ${formatUnknownError(error)}`);
    }
    if (file.binary)
        return unavailable(`${TASKS_CONFIG_PATH} must be a text file`);
    if (file.truncated)
        return unavailable(`${TASKS_CONFIG_PATH} is too large and was truncated`);
    const result = parseTasksConfigText(file.content);
    if (!result.ok)
        return unavailable(result.error);
    return { kind: "loaded", config: result.config, path: TASKS_CONFIG_PATH };
}
function missing() {
    return {
        kind: "missing",
        message: tasksConfigMissingMessage,
        hint: tasksConfigMissingHint,
    };
}
function unavailable(detail) {
    return {
        kind: "unavailable",
        message: tasksConfigUnavailableMessage,
        hint: tasksConfigRefreshHint,
        detail,
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : undefined;
}
function formatUnknownError(error) {
    return error instanceof Error ? error.message : String(error);
}
