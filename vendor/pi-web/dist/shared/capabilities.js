import { PI_WEB_CAPABILITIES } from "./apiTypes.js";
export { PI_WEB_CAPABILITIES };
// Annotated (not inferred) so the empty and populated registry shapes are
// identical for consumers: `Object.values` on the empty registry alone would
// not infer `PiWebCapability[]`.
export const KNOWN_PI_WEB_CAPABILITIES = Object.values(PI_WEB_CAPABILITIES);
const knownPiWebCapabilities = new Set(KNOWN_PI_WEB_CAPABILITIES);
export const WEB_RUNTIME_CAPABILITIES = [
    PI_WEB_CAPABILITIES.pluginLifecycle,
];
export const SESSIOND_RUNTIME_CAPABILITIES = [];
// Populated entries map each capability to the components that must both
// advertise it.
const EFFECTIVE_CAPABILITY_REQUIREMENTS = {
    [PI_WEB_CAPABILITIES.pluginLifecycle]: ["web"],
};
export function isPiWebCapability(value) {
    return typeof value === "string" && knownPiWebCapabilities.has(value);
}
export function supportsPiWebCapability(source, capability) {
    return source?.capabilities?.includes(capability) === true;
}
export function parseKnownPiWebCapabilities(value) {
    if (!Array.isArray(value) || !value.every((capability) => typeof capability === "string"))
        return undefined;
    return value.filter(isPiWebCapability);
}
export function effectivePiWebCapabilities(components) {
    return KNOWN_PI_WEB_CAPABILITIES.filter((capability) => {
        const requiredComponents = EFFECTIVE_CAPABILITY_REQUIREMENTS[capability];
        return requiredComponents.every((component) => {
            const runtime = components[component];
            return runtime?.available === true && supportsPiWebCapability(runtime, capability);
        });
    });
}
//# sourceMappingURL=capabilities.js.map