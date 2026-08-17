// Generated from pi-web-plugins/updates/updatesLogic.ts. Do not edit directly.
// The single command users should run when they do not want to think: if an
// update is available, `commands.update` already chains the update and a full
// restart; otherwise, when anything is stale, a full restart is enough.
export function recommendedCommand(status) {
    const { commands, release, components } = status;
    if (release.updateAvailable && typeof commands.update === "string" && commands.update !== "") {
        return { label: "Update & restart everything", command: commands.update };
    }
    const restartNeeded = components.web.stale || components.sessiond.stale || !components.sessiond.available;
    if (restartNeeded && typeof commands.restart === "string" && commands.restart !== "") {
        return { label: "Restart everything", command: commands.restart };
    }
    return undefined;
}
export function additionalCommands(status, recommended) {
    return [
        ["Update", status.commands.update],
        ["Restart all", status.commands.restart],
        ["Restart Web/UI", status.commands.restartWeb],
        ["Restart session daemon", status.commands.restartSessiond],
        ["Status", status.commands.status],
    ]
        .filter((entry) => typeof entry[1] === "string" && entry[1] !== "")
        .filter(([, command]) => command !== recommended?.command)
        .map(([label, command]) => ({ label, command }));
}
export function messagesFor(state) {
    return state?.piWebStatus?.messages ?? [];
}
export function statusFor(state) {
    return state?.piWebStatus;
}
export function messageCount(state) {
    return messagesFor(state).length;
}
export function isSelfManagedInstallation(installation) {
    return installation === undefined || installation.kind === "local" || installation.kind === "docker" || installation.kind === "unknown";
}
export function shouldShowUpdatesPanel(state, hint = {}) {
    const status = statusFor(state);
    if (hint.dockerMode !== undefined)
        return true;
    if (messageCount(state) > 0)
        return true;
    if (status === undefined)
        return false;
    return isSelfManagedInstallation(status.components.web.installation)
        || isSelfManagedInstallation(status.components.sessiond.installation);
}
export function fallbackDockerStatus(hint, generatedAt = "federated status unavailable") {
    if (hint.dockerMode === undefined)
        return undefined;
    const commandPrefix = hint.dockerMode === "dev" ? "pi-web-docker --dev" : "pi-web-docker";
    const installation = { kind: "docker", dockerMode: hint.dockerMode };
    return {
        packageName: "@jmfederico/pi-web",
        generatedAt,
        components: {
            web: { component: "web", label: "Web/UI", stale: false, available: true, installation },
            sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true, installation },
        },
        release: { packageName: "@jmfederico/pi-web", updateAvailable: false, skipped: true },
        commands: {
            update: `${commandPrefix} update`,
            restart: `${commandPrefix} restart`,
            restartWeb: `${commandPrefix} restart-web`,
            restartSessiond: `${commandPrefix} restart-sessiond`,
            status: `${commandPrefix} status`,
        },
        messages: [{
                id: "docker-status-compatibility",
                severity: "info",
                title: "Docker update commands available",
                body: "This Updates plugin was loaded from a Docker PI WEB runtime, but the gateway has not provided Docker-aware status details yet. The Docker maintenance commands below are still available.",
            }],
    };
}
export function formatVersion(version) {
    return version === undefined || version === "" ? "unknown" : version;
}
export function installationLabel(installation) {
    if (installation === undefined)
        return "installation unknown";
    if (installation.kind === "pi-package") {
        const scope = installation.scope === undefined ? "" : ` · ${installation.scope}`;
        const source = installation.source ?? "Pi package";
        return `${source}${scope}`;
    }
    if (installation.kind === "npm-global")
        return "global npm package";
    if (installation.kind === "local")
        return "local checkout";
    if (installation.kind === "docker")
        return installation.dockerMode === "dev" ? "Docker development runtime" : "Docker runtime";
    return "installation unknown";
}
