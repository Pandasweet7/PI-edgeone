import { isHostAbsoluteAgentDir } from "../config.js";
import { ACTIVE_AGENT_PROFILE_SCHEMA_VERSION } from "../shared/activeAgentProfile.js";
export function createActiveAgentProfileDescriptor(agent) {
    if (!isHostAbsoluteAgentDir(agent.dir)) {
        throw new Error("Active agent profile directory must be valid for this host");
    }
    return Object.freeze({
        schemaVersion: ACTIVE_AGENT_PROFILE_SCHEMA_VERSION,
        dir: agent.dir,
    });
}
//# sourceMappingURL=activeAgentProfile.js.map