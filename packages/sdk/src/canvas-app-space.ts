/**
 * The canvas app byte-space id family (issue 181). Pure: no Node built-ins,
 * so the web management client can use it too.
 */

/**
 * The fixed 12-hex prefix of every canvas app byte space id:
 * sha256("pilotswarm-canvas-apps:artifacts") truncated to 12 hex characters.
 * A unit test pins the literal to that derivation.
 */
export const CANVAS_APP_SPACE_PREFIX = "d8927a3e1021";

/**
 * Could this id be an app byte space? New sessions may not take such an id
 * (the CMS refuses it), so for anything created from now on the prefix is the
 * answer; refusals of reads are still confirmed against the registry so a
 * session created before this release whose id happens to match keeps working.
 */
export function looksLikeCanvasAppSpace(id: string): boolean {
    const s = String(id ?? "").toLowerCase();
    return s.length === 36 && s.replace(/-/g, "").startsWith(CANVAS_APP_SPACE_PREFIX) && s[14] === "8";
}
