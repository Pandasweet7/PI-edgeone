export const minimumSupportedNodeVersion = "22.19.0";
export function nativeServicePrerequisiteNeedsPathAdvice(prerequisite) {
    return prerequisite.kind === "command-available" || prerequisite.kind === "node-version";
}
export const nativeServiceManagerRefs = {
    sessiond: {
        systemdName: "pi-web-sessiond.service",
        launchdLabel: "com.pi-web.sessiond",
        launchdPlistName: "com.pi-web.sessiond.plist",
        logName: "sessiond.log",
    },
    web: {
        systemdName: "pi-web.service",
        launchdLabel: "com.pi-web.web",
        launchdPlistName: "com.pi-web.web.plist",
        logName: "web.log",
    },
    uiDev: {
        systemdName: "pi-web-ui-dev.service",
        launchdLabel: "com.pi-web.ui-dev",
        launchdPlistName: "com.pi-web.ui-dev.plist",
        logName: "ui-dev.log",
    },
};
export const productionNativeServiceIds = ["sessiond", "web"];
export async function resolveProductionNativeServicePlan(input, dependencies) {
    const configuredStrategies = new Map();
    const selectionRequirements = [];
    const serviceIdsToProbe = [];
    for (const serviceId of productionNativeServiceIds) {
        const executable = input.executables[serviceId];
        if (hasConfiguredCommand(executable.configuredCommand)) {
            configuredStrategies.set(serviceId, {
                kind: "configured-override",
                command: executable.configuredCommand,
                verification: "unverified",
            });
            continue;
        }
        serviceIdsToProbe.push(serviceId);
        selectionRequirements.push(commandRequirement(serviceId, executable.namedCommand));
    }
    let outcomes = new Map();
    if (selectionRequirements.length > 0) {
        const probeResult = await runSelectionProbe(input, selectionRequirements, dependencies.probe);
        if (probeResult.kind === "infrastructure-failure") {
            return {
                ok: false,
                failures: [{ kind: "probe-infrastructure", serviceIds: serviceIdsToProbe, reason: probeResult.reason, message: probeResult.message }],
            };
        }
        const parsedOutcomes = probeOutcomes(selectionRequirements, probeResult.outcomes);
        if (parsedOutcomes.kind === "infrastructure-failure") {
            return {
                ok: false,
                failures: [{ kind: "probe-infrastructure", serviceIds: serviceIdsToProbe, reason: parsedOutcomes.reason, message: parsedOutcomes.message }],
            };
        }
        outcomes = parsedOutcomes.outcomes;
    }
    const strategies = new Map(configuredStrategies);
    const failures = [];
    for (const serviceId of serviceIdsToProbe) {
        const executable = input.executables[serviceId];
        const outcome = outcomes.get(commandRequirementId(serviceId, executable.namedCommand));
        if (outcome?.status === "satisfied") {
            strategies.set(serviceId, {
                kind: "named-command",
                command: executable.namedCommand,
                selectedBy: "authoritative-backend-probe",
            });
            continue;
        }
        let entrypointExists;
        try {
            entrypointExists = dependencies.fileExists(executable.bundledEntrypointPath);
        }
        catch (error) {
            failures.push({
                kind: "entrypoint-inspection-failure",
                serviceId,
                entrypointPath: executable.bundledEntrypointPath,
                message: errorMessage(error),
            });
            continue;
        }
        if (entrypointExists) {
            strategies.set(serviceId, {
                kind: "bundled-entrypoint",
                command: "node",
                entrypointPath: executable.bundledEntrypointPath,
                namedCommand: executable.namedCommand,
                namedCommandFailure: outcome?.detail ?? null,
            });
            continue;
        }
        failures.push({
            kind: "executable-unavailable",
            serviceId,
            namedCommand: executable.namedCommand,
            namedCommandFailure: outcome?.detail ?? null,
            bundledEntrypointPath: executable.bundledEntrypointPath,
        });
    }
    if (failures.length > 0)
        return { ok: false, failures };
    return {
        ok: true,
        plan: {
            mode: "production",
            backend: input.backend,
            shell: input.shell,
            services: productionNativeServiceIds.map((serviceId) => productionService(input, serviceId, requiredStrategy(strategies, serviceId))),
        },
    };
}
export function createDevelopmentNativeServicePlan(input) {
    const environment = copyEnvironment(input.environment);
    const sessiondScripts = ["build:plugins", "start:sessiond"];
    const uiDevScripts = ["dev:web", "dev:client"];
    const uiDevCommand = 'trap "kill 0" EXIT; npm run dev:web & npm run dev:client & wait';
    return {
        mode: "development",
        backend: input.backend,
        shell: input.shell,
        services: [
            {
                id: "sessiond",
                manager: nativeServiceManagerRefs.sessiond,
                description: "PI WEB session daemon (dev)",
                shellCommand: "exec npm run start:sessiond",
                strategy: { kind: "development-npm-script", script: "start:sessiond" },
                restart: "never",
                environment,
                workingDirectory: input.workingDirectory,
                after: [],
                wants: [],
                prerequisites: [
                    nodeRequirement("sessiond"),
                    commandRequirement("sessiond", "npm"),
                    packageScriptsRequirement("sessiond", input.packageJsonPath, sessiondScripts),
                ],
            },
            {
                id: "uiDev",
                manager: nativeServiceManagerRefs.uiDev,
                description: "PI WEB UI dev server",
                shellCommand: `exec /usr/bin/env bash -c ${shellSingleQuote(input.shell.name, uiDevCommand)}`,
                strategy: { kind: "development-npm-script-group", scripts: uiDevScripts, interpreter: "bash" },
                restart: "never",
                environment,
                workingDirectory: input.workingDirectory,
                after: ["sessiond"],
                wants: ["sessiond"],
                prerequisites: [
                    nodeRequirement("uiDev"),
                    commandRequirement("uiDev", "npm"),
                    commandRequirement("uiDev", "bash"),
                    packageScriptsRequirement("uiDev", input.packageJsonPath, uiDevScripts),
                ],
            },
        ],
    };
}
export function planValidationProbeRequests(plan) {
    const requests = [];
    for (const service of plan.services) {
        const existing = requests.find((request) => request.workingDirectory === service.workingDirectory
            && environmentsEqual(request.environment, service.environment));
        if (existing === undefined) {
            requests.push({
                purpose: "plan-validation",
                backend: plan.backend,
                shell: plan.shell,
                environment: service.environment,
                workingDirectory: service.workingDirectory,
                prerequisites: [...service.prerequisites],
            });
            continue;
        }
        existing.prerequisites.push(...service.prerequisites);
    }
    return requests;
}
export async function validateNativeServicePlan(plan, probe) {
    const failures = [];
    for (const request of planValidationProbeRequests(plan)) {
        let result;
        try {
            result = await probe.run(request);
        }
        catch (error) {
            return {
                ok: false,
                failures: [{ kind: "probe-infrastructure", reason: "manager", message: errorMessage(error) }],
            };
        }
        if (result.kind === "infrastructure-failure") {
            return {
                ok: false,
                failures: [{ kind: "probe-infrastructure", reason: result.reason, message: result.message }],
            };
        }
        const parsed = probeOutcomes(request.prerequisites, result.outcomes);
        if (parsed.kind === "infrastructure-failure") {
            return {
                ok: false,
                failures: [{ kind: "probe-infrastructure", reason: parsed.reason, message: parsed.message }],
            };
        }
        for (const prerequisite of request.prerequisites) {
            const outcome = parsed.outcomes.get(prerequisite.id);
            if (outcome?.status === "unsatisfied") {
                failures.push({ kind: "prerequisite-unsatisfied", prerequisite, detail: outcome.detail });
            }
        }
    }
    return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
function productionService(input, serviceId, strategy) {
    const isWeb = serviceId === "web";
    return {
        id: serviceId,
        manager: nativeServiceManagerRefs[serviceId],
        description: isWeb ? "PI WEB server" : "PI WEB session daemon",
        shellCommand: `exec ${strategyCommand(input.shell, strategy)}`,
        strategy,
        restart: "on-failure",
        environment: copyEnvironment(input.environment),
        workingDirectory: null,
        after: isWeb ? ["sessiond"] : [],
        wants: isWeb ? ["sessiond"] : [],
        prerequisites: strategyPrerequisites(serviceId, strategy),
    };
}
function strategyCommand(shell, strategy) {
    switch (strategy.kind) {
        case "configured-override":
        case "named-command":
            return strategy.command;
        case "bundled-entrypoint":
            return `${strategy.command} ${shellSingleQuote(shell.name, strategy.entrypointPath)}`;
        case "development-npm-script":
            return `npm run ${strategy.script}`;
        case "development-npm-script-group":
            throw new Error("Development script groups define their complete service shell command");
    }
}
function strategyPrerequisites(serviceId, strategy) {
    switch (strategy.kind) {
        case "configured-override":
            return [];
        case "named-command":
            return [commandRequirement(serviceId, strategy.command), nodeRequirement(serviceId)];
        case "bundled-entrypoint":
            return [nodeRequirement(serviceId), readableFileRequirement(serviceId, strategy.entrypointPath)];
        case "development-npm-script":
        case "development-npm-script-group":
            throw new Error(`Unexpected ${strategy.kind} strategy in a production plan`);
    }
}
async function runSelectionProbe(input, prerequisites, probe) {
    try {
        return await probe.run({
            purpose: "executable-selection",
            backend: input.backend,
            shell: input.shell,
            environment: copyEnvironment(input.environment),
            workingDirectory: null,
            prerequisites,
        });
    }
    catch (error) {
        return { kind: "infrastructure-failure", reason: "manager", message: errorMessage(error) };
    }
}
function probeOutcomes(prerequisites, outcomes) {
    const expectedIds = new Set(prerequisites.map((prerequisite) => prerequisite.id));
    const byId = new Map();
    for (const outcome of outcomes) {
        if (!expectedIds.has(outcome.prerequisiteId)) {
            return { kind: "infrastructure-failure", reason: "malformed-output", message: `Authoritative probe returned unexpected outcome ${outcome.prerequisiteId}.` };
        }
        if (byId.has(outcome.prerequisiteId)) {
            return { kind: "infrastructure-failure", reason: "malformed-output", message: `Authoritative probe returned duplicate outcome ${outcome.prerequisiteId}.` };
        }
        byId.set(outcome.prerequisiteId, outcome);
    }
    const missing = prerequisites.find((prerequisite) => !byId.has(prerequisite.id));
    if (missing !== undefined) {
        return { kind: "infrastructure-failure", reason: "malformed-output", message: `Authoritative probe returned no outcome for ${missing.id}.` };
    }
    return { kind: "completed", outcomes: byId };
}
function requiredStrategy(strategies, serviceId) {
    const strategy = strategies.get(serviceId);
    if (strategy === undefined)
        throw new Error(`Missing executable strategy for ${serviceId}`);
    return strategy;
}
function hasConfiguredCommand(command) {
    return command !== undefined && command.trim() !== "";
}
function commandRequirementId(serviceId, command) {
    return `${serviceId}.command.${command}`;
}
function commandRequirement(serviceId, command) {
    return {
        id: commandRequirementId(serviceId, command),
        kind: "command-available",
        command,
        description: `${command} resolves to an external executable for the service shell`,
    };
}
function nodeRequirement(serviceId) {
    return {
        id: `${serviceId}.node`,
        kind: "node-version",
        command: "node",
        minimumVersion: minimumSupportedNodeVersion,
        description: `node >= ${minimumSupportedNodeVersion} is available to the service shell`,
    };
}
function readableFileRequirement(serviceId, path) {
    return {
        id: `${serviceId}.entrypoint`,
        kind: "readable-file",
        path,
        description: `bundled entrypoint is a readable regular file: ${path}`,
    };
}
function packageScriptsRequirement(serviceId, packageJsonPath, scripts) {
    return {
        id: `${serviceId}.package-scripts`,
        kind: "package-scripts",
        packageJsonPath,
        scripts,
        description: `package.json defines scripts: ${scripts.join(", ")}`,
    };
}
function shellSingleQuote(shell, value) {
    if (shell === "fish")
        return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function copyEnvironment(environment) {
    return { ...environment };
}
function environmentsEqual(left, right) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value]) => right[key] === value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=servicePlan.js.map