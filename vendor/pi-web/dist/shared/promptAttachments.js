/**
 * Image mime types supported by the pi coding agent. Mirrors
 * `detectSupportedImageMimeType` in `@earendil-works/pi-coding-agent`.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const supportedImageMimeTypes = new Set(SUPPORTED_IMAGE_MIME_TYPES);
/**
 * Maximum base64 payload per image. Matches pi's `DEFAULT_MAX_BYTES`
 * (4.5MB, headroom below Anthropic's 5MB inline image limit). pi resizes
 * images down to this size; we validate against it as the hard upper bound.
 */
export const MAX_INLINE_IMAGE_BASE64_BYTES = Math.round(4.5 * 1024 * 1024);
/** Maximum number of attachments allowed on a single prompt. */
export const MAX_PROMPT_ATTACHMENTS = 16;
export function isSupportedImageMimeType(value) {
    return typeof value === "string" && supportedImageMimeTypes.has(value);
}
export function extensionForImageMimeType(mimeType) {
    switch (mimeType) {
        case "image/jpeg": return "jpg";
        case "image/png": return "png";
        case "image/gif": return "gif";
        case "image/webp": return "webp";
        default: return "bin";
    }
}
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
export function base64ByteLength(data) {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
export function parsePromptAttachments(value, options = {}) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error("attachments must be an array");
    const maxAttachments = options.maxAttachments ?? MAX_PROMPT_ATTACHMENTS;
    if (value.length > maxAttachments)
        throw new Error(`too many attachments (max ${String(maxAttachments)})`);
    return value.map((entry, index) => parsePromptAttachment(entry, index, options));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsePromptAttachment(value, index, options) {
    if (!isRecord(value))
        throw new Error(`attachment ${String(index)} must be an object`);
    const record = value;
    const kind = record["kind"];
    if (kind === "image")
        return parseImageAttachment(record, index, options);
    if (kind === "file" && options.allowFileAttachments === true)
        return parseFileAttachment(record, index);
    throw new Error(`attachment ${String(index)} has unsupported kind`);
}
function parseImageAttachment(record, index, options) {
    const mimeType = record["mimeType"];
    if (!isSupportedImageMimeType(mimeType))
        throw new Error(`attachment ${String(index)} has unsupported image type`);
    const data = requireBase64Data(record["data"], index, { allowEmpty: false });
    if (options.enforceInlineSizeLimit === true && base64ByteLength(data) > MAX_INLINE_IMAGE_BASE64_BYTES) {
        throw new Error(`attachment ${String(index)} exceeds the inline image size limit`);
    }
    return {
        kind: "image",
        mimeType,
        data,
        ...attachmentName(record),
    };
}
function parseFileAttachment(record, index) {
    const mimeType = record["mimeType"];
    if (typeof mimeType !== "string" || mimeType.trim() === "")
        throw new Error(`attachment ${String(index)} has invalid file type`);
    return {
        kind: "file",
        mimeType: mimeType.trim(),
        data: requireBase64Data(record["data"], index, { allowEmpty: true }),
        ...attachmentName(record),
    };
}
function requireBase64Data(value, index, options) {
    if (typeof value !== "string" || (!options.allowEmpty && value === "") || !base64Pattern.test(value)) {
        throw new Error(`attachment ${String(index)} has invalid base64 data`);
    }
    return value;
}
function attachmentName(record) {
    const name = record["name"];
    return typeof name === "string" && name !== "" ? { name } : {};
}
//# sourceMappingURL=promptAttachments.js.map