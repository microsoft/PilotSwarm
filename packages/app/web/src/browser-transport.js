import { HttpApiTransport } from "pilotswarm-sdk/api";
import {
    normalizeBrowserArtifactContentType,
    isBinaryBrowserArtifactContentType,
    PROMPT_ARTIFACT_UPLOAD_MAX_BYTES,
    TEXT_ARTIFACT_MAX_BYTES,
} from "pilotswarm/ui-core";

function encodeBytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

/**
 * Browser data layer for the portal: HttpApiTransport over the same-origin
 * `/api/v1` Web API, plus the browser-specific conveniences (download via
 * anchor click, window.open). The legacy `/api/rpc` + `/portal-ws` surface
 * is no longer used by the portal itself.
 */

async function saveArtifactDownload(transport, sessionId, filename) {
    const response = await transport.api.downloadArtifactResponse(sessionId, filename);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    return {
        localPath: `browser-download://${sessionId}/${filename}`,
        filename,
    };
}

/**
 * Save a package as the .tgz the CLI would push. The Web API has served this
 * all along (GET /packages/:name/download); the Admin Console just never
 * offered it, so the only way to get a published package back out was the CLI.
 */
async function saveAgentPackageDownload(transport, name, semver, selector) {
    const response = await transport.api.downloadAgentPackageResponse(name, {
        ...(semver ? { semver } : {}),
        ...(selector?.scope ? { scope: selector.scope } : {}),
        ...(selector?.owner?.provider ? { ownerProvider: selector.owner.provider } : {}),
        ...(selector?.owner?.subject ? { ownerSubject: selector.owner.subject } : {}),
    });
    const blob = await response.blob();
    const filename = `${name}${semver ? `-${semver}` : ""}.tgz`;
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    return { filename };
}

async function openUrlInDefaultBrowser(targetUrl) {
    const href = String(targetUrl || "").trim();
    if (!href) {
        throw new Error("URL cannot be empty.");
    }
    const parsedUrl = new URL(href, window.location.href);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
        throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }
    window.open(parsedUrl.toString(), "_blank", "noopener,noreferrer");
    return { url: parsedUrl.toString() };
}

/** Azure DevOps' first-party resource id — the audience for repo reads. */
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

export class BrowserPortalTransport extends HttpApiTransport {
    constructor({ getAccessToken, getResourceToken, onUnauthorized, onForbidden } = {}) {
        super({
            apiUrl: window.location.origin,
            getAccessToken,
            onUnauthorized,
            onForbidden,
            host: {
                saveArtifactDownload,
                saveAgentPackageDownload,
                openUrlInDefaultBrowser,
                artifactExportDirectory: "Browser downloads",
            },
        });
        this.getResourceTokenImpl = typeof getResourceToken === "function" ? getResourceToken : null;
    }

    /**
     * Access token for reading a code host AS THE SIGNED-IN USER, so package
     * import happens in this browser with the viewer's own permissions.
     * GitHub needs none for public repos (a PAT covers private ones).
     */
    async getRepoAccessToken(kind) {
        if (kind !== "ado" || typeof this.getResourceTokenImpl !== "function") return null;
        return this.getResourceTokenImpl(ADO_RESOURCE_ID);
    }

    async uploadArtifactFromFile(sessionId, file, filenameOverride = null, contentTypeOverride = null, ifAbsent = false) {
        if (!file || typeof file.name !== "string") {
            throw new Error("A browser File is required for upload");
        }
        const filename = String(filenameOverride || file.name);
        const content = encodeBytesToBase64(new Uint8Array(await file.arrayBuffer()));
        const contentType = contentTypeOverride || file.type || undefined;
        return this.uploadArtifactContent(sessionId, filename, content, contentType, "base64", ifAbsent);
    }

    async uploadPromptArtifactFromFile(sessionId, file, filenameOverride = null) {
        const contentType = normalizeBrowserArtifactContentType(file?.name, file?.type);
        const maxBytes = isBinaryBrowserArtifactContentType(contentType)
            ? PROMPT_ARTIFACT_UPLOAD_MAX_BYTES
            : TEXT_ARTIFACT_MAX_BYTES;
        const sizeBytes = Number(file?.size);
        if (Number.isFinite(sizeBytes) && sizeBytes > maxBytes) {
            const limit = maxBytes === TEXT_ARTIFACT_MAX_BYTES
                ? "the 1 MiB text-artifact limit"
                : "the 8 MB upload route";
            throw new Error(`${file.name} is ${sizeBytes} bytes; composer artifacts must be ${maxBytes} bytes or smaller for ${limit}`);
        }
        return this.uploadArtifactFromFile(sessionId, file, filenameOverride, contentType, true);
    }

    /**
     * Capability probe for the composer's attach affordances (paste / drop /
     * picker). The portal server ships the same build as this bundle, so a
     * static true is honest — the API edge still validates every send.
     */
    supportsPromptImageAttachments() {
        return true;
    }
}
