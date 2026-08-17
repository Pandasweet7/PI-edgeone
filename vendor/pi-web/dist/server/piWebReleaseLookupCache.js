const DEFAULT_PI_WEB_RELEASE_LOOKUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export function createPiWebReleaseLookupCache(load, options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_PI_WEB_RELEASE_LOOKUP_CACHE_TTL_MS;
    const now = options.now ?? Date.now;
    let cached;
    let pending;
    let loadSequence = 0;
    return {
        get(currentVersion, lookupOptions = {}) {
            const force = lookupOptions.force === true;
            if (pending?.force === true)
                return pending.promise;
            const checkedAtMs = now();
            if (!force && cached !== undefined && checkedAtMs - cached.checkedAtMs < ttlMs)
                return Promise.resolve(cached);
            if (!force && pending !== undefined)
                return pending.promise;
            const sequence = ++loadSequence;
            const promise = Promise.resolve()
                .then(() => load(currentVersion))
                .then((latestVersion) => ({ checkedAtMs, latestVersion }))
                .catch((error) => ({ checkedAtMs, error: error instanceof Error ? error.message : String(error) }))
                .then((lookup) => {
                if (sequence === loadSequence)
                    cached = lookup;
                return lookup;
            })
                .finally(() => {
                if (pending?.sequence === sequence)
                    pending = undefined;
            });
            pending = { promise, force, sequence };
            return promise;
        },
    };
}
//# sourceMappingURL=piWebReleaseLookupCache.js.map