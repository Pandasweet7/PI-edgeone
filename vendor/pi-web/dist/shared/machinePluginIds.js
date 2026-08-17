import { isPiWebPluginId, isReservedPiWebPluginId } from "./pluginIds.js";
const MACHINE_PLUGIN_ID_PREFIX = "machine.";
export function machineScopedPluginId(machineId, pluginId) {
    if (machineId === "")
        throw new Error("Machine id is required");
    if (!isPiWebPluginId(pluginId))
        throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
    if (isReservedPiWebPluginId(pluginId))
        throw new Error(`Reserved PI WEB plugin id: ${pluginId}`);
    return `${MACHINE_PLUGIN_ID_PREFIX}${stringToHex(machineId)}.${pluginId}`;
}
export function parseMachineScopedPluginId(pluginId) {
    if (!pluginId.startsWith(MACHINE_PLUGIN_ID_PREFIX))
        return undefined;
    const rest = pluginId.slice(MACHINE_PLUGIN_ID_PREFIX.length);
    const separator = rest.indexOf(".");
    if (separator < 1)
        return undefined;
    const encodedMachineId = rest.slice(0, separator);
    const sourcePluginId = rest.slice(separator + 1);
    if (!isHexString(encodedMachineId) || !isPiWebPluginId(sourcePluginId) || isReservedPiWebPluginId(sourcePluginId))
        return undefined;
    const machineId = hexToString(encodedMachineId);
    if (machineId === "")
        return undefined;
    return { machineId, pluginId: sourcePluginId };
}
function stringToHex(value) {
    return [...new TextEncoder().encode(value)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
function hexToString(value) {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < value.length; index += 2) {
        bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
    }
    return new TextDecoder().decode(bytes);
}
function isHexString(value) {
    return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/u.test(value);
}
//# sourceMappingURL=machinePluginIds.js.map