export function getLoginProviderOptions(runtime, authType) {
    const providers = runtime.getProviders();
    const options = [];
    for (const provider of providers) {
        if (provider.auth.oauth === undefined)
            continue;
        options.push({
            id: provider.id,
            name: provider.name,
            authType: "oauth",
            status: truthfulProviderStatus(runtime, provider.id),
        });
    }
    for (const provider of providers) {
        if (provider.auth.apiKey?.login === undefined)
            continue;
        options.push({
            id: provider.id,
            name: provider.name,
            authType: "api_key",
            status: truthfulProviderStatus(runtime, provider.id),
            loginFlow: "interactive",
        });
    }
    return filterAndSort(options, authType);
}
export async function getLogoutProviderOptions(runtime) {
    const providerNames = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));
    const options = [];
    for (const credential of await runtime.listCredentials()) {
        options.push({
            id: credential.providerId,
            name: providerNames.get(credential.providerId) ?? credential.providerId,
            authType: credential.type,
            status: truthfulProviderStatus(runtime, credential.providerId),
        });
    }
    return filterAndSort(options);
}
function truthfulProviderStatus(runtime, providerId) {
    const reported = runtime.getProviderAuthStatus(providerId);
    // ModelRuntime reports any stored entry as configured before checking whether
    // the provider can resolve all required credential and ambient fields.
    return reported.configured && !runtime.hasConfiguredAuth(providerId) ? { configured: false } : reported;
}
function filterAndSort(options, authType) {
    const filtered = authType === undefined ? options : options.filter((option) => option.authType === authType);
    return filtered.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType) || a.id.localeCompare(b.id));
}
//# sourceMappingURL=authProviderOptions.js.map