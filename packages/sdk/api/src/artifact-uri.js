/** Build the canonical session artifact URI without losing filename bytes. */
export function artifactUri(sessionId, filename) {
    const encodedFilename = encodeURIComponent(String(filename || ""))
        .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `artifact://${String(sessionId || "")}/${encodedFilename}`;
}
