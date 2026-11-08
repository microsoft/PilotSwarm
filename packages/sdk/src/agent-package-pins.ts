/**
 * Exact package revisions for sessions that must not follow a republish
 * (workflow v2 package pins, design 03 "package agents", R09 and R18;
 * test plan T070). INACTIVE: only a workflow agent state's child is bound
 * this way, and only test hosts start runs that have one.
 *
 * A session is ordinarily bound to a published package by its registry id,
 * and it follows that package's active version: a republish changes the
 * prompt, skills, tools and MCP grants its next turn gets. A workflow
 * publication instead pins the exact revision it was checked against, so a
 * run keeps using that revision after the package is republished. Such a
 * child is bound to the pinned id `<packageId>@<sha256>`: the registry row
 * id of the package and the content hash of the exact published version.
 * A worker installs that version beside the active one on demand
 * (PilotSwarmWorker.ensurePinnedAgentPackageRevision) and serves its agent
 * only to sessions bound to that id, never as anyone's default copy.
 *
 * @internal
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The bound package id of a session that runs exactly the published version `sha256` of package `packageId`. */
export function pinnedAgentPackageId(packageId: string, sha256: string): string {
    const pinned = `${packageId}@${sha256}`;
    if (parsePinnedAgentPackageId(pinned) === null) {
        throw new Error(`"${packageId}" and "${sha256}" do not name a package revision.`);
    }
    return pinned;
}

/** The package and version a pinned id names, or null for any other id (an ordinary package id among them). */
export function parsePinnedAgentPackageId(id: string | null | undefined): { packageId: string; sha256: string } | null {
    if (typeof id !== "string") return null;
    const at = id.indexOf("@");
    if (at <= 0 || at !== id.lastIndexOf("@")) return null;
    const packageId = id.slice(0, at);
    const sha256 = id.slice(at + 1);
    return SHA256_HEX.test(sha256) ? { packageId, sha256 } : null;
}

export function isPinnedAgentPackageId(id: string | null | undefined): boolean {
    return parsePinnedAgentPackageId(id) !== null;
}
