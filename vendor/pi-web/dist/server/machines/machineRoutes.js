import { MachineService } from "./machineService.js";
export function registerMachineRoutes(app, machines = new MachineService()) {
    app.get("/api/machines", async () => ({ machines: await machines.list() }));
    app.post("/api/machines", async (request, reply) => {
        try {
            return await machines.add(request.body);
        }
        catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });
    app.get("/api/machines/:machineId/health", async (request, reply) => {
        const health = await machines.health(request.params.machineId);
        if (health === undefined)
            return reply.code(404).send({ error: "Machine not found" });
        return health;
    });
    app.get("/api/machines/:machineId/runtime", async (request, reply) => {
        const runtime = await machines.runtime(request.params.machineId, request.query.refresh === "1");
        if (runtime === undefined)
            return reply.code(404).send({ error: "Machine not found" });
        return runtime;
    });
    app.get("/api/machines/:machineId", async (request, reply) => {
        const machine = await machines.get(request.params.machineId);
        if (machine === undefined)
            return reply.code(404).send({ error: "Machine not found" });
        return machine;
    });
    app.patch("/api/machines/:machineId", async (request, reply) => {
        try {
            const machine = await machines.update(request.params.machineId, request.body);
            if (machine === undefined)
                return await reply.code(404).send({ error: "Machine not found" });
            return machine;
        }
        catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });
    app.delete("/api/machines/:machineId", async (request, reply) => {
        try {
            const removed = await machines.remove(request.params.machineId);
            if (!removed)
                return await reply.code(404).send({ error: "Machine not found" });
            return { deleted: true };
        }
        catch (error) {
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=machineRoutes.js.map