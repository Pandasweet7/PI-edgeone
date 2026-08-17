import { getSessionDaemonActiveAgentProfile, } from "../sessiond/sessionDaemonClient.js";
/** Reads the daemon-owned profile on every call so a new sessiond epoch is observed. */
export class SessionDaemonActiveAgentProfileProvider {
    constructor(daemon) {
        this.daemon = daemon;
    }
    getActiveAgentProfile() {
        return getSessionDaemonActiveAgentProfile(this.daemon);
    }
}
export class ActiveAgentProfileAccessError extends Error {
    constructor(result) {
        const label = result.status === "unavailable" ? "unavailable" : "invalid";
        super(`Active agent profile is ${label}: ${result.error}`);
        this.name = "ActiveAgentProfileAccessError";
        this.profileStatus = result.status;
    }
}
export async function requireActiveAgentProfile(provider) {
    const result = await provider.getActiveAgentProfile();
    if (result.status !== "available")
        throw new ActiveAgentProfileAccessError(result);
    return result.profile;
}
//# sourceMappingURL=activeAgentProfileProvider.js.map