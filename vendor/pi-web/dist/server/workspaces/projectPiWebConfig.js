import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveUploadsConfig, parsePathAccessConfig, parseUploadsConfig } from "../../config.js";
export const PROJECT_PI_WEB_CONFIG_PATH = ".pi-web/config.json";
export async function loadProjectPiWebConfig(projectPath) {
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(parsed))
            throw new Error(`PI WEB project config must be a JSON object: ${path}`);
        return { path, exists: true, config: parseProjectPiWebConfig(parsed, path) };
    }
    catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT"))
            return { path, exists: false, config: {} };
        throw error;
    }
}
export async function loadEffectiveProjectPathAccess(projectPath, globalConfig) {
    const projectConfig = await loadProjectPiWebConfig(projectPath);
    return mergePathAccessConfigs(globalConfig.pathAccess, projectConfig.config.pathAccess);
}
export async function loadEffectiveProjectUploadsConfig(projectPath, globalConfig) {
    const projectConfig = await loadProjectPiWebConfig(projectPath);
    return effectiveUploadsConfig({ uploads: { ...(globalConfig.uploads ?? {}), ...(projectConfig.config.uploads ?? {}) } });
}
export function mergePathAccessConfigs(...configs) {
    const allowedPaths = dedupe(configs.flatMap((config) => config?.allowedPaths ?? []));
    return allowedPaths.length === 0 ? undefined : { allowedPaths };
}
function parseProjectPiWebConfig(value, path) {
    const version = value["version"];
    return {
        ...(version !== undefined ? { version: parseProjectConfigVersion(version, path) } : {}),
        ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
        ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
    };
}
function parseProjectConfigVersion(value, path) {
    if (value !== 1)
        throw new Error(`PI WEB project config version must be 1: ${path}`);
    return 1;
}
function dedupe(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}
function isNodeErrorWithCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=projectPiWebConfig.js.map