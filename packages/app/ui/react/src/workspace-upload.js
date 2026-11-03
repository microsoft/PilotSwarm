// Shared Workspace upload policy. Transport owns HTTP/authentication; this
// helper owns bounded Blob reads, with no retry or fallback after a failure.
const LEGACY_MAX_BYTES = 65_536;
const PREFIX = "WORKSPACE_FILES_UPLOAD_";

function uploadError(code, message) {
    return Object.assign(new Error(message), { code: `${PREFIX}${code}` });
}

function checkCancelled(signal) {
    if (signal?.aborted) throw Object.assign(new Error("Upload cancelled."), { name: "AbortError" });
}

function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function rawDenial(error) {
    // ApiError preserves JSON-envelope codes. Older transports use FORBIDDEN
    // even for HTML/text responses, but explicitly describe that proxy case.
    return error?.status === 403 && (!error.code || error.nonJson === true || error.responseIsJson === false
        || (error.code === "FORBIDDEN" && /proxy or firewall/.test(error.message || "")));
}

/** These flags describe post-publication failures, not an uncertain commit. */
export function workspaceUploadReceiptWarning(result, action = "saved") {
    const failed = [];
    if (result?.notificationFailed) failed.push("notification");
    if (result?.receiptPersistenceFailed) failed.push("receipt persistence");
    return failed.length ? `File ${action}, but ${failed.join(" and ")} failed. The file is committed; publication was not retried.` : null;
}

export function workspaceUploadErrorText(error) {
    let message;
    if (error?.completionUncertain) {
        message = "Upload completion is uncertain. Inspect the refreshed target before trying again. Publication was not retried.";
        if (error.targetRefreshError) message += ` Target refresh failed: ${error.targetRefreshError.message || error.targetRefreshError}. Refresh it manually before retrying.`;
    } else if (error?.status === 413) {
        message = `The proxy or server rejected ${error.uploadPart === undefined ? "the file request" : `file part ${error.uploadPart + 1}`}${error.uploadPath ? ` for ${error.uploadPath}` : ""} (413). Check the proxy body limit against the advertised upload part size; it must allow each part. Nothing was retried.`;
    } else if (rawDenial(error)) {
        message = "The file request was blocked (403), possibly by a proxy or firewall. This is not a confirmed sign-in or ownership denial.";
    } else if (error?.name === "AbortError") {
        message = "Upload cancelled.";
    } else return null;
    return message;
}

/** Snapshot all target/capability values at entry; never consult the live view. */
export async function uploadWorkspaceBlob({
    transport, sessionId, folder, path, blob, ifMatch,
    upload, uploads, signal, onProgress = () => {}, onLegacy = () => {},
}) {
    const target = { folder, path, size: blob.size, ...(ifMatch !== undefined ? { ifMatch } : {}) };
    const legacyMax = Math.min(LEGACY_MAX_BYTES, upload?.legacyMaxBytes ?? LEGACY_MAX_BYTES);
    checkCancelled(signal);
    if (!upload || blob.size <= legacyMax) {
        // Old servers retain their existing legacy behavior, with an explicit
        // warning in the pane. Only this compatibility path reads a large Blob.
        if (!upload && blob.size > LEGACY_MAX_BYTES) onLegacy();
        onProgress({ phase: "legacy", bytes: 0, size: blob.size, path });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        checkCancelled(signal);
        const result = await transport.sessionWorkspaceFiles(sessionId, {
            op: "write", folder, path, contentBase64: base64(bytes),
            ...(ifMatch !== undefined ? { ifMatch } : {}),
        });
        onProgress({ phase: "completed", bytes: blob.size, size: blob.size, path });
        return result;
    }
    if (!uploads) throw uploadError("UNSUPPORTED", "This folder does not support large uploads or saves. The legacy decoded-write limit is 64 KiB.");
    if (!Number.isSafeInteger(upload.partBytes) || upload.partBytes <= 0) {
        throw uploadError("UNSUPPORTED", "The server advertised an invalid upload part size.");
    }
    let uploadId;
    let completing = false;
    try {
        onProgress({ phase: "starting", bytes: 0, size: blob.size, path });
        const started = await transport.startSessionWorkspaceUpload(sessionId, target);
        uploadId = started.uploadId;
        checkCancelled(signal);
        const partBytes = started.partBytes;
        if (!uploadId || !Number.isSafeInteger(partBytes) || partBytes <= 0 || partBytes > upload.partBytes
            || started.partCount !== Math.ceil(blob.size / partBytes)) {
            throw uploadError("UNSUPPORTED", "The server returned inconsistent upload part metadata.");
        }
        for (let part = 0; part < started.partCount; part++) {
            checkCancelled(signal);
            const offset = part * partBytes;
            const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + partBytes, blob.size)).arrayBuffer());
            checkCancelled(signal);
            try {
                await transport.putSessionWorkspaceUploadPart(sessionId, uploadId, part, bytes, { signal });
            } catch (error) {
                error.uploadPath = path;
                error.uploadPart = part;
                throw error;
            }
            onProgress({ phase: "uploading", bytes: offset + bytes.length, size: blob.size, path, part });
        }
        checkCancelled(signal);
        onProgress({ phase: "completing", bytes: blob.size, size: blob.size, path });
        completing = true;
        const result = await transport.completeSessionWorkspaceUpload(sessionId, uploadId);
        onProgress({ phase: "completed", bytes: blob.size, size: blob.size, path });
        return result;
    } catch (error) {
        // A missing completion receipt is not evidence that publication failed.
        // Typed pre-publication failures (including etag conflicts) are definite.
        if (completing && (!error.code || error.code === "INTERNAL_ERROR"
            || [`${PREFIX}IN_PROGRESS`, `${PREFIX}COMMIT_UNKNOWN`].includes(error.code))) {
            error.completionUncertain = true;
        }
        if (uploadId && !error.completionUncertain) {
            try {
                const result = await transport.abortSessionWorkspaceUpload(sessionId, uploadId);
                if (!["aborted", "expired"].includes(result?.state)) throw new Error(`Upload cleanup returned ${result?.state ?? "no state"}.`);
            } catch (cleanupError) {
                error.cleanupError = cleanupError;
            }
        }
        throw error;
    }
}
