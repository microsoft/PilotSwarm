export declare const TEXT_ARTIFACT_MAX_BYTES: number;
export declare function normalizeArtifactContentType(contentType?: string | null): string;
export declare function isBinaryArtifactContentType(contentType?: string | null): boolean;
export declare function isCompatibleDetectedArtifactType(declaredType: string, detectedType?: string | null): boolean;
