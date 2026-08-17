/**
 * Registry of feature-gating capabilities. Add an entry here (plus the
 * runtime/requirements entries in `capabilities.ts`) when a feature needs
 * rolling-version gating.
 */
export const PI_WEB_CAPABILITIES = {
    pluginLifecycle: "plugins.lifecycle",
};
export const PI_WEB_PLUGIN_LIFECYCLE_VERSION = 1;
export const SESSION_UNREAD_LIMIT = 1_000;
export const SESSION_UNREAD_SESSION_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_CWD_MAX_LENGTH = 32 * 1024;
export const SESSION_UNREAD_CATALOG_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH = 64;
export const SESSION_NOTIFICATION_LIMIT = 100;
export const SESSION_NOTIFICATION_MESSAGE_BYTES = 8 * 1024;
/**
 * `customType` of the follow-up custom message that carries a closed ask back to
 * the model and into the transcript. Its `details` are an {@link AskUserOutcome}.
 */
export const ASK_USER_ANSWERS_CUSTOM_TYPE = "pi-web.ask.answers";
/** Largest question set one `ask_user` call may post. */
export const ASK_USER_QUESTION_LIMIT = 20;
/** Largest option list one question may offer. */
export const ASK_USER_OPTION_LIMIT = 12;
/** Length bound for ids: the ask id, question ids, and option values. */
export const ASK_USER_ID_MAX_LENGTH = 128;
/** Length bound for model-authored prose: questions, details, and option labels. */
export const ASK_USER_TEXT_MAX_LENGTH = 1_000;
/** Length bound for the free text a user types as a custom answer. */
export const ASK_USER_OTHER_TEXT_MAX_LENGTH = 4_000;
/** Length bound for extension-dialog ids. */
export const EXTENSION_DIALOG_ID_MAX_LENGTH = 128;
/** Length bound for extension-authored dialog prose: titles, messages, options, placeholders. */
export const EXTENSION_DIALOG_TEXT_MAX_LENGTH = 1_000;
/** Largest option list one `select` dialog may offer. */
export const EXTENSION_DIALOG_OPTION_LIMIT = 24;
/** Length bound for the text a user types into an `input` dialog. */
export const EXTENSION_DIALOG_INPUT_MAX_LENGTH = 4_000;
export const SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 10_000;
//# sourceMappingURL=apiTypes.js.map