/**
 * Serves the same snapshot the realtime socket delivers, for the browser's
 * explicit refresh paths and for the federated HTTP route.
 */
export function registerMachineStatusRoutes(app, status, prefix = "") {
    app.get(`${prefix}/status`, () => status.snapshot());
}
//# sourceMappingURL=machineStatusRoutes.js.map