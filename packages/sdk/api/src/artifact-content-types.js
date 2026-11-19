/** Browser-safe artifact MIME normalization, classification, and sniff compatibility. */

export const TEXT_ARTIFACT_MAX_BYTES = 1_048_576;

const DEFAULT_ARTIFACT_CONTENT_TYPE = "text/markdown";
const OCTET_STREAM_CONTENT_TYPE = "application/octet-stream";
const YAML_ARTIFACT_CONTENT_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml"]);
const MIME_ALIASES = new Map([
    ["application/x-rar-compressed", "application/vnd.rar"],
]);
const TEXT_ARTIFACT_CONTENT_TYPES = new Set([
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-ndjson",
    "image/svg+xml",
    "text/yaml",
]);
const ZIP_COMPATIBLE_ARTIFACT_TYPES = new Set([
    "application/zip",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const CFB_COMPATIBLE_ARTIFACT_TYPES = new Set([
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
]);

export function normalizeArtifactContentType(contentType) {
    const normalized = String(contentType || "").trim().toLowerCase();
    if (!normalized) return DEFAULT_ARTIFACT_CONTENT_TYPE;
    if (YAML_ARTIFACT_CONTENT_TYPES.has(normalized)) return "text/yaml";
    return MIME_ALIASES.get(normalized) || normalized;
}

export function isBinaryArtifactContentType(contentType) {
    const normalized = normalizeArtifactContentType(contentType);
    if (normalized.startsWith("text/")) return false;
    return !TEXT_ARTIFACT_CONTENT_TYPES.has(normalized);
}

/** Keep magic-byte validation strict while accepting known aliases/containers. */
export function isCompatibleDetectedArtifactType(declaredType, detectedType) {
    if (!detectedType) return true;
    const declared = normalizeArtifactContentType(declaredType);
    const detected = normalizeArtifactContentType(detectedType);
    if (declared === detected) return true;
    if (detected === "application/zip" && ZIP_COMPATIBLE_ARTIFACT_TYPES.has(declared)) return true;
    if (detected === "application/x-cfb" && CFB_COMPATIBLE_ARTIFACT_TYPES.has(declared)) return true;
    if (declared === OCTET_STREAM_CONTENT_TYPE) return true;
    return false;
}
