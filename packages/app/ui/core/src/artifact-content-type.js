import {
    TEXT_ARTIFACT_MAX_BYTES,
    isBinaryArtifactContentType as isBinarySharedArtifactContentType,
    normalizeArtifactContentType as normalizeSharedArtifactContentType,
} from "pilotswarm-sdk/api";

export { TEXT_ARTIFACT_MAX_BYTES };

const CONTENT_TYPE_BY_EXTENSION = new Map([
    [".md", "text/markdown"],
    [".markdown", "text/markdown"],
    [".mdx", "text/markdown"],
    [".txt", "text/plain"],
    [".log", "text/plain"],
    [".sql", "text/plain"],
    [".toml", "text/plain"],
    [".ini", "text/plain"],
    [".py", "text/plain"],
    [".sh", "text/plain"],
    [".ps1", "text/plain"],
    [".kql", "text/plain"],
    [".ndjson", "text/plain"],
    [".diff", "text/plain"],
    [".patch", "text/plain"],
    [".env", "text/plain"],
    [".json", "application/json"],
    [".jsonl", "application/json"],
    [".html", "text/html"],
    [".htm", "text/html"],
    [".csv", "text/csv"],
    [".tsv", "text/plain"],
    [".yaml", "text/yaml"],
    [".yml", "text/yaml"],
    [".xml", "application/xml"],
    [".js", "application/javascript"],
    [".mjs", "application/javascript"],
    [".cjs", "application/javascript"],
    [".pdf", "application/pdf"],
    [".zip", "application/zip"],
    [".tar", "application/x-tar"],
    [".tgz", "application/gzip"],
    [".gz", "application/gzip"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".svg", "image/svg+xml"],
    [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".xlsm", "application/vnd.ms-excel.sheet.macroenabled.12"],
    [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".ppt", "application/vnd.ms-powerpoint"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    [".rar", "application/vnd.rar"],
    [".bin", "application/octet-stream"],
]);

const CONTENT_TYPE_BY_BASENAME = new Map([
    ["dockerfile", "text/plain"],
]);

export const ARTIFACT_UPLOAD_JSON_BODY_LIMIT_MB = 8;
export const ARTIFACT_UPLOAD_JSON_BODY_LIMIT = `${ARTIFACT_UPLOAD_JSON_BODY_LIMIT_MB}mb`;
export const ARTIFACT_UPLOAD_JSON_BODY_LIMIT_BYTES = ARTIFACT_UPLOAD_JSON_BODY_LIMIT_MB * 1024 * 1024;
// Leave room for JSON keys, the encoded filename/type, and request metadata
// after converting decoded bytes to base64.
export const ARTIFACT_UPLOAD_JSON_OVERHEAD_RESERVE_BYTES = 64 * 1024;
export const PROMPT_ARTIFACT_UPLOAD_MAX_BYTES = Math.floor(
    (ARTIFACT_UPLOAD_JSON_BODY_LIMIT_BYTES - ARTIFACT_UPLOAD_JSON_OVERHEAD_RESERVE_BYTES) * 3 / 4,
);

function artifactExtension(filename) {
    const name = String(filename || "").toLowerCase();
    if (name.endsWith(".tar.gz")) return ".gz";
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    const dot = name.lastIndexOf(".");
    return dot > slash ? name.slice(dot) : "";
}

export function guessArtifactContentType(filename, { unknownType = "application/octet-stream" } = {}) {
    const name = String(filename || "").replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() || "";
    return CONTENT_TYPE_BY_EXTENSION.get(artifactExtension(name))
        || CONTENT_TYPE_BY_BASENAME.get(name)
        || unknownType;
}

export function normalizeBrowserArtifactContentType(filename, contentType) {
    const lowerFilename = String(filename || "").toLowerCase();
    const normalized = String(contentType || "").trim().toLowerCase();
    const extension = artifactExtension(filename);
    if (normalized === "application/x-gzip") return "application/gzip";
    if (normalized === "application/x-compressed"
        && (lowerFilename.endsWith(".tgz") || lowerFilename.endsWith(".tar.gz"))) {
        return "application/gzip";
    }
    if (normalized === "application/x-compressed-tar" && [".gz", ".tgz"].includes(extension)) {
        return "application/gzip";
    }
    if (normalized === "application/x-zip-compressed" && extension === ".zip") {
        return "application/zip";
    }
    if (normalized === "application/vnd.ms-excel" && extension === ".csv") {
        return "text/csv";
    }
    if (normalized) return normalizeSharedArtifactContentType(normalized);
    return guessArtifactContentType(filename);
}

export function isBinaryBrowserArtifactContentType(contentType) {
    return isBinarySharedArtifactContentType(contentType);
}
