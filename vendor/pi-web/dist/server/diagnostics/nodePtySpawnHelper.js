import { accessSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
export const PI_WEB_SPAWN_HELPER_ISSUE_URL = "https://github.com/jmfederico/pi-web/issues/4";
export const NODE_PTY_SPAWN_HELPER_UPSTREAM_ISSUE_URL = "https://github.com/microsoft/node-pty/issues/850";
const doctorLabel = "node-pty macOS spawn-helper executable";
const requireFromHere = createRequire(import.meta.url);
export function checkNodePtyDarwinSpawnHelper(options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin")
        return { status: "skipped", reason: "not-macos" };
    const arch = options.arch ?? process.arch;
    const exists = options.exists ?? existsSync;
    const stat = options.stat ?? statSync;
    const access = options.access ?? accessSync;
    let nodePtyPackageJsonPath;
    try {
        nodePtyPackageJsonPath = options.nodePtyPackageJsonPath ?? (options.resolveNodePtyPackageJson ?? resolveNodePtyPackageJson)();
    }
    catch (error) {
        return { status: "node-pty-not-found", message: errorMessage(error) };
    }
    const nodePtyRoot = dirname(nodePtyPackageJsonPath);
    const nativeDir = findNodePtyNativeDir(nodePtyRoot, platform, arch, exists);
    if (nativeDir === undefined) {
        return {
            status: "native-module-not-found",
            nodePtyRoot,
            expectedHelperPath: join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
        };
    }
    const helperPath = join(nativeDir, "spawn-helper");
    try {
        if (!stat(helperPath).isFile())
            return { status: "spawn-helper-not-file", helperPath, nodePtyRoot };
    }
    catch (error) {
        if (isFileNotFoundError(error))
            return { status: "spawn-helper-missing", helperPath, nodePtyRoot };
        return { status: "spawn-helper-stat-error", helperPath, nodePtyRoot, message: errorMessage(error) };
    }
    try {
        access(helperPath, constants.X_OK);
        return { status: "ok", helperPath, nodePtyRoot };
    }
    catch {
        return { status: "spawn-helper-not-executable", helperPath, nodePtyRoot, fixCommand: chmodFixCommand(helperPath) };
    }
}
export function formatNodePtyDarwinSpawnHelperCheck(check) {
    if (check.status === "skipped")
        return { ok: true, lines: [] };
    if (check.status === "ok") {
        return {
            ok: true,
            lines: [`✓ ${doctorLabel}`, `  ${check.helperPath}`],
        };
    }
    if (check.status === "spawn-helper-not-executable") {
        return {
            ok: false,
            lines: [
                `✗ ${doctorLabel}`,
                `  ${check.helperPath} exists but is not executable.`,
                `  Known upstream node-pty packaging issue: ${NODE_PTY_SPAWN_HELPER_UPSTREAM_ISSUE_URL}`,
                `  PI WEB tracking issue: ${PI_WEB_SPAWN_HELPER_ISSUE_URL}`,
                "  Proposed workaround:",
                `    ${check.fixCommand}`,
                "  Then run `pi-web doctor` again and retry opening a terminal.",
            ],
        };
    }
    return {
        ok: false,
        lines: [`✗ ${doctorLabel}`, ...failureDetails(check)],
    };
}
function resolveNodePtyPackageJson() {
    return requireFromHere.resolve("node-pty/package.json");
}
function findNodePtyNativeDir(nodePtyRoot, platform, arch, exists) {
    for (const dir of nodePtyNativeDirs(nodePtyRoot, platform, arch)) {
        if (exists(join(dir, "pty.node")))
            return dir;
    }
    return undefined;
}
function nodePtyNativeDirs(nodePtyRoot, platform, arch) {
    const dirs = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
    return dirs.flatMap((dir) => [join(nodePtyRoot, dir), join(nodePtyRoot, "lib", dir)]);
}
function failureDetails(check) {
    if (check.status === "node-pty-not-found") {
        return [
            `  Could not resolve node-pty from PI WEB: ${check.message}`,
            "  Reinstall or update PI WEB, then run `pi-web doctor` again.",
        ];
    }
    if (check.status === "native-module-not-found") {
        return [
            `  Could not find node-pty's native pty.node module under ${check.nodePtyRoot}.`,
            `  Expected macOS helper location: ${check.expectedHelperPath}`,
            "  Reinstall or update PI WEB, then run `pi-web doctor` again.",
        ];
    }
    if (check.status === "spawn-helper-missing") {
        return [
            `  Expected helper is missing: ${check.helperPath}`,
            "  Reinstall or update PI WEB, then run `pi-web doctor` again.",
        ];
    }
    if (check.status === "spawn-helper-not-file") {
        return [
            `  Expected helper is not a regular file: ${check.helperPath}`,
            "  Reinstall or update PI WEB, then run `pi-web doctor` again.",
        ];
    }
    return [
        `  Could not inspect ${check.helperPath}: ${check.message}`,
        "  Check the file permissions, then run `pi-web doctor` again.",
    ];
}
function chmodFixCommand(path) {
    return `chmod +x ${shellSingleQuote(path)}`;
}
function shellSingleQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function isFileNotFoundError(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=nodePtySpawnHelper.js.map