import { classifyWorkspaceFile, workspaceFileName } from "../../shared/workspaceFiles.js";
const IMAGE_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
const HTML_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
// Native PDF viewers refuse to run in any sandboxed context, so this policy
// deliberately omits the `sandbox` directive and the embedding frame omits the
// sandbox attribute. Isolation comes from the response itself: `application/pdf`
// plus `nosniff` means these bytes can only reach the browser's PDF handler and
// can never become an active same-origin document, while `default-src 'none'`
// denies scripts, navigation helpers, and every subresource except the
// same-origin plugin document (`object-src 'self'`) that the viewer embeds.
const PDF_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'self'";
const DOWNLOAD_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'none'";
const ERROR_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'self'";
export function workspaceFilePreviewResponsePolicy(path, options = {}) {
    const filename = workspaceFileName(path);
    if (filename === "")
        throw new Error("Workspace file path must include a filename");
    if (options.download === true) {
        return responsePolicy("application/octet-stream", "attachment", filename, DOWNLOAD_CONTENT_SECURITY_POLICY);
    }
    const classification = classifyWorkspaceFile(path);
    if (classification === undefined || !("previewMimeType" in classification)) {
        throw new Error("Inline preview is not supported for this file type");
    }
    const contentSecurityPolicy = classification.mediaType === "image"
        ? IMAGE_CONTENT_SECURITY_POLICY
        : classification.mediaType === "html"
            ? HTML_CONTENT_SECURITY_POLICY
            : PDF_CONTENT_SECURITY_POLICY;
    return responsePolicy(classification.previewMimeType, "inline", filename, contentSecurityPolicy);
}
function responsePolicy(contentType, disposition, filename, contentSecurityPolicy) {
    return {
        contentType,
        contentDisposition: contentDisposition(disposition, filename),
        contentSecurityPolicy,
        contentTypeOptions: "nosniff",
    };
}
export function workspaceFilePreviewErrorResponsePolicy() {
    return {
        contentType: "application/json; charset=utf-8",
        contentDisposition: "inline",
        contentSecurityPolicy: ERROR_CONTENT_SECURITY_POLICY,
        contentTypeOptions: "nosniff",
    };
}
function contentDisposition(disposition, filename) {
    const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
    return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}
function encodeRfc5987Value(value) {
    return encodeURIComponent(value).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
//# sourceMappingURL=filePreviewResponsePolicy.js.map