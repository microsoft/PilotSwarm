/** Build the canonical session artifact URI without losing filename bytes. */
export function artifactUri(sessionId, filename) {
    const encodedFilename = encodeURIComponent(String(filename || ""))
        .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        // encodeURIComponent leaves "." and "_" untouched. At the end of a
        // bare URI those bytes are indistinguishable from prose punctuation
        // and Markdown emphasis, so canonical producers encode them.
        .replace(/[._]+$/g, (ending) => [...ending]
            .map((character) => character === "." ? "%2E" : "%5F")
            .join(""));
    return `artifact://${String(sessionId || "")}/${encodedFilename}`;
}
