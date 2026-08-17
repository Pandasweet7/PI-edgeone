import { statSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createEditToolDefinition, defineTool, hasTrustRequiringProjectResources, ProjectTrustStore, readStoredCredential, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { projectBrowserMessage } from "../browserMessageProjection.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import { projectSessionTree } from "./sessionTreeProjection.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";
import { findArchiveCandidateByIdOrPrefix, planSessionArchiveTree } from "./sessionArchiveTree.js";
import { deterministicSessionName, fallbackSessionName, generateShortSessionName } from "./sessionNameGenerator.js";
import { computeEditPreview } from "./editPreview.js";
import { attachmentsToInlineImages, saveAttachmentsToWorkspace } from "./attachmentService.js";
import { parsePromptAttachments } from "../../shared/promptAttachments.js";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH, SESSION_UNREAD_LIMIT } from "../../shared/apiTypes.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { PendingAskStore, renderAskUserAnswersText } from "./pendingAskStore.js";
import { PendingExtensionDialogStore } from "./pendingExtensionDialogStore.js";
import { ExtensionDialogWaiters, effectiveExtensionDialogTimeoutMs, extensionDialogCancelValue } from "./extensionDialogWaiters.js";
import { DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS } from "../../config.js";
import { createSpawnSessionToolDefinition } from "./spawnSessionTool.js";
import { createSubsessionToolDefinitions } from "./spawnSubsessionTool.js";
import { buildTranscriptView } from "./subsessionTranscript.js";
import { planSessionCleanup, summarizeSessionCleanupExecution } from "./sessionCleanup.js";
import { SessionNotificationStore, } from "./sessionNotificationStore.js";
import { plainTextTheme } from "./plainTextTheme.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";
const noopLogger = { info() { } };
const DEFAULT_UNREAD_PUBLICATION_RETRY_MS = 1_000;
/**
 * User-facing names for the two phases of session startup PI WEB can prove it
 * is inside: it awaits exactly one call for each, so the phase is a fact rather
 * than a guess. Deliberately free of internal symbol names and file paths.
 */
const STARTUP_PHASE_RUNTIME = "Starting the Pi session";
const STARTUP_PHASE_EXTENSIONS = "Loading session extensions";
/**
 * Appended to whichever phase is running when a background provider catalog
 * refresh happens to be in flight. It is stated as a concurrent fact, never as
 * the cause: PI WEB can verify that a refresh is running, but not that this
 * particular startup is waiting on it.
 */
const STARTUP_CONCURRENT_CATALOG_REFRESH = "provider model lists are refreshing";
const MAX_UNREAD_PUBLICATION_RETRY_MS = 30_000;
const MAX_PENDING_UNREAD_MUTATIONS = SESSION_UNREAD_LIMIT + 1;
function noop() {
    // Intentionally empty default unsubscribe callback.
}
function spawnTargetError(decision) {
    if (decision.reason === "not-registered")
        return new Error("Spawning session is not in a registered project");
    return new Error(`cwd must be a workspace of this project. Allowed: ${decision.allowedCwds.join(", ")}`);
}
/**
 * Tracked subsessions are worktree-scoped, so a requested target other than the
 * parent's own cwd fails closed instead of being silently retargeted. The
 * message names the rule and both supported ways to get work done elsewhere.
 */
function subsessionCwdError(spawningCwd, requestedCwd) {
    return new Error(`A tracked subsession runs in this session's working directory (${spawningCwd}); ${requestedCwd} was requested. Instruct the child to work elsewhere from this workspace, or use spawn_session for an independent session in another workspace.`);
}
function modelSpecOf(model) {
    return `${model.provider}/${model.id}`;
}
/**
 * Parse a strict `provider/model-id` spec: split on the first `/` (model ids
 * may themselves contain `/`) and require both parts to be non-empty.
 */
function parseModelSpec(spec) {
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1)
        return undefined;
    return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}
/**
 * Error for a spawn-tool model spec that matched nothing. States the facts —
 * the bad spec and the required format — with deliberately no model list
 * (a list would invite guesses). The agent loop turns the throw into an
 * error tool result; how to recover is the agent's call.
 */
function unknownSpawnModelError(modelSpec) {
    return new Error(`Unknown model "${modelSpec}". Pass an exact "provider/model-id".`);
}
function authLossWarningKey(sessionId, provider, modelId) {
    return `${sessionId}:${provider}/${modelId}`;
}
function refMatchesActiveSession(ref, active) {
    return cwdPathsEqual(active.runtime.cwd, ref.cwd);
}
function refMatchesStartupSession(ref, session) {
    return cwdPathsEqual(session.sessionManager.getCwd(), ref.cwd);
}
function sessionTreeNavigationOptions(request) {
    switch (request.summary.mode) {
        case "none":
            return { summarize: false };
        case "default":
            return { summarize: true };
        case "custom": {
            const customInstructions = request.summary.instructions.trim();
            if (customInstructions === "")
                throw new Error("Custom branch-summary instructions are required");
            if (customInstructions.length > SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
                throw new Error(`Custom branch-summary instructions must be at most ${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)} characters`);
            }
            return { summarize: true, customInstructions };
        }
    }
}
function decrementWeakCount(counts, key) {
    const remaining = (counts.get(key) ?? 1) - 1;
    if (remaining <= 0)
        counts.delete(key);
    else
        counts.set(key, remaining);
}
function decrementMapCount(counts, key) {
    const remaining = (counts.get(key) ?? 1) - 1;
    if (remaining <= 0)
        counts.delete(key);
    else
        counts.set(key, remaining);
}
function requirePromptText(value) {
    if (typeof value !== "string")
        throw new Error("Prompt text is required");
    return value;
}
function parsePromptStreamingBehavior(value) {
    if (value === undefined)
        return undefined;
    if (value === "steer" || value === "followUp")
        return value;
    throw new Error('Prompt streamingBehavior must be "steer" or "followUp"');
}
const CLEAR_RUNTIME_NOTIFICATIONS = { kind: "clear", reason: "runtime-close" };
const DEFER_RUNTIME_NOTIFICATIONS = { kind: "defer" };
function resourceDiagnosticToWarning(diagnostic, source) {
    return {
        severity: diagnostic.type === "error" ? "error" : "warning",
        message: diagnostic.message,
        source,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    };
}
function runtimeDiagnosticToWarning(diagnostic) {
    return { severity: diagnostic.type, message: diagnostic.message, source: "runtime" };
}
/**
 * Compute the live warnings for a runtime by re-reading its current resource
 * loader diagnostics, extension load errors, and runtime setup diagnostics.
 *
 * This mimics the TUI recomputing warnings on every (re)bind: it reads the
 * runtime's current state rather than a cached snapshot, so a rebuilt runtime
 * yields fresh warnings. Runtimes without SDK services (e.g. test fakes)
 * contribute no warnings.
 */
export function collectRuntimeWarnings(runtime) {
    const warnings = [];
    for (const diagnostic of runtime.diagnostics ?? [])
        warnings.push(runtimeDiagnosticToWarning(diagnostic));
    const resourceLoader = runtime.services?.resourceLoader;
    if (resourceLoader !== undefined) {
        for (const diagnostic of resourceLoader.getSkills().diagnostics)
            warnings.push(resourceDiagnosticToWarning(diagnostic, "skill"));
        for (const diagnostic of resourceLoader.getPrompts().diagnostics)
            warnings.push(resourceDiagnosticToWarning(diagnostic, "prompt"));
        for (const diagnostic of resourceLoader.getThemes().diagnostics)
            warnings.push(resourceDiagnosticToWarning(diagnostic, "theme"));
        for (const error of resourceLoader.getExtensions().errors) {
            warnings.push({ severity: "error", message: `${error.path}: ${error.error}`, source: "extension", path: error.path });
        }
    }
    return warnings;
}
/**
 * Verbatim TUI wording for the Anthropic subscription-auth billing notice. Kept
 * character-for-character in sync with `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` in
 * the SDK's interactive mode so the browser shows the same message the TUI does.
 */
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING = "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";
/** Mirror of the SDK TUI `isAnthropicSubscriptionAuthKey` (subscription API keys start with `sk-ant-oat`). */
function isAnthropicSubscriptionAuthKey(apiKey) {
    return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}
/**
 * Dismiss id for the Anthropic subscription-auth billing notice. This is `pi`'s
 * own `WarningSettings` key verbatim (`anthropicExtraUsage`): we carry the
 * coupling `pi` already defines rather than inventing a parallel vocabulary, and
 * {@link dismissSessionWarning} maps it back to `setWarnings`.
 */
const ANTHROPIC_EXTRA_USAGE_DISMISS_ID = "anthropicExtraUsage";
/**
 * Port of the TUI `maybeWarnAboutAnthropicSubscriptionAuth` gate/trigger, computed
 * live from the session's current model, stored Anthropic credential, and warning
 * settings. Returns the billing warning when the active provider is `anthropic`
 * and auth is a subscription credential (stored `oauth`, or an `sk-ant-oat` API
 * key), unless suppressed via `getWarnings().anthropicExtraUsage === false`.
 *
 * The stored credential is read synchronously (matching the TUI's `oauth` branch
 * and the documented `sk-ant-oat` key trigger) so warnings stay part of the
 * synchronous live status computation.
 */
export function anthropicSubscriptionWarning(session, authPath) {
    if (session.settingsManager.getWarnings().anthropicExtraUsage === false)
        return undefined;
    if (session.model?.provider !== "anthropic")
        return undefined;
    const credential = readStoredCredential("anthropic", authPath);
    if (credential === undefined)
        return undefined;
    const isSubscriptionAuth = credential.type === "oauth"
        ? true
        : isAnthropicSubscriptionAuthKey(credential.key);
    if (!isSubscriptionAuth)
        return undefined;
    return {
        severity: "warning",
        message: ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
        source: "anthropic",
        dismiss: { id: ANTHROPIC_EXTRA_USAGE_DISMISS_ID },
    };
}
/**
 * Durably suppress a dismissable session warning by mapping its opaque dismiss
 * id back to the concrete `pi` suppression it represents. Only known ids are
 * honored; unknown ids throw so a stale/forged client cannot silently no-op.
 *
 * This is the single place provider-specific suppression lives: the wire type,
 * parser, and UI stay agnostic. Adding a future dismissable warning is a
 * server-only change here plus a `dismiss` id on its producer.
 */
export function dismissSessionWarning(session, dismissId) {
    if (dismissId !== ANTHROPIC_EXTRA_USAGE_DISMISS_ID) {
        throw new Error(`Unknown session warning dismiss id: ${dismissId}`);
    }
    session.settingsManager.setWarnings({ ...session.settingsManager.getWarnings(), anthropicExtraUsage: false });
}
function defaultCreateAgentRuntime(createRuntime, options) {
    if (!(options.sessionManager instanceof SessionManager))
        throw new Error("Default runtime creation requires an SDK SessionManager");
    const runtimeFactory = createRuntimeWithOneShotSessionOptions(createRuntime, options.initialModel, options.initialThinkingLevel, options.delegationToolsEnabled);
    return createAgentSessionRuntime(runtimeFactory, {
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager: options.sessionManager,
    });
}
function createRuntimeWithOneShotSessionOptions(createRuntime, initialModel, initialThinkingLevel, delegationToolsEnabled) {
    // These inputs belong only to the session being opened. A later runtime
    // replacement resolves its own model and delegation capability, and restores
    // the thinking level from the existing session file.
    let pendingInitialModel = initialModel;
    let pendingInitialThinkingLevel = initialThinkingLevel;
    let pendingDelegationToolsEnabled = delegationToolsEnabled;
    return async (options) => {
        const model = pendingInitialModel;
        const thinkingLevel = pendingInitialThinkingLevel;
        const toolsEnabled = pendingDelegationToolsEnabled;
        pendingInitialModel = undefined;
        pendingInitialThinkingLevel = undefined;
        pendingDelegationToolsEnabled = undefined;
        return createRuntime({
            ...options,
            ...(model === undefined ? {} : { initialModel: model }),
            ...(thinkingLevel === undefined ? {} : { initialThinkingLevel: thinkingLevel }),
            ...(toolsEnabled === undefined ? {} : { delegationToolsEnabled: toolsEnabled }),
        });
    };
}
export function createPiWebCustomToolDefinitions(cwd, delegationEnabled, spawn, subsessions, askUser) {
    return [
        createPiWebEditToolDefinition(cwd),
        ...(delegationEnabled && spawn !== undefined ? [createSpawnSessionToolDefinition(cwd, { spawn })] : []),
        ...(delegationEnabled && subsessions !== undefined ? createSubsessionToolDefinitions(cwd, subsessions) : []),
        // Asking the user is not delegation: the questions land in the session the
        // user is already watching, so tracked children may ask too.
        ...(askUser === undefined ? [] : [createAskUserToolDefinition(askUser)]),
    ];
}
/**
 * Run the `project_trust` event over a pre-trust extension set, mirroring
 * `emitProjectTrustEvent` in the SDK's `dist/core/extensions/runner.js`. That
 * helper is not part of the package's public exports (the main index exports
 * only the `ProjectTrust*` types and `ProjectTrustStore`, and the package's
 * `exports` map blocks subpath imports, so `resolveProjectTrusted`/
 * `emitProjectTrustEvent` are not callable from here), so PI WEB reimplements
 * its documented decision loop over the SDK-provided extension objects: per
 * extension, the registered `project_trust` handlers run in order; the first
 * handler returning `yes`/`no` decides and `undecided` falls through to the
 * next handler/extension; a throwing handler is collected as an error and
 * later handlers still get their chance.
 */
