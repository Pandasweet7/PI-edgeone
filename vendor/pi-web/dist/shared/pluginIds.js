export const piWebPluginIdPattern = /^[a-z][a-z0-9.-]*$/u;
const reservedPiWebPluginIds = new Set(["core", "themes"]);
const machinePluginIdPrefix = "machine.";
export function isPiWebPluginId(value) {
    return piWebPluginIdPattern.test(value);
}
export function isReservedPiWebPluginId(value) {
    return reservedPiWebPluginIds.has(value) || value.startsWith(machinePluginIdPrefix);
}
//# sourceMappingURL=pluginIds.js.map