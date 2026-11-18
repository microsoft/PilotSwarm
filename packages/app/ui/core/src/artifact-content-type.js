const CONTENT_TYPE_BY_EXTENSION = new Map([
    [".md", "text/markdown"],
    [".markdown", "text/markdown"],
    [".mdx", "text/markdown"],
    [".txt", "text/plain"],
    [".log", "text/plain"],
    [".sql", "text/plain"],
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
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    [".bin", "application/octet-stream"],
]);

function artifactExtension(filename) {
    const name = String(filename || "").toLowerCase();
    if (name.endsWith(".tar.gz")) return ".gz";
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    const dot = name.lastIndexOf(".");
    return dot > slash ? name.slice(dot) : "";
}

export function guessArtifactContentType(filename, { unknownType = "application/octet-stream" } = {}) {
    return CONTENT_TYPE_BY_EXTENSION.get(artifactExtension(filename)) || unknownType;
}

export function normalizeBrowserArtifactContentType(filename, contentType) {
    const normalized = String(contentType || "").trim().toLowerCase();
    const extension = artifactExtension(filename);
    if (normalized === "application/x-gzip") return "application/gzip";
    if (normalized === "application/x-compressed-tar" && [".gz", ".tgz"].includes(extension)) {
        return "application/gzip";
    }
    if (normalized === "application/x-zip-compressed" && extension === ".zip") {
        return "application/zip";
    }
    if (normalized === "application/vnd.ms-excel" && extension === ".csv") {
        return "text/csv";
    }
    if (normalized) return normalized;
    return guessArtifactContentType(filename);
}
