import { createRequire } from "node:module";
export const NODE_PTY_GLOBAL_REINSTALL_COMMAND = "npm install -g @jmfederico/pi-web --allow-scripts=node-pty";
const doctorLabel = "node-pty native module loadable";
const requireFromHere = createRequire(import.meta.url);
export function checkNodePtyNativeModule(options = {}) {
    try {
        (options.load ?? loadNodePty)();
        return { status: "ok" };
    }
    catch (error) {
        return { status: "load-failed", message: errorMessage(error) };
    }
}
export function formatNodePtyNativeModuleCheck(check) {
    if (check.status === "ok")
        return { ok: true, lines: [`✓ ${doctorLabel}`] };
    return {
        ok: false,
        lines: [
            `✗ ${doctorLabel}`,
            `  Could not load node-pty: ${check.message}`,
            "  npm may have skipped node-pty's required install script.",
            "  For a global npm installation, reinstall PI WEB with:",
            `    ${NODE_PTY_GLOBAL_REINSTALL_COMMAND}`,
            "  Then run `pi-web doctor` again.",
        ],
    };
}
function loadNodePty() {
    return requireFromHere("node-pty");
}
function errorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll(/\s+/g, " ").trim();
}
//# sourceMappingURL=nodePtyNativeModule.js.map