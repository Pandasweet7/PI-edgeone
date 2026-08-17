import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { extensionForImageMimeType } from "../../shared/promptAttachments.js";
import { ensureInside, isNodeErrorWithCode, resolveParentInsideWorkspace } from "../workspaces/pathSafety.js";
/**
 * Default workspace-relative folder used when saving pasted/dropped
 * attachments for the agent to read with its own tools.
 */
export const DEFAULT_ATTACHMENT_FOLDER = ".pi-web/attachments";
/**
 * Convert validated attachments into pi-compatible inline image content.
 *
 * Mirrors pi's own CLI/TUI behaviour: each image is run through pi's
 * `resizeImage` so it fits within pi's max dimensions and inline byte budget
 * (2000x2000, ~4.5MB base64). Images that cannot be resized below the limit
 * are dropped, matching pi's `[Image omitted]` behaviour.
 */
export async function attachmentsToInlineImages(attachments) {
    const results = [];
    for (const attachment of attachments) {
        const bytes = Buffer.from(attachment.data, "base64");
        const resized = await resizeImage(bytes, attachment.mimeType);
        if (resized === null)
            continue;
        const note = formatDimensionNote(resized);
        results.push({
            image: { type: "image", data: resized.data, mimeType: resized.mimeType },
            ...(note === undefined ? {} : { dimensionNote: note }),
        });
    }
    return results;
}
/**
 * Write attachments into a workspace folder and return their relative paths.
 * Filenames are collision-safe and stay inside the workspace root.
 */
export async function saveAttachmentsToWorkspace(cwd, attachments, options = {}) {
    const folder = options.folder ?? DEFAULT_ATTACHMENT_FOLDER;
    const now = options.now ?? (() => new Date());
    const { root, target: requestedFolderTarget, relativePath: normalizedFolder } = await resolveParentInsideWorkspace(cwd, folder);
    await mkdir(requestedFolderTarget, { recursive: true });
    const folderTarget = await realpath(requestedFolderTarget);
    ensureInside(root, folderTarget);
    const stamp = timestamp(now());
    const saved = [];
    for (const [index, attachment] of attachments.entries()) {
        const bytes = Buffer.from(attachment.data, "base64");
        const filename = await writeUniqueAttachmentFile(folderTarget, attachmentFilename(attachment, stamp, index), bytes);
        const relativePath = normalizedFolder === "" ? filename : `${normalizedFolder}/${filename}`;
        saved.push({ path: relativePath, mimeType: attachment.mimeType, size: bytes.byteLength });
    }
    return saved;
}
async function writeUniqueAttachmentFile(folderTarget, filename, bytes) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = attempt === 0 ? filename : addCollisionSuffix(filename, attempt + 1);
        try {
            await writeFile(join(folderTarget, candidate), bytes, { flag: "wx" });
            return candidate;
        }
        catch (error) {
            if (!isNodeErrorWithCode(error, "EEXIST"))
                throw error;
        }
    }
    throw new Error("Unable to choose a unique attachment filename");
}
function addCollisionSuffix(filename, suffix) {
    const extension = extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    return `${stem}-${String(suffix)}${extension}`;
}
function attachmentFilename(attachment, stamp, index) {
    const originalName = sanitizeOriginalFilename(attachment.name) ?? fallbackAttachmentFilename(attachment);
    return `attachment-${stamp}-${String(index + 1)}-${originalName}`;
}
function fallbackAttachmentFilename(attachment) {
    if (attachment.kind === "image")
        return `image.${extensionForImageMimeType(attachment.mimeType)}`;
    return "file.bin";
}
const MAX_ORIGINAL_FILENAME_LENGTH = 96;
function sanitizeOriginalFilename(name) {
    const trimmed = name?.trim();
    if (trimmed === undefined || trimmed === "")
        return undefined;
    const leaf = basename(trimmed.replace(/\\/g, "/"));
    const sanitized = stripControlCharacters(leaf)
        .normalize("NFKC")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/-+\./g, ".")
        .replace(/^\.+/, "")
        .replace(/[.-]+$/, "");
    if (sanitized === "")
        return undefined;
    return truncateFilename(sanitized, MAX_ORIGINAL_FILENAME_LENGTH);
}
function stripControlCharacters(value) {
    return Array.from(value).filter((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    }).join("");
}
function truncateFilename(filename, maxLength) {
    if (filename.length <= maxLength)
        return filename;
    const extension = extname(filename);
    if (extension.length >= maxLength)
        return filename.slice(0, maxLength);
    const stem = filename.slice(0, filename.length - extension.length);
    return `${stem.slice(0, maxLength - extension.length)}${extension}`;
}
function timestamp(date) {
    const pad = (value, length = 2) => String(value).padStart(length, "0");
    return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
//# sourceMappingURL=attachmentService.js.map