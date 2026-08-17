import { createDevelopmentNativeServicePlan, nativeServicePrerequisiteNeedsPathAdvice, resolveProductionNativeServicePlan, validateNativeServicePlan, } from "./servicePlan.js";
export function nativeServiceInstallFailureNeedsPathAdvice(failure) {
    if (failure.kind === "plan-resolution") {
        return failure.failures.every((item) => item.kind === "executable-unavailable")
            && failure.failures.length > 0;
    }
    return failure.failures.some((item) => item.kind === "prerequisite-unsatisfied"
        && nativeServicePrerequisiteNeedsPathAdvice(item.prerequisite));
}
/**
 * Keeps preflight effects ahead of durable install effects. The authoritative
 * probes may create bounded temporary artifacts, but they must clean those up
 * before this function writes config or replaces existing services.
 */
export async function installNativeServiceCandidate(candidate, dependencies) {
    let plan;
    if (candidate.mode === "production") {
        const resolution = await resolveProductionNativeServicePlan(candidate.input, dependencies);
        if (!resolution.ok) {
            return { ok: false, failure: { kind: "plan-resolution", failures: resolution.failures } };
        }
        plan = resolution.plan;
    }
    else {
        plan = createDevelopmentNativeServicePlan(candidate.input);
    }
    const validation = await validateNativeServicePlan(plan, dependencies.probe);
    if (!validation.ok) {
        return { ok: false, failure: { kind: "plan-validation", failures: validation.failures } };
    }
    await dependencies.writeInitialConfig();
    await dependencies.replaceServices(plan);
    return { ok: true, plan };
}
//# sourceMappingURL=serviceInstall.js.map