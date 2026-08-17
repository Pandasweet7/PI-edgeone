export function registerAuthRoutes(app, auth, prefix = "") {
    app.get(`${prefix}/auth/providers`, async (request, reply) => {
        try {
            return await auth.authProviders(request.query.mode ?? "login", request.query.authType);
        }
        catch (error) {
            return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/auth/api-key/interactive`, async (request, reply) => {
        try {
            return await auth.startApiKeyLogin(request.body.providerId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/auth/logout`, async (request, reply) => {
        try {
            return await auth.logoutProvider(request.body.providerId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/auth/oauth`, async (request, reply) => {
        try {
            return await auth.startOAuthLogin(request.body.providerId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get(`${prefix}/auth/oauth/:flowId`, async (request, reply) => {
        try {
            return auth.oauthFlow(request.params.flowId);
        }
        catch (error) {
            return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/auth/oauth/:flowId/respond`, async (request, reply) => {
        try {
            return auth.respondToOAuthFlow(request.params.flowId, request.body.requestId, request.body.value);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post(`${prefix}/auth/oauth/:flowId/cancel`, async (request, reply) => {
        try {
            return auth.cancelOAuthFlow(request.params.flowId);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
}
//# sourceMappingURL=authRoutes.js.map