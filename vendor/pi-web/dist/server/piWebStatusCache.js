const DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS = 60_000;
export function createPiWebStatusCache(load, options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS;
    const now = options.now ?? Date.now;
    let cached;
    let pending;
    let loadSequence = 0;
    const refresh = (refreshOptions = {}) => {
        const force = refreshOptions.force === true;
        if (pending !== undefined && (!force || pending.force))
            return pending.promise;
        const sequence = ++loadSequence;
        const promise = Promise.resolve()
            .then(() => load({ force }))
            .then((status) => {
            if (sequence === loadSequence)
                cached = { status, expiresAt: now() + ttlMs };
            return status;
        })
            .finally(() => {
            if (pending?.sequence === sequence)
                pending = undefined;
        });
        pending = { promise, force, sequence };
        return promise;
    };
    return {
        async get() {
            if (cached !== undefined) {
                if (cached.expiresAt > now())
                    return cached.status;
                void refresh().catch((error) => { options.onError?.(error); });
                return cached.status;
            }
            return refresh();
        },
        refresh,
        invalidate() {
            cached = undefined;
            loadSequence += 1;
            pending = undefined;
        },
    };
}
//# sourceMappingURL=piWebStatusCache.js.map