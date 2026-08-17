import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { requireActiveAgentProfile } from "./activeAgentProfileProvider.js";
export class ActiveProfilePiPackageService {
    constructor(activeAgentProfile, serviceForAgentDir) {
        this.activeAgentProfile = activeAgentProfile;
        this.serviceForAgentDir = serviceForAgentDir;
        this.mutationQueue = Promise.resolve();
    }
    async list() {
        return await this.withActiveService((service) => service.list());
    }
    install(source) {
        return this.enqueueMutation((service) => service.install(source));
    }
    remove(source, scope) {
        return this.enqueueMutation((service) => service.remove(source, scope));
    }
    update(source) {
        return this.enqueueMutation((service) => service.update(source));
    }
    enqueueMutation(operation) {
        const queuedMutation = this.mutationQueue.then(() => this.withActiveService(operation));
        this.mutationQueue = queuedMutation.then(() => undefined, () => undefined);
        return queuedMutation;
    }
    async withActiveService(operation) {
        const profile = await requireActiveAgentProfile(this.activeAgentProfile);
        return await operation(this.serviceForAgentDir(profile.dir));
    }
}
export class DefaultPiPackageService {
    constructor(manager) {
        this.manager = manager;
        this.mutationQueue = Promise.resolve();
    }
    list() {
        return Promise.resolve({ packages: this.listPackages() });
    }
    install(source) {
        return this.enqueueMutation(async () => {
            await this.manager.installAndPersist(source);
            await this.flushSettings();
            return this.mutationResponse("install", { source });
        });
    }
    remove(source, scope = "user") {
        return this.enqueueMutation(async () => {
            const removed = scope === "project"
                ? await this.manager.removeAndPersist(source, { local: true })
                : await this.manager.removeAndPersist(source);
            await this.flushSettings();
            return this.mutationResponse("remove", { source, scope, removed });
        });
    }
    update(source) {
        return this.enqueueMutation(async () => {
            if (source === undefined) {
                await this.manager.update();
                await this.flushSettings();
                return this.mutationResponse("update", {});
            }
            await this.manager.update(source);
            await this.flushSettings();
            return this.mutationResponse("update", { source });
        });
    }
    enqueueMutation(operation) {
        const queuedMutation = this.mutationQueue.then(operation);
        this.mutationQueue = queuedMutation.then(() => undefined, () => undefined);
        return queuedMutation;
    }
    mutationResponse(action, metadata) {
        return { action, ...metadata, packages: this.listPackages() };
    }
    async flushSettings() {
        await this.manager.flush?.();
    }
    listPackages() {
        return this.manager.listConfiguredPackages().map((configuredPackage) => ({
            source: configuredPackage.source,
            scope: configuredPackage.scope,
            filtered: configuredPackage.filtered,
            ...(configuredPackage.installedPath === undefined ? {} : { installedPath: configuredPackage.installedPath }),
        }));
    }
}
export function createActiveProfilePiPackageService(activeAgentProfile, cwd = process.cwd()) {
    return new ActiveProfilePiPackageService(activeAgentProfile, (agentDir) => createDefaultPiPackageService(cwd, agentDir));
}
export function createDefaultPiPackageService(cwd, agentDir) {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    return new DefaultPiPackageService({
        listConfiguredPackages: () => manager.listConfiguredPackages(),
        installAndPersist: (source, options) => manager.installAndPersist(source, options),
        removeAndPersist: (source, options) => manager.removeAndPersist(source, options),
        update: (source) => manager.update(source),
        flush: () => settingsManager.flush(),
    });
}
//# sourceMappingURL=piPackageService.js.map