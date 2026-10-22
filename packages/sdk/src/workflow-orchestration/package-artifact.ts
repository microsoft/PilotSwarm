import { createHash } from "node:crypto";

export function workflowPackagesArtifactSessionId(): string {
    const hash = createHash("sha256")
        .update("pilotswarm-workflow-packages:artifacts")
        .digest("hex");
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join("-");
}

export function workflowPackageArtifactFilename(packageSha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(packageSha256)) {
        throw Object.assign(
            new Error("Workflow package SHA-256 must contain 64 lowercase hexadecimal characters."),
            { code: "WORKFLOW_PACKAGE_IDENTITY_INVALID" },
        );
    }
    return `workflow-package.${packageSha256}.tar.gz`;
}