export async function emitWebProjectTrustEvent(extensionsResult, event, ctx) {
    const errors = [];
    for (const extension of extensionsResult.extensions) {
        // A single extension may register multiple handlers for the same event.
        // The handlers map is keyed exactly as the extension registered it, so a
        // `project_trust` key guarantees `ProjectTrustHandler` entries — the same
        // assumption the SDK's emitProjectTrustEvent makes.
        const handlers = extension.handlers.get("project_trust");
        if (handlers === undefined || handlers.length === 0)
            continue;
        for (const handler of handlers) {
            try {
                const handlerResult = await handler(event, ctx);
                // The SDK reads `trusted` straight off the handler result, so a
                // non-object would throw there; PI WEB reports it as a handler error
                // and lets the next handler/extension try.
                if (typeof handlerResult !== "object" || handlerResult === null) {
                    errors.push({ extensionPath: extension.path, error: "project_trust handler returned a non-object result" });
                    continue;
                }
                const trusted = "trusted" in handlerResult ? handlerResult.trusted : undefined;
                if (trusted === "undecided") {
                    continue;
                }
                // Rebuild the decision so only the documented `trusted`/`remember`
                // fields carry over — the SDK's resolver reads exactly those two.
                const remember = "remember" in handlerResult ? handlerResult.remember : undefined;
                return {
                    result: {
                        trusted: trusted === "yes" ? "yes" : "no",
                        ...(remember === true ? { remember: true } : {}),
                    },
                    errors,
                };
            }
            catch (error) {
                errors.push({
                    extensionPath: extension.path,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return { errors };
}
/**
 * PI WEB's headless project-trust context. `hasUI` is false because there is
 * no browser trust prompt (chartered behavior: `ask` never loads untrusted
 * resources), so the UI methods are inert — the same no-UI shape the SDK
 * passes when pi runs without a trust UI. The host mode is `rpc`, mirroring
 * how PI WEB binds its session extension contexts.
 */
function webProjectTrustContext(cwd) {
    return {
        cwd,
        mode: "rpc",
        hasUI: false,
        ui: {
            select: () => Promise.resolve(undefined),
            confirm: () => Promise.resolve(false),
            input: () => Promise.resolve(undefined),
            notify: () => undefined,
        },
    };
}
/**
 * Resolve whether a workspace's project-local `.pi/` resources may load, the
 * way `pi` resolves it — a faithful mirror of the SDK's `resolveProjectTrusted`
 * (`dist/core/project-trust.js`, also not a public export). PI WEB has no
 * browser trust prompt, so the precedence is, in order:
 *
 * 1. Nothing trust-requiring under `cwd` → trusted.
 * 2. Pre-trust extensions (user/global — project-local ones are not loaded
 *    yet) may decide via the `project_trust` event; `remember: true` persists
 *    the decision to the agent dir's `trust.json`. Handler errors are reported
 *    through {@link WebProjectTrustResolution.onExtensionError} and never
 *    abort resolution.
 * 3. Otherwise the saved `trust.json` decision wins.
 * 4. Otherwise `defaultProjectTrust` decides (`always` trusts; `never`/`ask`
 *    do not — `ask` cannot prompt in the browser, matching `pi` run without a
 *    trust UI).
 */
export async function resolveWebProjectTrusted(resolution) {
    const { cwd, trustStore, settingsManager } = resolution;
    if (!hasTrustRequiringProjectResources(cwd))
        return true;
    if (resolution.extensionsResult) {
        const { result, errors } = await emitWebProjectTrustEvent(resolution.extensionsResult, { type: "project_trust", cwd }, webProjectTrustContext(cwd));
        for (const error of errors) {
            resolution.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
        }
        if (result) {
            const trusted = result.trusted === "yes";
            if (result.remember === true) {
                trustStore.set(cwd, trusted);
            }
            return trusted;
        }
    }
    const saved = trustStore.get(cwd);
    if (saved !== null)
        return saved;
    return settingsManager.getDefaultProjectTrust() === "always";
}
/**
 * Resource-loader options that append PI WEB's own system-prompt sections.
 *
 * `appendSystemPromptOverride` composes with what the loader already resolved,
 * so the operator's `SYSTEM.md` / `APPEND_SYSTEM.md` files keep their content
 * and PI WEB's sections land after them. Returns `undefined` when there is
 * nothing to add, leaving the loader exactly as pi configures it.
 */
export function piWebResourceLoaderOptions(appendSystemPromptSections) {
    if (appendSystemPromptSections.length === 0)
        return undefined;
    return { appendSystemPromptOverride: (base) => [...base, ...appendSystemPromptSections] };
}
function createDefaultRuntimeFactory(modelRuntime, sessionManagers, spawn, subsessions, askUser, appendSystemPromptSections = []) {
    const resourceLoaderOptions = piWebResourceLoaderOptions(appendSystemPromptSections);
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent, initialModel, initialThinkingLevel, delegationToolsEnabled }) => {
        // PI WEB always honors pi's project-trust model. When the workspace ships
        // trust-requiring resources, trust is resolved exactly once, mirroring the
        // SDK's flow: the resource loader first loads the pre-trust extension set
        // (user/global; project-local ones stay out) and calls back with it, so
        // those extensions may decide via the `project_trust` event; the resolved
        // value then lands in the SettingsManager before any project-local
        // resource (extensions, packages, settings, prompts) loads. With no
        // browser trust prompt, an untrusted project's resources are skipped
        // (matching `pi` run without a UI). Projects without trust-requiring
        // resources skip resolution entirely and are trusted, as before.
        const projectTrustRequiring = hasTrustRequiringProjectResources(cwd);
        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: !projectTrustRequiring });
        // Pre-session-creation trust failures (`project_trust` handler errors)
        // land in the runtime diagnostics next to the services diagnostics,
        // exactly as the CLI appends its project-trust diagnostics.
        const projectTrustDiagnostics = [];
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime,
            settingsManager,
            ...(resourceLoaderOptions === undefined ? {} : { resourceLoaderOptions }),
            ...(projectTrustRequiring
                ? {
                    resourceLoaderReloadOptions: {
                        resolveProjectTrust: async ({ extensionsResult }) => resolveWebProjectTrusted({
                            cwd,
                            trustStore: new ProjectTrustStore(agentDir),
                            settingsManager,
                            extensionsResult,
                            onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
                        }),
                    },
                }
                : {}),
        });
        const resolvedDelegationToolsEnabled = delegationToolsEnabled
            ?? await sessionAllowsDelegationTools(sessionManager, sessionManagers);
        const customTools = createPiWebCustomToolDefinitions(cwd, resolvedDelegationToolsEnabled, spawn, subsessions, askUser);
        const result = await createAgentSessionFromServices({
            services,
            sessionManager,
            customTools,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            ...(initialModel === undefined ? {} : { model: initialModel }),
            ...(initialThinkingLevel === undefined ? {} : { thinkingLevel: initialThinkingLevel }),
        });
        return { ...result, services, diagnostics: [...projectTrustDiagnostics, ...services.diagnostics] };
    };
}
function createPiWebEditToolDefinition(cwd) {
    const editTool = createEditToolDefinition(cwd);
    return defineTool({
        name: editTool.name,
        label: editTool.label,
        description: editTool.description,
        ...(editTool.promptSnippet === undefined ? {} : { promptSnippet: editTool.promptSnippet }),
        ...(editTool.promptGuidelines === undefined ? {} : { promptGuidelines: editTool.promptGuidelines }),
        parameters: editTool.parameters,
        ...(editTool.renderShell === undefined ? {} : { renderShell: editTool.renderShell }),
        ...(editTool.prepareArguments === undefined ? {} : { prepareArguments: editTool.prepareArguments }),
        ...(editTool.executionMode === undefined ? {} : { executionMode: editTool.executionMode }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const preview = await computeEditPreview(params.path, params.edits, cwd);
            if (signal?.aborted !== true) {
                onUpdate?.({ content: [{ type: "text", text: "Edit preview computed." }], details: { preview } });
            }
            return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    });
}
export class PiSessionService {
    constructor(events, deps) {
        this.events = events;
        this.active = new Map();
        this.pendingSessionOpens = new Map();
        /**
         * Sessions whose extension binding is still in flight. A `session_start`
         * dialog parks that window before the session ever becomes active, so this
         * is the only way the dialog answer/cancel and status paths can reach it;
         * {@link getOrOpen} never consults it, keeping every other operation gated
         * on full readiness.
         */
        this.startupSessions = new Map();
        this.activities = new Map();
        /** Runtime-identity gate held while Pi may await abandoned-branch summarization. */
        this.treeNavigations = new WeakSet();
        /** Counts async operations that may append an entry before they settle. */
        this.sessionEntryMutationCounts = new WeakMap();
        /** Runtime/session-identity reservations for operations that must not overlap tree navigation. */
        this.treeExclusiveRuntimeOperationCounts = new WeakMap();
        this.treeExclusiveSessionOperationCounts = new Map();
        this.deferredSubsessionNotifications = new WeakMap();
        this.deferredGeneratedSessionNames = new WeakMap();
        this.compactionPromptQueues = new Map();
        this.compactionDrainTimers = new Map();
        this.authLossWarnings = new Set();
        /** Tracked subsession id -> the parent session id that spawned it. */
        this.subsessionParents = new Map();
        /** Parent session id -> the set of tracked subsession ids it spawned. */
        this.subsessionChildren = new Map();
        /** Tracked subsession id -> persisted recovery details for the child. */
        this.subsessionLinks = new Map();
        /** Parent id/file identities whose persisted links have already been loaded. */
        this.subsessionHydratedParents = new Set();
        /**
         * Tracked subsession id -> whether a completion notification is armed.
         * Armed when the child starts working; firing on completion disarms it so a
         * child that works again (and stops again) notifies the parent each time.
         */
        this.subsessionNotifyArmed = new Map();
        this.notificationGenerationBySession = new WeakMap();
        /** The parked extension Promise resolvers behind the store's open dialogs. */
        this.dialogWaiters = new ExtensionDialogWaiters();
        this.pendingUnreadMutations = [];
        this.unreadPublicationFlushRequested = false;
        this.unreadPublicationStopped = false;
        this.archiveStore = deps.archiveStore ?? new SessionArchiveStore();
        this.agentDir = deps.agentDir;
        this.sessionManager = deps.sessionManager;
        this.modelRuntime = deps.modelRuntime;
        this.spawnTargets = deps.spawnTargets;
        this.logger = deps.logger ?? noopLogger;
        this.now = deps.now ?? (() => new Date());
        this.notificationStore = deps.notificationStore ?? new SessionNotificationStore();
        this.unreadStore = deps.unreadStore ?? new SessionUnreadStore();
        this.onUnreadChanged = deps.onUnreadChanged;
        this.pendingAskStore = deps.pendingAskStore ?? new PendingAskStore();
        this.pendingExtensionDialogStore = deps.pendingExtensionDialogStore ?? new PendingExtensionDialogStore();
        this.extensionDialogsTimeoutMs = deps.extensionDialogsTimeoutMs ?? DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS;
        this.catalogRefreshStatus = deps.catalogRefreshStatus;
        this.unreadPublicationRetryInitialMs = Math.max(0, deps.unreadPublicationRetryDelayMs ?? DEFAULT_UNREAD_PUBLICATION_RETRY_MS);
        this.unreadPublicationRetryDelayMs = this.unreadPublicationRetryInitialMs;
        // Subsessions are gated behind their own flag, and they
        // also require the spawn capability (they share its project-scope resolver).
        const subsessionsActive = this.spawnTargets !== undefined && deps.subsessionsEnabled === true;
        this.createRuntime = deps.createRuntime ?? createDefaultRuntimeFactory(this.modelRuntime, this.sessionManager, this.spawnTargets === undefined ? undefined : (input) => this.spawnSession(input), !subsessionsActive ? undefined : {
            spawn: (input) => this.spawnSubsession(input),
            list: (parentSessionId, parentSessionFile) => this.listSubsessions(parentSessionId, parentSessionFile),
            check: (parentSessionId, sessionId, parentSessionFile) => this.checkSubsession(parentSessionId, sessionId, parentSessionFile),
            read: (parentSessionId, sessionId, query, parentSessionFile) => this.readSubsession(parentSessionId, sessionId, query, parentSessionFile),
        }, deps.askUserEnabled === true ? { open: (input) => this.openAsk(input) } : undefined, deps.appendSystemPromptSections ?? []);
        this.createAgentRuntime = deps.createAgentRuntime ?? defaultCreateAgentRuntime;
        this.workspaceActivity = deps.workspaceActivity;
        this.heartbeat = setInterval(() => { this.publishHeartbeats(); }, deps.heartbeatIntervalMs ?? 2000);
        this.commandService = new SessionCommandService((sessionId) => this.getActive(this.activeSessionRef(sessionId)), (sessionId, text) => this.prompt(this.activeSessionRef(sessionId), text, undefined, undefined, { echoUserMessage: false }), events, {
            onCompactionStart: (session) => {
                this.beginSessionEntryMutation(session, "compact the session");
                this.publishActivity(session, "compacting", "active");
                this.publishStatus(session);
            },
            onCompactionEnd: (session, result, detail) => {
                this.endSessionEntryMutation(session);
                this.publishActivity(session, result === "success" ? "compaction complete" : "compaction failed", result === "success" ? "idle" : "error", detail);
                this.publishStatus(session);
            },
            reloadSession: (session) => this.reloadSessionRuntime(session),
            getSessionTree: (session) => {
                if (typeof session.sessionManager.getTree !== "function" || typeof session.navigateTree !== "function")
                    return undefined;
                return projectSessionTree(session.sessionManager.getTree(), session.sessionManager.getLeafId());
            },
            hasActiveWork: (session) => this.hasActiveWork(session),
            isTreeNavigationActive: (session) => this.treeNavigations.has(session),
            runSessionReplacement: (session, operation) => this.runTreeExclusiveOperation([{ sessionId: session.sessionId, session }], "Stop current session activity before replacing the session", operation),
        }, { listSessionNames: (cwd) => this.listSessionNames(cwd) });
    }
    activeCount() {
        return this.active.size;
    }
    notificationCatalog() {
        return this.notificationStore.catalogSnapshot();
    }
    async unreadCatalog() {
        await this.publishUnreadMutations([]);
        return this.unreadStore.durableCatalogSnapshot();
    }
    async acknowledgeUnread(sessionId, request) {
        const result = this.unreadStore.acknowledge(sessionId, {
            ...request,
            cwd: canonicalizeStoredCwd(request.cwd),
        });
        await this.publishUnreadMutations(result.mutations);
        return this.unreadStore.durableCatalogSnapshot();
    }
    notificationInbox(ref) {
        return this.notificationStore.inboxSnapshot(ref.id, canonicalizeStoredCwd(ref.cwd));
    }
    dismissNotification(ref, request) {
        const result = this.notificationStore.dismissNotification(ref.id, canonicalizeStoredCwd(ref.cwd), request.daemonInstanceId, request.notificationId);
        this.publishNotificationMutations(result.mutations);
        return result.snapshot;
    }
    dismissAllNotifications(ref, request) {
        const result = this.notificationStore.dismissAll(ref.id, canonicalizeStoredCwd(ref.cwd), request.daemonInstanceId, request.throughOrder, request.throughOverflowWatermark);
        this.publishNotificationMutations(result.mutations);
        return result.snapshot;
    }
    async cleanupPreview(request) {
        return previewResponseFromPlan(await this.cleanupPlan(request));
    }
    async cleanup(request) {
        const plan = await this.cleanupPlan(request);
        if (plan.deleteRecords.length > 0 && this.archiveStore.deleteArchived === undefined && this.archiveStore.deleteArchivedMany === undefined)
            throw new Error("Archive store does not support deletion");
        const archiveInputs = [];
        const readyArchiveInputs = [];
        const deleteRecords = [];
        const readyDeleteRecords = [];
        const skippedBusySessionIds = new Set(plan.skippedBusySessionIds);
        for (const input of plan.archiveInputs) {
            if (this.activeSessionHasWork(input.sessionId)) {
                skippedBusySessionIds.add(input.sessionId);
                continue;
            }
            await this.closeActive(input.sessionId, { kind: "clear", reason: "archive" });
            readyArchiveInputs.push(input);
        }
        await this.archiveStoreArchiveMany(readyArchiveInputs);
        archiveInputs.push(...readyArchiveInputs);
        await this.forgetUnreadSessions(readyArchiveInputs);
        for (const record of plan.deleteRecords) {
            if (this.activeSessionHasWork(record.sessionId)) {
                skippedBusySessionIds.add(record.sessionId);
                continue;
            }
            await this.closeActive(record.sessionId, { kind: "clear", reason: "delete" });
            readyDeleteRecords.push(record);
        }
        const deletedSessionIds = new Set(await this.archiveStoreDeleteArchivedMany(readyDeleteRecords.map((record) => record.sessionId)));
        deleteRecords.push(...readyDeleteRecords.filter((record) => deletedSessionIds.has(record.sessionId)));
        await this.forgetUnreadSessions(deleteRecords);
        return summarizeSessionCleanupExecution({
            archiveInputs,
            deleteRecords,
            thresholds: plan.thresholds,
            generatedAt: plan.generatedAt,
            skippedBusySessionIds: [...skippedBusySessionIds],
        });
    }
    async dispose() {
        this.unreadPublicationStopped = true;
        this.clearUnreadPublicationRetry();
        clearInterval(this.heartbeat);
        this.clearCompactionDrainTimers();
        // Same startup-park hazard as closeActive(): settle `session_start` dialogs
        // of sessions still binding extensions before awaiting their pending opens.
        for (const sessionId of this.startupSessions.keys())
            this.endSessionExtensionDialogs(sessionId);
        const pendingOpens = this.pendingSessionOpenPromises();
        if (pendingOpens.length > 0)
            await Promise.allSettled(pendingOpens);
        const activeSessions = Array.from(new Set(this.active.values()));
        for (const active of activeSessions) {
            this.forgetUnreadActivity(active.runtime.session);
            this.pendingAskStore.forgetSession(active.runtime.session.sessionId);
            this.endSessionExtensionDialogs(active.runtime.session.sessionId);
        }
        this.active.clear();
        this.pendingSessionOpens.clear();
        this.startupSessions.clear();
        this.activities.clear();
        this.compactionPromptQueues.clear();
        this.authLossWarnings.clear();
        this.subsessionParents.clear();
        this.subsessionChildren.clear();
        this.subsessionLinks.clear();
        this.subsessionHydratedParents.clear();
        this.subsessionNotifyArmed.clear();
        this.notificationStore.clearAll("service-dispose");
        await Promise.all(activeSessions.map(async (active) => {
            active.unsubscribe();
            active.runtime.setRebindSession(undefined);
            this.workspaceActivity?.removeSession(active.runtime.session.sessionId, active.runtime.session.sessionManager.getCwd());
            try {
                await this.abortSessionOperations(active.runtime.session);
            }
            finally {
                await active.runtime.dispose();
            }
        }));
        await this.publishUnreadMutations([]);
    }
    async list(cwd) {
        const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
        const sessionsById = new Map(sessions.map((session) => [session.id, session]));
        const archivedForCwd = archivedRecords.filter((record) => record.cwd === cwd);
        const archivedById = new Map(archivedForCwd.map((record) => [record.sessionId, record]));
        for (const record of archivedForCwd) {
            this.publishNotificationMutations(this.notificationStore.clearSession(record.sessionId, "archive-reconcile"));
        }
        const unarchivedSessions = sessions.filter((session) => !archivedById.has(session.id)).map(clientSessionFromListEntry);
        const reconcilableSessionIds = this.reconcilableSessionIds(cwd, unarchivedSessions.map((session) => session.id), archivedById);
        this.workspaceActivity?.reconcileSessionActivity(cwd, reconcilableSessionIds);
        await this.publishUnreadMutations(this.unreadStore.reconcileCwd(canonicalizeStoredCwd(cwd), reconcilableSessionIds));
        const archivedSessions = archivedForCwd
            .sort(compareArchivedRecords)
            .map((record) => clientSessionFromArchivedRecord(record, sessionsById.get(record.sessionId)))
            .filter(isDefined);
        return [...unarchivedSessions, ...archivedSessions];
    }
    async start(cwd, options = {}) {
        return this.startSession(cwd, options);
    }
    async startSession(cwd, options) {
        const active = await this.create(this.sessionManager.create(cwd, options.parentSession === undefined ? undefined : { parentSession: options.parentSession }), cwd, {
            startupIntent: "create",
            ...(options.startupToken === undefined ? {} : { startupToken: options.startupToken }),
            ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
            ...(options.initialThinkingLevel === undefined ? {} : { initialThinkingLevel: options.initialThinkingLevel }),
            ...(options.creationProvenance === undefined ? {} : { creationProvenance: options.creationProvenance }),
        });
        const { session } = active.runtime;
        const created = {
            id: session.sessionId,
            path: session.sessionFile ?? "",
            cwd,
            persisted: sessionFileExists(session.sessionFile),
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: session.messages.length,
            firstMessage: "",
            // Include the parent so listeners can nest the new session in the tree
            // immediately, instead of showing it flat until the next reload.
            ...(options.parentSession === undefined ? {} : { parentSessionPath: options.parentSession }),
        };
        // Broadcast so other clients (and the spawning agent's UI) can add the new
        // session to their list without a manual reload.
        this.events.publishGlobal({ type: "session.created", session: created });
        return created;
    }
    /**
     * Start a new session on behalf of a LLM and deliver an initial prompt to it.
     * The target cwd is constrained to a workspace of the same registered project
     * as the spawning session so the new session is visible in the web UI.
     */
    async spawnSession(input) {
        if (this.spawnTargets === undefined)
            throw new Error("Spawning sessions is disabled");
        const decision = await this.spawnTargets.resolveSpawnTarget(input.spawningCwd, input.cwd);
        if (!decision.allowed)
            throw spawnTargetError(decision);
        // A model spec overrides the inherited model. Only a spec resolves
        // against the spawning session; the default path must not depend on it.
        const model = input.modelSpec === undefined
            ? input.model
            : await this.resolveSpawnModel({ id: input.spawningSessionId, cwd: input.spawningCwd }, input.modelSpec);
        const created = await this.start(decision.cwd, {
            ...(model === undefined ? {} : { initialModel: model }),
            ...(input.thinkingLevel === undefined ? {} : { initialThinkingLevel: input.thinkingLevel }),
        });
        const modelUsed = this.active.get(created.id)?.runtime.session.model;
        await this.prompt(created, input.prompt);
        this.logger.info({ spawningCwd: input.spawningCwd, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length }, "spawn_session started a new session");
        return {
            sessionId: created.id,
            cwd: decision.cwd,
            ...(modelUsed === undefined ? {} : { model: modelSpecOf(modelUsed) }),
        };
    }
    /**
     * Start a *tracked* child session on behalf of a LLM. Unlike
     * {@link spawnSession}, a tracked child always runs in the parent's own
     * workspace: parent/child trees are worktree-scoped, so a child elsewhere
     * would be invisible to the parent's listing. The child records its parent
     * (so it shows in the session tree) and is registered so the parent is
     * notified when it stops working and can inspect it later.
     */
    async spawnSubsession(input) {
        if (this.spawnTargets === undefined)
            throw new Error("Spawning sessions is disabled");
        if (input.cwd !== undefined && input.cwd !== "" && !cwdPathsEqual(input.cwd, input.spawningCwd)) {
            throw subsessionCwdError(input.spawningCwd, input.cwd);
        }
        // Resolved against the parent's own cwd only: this still refuses spawning
        // from an unregistered directory, which keeps the child visible in the UI.
        const decision = await this.spawnTargets.resolveSpawnTarget(input.spawningCwd, undefined);
        if (!decision.allowed)
            throw spawnTargetError(decision);
        // A model spec overrides the inherited model and is resolved against the
        // parent's model runtime; only a spec resolves against the parent.
        const model = input.modelSpec === undefined
            ? input.model
            : await this.resolveSpawnModel({ id: input.parentSessionId, cwd: input.spawningCwd }, input.modelSpec);
        const created = await this.startSession(decision.cwd, {
            ...(input.parentSessionFile === undefined ? {} : { parentSession: input.parentSessionFile }),
            ...(model === undefined ? {} : { initialModel: model }),
            ...(input.thinkingLevel === undefined ? {} : { initialThinkingLevel: input.thinkingLevel }),
            creationProvenance: "tracked-subsession",
        });
        const modelUsed = this.active.get(created.id)?.runtime.session.model;
        const parentSessionFile = nonEmptyString(input.parentSessionFile);
        const link = {
            parentSessionId: input.parentSessionId,
            childSessionId: created.id,
            ...(created.path === "" ? {} : { childSessionFile: created.path }),
            ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
            cwd: decision.cwd,
        };
        await this.registerVerifiedSubsession(link);
        this.persistSubsessionLink(link);
        this.persistSubsessionChildMarker(input.parentSessionId, created.id);
        await this.prompt(created, input.prompt);
        this.logger.info({ parentSessionId: input.parentSessionId, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length }, "spawn_subsession started a tracked child session");
        return {
            sessionId: created.id,
            cwd: decision.cwd,
            ...(modelUsed === undefined ? {} : { model: modelSpecOf(modelUsed) }),
        };
    }
    /**
     * The models a session may pick from: its scoped set when model-scoped,
     * otherwise the runtime's available snapshot. Refreshes the runtime catalog
     * first so callers see newly configured providers and models. The refresh
     * stays local (`allowNetwork: false`); network refreshes belong to the
     * bounded background catalog refresher, not this request path.
     */
    async sessionModelCandidates(session) {
        await session.modelRuntime.refresh({ allowNetwork: false });
        return session.scopedModels.length > 0
            ? session.scopedModels.map((scoped) => scoped.model)
            : session.modelRuntime.getAvailableSnapshot();
    }
    /**
     * Resolve a strict `provider/model-id` spec from a spawn tool against the
     * *spawning* session's model runtime, using the same candidates
     * {@link setModel} offers plus a direct runtime lookup as fallback. Unknown
     * or malformed specs throw; the agent loop turns that into an error tool
     * result the spawning agent can retry from.
     */
    async resolveSpawnModel(spawningRef, modelSpec) {
        const session = await this.getOrOpen(spawningRef);
        const parsed = parseModelSpec(modelSpec);
        const candidates = await this.sessionModelCandidates(session);
        const model = parsed === undefined
            ? undefined
            : candidates.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId)
                ?? session.modelRuntime.getModel(parsed.provider, parsed.modelId);
        if (model === undefined)
            throw unknownSpawnModelError(modelSpec);
        return model;
    }
    /**
     * Register the question set an agent wants the user to answer as the session's
     * open ask. Deliberately does not wait for the user: `ask_user` terminates the
     * run and the submitted answers come back later as a follow-up message.
     *
     * Rejected question sets throw {@link PendingAskValidationError}, which the
     * agent loop reports to the model as an error tool result.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a rejected question set becomes a rejection rather than a synchronous throw from a promise-returning method.
    async openAsk(input) {
        const result = this.pendingAskStore.open(input);
        // A supersede closes the earlier ask, so the browsers watching it must hear
        // that before they hear about its replacement.
        if (result.superseded !== undefined)
            this.publishAskClosed(input.sessionId, result.superseded);
        this.events.publish(input.sessionId, { type: "ask.opened", ask: result.ask });
        this.publishStatusForSessionId(input.sessionId);
        return result;
    }
    /**
     * Record the user's answers to the session's open ask and hand them to the
     * model. The answers travel as a system-authored custom message rather than a
     * user message, so they are not attributed to the human in the transcript;
     * they still wake an idle session (`triggerTurn`) and queue behind in-flight
     * work (`deliverAs: "followUp"`), which is how the run that `ask_user`
     * terminated continues.
     */
    async submitAsk(ref, askId, submission) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        // Checked before the store closes the ask so a refused delivery cannot
        // discard answers the user already submitted.
        this.assertTreeNavigationInactive(session, "answer questions");
        return this.closeAsk(session, this.pendingAskStore.submit(session.sessionId, askId, submission));
    }
    /**
     * Close the open ask without answers. The model is still told, naming every
     * question as unanswered: it was promised a follow-up message and would
     * otherwise wait for one that never comes.
     */
    async cancelAsk(ref, askId) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.assertTreeNavigationInactive(session, "dismiss questions");
        return this.closeAsk(session, this.pendingAskStore.cancel(session.sessionId, askId));
    }
    /**
     * Publish and deliver a closed ask. A stale close is reported rather than
     * thrown: losing the race against a supersede, another browser, or a session
     * that went away is ordinary, and the returned status tells the browser what
     * the session's open ask is now.
     */
    async closeAsk(session, result) {
        if (result.status === "stale")
            return { result: "stale", sessionStatus: this.statusFromSession(session) };
        const { outcome } = result;
        this.publishAskClosed(session.sessionId, outcome);
        await this.runSessionEntryMutation(session, "deliver answers to your questions", () => session.sendCustomMessage({ customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: renderAskUserAnswersText(outcome), display: true, details: outcome }, { triggerTurn: true, deliverAs: "followUp" }));
        this.publishStatus(session);
        return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
    }
    publishAskClosed(sessionId, outcome) {
        this.events.publish(sessionId, { type: "ask.closed", askId: outcome.askId, reason: outcome.reason });
    }
    /**
     * Void the session's open ask because the user sent a chat message instead of
     * answering it. Every browser closes the card as cancelled, and the model is
     * told — without being woken — so the notice rides into the turn the message
     * itself triggers rather than becoming a turn of its own.
     */
    async voidOpenAskForUserMessage(session) {
        const outcome = this.pendingAskStore.cancelOpen(session.sessionId);
        if (outcome === undefined)
            return;
        this.publishAskClosed(session.sessionId, outcome);
        await this.runSessionEntryMutation(session, "void the open questions", () => session.sendCustomMessage({ customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: renderAskUserAnswersText(outcome), display: true, details: outcome }, { triggerTurn: false, deliverAs: "followUp" }));
        this.publishStatus(session);
    }
    /**
     * Record the user's answer to an open extension dialog and resolve the
     * extension's parked Promise with it. Unlike an ask, nothing is delivered to
     * the model: the waiter is extension code inside an already in-flight run
     * (or an idle handler), so no custom message and no turn are triggered.
     */
    async answerDialog(ref, dialogId, value) {
        await this.assertWritable(ref);
        const session = await this.sessionForStatusOrDialogClose(ref);
        const result = this.pendingExtensionDialogStore.answer(session.sessionId, dialogId, value);
        if (result.status === "stale")
            return { result: "stale", sessionStatus: this.statusFromSession(session) };
        const { outcome } = result;
        this.publishDialogClosed(session.sessionId, outcome);
        // `value` is what the store validated and recorded as the outcome's answer.
        this.dialogWaiters.settleWithAnswer(dialogId, value);
        this.publishStatus(session);
        return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
    }
    /** Close an open extension dialog without an answer; the extension's wait settles with its kind's cancel value. */
    async cancelDialog(ref, dialogId) {
        await this.assertWritable(ref);
        const session = await this.sessionForStatusOrDialogClose(ref);
        const result = this.pendingExtensionDialogStore.cancel(session.sessionId, dialogId, "cancelled");
        if (result.status === "stale")
            return { result: "stale", sessionStatus: this.statusFromSession(session) };
        const { outcome } = result;
        this.publishDialogClosed(session.sessionId, outcome);
        this.dialogWaiters.settleWithCancelValue(dialogId);
        this.publishStatus(session);
        return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
    }
    /**
     * Implement one `ctx.ui.select()`/`confirm()`/`input()` call from extension
     * code: open the store record, tell the browsers, and park a Promise that
     * settles when the browser answers or cancels, the extension's own
     * `signal`/`timeout` dismisses the dialog, the daemon default timeout
     * elapses, or the runtime goes away. `store.open` validates the dialog, so a
     * malformed one rejects the extension's call rather than rendering garbage.
     * `async` so a rejected dialog becomes a rejection rather than a synchronous
     * throw from a promise-returning method.
     */
    async openExtensionDialog(session, request, opts) {
        const signal = opts?.signal;
        // A pre-aborted signal dismisses the dialog before it ever opens.
        if (signal?.aborted === true)
            return extensionDialogCancelValue(request.kind);
        const timeoutMs = effectiveExtensionDialogTimeoutMs(opts?.timeout, this.extensionDialogsTimeoutMs);
        const dialog = this.pendingExtensionDialogStore.open({
            sessionId: session.sessionId,
            kind: request.kind,
            title: request.title,
            ...(request.message === undefined ? {} : { message: request.message }),
            ...(request.options === undefined ? {} : { options: request.options }),
            ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            runScoped: session.isStreaming,
        });
        this.events.publish(session.sessionId, { type: "dialog.opened", dialog });
        this.publishStatus(session);
        return this.dialogWaiters.park(dialog, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(signal === undefined ? {} : { signal }),
            onTrigger: (reason) => {
                if (this.closeExtensionDialogFromTrigger(session.sessionId, dialog.dialogId, reason))
                    this.publishStatusForSessionId(session.sessionId);
            },
        });
    }
    /**
     * Close a dialog whose wait ended without the browser (timeout, signal
     * abort, run end, runtime teardown) and settle its parked Promise. Returns
     * whether this call closed the dialog; a stale close means a browser answer
     * or an earlier trigger already settled everything.
     */
    closeExtensionDialogFromTrigger(sessionId, dialogId, reason) {
        const result = this.pendingExtensionDialogStore.cancel(sessionId, dialogId, reason);
        if (result.status !== "closed")
            return false;
        this.publishDialogClosed(sessionId, result.outcome);
        this.dialogWaiters.settleWithCancelValue(dialogId);
        return true;
    }
    /**
     * Settle the session's run-scoped dialogs as `"aborted"`. Runs at
     * abort-request time (a user abort parks the agent loop behind the dialog
     * handler, so `agent_end` would never arrive on its own) and again from
     * the `agent_end` observer as the run-crash backstop — the store makes the
     * second settlement a stale no-op. Idle-opened dialogs (a `session_start`
     * probe, say) are not run-scoped and survive, because their waiter
     * outlives the run.
     */
    abortRunScopedExtensionDialogs(sessionId) {
        let closedAny = false;
        for (const dialog of this.pendingExtensionDialogStore.pendingDialogs(sessionId)) {
            if (dialog.runScoped)
                closedAny = this.closeExtensionDialogFromTrigger(sessionId, dialog.dialogId, "aborted") || closedAny;
        }
        if (closedAny)
            this.publishStatusForSessionId(sessionId);
    }
    /**
     * Settle every dialog of the session as `"session-ended"`: the runtime
     * whose extension code is parked on them is being closed, replaced, or
     * disposed, so those Promises would otherwise never settle.
     */
    endSessionExtensionDialogs(sessionId) {
        let closedAny = false;
        for (const dialog of this.pendingExtensionDialogStore.pendingDialogs(sessionId)) {
            closedAny = this.closeExtensionDialogFromTrigger(sessionId, dialog.dialogId, "session-ended") || closedAny;
        }
        // Publishes only while the session is still (or already re-)registered as
        // active, so teardown paths stay silent and runtime replacement refreshes.
        if (closedAny)
            this.publishStatusForSessionId(sessionId);
    }
    publishDialogClosed(sessionId, outcome) {
        this.events.publish(sessionId, {
            type: "dialog.closed",
            dialogId: outcome.dialogId,
            reason: outcome.reason,
            ...(outcome.answer === undefined ? {} : { answer: outcome.answer }),
        });
    }
    /**
     * Publish status for a session known only by id, as the ask tools are: they
     * run inside the session's own runtime, so the active entry is the session.
     */
    publishStatusForSessionId(sessionId) {
        const session = this.active.get(sessionId)?.runtime.session;
        if (session !== undefined)
            this.publishStatus(session);
    }
    /** Summaries of the tracked subsessions spawned by `parentSessionId`. */
    async listSubsessions(parentSessionId, parentSessionFile) {
        const parentFile = nonEmptyString(parentSessionFile);
        await this.hydrateSubsessionsForParent(parentSessionId, parentFile);
        const childIds = this.subsessionChildren.get(parentSessionId);
        if (childIds === undefined)
            return [];
        const authorizedChildIds = [...childIds].filter((childId) => this.subsessionLinkBelongsToParent(parentSessionId, parentFile, childId));
        return Promise.all(authorizedChildIds.map(async (childId) => ({ sessionId: childId, ...(await this.subsessionSummaryFields(childId)) })));
    }
    /** Status and final result of a subsession, scoped to the caller's children. */
    async checkSubsession(parentSessionId, sessionId, parentSessionFile) {
        const session = await this.openSubsession(parentSessionId, sessionId, parentSessionFile);
        const messages = historyMessages(session);
        return {
            sessionId,
            cwd: session.sessionManager.getCwd(),
            status: this.subsessionStatus(session),
            finalText: finalAssistantText(messages),
            messageCount: messages.length,
        };
    }
    /** Filtered, paginated transcript of a subsession, scoped to the caller's children. */
    async readSubsession(parentSessionId, sessionId, query, parentSessionFile) {
        const session = await this.openSubsession(parentSessionId, sessionId, parentSessionFile);
        const view = buildTranscriptView(historyMessages(session), query);
        return {
            sessionId,
            cwd: session.sessionManager.getCwd(),
            status: this.subsessionStatus(session),
            ...view,
        };
    }
    /** Open a session after verifying it is one of the caller's tracked children. */
    async openSubsession(parentSessionId, sessionId, parentSessionFile) {
        const parentFile = nonEmptyString(parentSessionFile);
        await this.hydrateSubsessionsForParent(parentSessionId, parentFile);
        if (this.subsessionParents.get(sessionId) !== parentSessionId || !this.subsessionLinkBelongsToParent(parentSessionId, parentFile, sessionId)) {
            throw new Error(`Session ${sessionId} is not one of your subsessions`);
        }
        return this.getOrOpenTrackedSubsession(sessionId);
    }
    subsessionLinkBelongsToParent(parentSessionId, parentSessionFile, childSessionId) {
        const link = this.subsessionLinks.get(childSessionId);
        if (link?.parentSessionId !== parentSessionId)
            return false;
        return parentSessionFile === undefined || trackedLinkParentFileMatches(link, parentSessionFile);
    }
    activeChildForSubsessionLink(link) {
        const active = this.active.get(link.childSessionId);
        if (active === undefined)
            return undefined;
        return activeSessionFileMatches(active, link.childSessionFile) ? active : undefined;
    }
    activeParentForSubsessionLink(link) {
        const active = this.active.get(link.parentSessionId);
        if (active === undefined)
            return undefined;
        return activeSessionFileMatches(active, link.parentSessionFile) ? active : undefined;
    }
    subsessionLinkForActiveChild(session) {
        const childId = session.sessionId;
        const parentId = this.subsessionParents.get(childId);
        const link = this.subsessionLinks.get(childId);
        if (parentId === undefined || link?.parentSessionId !== parentId)
            return undefined;
        return sessionFileMatches(session, link.childSessionFile) ? link : undefined;
    }
    async registerVerifiedSubsession(link) {
        const { childSessionId, parentSessionId } = link;
        const previousParentId = this.subsessionParents.get(childSessionId);
        if (previousParentId !== undefined && previousParentId !== parentSessionId) {
            const previousChildren = this.subsessionChildren.get(previousParentId);
            previousChildren?.delete(childSessionId);
            if (previousChildren?.size === 0)
                this.subsessionChildren.delete(previousParentId);
        }
        this.subsessionParents.set(childSessionId, parentSessionId);
        const children = this.subsessionChildren.get(parentSessionId) ?? new Set();
        children.add(childSessionId);
        this.subsessionChildren.set(parentSessionId, children);
        this.subsessionLinks.set(childSessionId, link);
        if (!this.subsessionNotifyArmed.has(childSessionId))
            this.subsessionNotifyArmed.set(childSessionId, false);
        const cwd = this.cwdForVerifiedSubsession(link);
        await this.publishUnreadMutations(this.unreadStore.excludeSession(childSessionId, cwd));
    }
    cwdForVerifiedSubsession(link) {
        const activeCwd = this.activeChildForSubsessionLink(link)?.runtime.session.sessionManager.getCwd();
        const linkedCwd = nonEmptyString(activeCwd) ?? nonEmptyString(link.cwd);
        if (linkedCwd !== undefined)
            return canonicalizeStoredCwd(linkedCwd);
        const childSessionFile = link.childSessionFile;
        if (childSessionFile !== undefined) {
            try {
                return canonicalizeStoredCwd(this.sessionManager.open(childSessionFile).getCwd());
            }
            catch (error) {
                throw new Error("Could not resolve cwd for verified tracked sub-session", { cause: error });
            }
        }
        throw new Error("Could not resolve cwd for verified tracked sub-session");
    }
    unregisterSubsession(childSessionId) {
        const parentSessionId = this.subsessionParents.get(childSessionId);
        this.subsessionParents.delete(childSessionId);
        this.subsessionLinks.delete(childSessionId);
        this.subsessionNotifyArmed.delete(childSessionId);
        if (parentSessionId === undefined)
            return;
        const children = this.subsessionChildren.get(parentSessionId);
        children?.delete(childSessionId);
        if (children?.size === 0)
            this.subsessionChildren.delete(parentSessionId);
    }
    persistSubsessionLink(link) {
        const parent = this.activeParentForSubsessionLink(link)?.runtime.session;
        if (parent === undefined)
            return;
        if (parent.sessionManager.appendCustomEntry === undefined)
            return;
        try {
            parent.sessionManager.appendCustomEntry(SUBSESSION_LINK_CUSTOM_TYPE, persistedParentSubsessionLinkData(link));
        }
        catch (error) {
            this.logger.info({ parentSessionId: link.parentSessionId, sessionId: link.childSessionId, error: error instanceof Error ? error.message : String(error) }, "failed to persist subsession link");
        }
    }
    persistSubsessionChildMarker(parentSessionId, childSessionId) {
        const child = this.active.get(childSessionId)?.runtime.session;
        if (child === undefined)
            return;
        if (child.sessionManager.appendCustomEntry === undefined)
            return;
        try {
            child.sessionManager.appendCustomEntry(SUBSESSION_CHILD_LINK_CUSTOM_TYPE, persistedChildSubsessionLinkData(parentSessionId, childSessionId));
        }
        catch (error) {
            this.logger.info({ parentSessionId, sessionId: childSessionId, error: error instanceof Error ? error.message : String(error) }, "failed to persist subsession child marker");
        }
    }
    async hydrateSubsessionsForParent(parentSessionId, parentSessionFile) {
        const hydrationKey = subsessionHydratedParentKey(parentSessionId, parentSessionFile);
        if (this.subsessionHydratedParents.has(hydrationKey))
            return;
        const activeParent = this.active.get(parentSessionId);
        if (activeParent !== undefined && (parentSessionFile === undefined || activeSessionFileMatches(activeParent, parentSessionFile))) {
            const activeParentFile = nonEmptyString(activeParent.runtime.session.sessionFile);
            const complete = await this.registerPersistedSubsessionLinks(parentSessionId, activeParent.runtime.session.sessionManager, activeParentFile);
            if (complete)
                this.subsessionHydratedParents.add(hydrationKey);
            return;
        }
        if (parentSessionFile === undefined)
            return;
        if ((await readSessionHeaderSummary(parentSessionFile))?.id !== parentSessionId)
            return;
        let parentManager;
        try {
            parentManager = this.sessionManager.open(parentSessionFile);
        }
        catch {
            return;
        }
        const complete = await this.registerPersistedSubsessionLinks(parentSessionId, parentManager, parentSessionFile);
        if (complete)
            this.subsessionHydratedParents.add(hydrationKey);
    }
    async registerPersistedSubsessionLinks(parentSessionId, parentManager, parentSessionFile) {
        // Parent custom links are the authoritative recovery record: verify the
        // exact live child file/header before tracking. Do not negatively cache a
        // scan while a candidate child is temporarily unavailable.
        const entries = parentManager.getEntries?.() ?? parentManager.getBranch();
        let complete = true;
        for (const entry of entries) {
            const link = parsePersistedParentSubsessionLink(entry);
            if (link?.spawnedBySessionId !== parentSessionId)
                continue;
            const verified = await this.verifiedSubsessionLinkFromParentLink(parentSessionId, parentSessionFile, link);
            if (verified === undefined) {
                complete = false;
                continue;
            }
            await this.registerVerifiedSubsession(verified);
        }
        return complete;
    }
    async verifiedSubsessionLinkFromParentLink(parentSessionId, parentSessionFile, link) {
        if (parentSessionFile === undefined)
            return undefined;
        if (link.spawnedBySessionId !== parentSessionId)
            return undefined;
        if (!(await this.parentLinkHasValidChildTarget(parentSessionFile, link)))
            return undefined;
        return trackedSubsessionLinkFromParentLink(parentSessionId, link, parentSessionFile);
    }
    async parentLinkHasValidChildTarget(parentSessionFile, link) {
        return link.spawnedSessionFile !== undefined
            && await sessionFileHeaderMatches(link.spawnedSessionFile, { sessionId: link.spawnedSessionId, parentSessionFile });
    }
    async recoverSubsessionTrackingForOpenedSession(session) {
        const link = await this.verifiedSubsessionLinkFromOpenedChild(session);
        if (link === undefined)
            return;
        await this.registerVerifiedSubsession(link);
    }
    verifiedSubsessionLinkFromOpenedChild(session) {
        return verifiedTrackedSubsessionLink(this.sessionManager, {
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
            sessionManager: session.sessionManager,
            cwd: session.sessionManager.getCwd(),
        });
    }
    async getOrOpenTrackedSubsession(sessionId) {
        const link = this.subsessionLinks.get(sessionId);
        if (link === undefined)
            throw new Error("Session not found");
        const active = this.activeChildForSubsessionLink(link);
        if (active !== undefined)
            return active.runtime.session;
        if (link.childSessionFile !== undefined) {
            if (!(await sessionFileHeaderMatches(link.childSessionFile, { sessionId, parentSessionFile: link.parentSessionFile })))
                throw new Error("Session not found");
            const sessionManager = this.sessionManager.open(link.childSessionFile);
            return (await this.create(sessionManager, link.cwd ?? sessionManager.getCwd())).runtime.session;
        }
        throw new Error("Session not found");
    }
    async subsessionSummaryFields(childSessionId) {
        const link = this.subsessionLinks.get(childSessionId);
        const active = link === undefined ? undefined : this.activeChildForSubsessionLink(link);
        if (active !== undefined) {
            return { cwd: active.runtime.cwd, status: this.subsessionStatus(active.runtime.session) };
        }
        if (link?.childSessionFile !== undefined && (await sessionFileHeaderMatches(link.childSessionFile, { sessionId: childSessionId, parentSessionFile: link.parentSessionFile }))) {
            return { cwd: link.cwd ?? "", status: "idle" };
        }
        if (link?.cwd !== undefined)
            return { cwd: link.cwd, status: "unknown" };
        return { cwd: "", status: "unknown" };
    }
    subsessionStatus(session) {
        if (this.hasActiveWork(session))
            return "working";
        if (this.activities.get(session.sessionId)?.phase === "error")
            return "error";
        return "idle";
    }
    workingSubsessionIds(parentSessionId) {
        const childIds = this.subsessionChildren.get(parentSessionId);
        if (childIds === undefined)
            return [];
        return [...childIds].filter((childId) => {
            const link = this.subsessionLinks.get(childId);
            const active = link === undefined ? undefined : this.activeChildForSubsessionLink(link);
            return active !== undefined && this.hasActiveWork(active.runtime.session);
        });
    }
    /**
     * Drive parent notifications from a tracked child's status. Arms a pending
     * notification while the child is working, and when it stops fires a single
     * follow-up message to the parent via {@link prompt} (which queues if the
     * parent is busy and delivers immediately when it is idle).
     */
    updateSubsessionTracking(session) {
        const link = this.subsessionLinkForActiveChild(session);
        if (link === undefined)
            return;
        const childId = link.childSessionId;
        if (this.hasActiveWork(session)) {
            this.subsessionNotifyArmed.set(childId, true);
            return;
        }
        if (this.subsessionNotifyArmed.get(childId) !== true)
            return;
        this.subsessionNotifyArmed.set(childId, false);
        const status = this.activities.get(childId)?.phase === "error" ? "error" : "idle";
        const finalText = finalAssistantText(historyMessages(session));
        const outputSection = formatSubsessionNotificationOutput(childId, finalText);
        const workingIds = this.workingSubsessionIds(link.parentSessionId);
        const next = workingIds.length === 0
            ? "No other tracked subsessions are working."
            : `Still working: ${workingIds.join(", ")}. Continue working, or call yield_to_subsessions alone and last at the next join point. Further completion notices arrive automatically; do not poll.`;
        const text = `Subsession ${childId} stopped working (${status}).\n${next}\n\n${outputSection}`;
        void this.notifyParentOfSubsession(link.parentSessionId, childId, text);
    }
    async getOrOpenParentForSubsession(parentSessionId, childSessionId) {
        const link = this.subsessionLinks.get(childSessionId);
        if (link?.parentSessionId !== parentSessionId)
            throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);
        const active = this.activeParentForSubsessionLink(link);
        if (active !== undefined)
            return active.runtime.session;
        const parentSessionFile = link.parentSessionFile;
        if (parentSessionFile === undefined)
            throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);
        if ((await readSessionHeaderSummary(parentSessionFile))?.id !== parentSessionId) {
            throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);
        }
        const sessionManager = this.sessionManager.open(parentSessionFile);
        return (await this.create(sessionManager, sessionManager.getCwd())).runtime.session;
    }
    /**
     * Deliver a subsession-completion notice to the parent as a system-authored
     * custom message rather than a user message, so it is not attributed to the
     * human in the transcript. It still wakes an idle parent (`triggerTurn`) and
     * queues behind in-flight work (`deliverAs: "followUp"`), preserving the
     * established "queue if busy, send and act if idle" behavior.
     */
    async notifyParentOfSubsession(parentId, childId, text) {
        try {
            const session = await this.getOrOpenParentForSubsession(parentId, childId);
            if (this.treeNavigations.has(session)) {
                const pending = this.deferredSubsessionNotifications.get(session) ?? [];
                pending.push({ parentId, childId, text });
                this.deferredSubsessionNotifications.set(session, pending);
                return;
            }
            await this.deliverSubsessionNotification(session, { parentId, childId, text });
        }
        catch (error) {
            this.logSubsessionNotificationFailure(parentId, childId, error);
        }
    }
    async deliverSubsessionNotification(session, notification) {
        await this.runSessionEntryMutation(session, "deliver a subsession notification", () => session.sendCustomMessage({ customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, content: notification.text, display: true, details: { sessionId: notification.childId } }, { triggerTurn: true, deliverAs: "followUp" }));
        this.publishStatus(session);
    }
    logSubsessionNotificationFailure(parentId, childId, error) {
        this.logger.info({ parentSessionId: parentId, sessionId: childId, error: error instanceof Error ? error.message : String(error) }, "failed to notify parent of subsession completion");
    }
    async messages(ref, page) {
        const session = await this.getOrOpen(ref);
        return pageMessagesAtSafeBoundary(historyMessages(session), page);
    }
    async status(ref) {
        return this.statusFromSession(await this.sessionForStatusOrDialogClose(ref));
    }
    /**
     * Join-time snapshot of the in-flight assistant stream. The `seq` watermark and
     * the partial are read together in one synchronous tick (no await between the
     * `currentSeq` read and the `state.streamingMessage` read) so a joining client
     * can seed the partial and then apply only buffered live events with
     * `seq > snapshot.seq`. The partial is browser-projected to strip thinking
     * signatures; it is `null` when no assistant message is mid-stream.
     */
    async streamSnapshot(ref) {
        const session = await this.getOrOpen(ref);
        // Single consistent tick: capture the watermark and the partial together so
        // the seq matches the partial the client seeds against.
        const seq = this.events.currentSeq(session.sessionId);
        const streamingMessage = session.state.streamingMessage;
        const partial = streamingMessage === undefined || streamingMessage === null
            ? null
            : annotateAssistantThinkingLevel(projectBrowserMessage(streamingMessage), session.thinkingLevel);
        return { seq, partial };
    }
    async availableModels(ref) {
        const session = await this.getOrOpen(ref);
        const models = await this.sessionModelCandidates(session);
        return models.map(modelToClientModel);
    }
    async setModel(ref, provider, modelId) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.assertTreeNavigationInactive(session, "change models");
        const candidates = await this.sessionModelCandidates(session);
        this.assertTreeNavigationInactive(session, "change models");
        const model = candidates.find((candidate) => candidate.provider === provider && candidate.id === modelId)
            ?? session.modelRuntime.getModel(provider, modelId);
        if (model === undefined)
            throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.runSessionEntryMutation(session, "change models", () => session.setModel(model));
        this.publishActivity(session, `model: ${model.id}`, "idle", model.provider);
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async cycleModel(ref, direction) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        const result = await this.runSessionEntryMutation(session, "change models", () => session.cycleModel(direction));
        if (result === undefined)
            throw new Error(session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
        this.publishActivity(session, `model: ${result.model.id}`, "idle", result.model.provider);
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async availableThinkingLevels(ref) {
        const session = await this.getOrOpen(ref);
        return session.getAvailableThinkingLevels();
    }
    async setThinkingLevel(ref, level) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.assertTreeNavigationInactive(session, "change the thinking level");
        // pi owns the valid set; validate against the session's live levels rather
        // than a hardcoded union so this stays correct if pi changes the set.
        const available = session.getAvailableThinkingLevels();
        const match = available.find((candidate) => candidate === level);
        if (match === undefined)
            throw new Error(`Invalid thinking level: ${level}`);
        session.setThinkingLevel(match);
        this.publishActivity(session, `thinking: ${session.thinkingLevel}`, "idle");
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async cycleThinkingLevel(ref) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.assertTreeNavigationInactive(session, "change the thinking level");
        const level = session.cycleThinkingLevel();
        if (level === undefined)
            throw new Error("Current model does not support thinking");
        this.publishActivity(session, `thinking: ${level}`, "idle");
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async commands(ref) {
        const session = await this.getOrOpen(ref);
        const commands = [...BUILTIN_COMMANDS];
        for (const command of session.extensionRunner.getRegisteredCommands()) {
            commands.push({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }), source: "extension" });
        }
        for (const template of session.promptTemplates) {
            commands.push({ name: template.name, ...(template.description === undefined ? {} : { description: template.description }), source: "prompt" });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
            commands.push({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" });
        }
        return commands.sort((a, b) => a.name.localeCompare(b.name));
    }
    async prompt(ref, text, streamingBehavior, attachments, options) {
        const promptText = requirePromptText(text);
        // Command-forwarded prompts (e.g. /skill:*) are expanded by the agent, which
        // streams the canonical message back. The client doesn't render the raw
        // command text, so the server must not echo it either, or it would show up
        // as a transient line that vanishes on reload.
        const echoUserMessage = options?.echoUserMessage !== false;
        const requestedBehavior = parsePromptStreamingBehavior(streamingBehavior);
        const parsedAttachments = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false });
        const images = (await attachmentsToInlineImages(parsedAttachments)).map((entry) => entry.image);
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.assertTreeNavigationInactive(session, "send a prompt");
        this.maybeGenerateSessionName(session, promptText);
        const isQueued = session.isStreaming || session.isCompacting;
        const behavior = isQueued ? requestedBehavior ?? "followUp" : undefined;
        if (isQueued && images.length === 0 && this.hasQueuedMessageText(session, promptText)) {
            this.publishActivity(session, "duplicate queued message ignored", "active");
            this.publishStatus(session);
            return;
        }
        // A chat message answers the session's open ask in the user's own words, so
        // the form is void: keeping it open would invite answers to questions the
        // conversation has already moved past. Ignored duplicates skip this on
        // purpose: they must not void an ask posted after the queued original.
        await this.voidOpenAskForUserMessage(session);
        if (session.isCompacting) {
            this.enqueuePromptDuringCompaction(session, promptText, behavior ?? "followUp", images, echoUserMessage);
            return;
        }
        void this.submitPrompt(session, promptText, behavior, images, echoUserMessage);
    }
    submitPrompt(session, text, behavior, images = [], echoUserMessage = true) {
        this.publishActivity(session, behavior === "steer" ? "steering queued" : behavior === "followUp" ? "message queued" : "prompt accepted", "active");
        if (behavior === undefined && echoUserMessage)
            this.events.publish(session.sessionId, { type: "message.append", message: userMessage(text, images) });
        const promptOptions = buildPromptOptions(behavior, images);
        const promptPromise = this.runSessionEntryMutation(session, "send a prompt", () => session.prompt(text, promptOptions)).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.publishActivity(session, "error", "error", message);
            this.events.publish(session.sessionId, { type: "session.error", message });
        });
        void promptPromise;
        return promptPromise;
    }
    enqueuePromptDuringCompaction(session, text, kind, images = [], echoUserMessage = true) {
        const queue = this.compactionPromptQueues.get(session.sessionId) ?? [];
        queue.push({ kind, text, ...(images.length > 0 ? { images } : {}), ...(echoUserMessage ? {} : { echoUserMessage: false }) });
        this.compactionPromptQueues.set(session.sessionId, queue);
        this.publishActivity(session, "message queued during compaction", "active");
        this.publishStatus(session);
    }
    async saveAttachments(ref, attachments, folder) {
        const parsed = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false, allowFileAttachments: true });
        if (parsed.length === 0)
            return [];
        await this.assertWritable(ref);
        const active = await this.getActive(ref);
        return saveAttachmentsToWorkspace(active.runtime.cwd, parsed, folder === undefined ? {} : { folder });
    }
    async shell(ref, text) {
        await this.assertWritable(ref);
        const active = await this.getActive(ref);
        const { session } = active.runtime;
        this.assertTreeNavigationInactive(session, "run a shell command");
        const isExcluded = text.startsWith("!!");
        const command = (isExcluded ? text.slice(2) : text.slice(1)).trim();
        if (!command)
            throw new Error("Usage: !<shell command>");
        if (session.isBashRunning)
            throw new Error("A bash command is already running");
        this.publishActivity(session, "running bash", "active", command);
        this.events.publish(session.sessionId, { type: "shell.start", command, excludeFromContext: isExcluded });
        void this.runSessionEntryMutation(session, "run a shell command", () => session.executeBash(command, (chunk) => {
            this.events.publish(session.sessionId, { type: "shell.chunk", chunk });
            this.publishActivity(session, "running bash", "active", command);
            this.publishStatus(session);
        }, { excludeFromContext: isExcluded })).then((result) => {
            this.events.publish(session.sessionId, {
                type: "shell.end",
                output: result.output,
                ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
                cancelled: result.cancelled,
                truncated: result.truncated,
                ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
            });
            this.publishActivity(session, "bash complete", result.exitCode === 0 ? "idle" : "error", command);
            this.publishStatus(session);
        }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish(session.sessionId, { type: "shell.end", output: message, isError: true });
            this.events.publish(session.sessionId, { type: "session.error", message });
            this.publishActivity(session, "bash failed", "error", message);
            this.publishStatus(session);
        });
    }
    async runCommand(ref, text) {
        await this.assertWritable(ref);
        const active = await this.getActive(ref);
        return this.commandService.run(active.runtime.session.sessionId, text);
    }
    async respondToCommand(ref, requestId, value) {
        await this.assertWritable(ref);
        const active = await this.getActive(ref);
        return this.commandService.respond(active.runtime.session.sessionId, requestId, value);
    }
    async navigateTree(ref, request) {
        if (request.targetId.trim() === "")
            throw new Error("Session tree target is required");
        if (this.isTreeExclusiveSessionIdentityActive(ref.id)) {
            throw new Error("Stop current session activity before navigating the session tree");
        }
        await this.assertWritable(ref);
        const options = sessionTreeNavigationOptions(request);
        const session = await this.getOrOpen(ref);
        if (typeof session.navigateTree !== "function")
            throw new Error("Session tree navigation is not supported by this Pi runtime");
        if (this.hasActiveWork(session))
            throw new Error("Stop current session activity before navigating the session tree");
        // Acquire synchronously after the active-work check. No leaf-producing work
        // may enter this runtime until Pi's potentially asynchronous summary settles.
        this.treeNavigations.add(session);
        try {
            if (session.sessionManager.getLeafId() !== request.expectedLeafId) {
                throw new Error("The session changed since /tree was opened. Reopen /tree and try again.");
            }
            this.publishActivity(session, options.summarize ? "summarizing branch" : "navigating session tree", "active");
            this.publishStatus(session);
            const result = await session.navigateTree(request.targetId, options);
            if (result.cancelled) {
                if (this.isCurrentActiveSession(session)) {
                    this.publishActivity(session, result.aborted === true ? "branch summary aborted" : "tree navigation cancelled", "idle");
                }
                return { cancelled: true, ...(result.aborted === undefined ? {} : { aborted: result.aborted }) };
            }
            if (this.isCurrentActiveSession(session))
                this.publishActivity(session, "session tree navigated", "idle");
            return { cancelled: false, ...(result.editorText === undefined ? {} : { editorText: result.editorText }) };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.isCurrentActiveSession(session)) {
                this.publishActivity(session, "tree navigation failed", "error", message);
                this.events.publish(session.sessionId, { type: "session.error", message });
            }
            throw error;
        }
        finally {
            this.treeNavigations.delete(session);
            if (this.isCurrentActiveSession(session)) {
                this.flushDeferredTreeNavigationWork(session);
                this.publishStatus(session);
            }
            else {
                this.deferredGeneratedSessionNames.delete(session);
                this.deferredSubsessionNotifications.delete(session);
            }
        }
    }
    /**
     * Fork the session from one entry of its tree into a new session file,
     * leaving the original session untouched. The forked runtime replaces the
     * current one, so the outcome is reported for the session the client is
     * about to join rather than the forked-from record.
     */
    async forkFromTree(ref, request) {
        if (request.entryId.trim() === "")
            throw new Error("Session tree entry is required");
        if (this.isTreeExclusiveSessionIdentityActive(ref.id)) {
            throw new Error("Stop current session activity before forking the session tree");
        }
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        if (this.hasActiveWork(session))
            throw new Error("Stop current session activity before forking the session tree");
        if (session.sessionManager.getLeafId() !== request.expectedLeafId) {
            throw new Error("The session changed since /tree was opened. Reopen /tree and try again.");
        }
        this.publishActivity(session, "forking session from entry", "active");
        this.publishStatus(session);
        try {
            const result = await this.commandService.forkEntry(session.sessionId, request.entryId, {
                expectedLeafId: request.expectedLeafId,
            });
            if (result.type === "unsupported")
                throw new Error(result.message);
            if (result.type !== "done")
                throw new Error("Session fork is unavailable");
            if (result.session === undefined) {
                if (this.isCurrentActiveSession(session)) {
                    this.publishActivity(session, "fork cancelled", "idle");
                    this.publishStatus(session);
                }
                return { cancelled: true };
            }
            const forkedSession = this.active.get(result.session.id)?.runtime.session;
            if (forkedSession !== undefined && this.isCurrentActiveSession(forkedSession)) {
                this.publishActivity(forkedSession, "session forked", "idle");
                this.publishStatus(forkedSession);
            }
            if (result.session.id !== session.sessionId)
                this.clearSupersededSessionActivity(session);
            return {
                cancelled: false,
                session: result.session,
                ...(result.promptDraft === undefined ? {} : { promptDraft: result.promptDraft }),
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.isCurrentActiveSession(session)) {
                this.publishActivity(session, "fork failed", "error", message);
                this.events.publish(session.sessionId, { type: "session.error", message });
                this.publishStatus(session);
            }
            throw error;
        }
    }
    /**
     * A changed-id fork can rebind its runtime after a heartbeat published the
     * prior identity as active. Clear every observable owner before forgetting
     * that identity's local activity record.
     */
    clearSupersededSessionActivity(session) {
        const sessionId = session.sessionId;
        if (this.activities.get(sessionId)?.phase === "active") {
            const at = new Date().toISOString();
            const stored = { phase: "idle", label: "idle", at };
            this.activities.set(sessionId, stored);
            const activity = { sessionId, ...stored };
            this.events.publish(sessionId, { type: "activity.update", activity });
            this.events.publishGlobal({ type: "activity.update", activity });
        }
        this.workspaceActivity?.removeSession(sessionId, session.sessionManager.getCwd());
        this.activities.delete(sessionId);
    }
    async reloadSessionRuntime(session) {
        if (this.hasActiveWork(session))
            throw new Error("Stop current session activity before reloading");
        await this.runTreeExclusiveOperation([{ sessionId: session.sessionId, session }], "Stop current session activity before reloading", async () => {
            this.publishActivity(session, "reloading resources", "active");
            const priorGeneration = this.notificationGenerationBySession.get(session);
            let candidateGeneration;
            try {
                await session.reload(priorGeneration === undefined ? undefined : {
                    beforeSessionStart: () => {
                        candidateGeneration = this.notificationStore.beginReplacement(priorGeneration, notificationIdentityForSession(session));
                        this.notificationGenerationBySession.set(session, candidateGeneration);
                        this.replaceSessionNotificationContext(session, candidateGeneration);
                    },
                });
                if (candidateGeneration !== undefined) {
                    this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
                }
                this.publishActivity(session, "resources reloaded", "idle");
                this.publishStatus(session);
            }
            catch (error) {
                if (candidateGeneration !== undefined) {
                    this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration, "candidate"));
                    this.notificationGenerationBySession.set(session, candidateGeneration);
                }
                const message = error instanceof Error ? error.message : String(error);
                this.publishActivity(session, "reload failed", "error", message);
                this.events.publish(session.sessionId, { type: "session.error", message });
                this.publishStatus(session);
                throw error;
            }
        });
    }
    async archive(ref) {
        const session = await this.getOrOpen(ref);
        if (this.hasActiveWork(session))
            throw new Error("Stop current session activity before archiving");
        await this.runTreeExclusiveOperation([{ sessionId: session.sessionId, session }], "Stop current session activity before archiving", async () => {
            const archiveInput = await this.archiveInputForSession(session);
            await this.closeActive(session.sessionId, { kind: "clear", reason: "archive" });
            await this.archiveStore.archive(archiveInput);
            await this.forgetUnreadSessions([archiveInput]);
        });
    }
    async archiveMany(refs) {
        const uniqueRefs = uniqueBulkSessionRefs(refs);
        const [archivedRecords, sessionContext] = await Promise.all([
            this.archiveStore.list(),
            this.bulkSessionRefContext(uniqueRefs),
        ]);
        const failures = [];
        const alreadyArchivedSessionIds = [];
        const unreadArchivedIdentities = [];
        const planItems = [];
        for (const ref of uniqueRefs) {
            const archived = findArchivedRecordForBulkRef(archivedRecords, ref);
            if (archived !== undefined) {
                this.publishNotificationMutations(this.notificationStore.clearSession(archived.sessionId, "archive"));
                alreadyArchivedSessionIds.push(archived.sessionId);
                unreadArchivedIdentities.push(archived);
                continue;
            }
            const active = this.activeForRef(bulkRefToSessionRef(ref));
            const listed = findListedSessionForBulkRef(sessionContext, ref);
            const resolvedSessionId = active?.runtime.session.sessionId ?? listed?.id ?? ref.id;
            if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
                failures.push({ sessionId: resolvedSessionId, error: "Stop current session activity before archiving" });
                continue;
            }
            try {
                if (listed !== undefined) {
                    planItems.push({ input: archiveInputFromListEntry(listed) });
                }
                else if (active !== undefined) {
                    planItems.push({ input: archiveInputFromActiveSession(active.runtime.session) });
                }
                else {
                    failures.push({ sessionId: ref.id, error: "Session not found" });
                }
            }
            catch (error) {
                failures.push({ sessionId: resolvedSessionId, error: errorMessage(error) });
            }
        }
        const readyPlanItems = [];
        for (const item of planItems) {
            const active = this.activeForRef({ id: item.input.sessionId, cwd: item.input.cwd });
            if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
                failures.push({ sessionId: item.input.sessionId, error: "Stop current session activity before archiving" });
                continue;
            }
            readyPlanItems.push(active === undefined ? item : { ...item, active });
        }
        const readyInputs = [];
        const archivedSessionIds = [...alreadyArchivedSessionIds];
        await this.runTreeExclusiveOperation(readyPlanItems.map(({ input, active }) => ({
            sessionId: input.sessionId,
            ...(active === undefined ? {} : { session: active.runtime.session, runtime: active.runtime }),
        })), "Stop current session activity before archiving", async () => {
            for (const item of readyPlanItems) {
                try {
                    await this.closeActive(item.input.sessionId, { kind: "clear", reason: "archive" });
                    readyInputs.push(item.input);
                }
                catch (error) {
                    failures.push({ sessionId: item.input.sessionId, error: errorMessage(error) });
                }
            }
            try {
                const archived = await this.archiveStoreArchiveMany(readyInputs);
                archivedSessionIds.push(...archived.map((record) => record.sessionId));
                unreadArchivedIdentities.push(...archived);
            }
            catch (error) {
                for (const input of readyInputs)
                    failures.push({ sessionId: input.sessionId, error: errorMessage(error) });
            }
        });
        await this.forgetUnreadSessions(unreadArchivedIdentities);
        return {
            archived: true,
            archivedSessionIds: uniqueStrings(archivedSessionIds),
            failures,
            generatedAt: new Date().toISOString(),
        };
    }
    async archiveTree(ref) {
        const session = await this.getOrOpen(ref);
        const catalog = await this.workspaceArchiveCandidates(session.sessionManager.getCwd());
        const root = findArchiveCandidateByIdOrPrefix(catalog, session.sessionId) ?? archiveCandidateFromActiveSession(session, false);
        const plan = planSessionArchiveTree(root, catalog);
        const busy = plan.targets.map((target) => target.activeSession).find((target) => target !== undefined && this.hasActiveWork(target));
        if (busy !== undefined)
            throw new Error(`Stop current session activity before archiving ${sessionDisplayName(busy)}`);
        const archiveInputs = plan.unarchivedTargets.map((target) => archiveInputFromCandidate(target));
        await this.runTreeExclusiveOperation(plan.unarchivedTargets.map((target) => ({
            sessionId: target.id,
            ...(target.activeSession === undefined ? {} : { session: target.activeSession }),
        })), `Stop current session activity before archiving ${sessionDisplayName(session)}`, async () => {
            for (const target of plan.targets) {
                if (target.archived)
                    this.publishNotificationMutations(this.notificationStore.clearSession(target.id, "archive"));
            }
            for (const input of archiveInputs)
                await this.closeActive(input.sessionId, { kind: "clear", reason: "archive" });
            await this.archiveStoreArchiveMany(archiveInputs);
        });
        await this.forgetUnreadSessions(plan.targets.map((target) => ({ sessionId: target.id, cwd: target.cwd })));
        return {
            archived: true,
            sessionIds: archiveInputs.map((input) => input.sessionId),
            archivedCount: archiveInputs.length,
            skippedAlreadyArchivedCount: plan.skippedAlreadyArchivedCount,
        };
    }
    async restore(ref) {
        const archived = await this.getArchived(ref);
        if (archived === undefined)
            throw new Error("Session not found");
        await this.closeActive(archived.sessionId, { kind: "clear", reason: "restore" });
        await this.archiveStore.restore(archived.sessionId);
        await this.forgetUnreadSessions([archived]);
    }
    async deleteArchivedMany(refs) {
        if (this.archiveStore.deleteArchived === undefined && this.archiveStore.deleteArchivedMany === undefined)
            throw new Error("Archive store does not support deletion");
        const uniqueRefs = uniqueBulkSessionRefs(refs);
        const archivedRecords = await this.archiveStore.list();
        const failures = [];
        const planItems = [];
        for (const ref of uniqueRefs) {
            const record = findArchivedRecordForBulkRef(archivedRecords, ref);
            if (record === undefined) {
                failures.push({ sessionId: ref.id, error: "Archived session not found" });
                continue;
            }
            const active = this.activeForRef({ id: record.sessionId, cwd: record.cwd });
            if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
                failures.push({ sessionId: record.sessionId, error: "Stop current session activity before deleting archived session" });
                continue;
            }
            planItems.push({ record });
        }
        const readyRecords = [];
        for (const item of planItems) {
            try {
                await this.closeActive(item.record.sessionId, { kind: "clear", reason: "delete" });
                readyRecords.push(item.record);
            }
            catch (error) {
                failures.push({ sessionId: item.record.sessionId, error: errorMessage(error) });
            }
        }
        const deleteIds = readyRecords.map((record) => record.sessionId);
        let deletedSessionIds = [];
        try {
            deletedSessionIds = await this.archiveStoreDeleteArchivedMany(deleteIds);
        }
        catch (error) {
            for (const sessionId of deleteIds)
                failures.push({ sessionId, error: errorMessage(error) });
        }
        const deletedIdSet = new Set(deletedSessionIds);
        await this.forgetUnreadSessions(readyRecords.filter((record) => deletedIdSet.has(record.sessionId)));
        return {
            deleted: true,
            deletedSessionIds,
            failures,
            generatedAt: new Date().toISOString(),
        };
    }
    async reload(ref) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        if (this.hasActiveWork(session))
            throw new Error("Stop current session activity before reloading");
        const reopenedSession = await this.runTreeExclusiveOperation([{ sessionId: session.sessionId, session }], "Stop current session activity before reloading", async () => {
            const priorGeneration = this.notificationGenerationBySession.get(session);
            const { sessionId, cwd } = notificationIdentityForSession(session);
            let candidateGeneration;
            try {
                await this.closeActive(sessionId, priorGeneration === undefined ? CLEAR_RUNTIME_NOTIFICATIONS : DEFER_RUNTIME_NOTIFICATIONS);
                candidateGeneration = priorGeneration === undefined
                    ? undefined
                    : this.notificationStore.beginReplacement(priorGeneration, { sessionId, cwd });
                const reopened = await this.getActive(ref, candidateGeneration === undefined ? {} : { notificationGeneration: candidateGeneration });
                if (candidateGeneration !== undefined) {
                    this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
                }
                return reopened.runtime.session;
            }
            catch (error) {
                if (candidateGeneration !== undefined) {
                    this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration));
                }
                throw error;
            }
        });
        this.publishStatus(reopenedSession);
    }
    async detachParent(ref) {
        const session = await this.getOrOpen(ref);
        const sessionFile = session.sessionFile;
        if (sessionFile === undefined || sessionFile === "")
            throw new Error("Session is not persisted");
        await clearParentSession(sessionFile);
        // The header rewrite keeps the inode, and whenever it leaves the file's
        // size unchanged it is invisible to the gateway's summary memo, which
        // cannot detect such rewrites from identity + size alone and would keep
        // listing the old parent link until restart.
        this.sessionManager.invalidateSessionFile(sessionFile);
        clearParentSessionHeader(session.sessionManager);
        this.unregisterSubsession(session.sessionId);
        await this.forgetUnreadSessions([{ sessionId: session.sessionId, cwd: session.sessionManager.getCwd() }]);
    }
    async clearQueue(ref) {
        await this.assertWritable(ref);
        const session = await this.getOrOpen(ref);
        this.clearCompactionPromptQueue(session.sessionId);
        clearSessionQueue(session);
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async dismissWarning(ref, dismissId) {
        const session = await this.getOrOpen(ref);
        dismissSessionWarning(session, dismissId);
        this.publishStatus(session);
        return this.statusFromSession(session);
    }
    async abort(ref) {
        const active = this.activeForRef(ref);
        if (active === undefined)
            return;
        const sessionId = active.runtime.session.sessionId;
        this.clearCompactionPromptQueue(sessionId);
        clearSessionQueue(active.runtime.session);
        // Settle run-scoped dialogs now, at abort-request time: pi's agent loop
        // waits for a parked `tool_call` dialog handler before it can emit
        // `agent_end`, so leaving settlement to the `agent_end` observer would
        // strand the dialog until its timeout. Settling before the runtime abort
        // also means a failing or hung abort cannot strand the parked waiter.
        this.abortRunScopedExtensionDialogs(sessionId);
        try {
            await this.abortSessionOperations(active.runtime.session);
            this.publishActivity(active.runtime.session, "stopped", "idle");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.publishActivity(active.runtime.session, "stop failed", "error", message);
            throw error;
        }
        finally {
            this.publishStatus(active.runtime.session);
        }
    }
    async stop(ref) {
        const active = this.activeForRef(ref);
        if (active !== undefined) {
            await this.closeActive(active.runtime.session.sessionId);
            return;
        }
        // A session whose open is parked (e.g. on a session_start dialog) is not
        // active yet; close it through the same path so stopping cannot block
        // behind the dialog timeout.
        const startup = this.startupSessionForRef(ref);
        if (startup !== undefined) {
            await this.closeActive(startup.sessionId);
            return;
        }
        this.publishNotificationMutations(this.notificationStore.clearSessionIdentity(ref.id, canonicalizeStoredCwd(ref.cwd), "runtime-close"));
    }
    async bulkSessionRefContext(refs) {
        const cwdSet = new Set();
        for (const ref of refs)
            cwdSet.add(ref.cwd);
        return { sessionsByCwd: await this.listSessionsByCwd([...cwdSet]) };
    }
    async listSessionsByCwd(cwds) {
        const uniqueCwds = uniqueStrings(cwds);
        const entries = await Promise.all(uniqueCwds.map(async (cwd) => [cwd, await this.sessionManager.list(cwd)]));
        return new Map(entries);
    }
    async archiveStoreArchiveMany(inputs) {
        if (inputs.length === 0)
            return [];
        if (this.archiveStore.archiveMany !== undefined)
            return this.archiveStore.archiveMany(inputs);
        const records = [];
        for (const input of inputs)
            records.push(await this.archiveStore.archive(input));
        return records;
    }
    async archiveStoreDeleteArchivedMany(sessionIds) {
        if (sessionIds.length === 0)
            return [];
        if (this.archiveStore.deleteArchivedMany !== undefined)
            return this.archiveStore.deleteArchivedMany(sessionIds);
        if (this.archiveStore.deleteArchived === undefined)
            throw new Error("Archive store does not support deletion");
        for (const sessionId of sessionIds)
            await this.archiveStore.deleteArchived(sessionId);
        return [...sessionIds];
    }
    async cleanupPlan(request) {
        const [sessions, archivedRecords] = await Promise.all([this.sessionManager.listAll(), this.archiveStore.list()]);
        return planSessionCleanup({
            sessions,
            archivedRecords,
            activeSessions: this.cleanupActiveSessionStatuses(),
            thresholds: request.thresholds,
            ...(request.projectCwds === undefined ? {} : { projectCwds: request.projectCwds }),
            now: this.now(),
        });
    }
    cleanupActiveSessionStatuses() {
        return [...new Set(this.active.values())].map((active) => ({
            sessionId: active.runtime.session.sessionId,
            hasActiveWork: this.hasActiveWork(active.runtime.session),
        }));
    }
    activeSessionHasWork(sessionId) {
        const active = this.active.get(sessionId);
        return active !== undefined && this.hasActiveWork(active.runtime.session);
    }
    reconcilableSessionIds(cwd, listedSessionIds, archivedById) {
        const sessionIds = new Set(listedSessionIds);
        for (const active of new Set(this.active.values())) {
            const session = active.runtime.session;
            if (session.sessionManager.getCwd() === cwd && !archivedById.has(session.sessionId))
                sessionIds.add(session.sessionId);
        }
        return [...sessionIds];
    }
    async archiveInputForSession(session) {
        const cwd = session.sessionManager.getCwd();
        const sessionFile = session.sessionFile;
        if (sessionFile === undefined || sessionFile === "")
            throw new Error("Session is not persisted");
        const listed = (await this.sessionManager.list(cwd)).find((candidate) => candidate.id === session.sessionId);
        if (listed !== undefined)
            return archiveInputFromListEntry(listed);
        return archiveInputFromActiveSession(session);
    }
    async workspaceArchiveCandidates(cwd) {
        const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
        const candidates = new Map();
        const archivedById = new Map();
        for (const record of archivedRecords) {
            if (record.cwd === cwd)
                archivedById.set(record.sessionId, record);
        }
        for (const session of sessions) {
            const archived = archivedById.get(session.id);
            if (archived === undefined)
                candidates.set(session.id, archiveCandidateFromListEntry(session));
            else {
                const candidate = archiveCandidateFromArchivedRecord(archived, session);
                if (candidate !== undefined)
                    candidates.set(candidate.id, candidate);
            }
        }
        for (const record of archivedById.values()) {
            if (candidates.has(record.sessionId))
                continue;
            const candidate = archiveCandidateFromArchivedRecord(record, undefined);
            if (candidate !== undefined)
                candidates.set(candidate.id, candidate);
        }
        for (const active of new Set(this.active.values())) {
            const session = active.runtime.session;
            if (session.sessionManager.getCwd() !== cwd || archivedById.has(session.sessionId))
                continue;
            const existing = candidates.get(session.sessionId);
            candidates.set(session.sessionId, { ...(existing ?? archiveCandidateFromActiveSession(session, false)), activeSession: session });
        }
        return [...candidates.values()];
    }
    async listSessionNames(cwd) {
        const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
        const names = new Set();
        for (const session of sessions)
            addSessionName(names, session.name);
        for (const record of archivedRecords) {
            if (record.cwd === cwd)
                addSessionName(names, record.name);
        }
        for (const active of new Set(this.active.values())) {
            const session = active.runtime.session;
            if (session.sessionManager.getCwd() === cwd)
                addSessionName(names, session.sessionName);
        }
        return [...names];
    }
    async closeActive(sessionId, notificationPolicy = CLEAR_RUNTIME_NOTIFICATIONS) {
        // A session whose open is parked on a `session_start` dialog holds its
        // pending open until the dialog settles; settle it first so closing cannot
        // block behind the dialog timeout (which `0` makes infinite).
        if (this.startupSessions.has(sessionId))
            this.endSessionExtensionDialogs(sessionId);
        const pendingOpens = this.pendingSessionOpenPromises(sessionId);
        if (pendingOpens.length > 0)
            await Promise.allSettled(pendingOpens);
        const active = this.active.get(sessionId);
        if (notificationPolicy.kind === "clear") {
            const generation = active === undefined ? undefined : this.notificationGenerationBySession.get(active.runtime.session);
            const mutations = generation === undefined
                ? this.notificationStore.clearSession(sessionId, notificationPolicy.reason)
                : this.notificationStore.clearGeneration(generation, notificationPolicy.reason);
            this.publishNotificationMutations(mutations);
        }
        if (!active)
            return;
        this.forgetUnreadActivity(active.runtime.session);
        // An open ask is meaningful only while the runtime that posted it exists: no
        // one is left to receive the answers, so it is dropped without an outcome.
        this.pendingAskStore.forgetSession(sessionId);
        // Open dialogs share that stance, but their extension waiters are parked
        // Promises inside the dying runtime: settle them rather than dropping them.
        this.endSessionExtensionDialogs(sessionId);
        this.active.delete(sessionId);
        this.activities.delete(sessionId);
        this.workspaceActivity?.removeSession(sessionId, active.runtime.session.sessionManager.getCwd());
        this.clearAuthLossWarningsForSession(sessionId);
        this.clearCompactionPromptQueue(sessionId);
        // Disarm subsession notification before teardown so the abort below cannot
        // emit a "stopped working" event that notifies the parent (e.g. on archive).
        // The parent/children link is kept so the parent can still see the child.
        if (this.subsessionLinkForActiveChild(active.runtime.session) !== undefined)
            this.subsessionNotifyArmed.delete(sessionId);
        clearSessionQueue(active.runtime.session);
        active.unsubscribe();
        active.runtime.setRebindSession(undefined);
        try {
            await this.abortSessionOperations(active.runtime.session);
        }
        finally {
            await active.runtime.dispose();
        }
    }
    async abortSessionOperations(session) {
        let branchSummaryAbortFailed = false;
        let branchSummaryAbortError;
        try {
            session.abortBranchSummary?.();
        }
        catch (error) {
            branchSummaryAbortFailed = true;
            branchSummaryAbortError = error;
        }
        try {
            await session.abort();
        }
        catch (abortError) {
            if (branchSummaryAbortFailed) {
                throw new AggregateError([branchSummaryAbortError, abortError], "Failed to abort session operations", { cause: abortError });
            }
            throw abortError;
        }
        if (branchSummaryAbortFailed)
            throw branchSummaryAbortError;
    }
    async assertWritable(ref) {
        if (await this.getArchived(ref) !== undefined)
            throw new Error("Archived sessions are read-only. Restore the session to continue.");
    }
    async getOrOpen(ref) {
        return (await this.getActive(ref)).runtime.session;
    }
    async getActive(ref, options = {}) {
        const active = this.activeForRef(ref);
        if (active !== undefined)
            return active;
        const archived = await this.getArchived(ref);
        if (archived?.archivePath !== undefined) {
            const { archivePath } = archived;
            return this.openExistingSession(archived.sessionId, archived.cwd, () => this.sessionManager.open(archivePath), { notifications: "disabled" });
        }
        // Resolve the session file directly by id: opening one known session must
        // not depend on — or wait behind — a full transcript listing of its whole
        // workspace. `getActive` routes prompt/shell/runCommand, so coupling it to
        // the listing would let an in-flight listing serialize unrelated sends.
        const match = await this.sessionManager.resolveSessionFile(ref.cwd, ref.id);
        if (!match)
            throw new Error("Session not found");
        return this.openExistingSession(match.id, match.cwd, () => this.sessionManager.open(match.path), options);
    }
    openExistingSession(sessionId, cwd, openSessionManager, options = {}) {
        const active = this.activeForRef({ id: sessionId, cwd });
        if (active !== undefined)
            return Promise.resolve(active);
        const key = JSON.stringify([canonicalizeStoredCwd(cwd), sessionId]);
        const existing = this.pendingSessionOpens.get(key);
        if (existing !== undefined)
            return existing.promise;
        const pending = {
            sessionId,
            promise: this.create(openSessionManager(), cwd, options),
        };
        pending.promise = pending.promise.finally(() => {
            if (this.pendingSessionOpens.get(key) === pending)
                this.pendingSessionOpens.delete(key);
        });
        this.pendingSessionOpens.set(key, pending);
        return pending.promise;
    }
    pendingSessionOpenPromises(sessionId) {
        return [...this.pendingSessionOpens.values()]
            .filter((pending) => sessionId === undefined || pending.sessionId === sessionId)
            .map((pending) => pending.promise);
    }
    async getArchived(ref) {
        const archived = await this.archiveStore.get(ref.id);
        if (archived === undefined)
            return undefined;
        if (archived.cwd !== ref.cwd)
            return undefined;
        return archived;
    }
    isCurrentActiveSession(session) {
        return this.active.get(session.sessionId)?.runtime.session === session;
    }
    /**
     * The command service tracks sessions by id alone; its callbacks only ever
     * run against a session the caller just resolved as active, so the cwd
     * needed for a full ref comes from that active runtime.
     */
    activeSessionRef(sessionId) {
        const active = this.active.get(sessionId);
        if (active === undefined)
            throw new Error("Session not found");
        return { id: sessionId, cwd: active.runtime.cwd };
    }
    activeForRef(ref) {
        const sessionId = ref.id;
        const exact = this.active.get(sessionId);
        if (exact !== undefined && refMatchesActiveSession(ref, exact))
            return exact;
        for (const [candidateId, active] of this.active.entries()) {
            if (candidateId.startsWith(sessionId) && refMatchesActiveSession(ref, active))
                return active;
        }
        return undefined;
    }
    startupSessionForRef(ref) {
        const sessionId = ref.id;
        const exact = this.startupSessions.get(sessionId);
        if (exact !== undefined && refMatchesStartupSession(ref, exact))
            return exact;
        for (const [candidateId, session] of this.startupSessions.entries()) {
            if (candidateId.startsWith(sessionId) && refMatchesStartupSession(ref, session))
                return session;
        }
        return undefined;
    }
    /**
     * The session to serve a read-only status or a dialog close for, while it
     * can still be found: active first, then still starting up, and only then
     * the on-demand open path (which a stale close on an idle session needs for
     * its status projection).
     */
    async sessionForStatusOrDialogClose(ref) {
        const reachable = this.activeForRef(ref)?.runtime.session ?? this.startupSessionForRef(ref);
        if (reachable !== undefined)
            return reachable;
        return this.getOrOpen(ref);
    }
    /**
     * Construct a session while telling waiting browsers which phase of startup
     * they are waiting on. The reporting wraps the *whole* construction rather
     * than the inner bookkeeping `try`, because the runtime construction that runs
     * first is both the slowest phase and one that can fail on its own; a clear
     * that only ran for the later phases would leave a stale label behind.
     */
    async create(sessionManager, cwd, options = {}) {
        const startup = this.startupProgress(sessionManager, options.startupIntent ?? "open", options.startupToken);
        try {
            return await this.createSessionRuntime(sessionManager, cwd, options, startup);
        }
        finally {
            startup.end();
        }
    }
    async createSessionRuntime(sessionManager, cwd, options, startup) {
        startup.report(STARTUP_PHASE_RUNTIME);
        const delegationToolsEnabled = options.creationProvenance !== "tracked-subsession"
            && await sessionAllowsDelegationTools(sessionManager, this.sessionManager);
        const runtime = await this.createAgentRuntime(this.createRuntime, {
            cwd,
            agentDir: this.agentDir,
            sessionManager,
            delegationToolsEnabled,
            ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
            ...(options.initialThinkingLevel === undefined ? {} : { initialThinkingLevel: options.initialThinkingLevel }),
        });
        const active = { runtime, unsubscribe: noop };
        let boundSession = runtime.session;
        let notificationGeneration = options.notificationGeneration;
        let notificationOwnership = options.notifications === "disabled"
            ? "disabled"
            : notificationGeneration === undefined
                ? "registered"
                : "external";
        if (notificationOwnership === "registered") {
            const notificationIdentity = notificationIdentityForSession(runtime.session);
            const existingCandidate = this.notificationStore.beginReplacementForSession(notificationIdentity.sessionId, notificationIdentity.cwd);
            if (existingCandidate !== undefined) {
                notificationGeneration = existingCandidate;
                notificationOwnership = "replacement";
            }
            else {
                const registration = this.notificationStore.registerSession(notificationIdentity.sessionId, notificationIdentity.cwd);
                notificationGeneration = registration.generation;
                this.publishNotificationMutations(registration.mutations);
            }
        }
        if (notificationGeneration !== undefined)
            this.notificationGenerationBySession.set(runtime.session, notificationGeneration);
        try {
            if (options.creationProvenance === "tracked-subsession") {
                await this.publishUnreadMutations(this.unreadStore.excludeSession(runtime.session.sessionId, canonicalizeStoredCwd(runtime.session.sessionManager.getCwd())));
            }
            else {
                await this.recoverSubsessionTrackingForOpenedSession(runtime.session);
            }
            startup.report(STARTUP_PHASE_EXTENSIONS);
            await this.bindSessionExtensions(runtime.session, notificationGeneration);
            this.bindRuntime(active);
            runtime.setRebindSession(async (session) => {
                const priorGeneration = notificationGeneration;
                let candidateGeneration;
                try {
                    await this.prepareUnreadRuntimeRebind(boundSession, session);
                    await this.recoverSubsessionTrackingForOpenedSession(session);
                    if (priorGeneration !== undefined) {
                        candidateGeneration = this.notificationStore.beginReplacement(priorGeneration, notificationIdentityForSession(session));
                        this.notificationGenerationBySession.set(session, candidateGeneration);
                    }
                    this.bindRuntime(active, session);
                    // The runtime being replaced parked every dialog the store still
                    // holds for this session; settle those waits before the new
                    // runtime's extensions can open fresh dialogs under the same id.
                    this.endSessionExtensionDialogs(boundSession.sessionId);
                    boundSession = session;
                    await this.bindSessionExtensions(session, candidateGeneration);
                    if (candidateGeneration !== undefined) {
                        this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
                        notificationGeneration = candidateGeneration;
                    }
                }
                catch (error) {
                    if (candidateGeneration !== undefined) {
                        this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration, "candidate"));
                        notificationGeneration = candidateGeneration;
                        this.notificationGenerationBySession.set(session, candidateGeneration);
                    }
                    throw error;
                }
            });
            this.active.set(runtime.session.sessionId, active);
            if (notificationOwnership === "replacement" && notificationGeneration !== undefined) {
                this.publishNotificationMutations(this.notificationStore.commitReplacement(notificationGeneration));
                notificationOwnership = "external";
            }
            this.publishStatus(runtime.session);
            return active;
        }
        catch (error) {
            if (notificationGeneration !== undefined) {
                if (notificationOwnership === "registered") {
                    this.publishNotificationMutations(this.notificationStore.clearSession(runtime.session.sessionId, "initialization-failed"));
                }
                else if (notificationOwnership === "replacement") {
                    this.publishNotificationMutations(this.notificationStore.abortReplacement(notificationGeneration));
                }
            }
            active.unsubscribe();
            this.forgetUnreadActivity(boundSession);
            // A session_start dialog may already be parked when a later startup
            // step fails; its waiter dies with the runtime being torn down here.
            this.endSessionExtensionDialogs(boundSession.sessionId);
            let removedActive = false;
            for (const [sessionId, candidate] of this.active.entries()) {
                if (candidate !== active)
                    continue;
                this.active.delete(sessionId);
                this.activities.delete(sessionId);
                this.clearAuthLossWarningsForSession(sessionId);
                this.clearCompactionPromptQueue(sessionId);
                removedActive = true;
            }
            if (removedActive) {
                this.workspaceActivity?.removeSession(runtime.session.sessionId, runtime.session.sessionManager.getCwd());
            }
            try {
                await runtime.session.abort();
            }
            finally {
                await runtime.dispose();
            }
            throw error;
        }
    }
    async bindSessionExtensions(session, generation) {
        const uiContext = this.sessionUiContext(session, generation);
        // A `session_start` hook can park this bind on a dialog the browser has
        // not answered yet. On the initial create/open path the session becomes
        // active only after this returns, so register it for the duration: the
        // answer that unblocks startup has to be reachable while it waits.
        this.startupSessions.set(session.sessionId, session);
        try {
            await session.bindExtensions({
                uiContext,
                mode: "rpc",
                onError: (error) => {
                    const message = `${error.extensionPath}: ${error.error}`;
                    this.publishActivity(session, "extension error", "error", message);
                    this.events.publish(session.sessionId, { type: "session.error", message });
                },
            });
        }
        finally {
            this.startupSessions.delete(session.sessionId);
        }
    }
    replaceSessionNotificationContext(session, generation) {
        session.extensionRunner.setUIContext(this.sessionUiContext(session, generation), "rpc");
    }
    sessionUiContext(session, generation) {
        const baseUiContext = session.extensionRunner.getUIContext();
        const notify = (message, type) => {
            if (generation === undefined) {
                this.events.publish(session.sessionId, {
                    type: "command.output",
                    level: type === "error" ? "error" : "info",
                    message,
                });
                return;
            }
            const added = this.notificationStore.addNotification(generation, message, type);
            this.publishNotificationMutations(added.mutations);
        };
        // PI WEB owns the browser-facing dialog, notification, and text-formatting
        // boundaries: the three dialog primitives park daemon-held Promises that
        // the browser answers, while every other UI method delegates to Pi's
        // headless defaults so unsupported surfaces cancel safely instead of
        // hanging.
        return new Proxy(baseUiContext, {
            get: (target, property, receiver) => {
                if (property === "notify")
                    return notify;
                if (property === "theme")
                    return plainTextTheme;
                if (property === "confirm") {
                    return (title, message, opts) => this.openExtensionDialog(session, { kind: "confirm", title, message }, opts);
                }
                if (property === "select") {
                    return (title, options, opts) => this.openExtensionDialog(session, { kind: "select", title, options }, opts);
                }
                if (property === "input") {
                    return (title, placeholder, opts) => this.openExtensionDialog(session, { kind: "input", title, placeholder }, opts);
                }
                const value = Reflect.get(target, property, receiver);
                return value;
            },
        });
    }
    publishNotificationMutations(mutations) {
        for (const mutation of mutations) {
            this.events.publish(mutation.sessionId, mutation.inboxEvent);
            this.events.publishNotificationSummary(mutation.summaryEvent);
        }
    }
    async prepareUnreadRuntimeRebind(previous, next) {
        const previousCwd = canonicalizeStoredCwd(previous.sessionManager.getCwd());
        this.unreadStore.forgetActivity(previous.sessionId, previousCwd);
        const nextCwd = canonicalizeStoredCwd(next.sessionManager.getCwd());
        if (previous.sessionId === next.sessionId && cwdPathsEqual(previousCwd, nextCwd))
            return;
        await this.publishUnreadMutations(this.unreadStore.forgetSession(previous.sessionId, previousCwd));
    }
    forgetUnreadActivity(session) {
        this.unreadStore.forgetActivity(session.sessionId, canonicalizeStoredCwd(session.sessionManager.getCwd()));
    }
    async forgetUnreadSessions(identities) {
        const mutations = [];
        for (const identity of identities) {
            mutations.push(...this.unreadStore.forgetSession(identity.sessionId, canonicalizeStoredCwd(identity.cwd)));
        }
        await this.publishUnreadMutations(mutations);
    }
    observeUnreadActivityState(session) {
        const mutations = this.unreadStore.observeActivityState(session.sessionId, canonicalizeStoredCwd(session.sessionManager.getCwd()), this.hasActiveWork(session));
        if (mutations.length === 0)
            return;
        void this.publishUnreadMutations(mutations).catch(() => undefined);
    }
    publishUnreadMutations(mutations) {
        // The store applied the mutations already, so the status projection is told
        // now rather than after the durable flush: it reads in-memory unread state
        // and must not lag behind the rows the browser is about to see.
        if (mutations.length > 0)
            this.onUnreadChanged?.();
        this.enqueueUnreadMutations(mutations);
        this.unreadPublicationFlushRequested = true;
        if (this.unreadPublication === undefined && this.unreadPublicationRetryTimer !== undefined) {
            const failure = this.unreadPublicationFailure;
            return Promise.reject(failure instanceof Error
                ? failure
                : new Error("Session unread publication is awaiting retry", { cause: failure }));
        }
        return this.ensureUnreadPublication();
    }
    ensureUnreadPublication() {
        const existing = this.unreadPublication;
        if (existing !== undefined)
            return existing;
        const publication = this.drainUnreadPublication();
        this.unreadPublication = publication;
        void publication.then(() => {
            if (this.unreadPublication === publication)
                this.unreadPublication = undefined;
        }, (error) => {
            if (this.unreadPublication === publication)
                this.unreadPublication = undefined;
            this.unreadPublicationFailure = error;
            this.logger.info({ error: error instanceof Error ? error.message : String(error) }, "failed to publish durable session unread mutations");
            this.scheduleUnreadPublicationRetry();
        });
        return publication;
    }
    async drainUnreadPublication() {
        while (this.unreadPublicationFlushRequested || this.pendingUnreadMutations.length > 0) {
            this.unreadPublicationFlushRequested = false;
            const batch = this.pendingUnreadMutations.splice(0);
            let publishedCount = 0;
            try {
                await this.unreadStore.flush();
                for (const mutation of batch) {
                    this.events.publishGlobal(mutation.event);
                    publishedCount += 1;
                }
            }
            catch (error) {
                this.prependUnreadMutations(batch.slice(publishedCount));
                this.unreadPublicationFlushRequested = true;
                throw error;
            }
            this.unreadPublicationFailure = undefined;
            this.clearUnreadPublicationRetry();
        }
    }
    enqueueUnreadMutations(mutations) {
        this.pendingUnreadMutations.push(...mutations);
        this.trimPendingUnreadMutations();
    }
    prependUnreadMutations(mutations) {
        this.pendingUnreadMutations.unshift(...mutations);
        this.trimPendingUnreadMutations();
    }
    trimPendingUnreadMutations() {
        const excess = this.pendingUnreadMutations.length - MAX_PENDING_UNREAD_MUTATIONS;
        if (excess > 0)
            this.pendingUnreadMutations.splice(0, excess);
    }
    scheduleUnreadPublicationRetry() {
        if (this.unreadPublicationStopped || this.unreadPublicationRetryTimer !== undefined)
            return;
        const delay = this.unreadPublicationRetryDelayMs;
        this.unreadPublicationRetryDelayMs = Math.min(Math.max(delay * 2, this.unreadPublicationRetryInitialMs), Math.max(MAX_UNREAD_PUBLICATION_RETRY_MS, this.unreadPublicationRetryInitialMs));
        this.unreadPublicationRetryTimer = setTimeout(() => {
            this.unreadPublicationRetryTimer = undefined;
            void this.ensureUnreadPublication().catch(() => undefined);
        }, delay);
        this.unreadPublicationRetryTimer.unref();
    }
    clearUnreadPublicationRetry() {
        if (this.unreadPublicationRetryTimer !== undefined)
            clearTimeout(this.unreadPublicationRetryTimer);
        this.unreadPublicationRetryTimer = undefined;
        this.unreadPublicationRetryDelayMs = this.unreadPublicationRetryInitialMs;
    }
    bindRuntime(active, session = active.runtime.session) {
        active.unsubscribe();
        for (const [sessionId, candidate] of this.active.entries()) {
            if (candidate === active) {
                this.active.delete(sessionId);
                if (sessionId !== session.sessionId)
                    this.clearCompactionPromptQueue(sessionId);
            }
        }
        active.unsubscribe = session.subscribe((event) => {
            this.events.publish(session.sessionId, toClientEvent(event, session.thinkingLevel));
            this.publishActivityForEvent(session, event);
            const eventType = getString(event, "type");
            if (eventType === "agent_end")
                this.abortRunScopedExtensionDialogs(session.sessionId);
            if (eventType === "compaction_end")
                this.scheduleCompactionQueueDrain(session.sessionId);
            if (eventType === "agent_start" || eventType === "agent_end")
                this.scheduleCompactionQueueDrain(session.sessionId);
            this.publishStatus(session);
            this.updateSubsessionTracking(session);
        });
        this.active.set(session.sessionId, active);
    }
    scheduleCompactionQueueDrain(sessionId, delayMs = 0) {
        if (!this.compactionPromptQueues.has(sessionId) || this.compactionDrainTimers.has(sessionId))
            return;
        const timer = setTimeout(() => {
            this.compactionDrainTimers.delete(sessionId);
            this.drainCompactionPromptQueue(sessionId);
        }, delayMs);
        this.compactionDrainTimers.set(sessionId, timer);
    }
    drainCompactionPromptQueue(sessionId) {
        const active = this.active.get(sessionId);
        if (active === undefined)
            return;
        const { session } = active.runtime;
        if (session.isCompacting) {
            this.scheduleCompactionQueueDrain(sessionId, 100);
            return;
        }
        if (session.isStreaming) {
            const queued = this.takeCompactionPromptQueue(sessionId);
            if (queued.length === 0)
                return;
            this.publishStatus(session);
            for (const prompt of queued)
                void this.submitPrompt(session, prompt.text, prompt.kind, prompt.images, prompt.echoUserMessage ?? true);
            return;
        }
        const prompt = this.shiftCompactionPrompt(sessionId);
        if (prompt === undefined)
            return;
        this.publishStatus(session);
        const submitted = this.submitPrompt(session, prompt.text, undefined, prompt.images, prompt.echoUserMessage ?? true);
        void submitted.finally(() => { this.scheduleCompactionQueueDrain(sessionId); });
    }
    takeCompactionPromptQueue(sessionId) {
        const queued = this.compactionPromptQueues.get(sessionId) ?? [];
        this.compactionPromptQueues.delete(sessionId);
        return queued;
    }
    shiftCompactionPrompt(sessionId) {
        const queue = this.compactionPromptQueues.get(sessionId);
        const prompt = queue?.shift();
        if (queue === undefined || queue.length === 0)
            this.compactionPromptQueues.delete(sessionId);
        return prompt;
    }
    clearCompactionPromptQueue(sessionId) {
        this.compactionPromptQueues.delete(sessionId);
        const timer = this.compactionDrainTimers.get(sessionId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.compactionDrainTimers.delete(sessionId);
        }
    }
    clearCompactionDrainTimers() {
        for (const timer of this.compactionDrainTimers.values())
            clearTimeout(timer);
        this.compactionDrainTimers.clear();
    }
    maybeGenerateSessionName(session, firstMessage) {
        if (session.sessionName !== undefined || session.messages.length !== 0 || session.isStreaming || session.isCompacting)
            return;
        const deterministicName = deterministicSessionName(firstMessage);
        if (deterministicName !== undefined) {
            this.applyGeneratedSessionName(session, deterministicName);
            return;
        }
        const model = session.model;
        if (model === undefined)
            return;
        void generateShortSessionName(session.agent.streamFunction, model, firstMessage).then((name) => {
            this.applyGeneratedSessionName(session, name ?? fallbackSessionName(firstMessage));
        }).catch(() => {
            this.applyGeneratedSessionName(session, fallbackSessionName(firstMessage));
        });
    }
    applyGeneratedSessionName(session, name) {
        if (name === undefined || session.sessionName !== undefined)
            return;
        if (this.treeNavigations.has(session)) {
            this.deferredGeneratedSessionNames.set(session, name);
            return;
        }
        session.setSessionName(name);
        this.publishSessionName(session);
    }
    flushDeferredTreeNavigationWork(session) {
        const generatedName = this.deferredGeneratedSessionNames.get(session);
        this.deferredGeneratedSessionNames.delete(session);
        if (generatedName !== undefined) {
            try {
                this.applyGeneratedSessionName(session, generatedName);
            }
            catch (error) {
                this.logger.info({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }, "failed to apply deferred session name");
            }
        }
        const notifications = this.deferredSubsessionNotifications.get(session) ?? [];
        this.deferredSubsessionNotifications.delete(session);
        for (const notification of notifications) {
            void this.deliverSubsessionNotification(session, notification).catch((error) => {
                this.logSubsessionNotificationFailure(notification.parentId, notification.childId, error);
            });
        }
    }
    applyAuthChange(change = {}) {
        // ModelRuntime.login()/logout() refresh the shared runtime before AuthService
        // emits the change, so no refresh is needed here. Keeping this synchronous
        // also lets every active session observe the same committed auth snapshot.
        for (const active of this.active.values()) {
            const { session } = active.runtime;
            this.syncCurrentModelAuthWarning(session, change.removedProviderId);
            this.publishStatus(session);
        }
    }
    syncCurrentModelAuthWarning(session, removedProviderId) {
        const model = session.model;
        if (model === undefined)
            return;
        if (model.provider === "unknown" && model.id === "unknown")
            return;
        const warningKey = authLossWarningKey(session.sessionId, model.provider, model.id);
        const registered = session.modelRuntime.getModel(model.provider, model.id);
        if (registered === undefined)
            return;
        if (session.modelRuntime.hasConfiguredAuth(model.provider)) {
            this.authLossWarnings.delete(warningKey);
            return;
        }
        if (removedProviderId === undefined || model.provider !== removedProviderId || this.authLossWarnings.has(warningKey))
            return;
        this.authLossWarnings.add(warningKey);
        this.events.publish(session.sessionId, {
            type: "command.output",
            level: "error",
            message: `Authentication for ${model.provider}/${model.id} was removed. Use /model to select another model.`,
        });
    }
    clearAuthLossWarningsForSession(sessionId) {
        const prefix = `${sessionId}:`;
        for (const key of this.authLossWarnings) {
            if (key.startsWith(prefix))
                this.authLossWarnings.delete(key);
        }
    }
    publishSessionName(session) {
        const event = session.sessionName === undefined
            ? { type: "session.name", sessionId: session.sessionId }
            : { type: "session.name", sessionId: session.sessionId, name: session.sessionName };
        this.events.publish(session.sessionId, event);
        this.events.publishGlobal(event);
    }
    publishHeartbeats() {
        for (const active of this.active.values()) {
            const { session } = active.runtime;
            // Re-evaluate subsession completion here too: agent_end can arrive while
            // the session still reports active work transiently, so the event-driven
            // latch may not fire. The heartbeat re-checks once the session settles.
            this.updateSubsessionTracking(session);
            const activity = this.activities.get(session.sessionId);
            if (!this.hasActiveWork(session)) {
                if (activity?.phase === "active")
                    this.publishStatus(session);
                continue;
            }
            this.publishStatus(session);
            if (activity?.phase === "active")
                this.publishActivity(session, activity.label, "active", activity.detail);
            else
                this.publishActivity(session, this.activityLabelFromStatus(session), "active");
        }
    }
    activityLabelFromStatus(session) {
        if (this.treeNavigations.has(session))
            return "navigating session tree";
        if (this.isSessionEntryMutationActive(session))
            return "updating session";
        if (session.isCompacting)
            return "compacting";
        if (session.isBashRunning)
            return "running bash";
        if (session.isStreaming)
            return "agent running";
        if (this.pendingMessageCount(session) > 0)
            return "queued";
        return "active";
    }
    hasActiveWork(session) {
        return this.treeNavigations.has(session)
            || this.isSessionEntryMutationActive(session)
            || this.isTreeExclusiveOperationActive(session)
            || sessionHasActiveWork(session, this.compactionQueuedMessages(session.sessionId).length);
    }
    async runTreeExclusiveOperation(targets, activeError, operation) {
        const sessionIds = new Set();
        const runtimes = new Set();
        const sessions = new Set();
        for (const target of targets) {
            const runtime = target.runtime ?? (target.session === undefined ? undefined : this.activeRuntimeForSession(target.session));
            const session = target.session ?? runtime?.session;
            if (session !== undefined && this.hasActiveWork(session))
                throw new Error(activeError);
            sessionIds.add(target.sessionId);
            if (runtime !== undefined)
                runtimes.add(runtime);
            if (session !== undefined)
                sessions.add(session);
        }
        for (const sessionId of sessionIds) {
            this.treeExclusiveSessionOperationCounts.set(sessionId, (this.treeExclusiveSessionOperationCounts.get(sessionId) ?? 0) + 1);
        }
        for (const runtime of runtimes) {
            this.treeExclusiveRuntimeOperationCounts.set(runtime, (this.treeExclusiveRuntimeOperationCounts.get(runtime) ?? 0) + 1);
        }
        for (const session of sessions)
            this.observeUnreadActivityState(session);
        try {
            return await operation();
        }
        finally {
            for (const runtime of runtimes)
                decrementWeakCount(this.treeExclusiveRuntimeOperationCounts, runtime);
            for (const sessionId of sessionIds)
                decrementMapCount(this.treeExclusiveSessionOperationCounts, sessionId);
            for (const session of sessions) {
                if (this.isCurrentActiveSession(session))
                    this.observeUnreadActivityState(session);
            }
        }
    }
    isTreeExclusiveSessionIdentityActive(sessionId) {
        return (this.treeExclusiveSessionOperationCounts.get(sessionId) ?? 0) > 0;
    }
    isTreeExclusiveOperationActive(session) {
        if (this.isTreeExclusiveSessionIdentityActive(session.sessionId))
            return true;
        const runtime = this.activeRuntimeForSession(session);
        return runtime !== undefined && (this.treeExclusiveRuntimeOperationCounts.get(runtime) ?? 0) > 0;
    }
    activeRuntimeForSession(session) {
        for (const active of new Set(this.active.values())) {
            if (active.runtime.session === session)
                return active.runtime;
        }
        return undefined;
    }
    assertTreeNavigationInactive(session, action) {
        if (this.treeNavigations.has(session))
            throw new Error(`Cannot ${action} while session tree navigation is active`);
    }
    async runSessionEntryMutation(session, action, operation) {
        this.beginSessionEntryMutation(session, action);
        try {
            return await operation();
        }
        finally {
            this.endSessionEntryMutation(session);
        }
    }
    beginSessionEntryMutation(session, action) {
        this.assertTreeNavigationInactive(session, action);
        this.sessionEntryMutationCounts.set(session, (this.sessionEntryMutationCounts.get(session) ?? 0) + 1);
        this.observeUnreadActivityState(session);
    }
    endSessionEntryMutation(session) {
        const remaining = (this.sessionEntryMutationCounts.get(session) ?? 1) - 1;
        if (remaining <= 0)
            this.sessionEntryMutationCounts.delete(session);
        else
            this.sessionEntryMutationCounts.set(session, remaining);
        this.observeUnreadActivityState(session);
    }
    isSessionEntryMutationActive(session) {
        return (this.sessionEntryMutationCounts.get(session) ?? 0) > 0;
    }
    publishActivityForEvent(session, event) {
        const eventType = getString(event, "type");
        if (eventType === undefined)
            return;
        if (eventType === "agent_start") {
            this.publishActivity(session, "agent running", "active");
            return;
        }
        if (eventType === "agent_end") {
            this.publishActivity(session, "idle", "idle");
            setTimeout(() => {
                this.publishActivity(session, "idle", "idle");
                this.publishStatus(session);
            }, 250);
            return;
        }
        if (eventType === "turn_end") {
            this.publishActivity(session, "turn complete", "idle");
            return;
        }
        if (eventType === "message_start") {
            this.publishActivity(session, "message started", "active");
            return;
        }
        if (eventType === "message_end") {
            this.publishActivity(session, "message complete", "idle");
            return;
        }
        if (eventType === "message_update") {
            this.publishActivity(session, "receiving response", "active");
            return;
        }
        if (eventType === "tool_execution_start") {
            this.publishActivity(session, "running tool", "active", getString(event, "toolName"));
            return;
        }
        if (eventType === "tool_execution_end") {
            const isError = getBoolean(event, "isError") === true;
            this.publishActivity(session, isError ? "tool failed" : "tool complete", isError ? "error" : "idle", getString(event, "toolName"));
            return;
        }
        if (eventType === "bash_execution_start") {
            this.publishActivity(session, "running bash", "active");
            return;
        }
        if (eventType === "bash_execution_end") {
            this.publishActivity(session, "bash complete", "idle");
            return;
        }
        if (this.hasActiveWork(session))
            this.publishActivity(session, eventType.replaceAll("_", " "), "active");
    }
    /**
     * Build the reporter for one session construction.
     *
     * The session id is known before any await — a `SessionManager` has its id
     * from construction — so the daemon can name what it is starting even though
     * the `PiAgentSession` that {@link publishActivity} needs does not exist yet.
     * Without an id there is nothing to report against, so the reporter stays
     * silent and the browser keeps its own generic wording.
     */
    startupProgress(sessionManager, intent, startupToken) {
        const sessionId = sessionManager.getSessionId();
        if (sessionId === "")
            return { report: noop, end: noop };
        const label = intent === "create" ? "Creating session" : "Opening session";
        return {
            report: (phase) => { this.publishStartupProgress(sessionId, startupToken, label, "active", this.startupDetail(phase)); },
            end: () => {
                // A real activity published during the window (an extension error, say)
                // is the truth about this session and must survive the clear.
                if (this.activities.has(sessionId))
                    return;
                this.publishStartupProgress(sessionId, startupToken, "idle", "idle", undefined);
            },
        };
    }
    startupDetail(phase) {
        return this.catalogRefreshStatus?.isRefreshInFlight() === true
            ? `${phase} · ${STARTUP_CONCURRENT_CATALOG_REFRESH}`
            : phase;
    }
    /**
     * Report startup progress on the global channel only, echoing the caller's
     * correlation token so a waiting browser row recognises its own construction.
     *
     * Unlike {@link publishActivity} this deliberately records nothing: no
     * `activities` entry, no workspace activity, no unread observation. There is
     * no session to own that state, and a failed creation would leave it stranded.
     *
     * Every report is marked `startup`, which is what keeps a session that is
     * merely opening from counting as one doing work. This is the only publisher
     * that sets the marker, and because it writes no `activities` entry no later
     * heartbeat re-publication can carry it.
     */
    publishStartupProgress(sessionId, startupToken, label, phase, detail) {
        const at = new Date().toISOString();
        const activity = detail === undefined ? { sessionId, phase, label, at, startup: true } : { sessionId, phase, label, detail, at, startup: true };
        this.events.publishGlobal(startupToken === undefined ? { type: "session.startup", activity } : { type: "session.startup", startupToken, activity });
    }
    publishActivity(session, label, phase, detail) {
        const at = new Date().toISOString();
        const stored = detail === undefined ? { phase, label, at } : { phase, label, detail, at };
        this.activities.set(session.sessionId, stored);
        const activity = detail === undefined ? { sessionId: session.sessionId, phase, label, at } : { sessionId: session.sessionId, phase, label, detail, at };
        this.workspaceActivity?.applySessionActivity(session.sessionManager.getCwd(), activity);
        this.events.publish(session.sessionId, { type: "activity.update", activity });
        this.events.publishGlobal({ type: "activity.update", activity });
        this.observeUnreadActivityState(session);
    }
    publishStatus(session) {
        const status = this.statusFromSession(session);
        this.clearStaleActiveActivity(session);
        this.workspaceActivity?.applySessionStatus(session.sessionManager.getCwd(), status);
        this.events.publish(session.sessionId, { type: "status.update", status });
        this.events.publishGlobal({ type: "status.update", status });
        this.observeUnreadActivityState(session);
    }
    clearStaleActiveActivity(session) {
        const current = this.activities.get(session.sessionId);
        if (current?.phase !== "active" || this.hasActiveWork(session))
            return;
        const at = new Date().toISOString();
        const stored = { phase: "idle", label: "idle", at };
        this.activities.set(session.sessionId, stored);
        const activity = { sessionId: session.sessionId, ...stored };
        this.events.publish(session.sessionId, { type: "activity.update", activity });
        this.events.publishGlobal({ type: "activity.update", activity });
    }
    statusFromSession(session) {
        const stats = session.getSessionStats();
        const model = session.model === undefined ? undefined : modelToClientModel(session.model);
        const contextUsage = session.getContextUsage();
        const warnings = this.warningsForSession(session);
        const pendingAsk = this.pendingAskStore.pendingAsk(session.sessionId);
        const pendingDialogs = this.pendingExtensionDialogStore.pendingDialogs(session.sessionId);
        return {
            sessionId: session.sessionId,
            persisted: sessionFileExists(session.sessionFile),
            ...(model === undefined ? {} : { model }),
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            isBashRunning: session.isBashRunning,
            pendingMessageCount: this.pendingMessageCount(session),
            queuedMessages: queuedMessagesFromSession(session, this.compactionQueuedMessages(session.sessionId)),
            messageCount: session.messages.length,
            tokens: stats.tokens,
            cost: stats.cost,
            ...(contextUsage === undefined ? {} : { contextUsage }),
            ...(warnings.length === 0 ? {} : { warnings }),
            ...(pendingAsk === undefined ? {} : { pendingAsk }),
            ...(pendingDialogs.length === 0 ? {} : { pendingDialogs }),
        };
    }
    /**
     * Compute the live warning set for a session: runtime/resource diagnostics from
     * the active runtime (if any) plus the Anthropic subscription-auth notice. Read
     * fresh on each status publish so a rebuilt runtime or an auth/model change is
     * reflected without caching a stale snapshot.
     */
    warningsForSession(session) {
        const runtime = this.active.get(session.sessionId)?.runtime;
        const warnings = runtime === undefined ? [] : collectRuntimeWarnings(runtime);
        const anthropic = anthropicSubscriptionWarning(session, join(this.agentDir, "auth.json"));
        if (anthropic !== undefined)
            warnings.push(anthropic);
        return warnings;
    }
    pendingMessageCount(session) {
        return session.pendingMessageCount + this.compactionQueuedMessages(session.sessionId).length;
    }
    compactionQueuedMessages(sessionId) {
        return this.compactionPromptQueues.get(sessionId) ?? [];
    }
    hasQueuedMessageText(session, text) {
        return queuedMessagesFromSession(session, this.compactionQueuedMessages(session.sessionId)).some((message) => message.text === text);
    }
}
function previewResponseFromPlan(plan) {
    return {
        generatedAt: plan.generatedAt,
        thresholds: plan.thresholds,
        projects: plan.projects,
        totals: plan.totals,
        ...(plan.skippedBusySessionIds.length === 0 ? {} : { skippedBusySessionIds: plan.skippedBusySessionIds }),
    };
}
function uniqueBulkSessionRefs(refs) {
    const seen = new Set();
    const unique = [];
    for (const ref of refs) {
        const key = `${ref.cwd}\0${ref.id}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(ref);
    }
    return unique;
}
function bulkRefToSessionRef(ref) {
    return { id: ref.id, cwd: ref.cwd };
}
function findArchivedRecordForBulkRef(records, ref) {
    return records.find((record) => record.cwd === ref.cwd && (record.sessionId === ref.id || record.sessionId.startsWith(ref.id)));
}
function findListedSessionForBulkRef(context, ref) {
    return findSessionByIdOrPrefix(context.sessionsByCwd.get(ref.cwd) ?? [], ref.id);
}
function findSessionByIdOrPrefix(sessions, sessionId) {
    return sessions.find((session) => session.id === sessionId) ?? sessions.find((session) => session.id.startsWith(sessionId));
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function modelToClientModel(model) {
    if (model === undefined)
        return {};
    const name = getString(model, "name");
    const reasoning = getProperty(model, "reasoning");
    return {
        provider: model.provider,
        id: model.id,
        ...(name === undefined ? {} : { name }),
        contextWindow: model.contextWindow,
        ...(reasoning === undefined ? {} : { reasoning }),
    };
}
function notificationIdentityForSession(session) {
    return {
        sessionId: session.sessionId,
        cwd: canonicalizeStoredCwd(session.sessionManager.getCwd()),
    };
}
function clientSessionFromListEntry(session) {
    return {
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        persisted: true,
        ...(session.name === undefined ? {} : { name: session.name }),
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
    };
}
function archiveInputFromListEntry(session) {
    return {
        sessionId: session.id,
        cwd: session.cwd,
        path: session.path,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        ...(session.name === undefined ? {} : { name: session.name }),
        ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
    };
}
function archiveInputFromActiveSession(session) {
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "")
        throw new Error("Session is not persisted");
    const parentSessionPath = session.sessionManager.getHeader?.()?.parentSession;
    return {
        sessionId: session.sessionId,
        cwd: session.sessionManager.getCwd(),
        path: sessionFile,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: session.messages.length,
        firstMessage: "",
        ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    };
}
function archiveCandidateFromListEntry(session) {
    return {
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        archived: false,
        listEntry: session,
        ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
    };
}
function archiveCandidateFromArchivedRecord(record, fallback) {
    const path = record.originalPath ?? fallback?.path;
    if (path === undefined)
        return undefined;
    const parentSessionPath = record.parentSessionPath ?? fallback?.parentSessionPath;
    return {
        id: record.sessionId,
        path,
        cwd: record.cwd,
        archived: true,
        ...(fallback === undefined ? {} : { listEntry: fallback }),
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    };
}
function archiveCandidateFromActiveSession(session, archived) {
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "")
        throw new Error("Session is not persisted");
    const parentSessionPath = session.sessionManager.getHeader?.()?.parentSession;
    return {
        id: session.sessionId,
        path: sessionFile,
        cwd: session.sessionManager.getCwd(),
        archived,
        activeSession: session,
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    };
}
function archiveInputFromCandidate(candidate) {
    if (candidate.listEntry !== undefined)
        return archiveInputFromListEntry(candidate.listEntry);
    if (candidate.activeSession !== undefined)
        return archiveInputFromActiveSession(candidate.activeSession);
    throw new Error(`Session is not available for archiving: ${candidate.id}`);
}
function sessionHasActiveWork(session, extraQueuedMessageCount = 0) {
    return session.isStreaming || session.isCompacting || session.isBashRunning || session.pendingMessageCount + extraQueuedMessageCount > 0;
}
function sessionDisplayName(session) {
    return session.sessionName ?? session.sessionId;
}
function clientSessionFromArchivedRecord(record, fallback) {
    const path = record.originalPath ?? fallback?.path;
    const created = record.created ?? fallback?.created.toISOString();
    const modified = record.modified ?? fallback?.modified.toISOString();
    const messageCount = record.messageCount ?? fallback?.messageCount;
    const firstMessage = record.firstMessage ?? fallback?.firstMessage;
    if (path === undefined || created === undefined || modified === undefined || messageCount === undefined || firstMessage === undefined)
        return undefined;
    const name = record.name ?? fallback?.name;
    const parentSessionPath = record.parentSessionPath ?? fallback?.parentSessionPath;
    return {
        id: record.sessionId,
        path,
        cwd: record.cwd,
        ...(name === undefined ? {} : { name }),
        created,
        modified,
        messageCount,
        firstMessage,
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
        archived: true,
        archivedAt: record.archivedAt,
    };
}
function addSessionName(names, name) {
    const trimmed = name?.replace(/\s+/g, " ").trim();
    if (trimmed !== undefined && trimmed !== "")
        names.add(trimmed);
}
function compareArchivedRecords(a, b) {
    return archivedTimestamp(b) - archivedTimestamp(a);
}
function archivedTimestamp(record) {
    const time = Date.parse(record.archivedAt);
    return Number.isNaN(time) ? 0 : time;
}
function isDefined(value) {
    return value !== undefined;
}
/**
 * Resolve the delegation capability from server-owned, persisted session
 * provenance. A copied marker is not enough: the child header and reciprocal
 * parent link must identify the exact same session files.
 */
export async function sessionAllowsDelegationTools(sessionManager, managers) {
    const trackedLink = await verifiedTrackedSubsessionLink(managers, {
        sessionId: sessionManager.getSessionId(),
        sessionFile: sessionManager.getSessionFile(),
        sessionManager,
        cwd: sessionManager.getCwd(),
    });
    return trackedLink === undefined;
}
async function verifiedTrackedSubsessionLink(managers, session) {
    // Child markers are only hints; the current child header and reciprocal
    // parent custom link must agree on the exact ids and files before relinking.
    const entries = session.sessionManager.getEntries?.() ?? session.sessionManager.getBranch();
    let marker;
    for (const entry of entries) {
        const parsed = parsePersistedChildSubsessionLink(entry);
        if (parsed?.spawnedSessionId === session.sessionId)
            marker = parsed;
    }
    if (marker === undefined)
        return undefined;
    const childSessionFile = nonEmptyString(session.sessionFile);
    if (childSessionFile === undefined)
        return undefined;
    const childHeader = await readSessionHeaderSummary(childSessionFile);
    if (childHeader?.id !== session.sessionId)
        return undefined;
    const parentSessionFile = nonEmptyString(childHeader.parentSession);
    if (parentSessionFile === undefined)
        return undefined;
    const parentHeader = await readSessionHeaderSummary(parentSessionFile);
    if (parentHeader?.id !== marker.spawnedBySessionId)
        return undefined;
    const parentLink = findReciprocalParentSubsessionLink(managers, parentSessionFile, marker.spawnedBySessionId, session.sessionId, childSessionFile);
    if (parentLink === undefined)
        return undefined;
    return {
        parentSessionId: marker.spawnedBySessionId,
        childSessionId: session.sessionId,
        childSessionFile,
        parentSessionFile,
        cwd: parentLink.cwd ?? session.cwd,
    };
}
function findReciprocalParentSubsessionLink(managers, parentSessionFile, parentSessionId, childSessionId, childSessionFile) {
    let parentManager;
    try {
        parentManager = managers.open(parentSessionFile);
    }
    catch {
        return undefined;
    }
    const entries = parentManager.getEntries?.() ?? parentManager.getBranch();
    for (const entry of entries) {
        const link = parsePersistedParentSubsessionLink(entry);
        if (link === undefined)
            continue;
        if (link.spawnedBySessionId !== parentSessionId || link.spawnedSessionId !== childSessionId)
            continue;
        if (link.spawnedSessionFile === undefined || !sessionPathsEqual(link.spawnedSessionFile, childSessionFile))
            continue;
        return link;
    }
    return undefined;
}
function trackedSubsessionLinkFromParentLink(parentSessionId, link, parentSessionFile) {
    return {
        parentSessionId,
        childSessionId: link.spawnedSessionId,
        ...(link.spawnedSessionFile === undefined ? {} : { childSessionFile: link.spawnedSessionFile }),
        parentSessionFile,
        ...(link.cwd === undefined ? {} : { cwd: link.cwd }),
    };
}
function persistedParentSubsessionLinkData(link) {
    return {
        version: 1,
        spawnedBySessionId: link.parentSessionId,
        spawnedSessionId: link.childSessionId,
        ...(link.childSessionFile === undefined ? {} : { spawnedSessionFile: link.childSessionFile }),
        ...(link.cwd === undefined ? {} : { cwd: link.cwd }),
    };
}
function persistedChildSubsessionLinkData(parentSessionId, childSessionId) {
    return {
        version: 1,
        spawnedBySessionId: parentSessionId,
        spawnedSessionId: childSessionId,
    };
}
function parsePersistedParentSubsessionLink(entry) {
    if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SUBSESSION_LINK_CUSTOM_TYPE)
        return undefined;
    const data = entry["data"];
    if (!isRecord(data))
        return undefined;
    const spawnedBySessionId = getString(data, "spawnedBySessionId");
    const spawnedSessionId = getString(data, "spawnedSessionId");
    if (spawnedBySessionId === undefined || spawnedBySessionId === "" || spawnedSessionId === undefined || spawnedSessionId === "")
        return undefined;
    const spawnedSessionFile = getString(data, "spawnedSessionFile");
    const cwd = getString(data, "cwd");
    return {
        spawnedBySessionId,
        spawnedSessionId,
        ...(spawnedSessionFile === undefined || spawnedSessionFile === "" ? {} : { spawnedSessionFile }),
        ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    };
}
function parsePersistedChildSubsessionLink(entry) {
    if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SUBSESSION_CHILD_LINK_CUSTOM_TYPE)
        return undefined;
    const data = entry["data"];
    if (!isRecord(data))
        return undefined;
    const spawnedBySessionId = getString(data, "spawnedBySessionId");
    const spawnedSessionId = getString(data, "spawnedSessionId");
    if (spawnedBySessionId === undefined || spawnedBySessionId === "" || spawnedSessionId === undefined || spawnedSessionId === "")
        return undefined;
    return { spawnedBySessionId, spawnedSessionId };
}
function nonEmptyString(value) {
    return value === undefined || value === "" ? undefined : value;
}
function subsessionHydratedParentKey(parentSessionId, parentSessionFile) {
    return `${parentSessionId}\0${parentSessionFile ?? ""}`;
}
function sessionPathsEqual(a, b) {
    return cwdPathsEqual(a, b);
}
function sessionFileExists(sessionFile) {
    if (sessionFile === undefined || sessionFile === "")
        return false;
    try {
        return statSync(sessionFile).isFile();
    }
    catch {
        return false;
    }
}
function sessionFileMatches(session, expectedSessionFile) {
    const sessionFile = nonEmptyString(session.sessionFile);
    return sessionFile !== undefined && expectedSessionFile !== undefined && sessionPathsEqual(sessionFile, expectedSessionFile);
}
function activeSessionFileMatches(active, expectedSessionFile) {
    return sessionFileMatches(active.runtime.session, expectedSessionFile);
}
function trackedLinkParentFileMatches(link, parentSessionFile) {
    return link.parentSessionFile !== undefined && sessionPathsEqual(link.parentSessionFile, parentSessionFile);
}
async function sessionFileHeaderMatches(sessionFile, expected) {
    const header = await readSessionHeaderSummary(sessionFile);
    if (header?.id !== expected.sessionId)
        return false;
    if (expected.parentSessionFile === undefined)
        return true;
    return header.parentSession !== undefined && sessionPathsEqual(header.parentSession, expected.parentSessionFile);
}
async function clearParentSession(sessionFile) {
    const content = await readFile(sessionFile, "utf8");
    const newlineIndex = content.indexOf("\n");
    const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
    const rest = newlineIndex === -1 ? "" : content.slice(newlineIndex);
    const header = JSON.parse(firstLine);
    if (!isRecord(header) || header["type"] !== "session")
        throw new Error("Invalid session file header");
    if (header["parentSession"] === undefined)
        return;
    delete header["parentSession"];
    await writeFile(sessionFile, `${JSON.stringify(header)}${rest}`, "utf8");
}
function clearParentSessionHeader(sessionManager) {
    const header = sessionManager.getHeader?.();
    if (header !== undefined && header !== null)
        delete header.parentSession;
}
function clearSessionQueue(session) {
    session.clearQueue();
}
function queuedMessagesFromSession(session, extraQueuedMessages = []) {
    return [
        ...session.getSteeringMessages().map((text) => ({ kind: "steer", text })),
        ...session.getFollowUpMessages().map((text) => ({ kind: "followUp", text })),
        ...extraQueuedMessages,
    ];
}
function userTextMessage(text) {
    return { role: "user", content: text };
}
/**
 * Build the optimistic user message echoed to clients. When images are present
 * we mirror pi's content-array shape (`[{type:"text"}, {type:"image"}, ...]`) so
 * the local echo matches what pi persists in the session branch.
 */
function userMessage(text, images) {
    if (images.length === 0)
        return userTextMessage(text);
    const content = [];
    if (text !== "")
        content.push({ type: "text", text });
    content.push(...images);
    return { role: "user", content };
}
function buildPromptOptions(behavior, images) {
    const options = {};
    if (behavior !== undefined)
        options.streamingBehavior = behavior;
    if (images.length > 0)
        options.images = images;
    return Object.keys(options).length > 0 ? options : undefined;
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
/**
 * Attach the thinking level in effect when an assistant message was generated,
 * so chat bubbles can show it next to the model. Non-assistant messages pass
 * through by reference; assistant messages are copied only when a level is set.
 * "off" is the absence of thinking, not a level worth labeling on every bubble.
 */
function annotateAssistantThinkingLevel(message, thinkingLevel) {
    if (thinkingLevel === undefined || thinkingLevel === "" || thinkingLevel === "off")
        return message;
    if (!isRecord(message) || message["role"] !== "assistant")
        return message;
    return { ...message, thinkingLevel };
}
function historyMessages(session) {
    const messages = [];
    // Pi records the initial level at session creation and every later change, so
    // walking the branch yields the level in effect for each assistant message.
    let thinkingLevel;
    for (const entry of session.sessionManager.getBranch()) {
        if (!isRecord(entry))
            continue;
        if (entry["type"] === "message")
            messages.push(annotateAssistantThinkingLevel(entry["message"], thinkingLevel));
        else if (entry["type"] === "thinking_level_change") {
            const level = getString(entry, "thinkingLevel");
            if (level !== undefined)
                thinkingLevel = level;
        }
        else if (entry["type"] === "custom_message" && entry["display"] === true)
            messages.push({ role: "custom", content: entry["content"], customType: entry["customType"], details: entry["details"] });
        else if (entry["type"] === "compaction")
            messages.push({ role: "system", source: "compaction", content: `Compacted history:\n\n${stringValue(entry["summary"])}` });
        else if (entry["type"] === "branch_summary")
            messages.push({ role: "system", source: "branch_summary", content: `Branch summary:\n\n${stringValue(entry["summary"])}` });
    }
    return messages;
}
/** custom entry type used to persist parent -> child subsession links outside LLM context. */
const SUBSESSION_LINK_CUSTOM_TYPE = "pi-web.subsession.link";
/** custom entry type used to mark a child as created by spawn_subsession. */
const SUBSESSION_CHILD_LINK_CUSTOM_TYPE = "pi-web.subsession.spawned";
/** customType marking a parent-facing subsession-completion notice. */
const SUBSESSION_NOTIFICATION_CUSTOM_TYPE = "subsession.completion";
const SUBSESSION_NOTIFICATION_MAX_OUTPUT_CHARS = 2000;
/** Avoid duplicating a partial result in context when deliberate inspection can return the full output. */
function formatSubsessionNotificationOutput(childSessionId, text) {
    if (text.length > SUBSESSION_NOTIFICATION_MAX_OUTPUT_CHARS) {
        return `Output from subsession ${childSessionId} was too long for this completion notice and was omitted. Call check_subsession with sessionId "${childSessionId}" to retrieve the final output.`;
    }
    return `--- SUBSESSION OUTPUT: ${childSessionId} ---\n${text === "" ? "(no output)" : text}`;
}
/** Most recent assistant text from a history message list, or "" if none. */
function finalAssistantText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!isRecord(message) || message["role"] !== "assistant")
            continue;
        const content = message["content"];
        if (typeof content === "string")
            return content;
        if (!Array.isArray(content))
            continue;
        const texts = [];
        for (const part of content) {
            if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string")
                texts.push(part["text"]);
        }
        if (texts.length > 0)
            return texts.join("\n").trim();
    }
    return "";
}
function toClientEvent(event, thinkingLevel) {
    const eventType = getString(event, "type");
    const assistantMessageEvent = getProperty(event, "assistantMessageEvent");
    if (eventType === "message_update" && getString(assistantMessageEvent, "type") === "text_delta") {
        return { type: "assistant.delta", text: getString(assistantMessageEvent, "delta") ?? "" };
    }
    if (eventType === "message_update" && getString(assistantMessageEvent, "type") === "thinking_delta") {
        return { type: "assistant.thinking.delta", text: getString(assistantMessageEvent, "delta") ?? "" };
    }
    if (eventType === "tool_execution_start") {
        const args = getProperty(event, "args");
        return { type: "tool.start", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", summary: summarizeToolArgs(args), args };
    }
    if (eventType === "tool_execution_update") {
        const partialResult = getProperty(event, "partialResult");
        return { type: "tool.update", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", text: stringifyToolResult(partialResult), content: toolResultContent(partialResult), details: toolResultDetails(partialResult) };
    }
    if (eventType === "tool_execution_end") {
        const result = getProperty(event, "result");
        return { type: "tool.end", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", text: stringifyToolResult(result), content: toolResultContent(result), details: toolResultDetails(result), isError: getBoolean(event, "isError") === true };
    }
    if (eventType === "agent_start")
        return { type: "agent.start" };
    if (eventType === "agent_end")
        return { type: "agent.end" };
    if (eventType === "message_end") {
        const message = getProperty(event, "message");
        if (message === undefined)
            return { type: "message.end" };
        return { type: "message.end", message: annotateAssistantThinkingLevel(message, thinkingLevel) };
    }
    return { type: "pi.event", eventType: eventType ?? "unknown" };
}
function summarizeToolArgs(args) {
    if (!isRecord(args))
        return stringifyPrimitive(args);
    const command = getString(args, "command");
    if (command !== undefined)
        return command;
    const path = getString(args, "path");
    if (path !== undefined)
        return path;
    if (typeof args["oldText"] === "string" && typeof args["newText"] === "string")
        return "edit text replacement";
    const edits = args["edits"];
    if (Array.isArray(edits))
        return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
    const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
    return entries.map(([key, value]) => `${key}: ${shortToolValue(value)}`).join(" · ");
}
function shortToolValue(value) {
    if (typeof value === "string")
        return value.length > 80 ? `${value.slice(0, 77)}…` : value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value))
        return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
    if (typeof value === "object" && value !== null)
        return "object";
    return "";
}
function toolResultContent(result) {
    if (isRecord(result)) {
        const content = getProperty(result, "content");
        if (content !== undefined)
            return content;
        const text = getString(result, "text") ?? getString(result, "output");
        if (text !== undefined)
            return [{ type: "text", text }];
    }
    if (typeof result === "string")
        return [{ type: "text", text: result }];
    return result;
}
function toolResultDetails(result) {
    return isRecord(result) ? getProperty(result, "details") : undefined;
}
function stringifyToolResult(result) {
    if (typeof result === "string")
        return result;
    if (Array.isArray(result))
        return result.map(stringifyToolResult).filter((text) => text !== "").join("\n");
    if (isRecord(result)) {
        if (getString(result, "type") === "image")
            return "[image]";
        const text = getString(result, "text") ?? getString(result, "content") ?? getString(result, "output");
        if (text !== undefined)
            return text;
        const content = getProperty(result, "content");
        if (Array.isArray(content))
            return stringifyToolResult(content);
        return JSON.stringify(result, null, 2);
    }
    return stringifyPrimitive(result);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function getProperty(value, key) {
    return isRecord(value) ? value[key] : undefined;
}
function getString(value, key) {
    const property = getProperty(value, key);
    return typeof property === "string" ? property : undefined;
}
function getBoolean(value, key) {
    const property = getProperty(value, key);
    return typeof property === "boolean" ? property : undefined;
}
function stringifyPrimitive(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
        return String(value);
    return "";
}
//# sourceMappingURL=piSessionService.js.map