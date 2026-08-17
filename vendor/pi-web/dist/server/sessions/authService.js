import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getLoginProviderOptions, getLogoutProviderOptions } from "./authProviderOptions.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";
const noopLogger = { error() { } };
/**
 * Model-runtime network policy for the shared runtime.
 *
 * Pi 0.84 made every runtime-owned refresh local-only: `ModelRuntime.create()`
 * fetches catalogs over the network only when `allowModelNetwork: true`, and
 * `login()`/`logout()`/runtime-API-key mutations synchronize provider state
 * with a hard-coded `allowNetwork: false`, provider-scoped and abortable.
 * Pi-web's own request-path refreshes pass `allowNetwork: false` explicitly
 * (see below), so no request path can stall on a provider-catalog fetch. The
 * single deliberate network path is the bounded background refresher in
 * modelCatalogRefresher.ts.
 */
export function createModelRuntimeForAgentDir(agentDir) {
    return ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        allowModelNetwork: false,
    });
}
export class AuthService {
    constructor(runtime, authFlows, logger) {
        this.listeners = new Set();
        this.runtime = runtime;
        this.authFlows = authFlows;
        this.logger = logger;
    }
    static async create(deps = {}) {
        const runtime = deps.runtime ?? (deps.agentDir === undefined ? await ModelRuntime.create({ allowModelNetwork: false }) : await createModelRuntimeForAgentDir(deps.agentDir));
        const logger = deps.logger ?? noopLogger;
        const authFlows = deps.authFlows ?? new OAuthLoginFlowService({ logger });
        return new AuthService(runtime, authFlows, logger);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    dispose() {
        this.authFlows.dispose();
        this.listeners.clear();
    }
    async authProviders(mode, authType) {
        await this.runtime.refresh({ allowNetwork: false });
        const providers = mode === "logout" ? await getLogoutProviderOptions(this.runtime) : getLoginProviderOptions(this.runtime, authType);
        return { providers };
    }
    async logoutProvider(providerId) {
        await this.runtime.logout(providerId);
        await this.emit({ removedProviderId: providerId }, { operation: "logout", providerId });
        return { accepted: true };
    }
    async startApiKeyLogin(providerId) {
        const provider = await this.requireApiKeyLoginProvider(providerId);
        return this.authFlows.start({
            providerId,
            providerName: provider.name,
            runtime: this.runtime,
            authType: "api_key",
            onComplete: () => this.emit({}, { operation: "login", providerId, authType: "api_key" }),
        });
    }
    async startOAuthLogin(providerId) {
        const provider = await this.requireOAuthLoginProvider(providerId);
        return this.authFlows.start({
            providerId,
            providerName: provider.name,
            runtime: this.runtime,
            authType: "oauth",
            onComplete: () => this.emit({}, { operation: "login", providerId, authType: "oauth" }),
        });
    }
    oauthFlow(flowId) {
        return this.authFlows.get(flowId);
    }
    respondToOAuthFlow(flowId, requestId, value) {
        return this.authFlows.respond(flowId, requestId, value);
    }
    cancelOAuthFlow(flowId) {
        return this.authFlows.cancel(flowId);
    }
    async emit(change, context) {
        const results = await Promise.allSettled([...this.listeners].map(async (listener) => listener(change)));
        for (const result of results) {
            if (result.status === "rejected") {
                this.logErrorNoThrow({ err: result.reason, ...context }, "auth-change listener failed");
            }
        }
    }
    logErrorNoThrow(details, message) {
        try {
            this.logger.error(details, message);
        }
        catch {
            // A diagnostic failure cannot turn an already-committed auth mutation into an API failure.
        }
    }
    async requireApiKeyLoginProvider(providerId) {
        await this.runtime.refresh({ allowNetwork: false });
        const provider = getLoginProviderOptions(this.runtime, "api_key").find((option) => option.id === providerId);
        if (provider !== undefined)
            return provider;
        const knownProvider = this.runtime.getProviders().find((option) => option.id === providerId);
        if (knownProvider !== undefined) {
            throw new Error(`${knownProvider.name} does not support interactive API-key setup`);
        }
        throw new Error(`API key provider not found: ${providerId}`);
    }
    async requireOAuthLoginProvider(providerId) {
        await this.runtime.refresh({ allowNetwork: false });
        const provider = getLoginProviderOptions(this.runtime, "oauth").find((option) => option.id === providerId);
        if (provider === undefined)
            throw new Error(`OAuth provider not found: ${providerId}`);
        return provider;
    }
}
//# sourceMappingURL=authService.js.map