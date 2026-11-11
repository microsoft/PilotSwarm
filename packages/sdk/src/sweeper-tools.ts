/**
 * Sweeper Agent Tools — system maintenance tools for scanning and cleaning
 * up terminal sessions.
 *
 * Leverages duroxide's bulk prune APIs (deleteInstanceBulk, pruneExecutionsBulk)
 * for efficient cleanup, plus CMS-level soft-delete for session metadata.
 *
 * These are registered as worker-level tools and referenced by the Sweeper
 * Agent session via toolNames.
 *
 * @module
 * @internal
 */

import { defineTool } from "@github/copilot-sdk";
import type { SessionCatalog } from "./cms.js";
import type { FactStore } from "./facts-store.js";
import type { Tool } from "@github/copilot-sdk";

/**
 * Create sweeper tools bound to the given CMS catalog and duroxide client.
 *
 * Call this after the worker has initialized the catalog and duroxide provider,
 * then register the returned tools via `worker.registerTools(tools)`.
 */
export function createSweeperTools(opts: {
    catalog: SessionCatalog;
    duroxideClient: any;
    factStore?: FactStore | null;
    duroxideSchema?: string;
    storeUrl?: string;
}): Tool<any>[] {
    const { catalog, duroxideClient, factStore } = opts;

    const TERMINAL_ORCH = new Set(["Completed", "Failed", "Terminated", "NotFound"]);

    /**
     * A session's orchestration status, or `unreadable` when the read fails. duroxide's getStatus answers
     * `{ status: "NotFound" }` for an instance that does not exist and throws only on an error (a lost connection, a
     * timeout), so a thrown read is never taken for NotFound: the Sweeper deletes nothing on a failed read.
     */
    async function readOrchestrationStatus(sessionId: string): Promise<{ status: string } | { unreadable: string }> {
        try {
            const st = await duroxideClient.getStatus(`session-${sessionId}`);
            const status = typeof st?.status === "string" && st.status ? st.status : null;
            return status ? { status } : { unreadable: "the status read returned no status" };
        } catch (err: any) {
            return { unreadable: String(err?.message ?? err) };
        }
    }

    /**
     * Re-derive whether a session is independently cleanable, mirroring the
     * eligibility rules used by scan_completed_sessions. This is the guardrail
    * that stops cleanup_session from deleting any LIVE session just because it
    * is idle, orphaned, or a child of a stale-looking parent. A session is only
    * cleanable when its OWN orchestration is terminal.
     */
    async function evaluateCleanupEligibility(
        session: { sessionId: string; parentSessionId: string | null; updatedAt: Date; sessionKind?: string },
        graceMinutes: number,
    ): Promise<{ eligible: boolean; status: string; reason: string }> {
        // A Workflow session (a test bench, a draft, one not started yet) has no session-<id> orchestration, so its
        // status reads NotFound while it is in use. It is never swept: its own run, or its owner session's end or
        // deletion, ends it.
        if (session.sessionKind === "workflow") {
            return {
                eligible: false,
                status: "Workflow",
                reason: "Refusing to clean a Workflow session: its own run, or its owner session's end or deletion, ends it.",
            };
        }
        const read = await readOrchestrationStatus(session.sessionId);
        if ("unreadable" in read) {
            return {
                eligible: false,
                status: "Unreadable",
                reason: `Could not read the target's orchestration status (${read.unreadable}); nothing is deleted on a failed read. Try again later.`,
            };
        }
        const orchStatus = read.status;

        const isRoot = !session.parentSessionId;
        const terminal = TERMINAL_ORCH.has(orchStatus);
        const stale = graceMinutes <= 0 || session.updatedAt.getTime() < Date.now() - graceMinutes * 60 * 1000;

        // Rule A: terminal orchestration (Completed/Failed/Terminated/NotFound).
        if (terminal) {
            if (!stale) {
                return {
                    eligible: false,
                    status: orchStatus,
                    reason: `Target orchestration is ${orchStatus} but was updated within the last ${graceMinutes}m; not yet stale.`,
                };
            }
            return { eligible: true, status: orchStatus, reason: `Orchestration ${orchStatus.toLowerCase()}` };
        }

        if (isRoot) {
            return {
                eligible: false,
                status: orchStatus,
                reason:
                    `Refusing to clean a ROOT session with a live (${orchStatus}) orchestration. ` +
                    `A root is only cleanable when its OWN orchestration is Completed/Failed/Terminated/NotFound. ` +
                    `Never infer a parent's status from stale children.`,
            };
        }
        return {
            eligible: false,
            status: orchStatus,
            reason: `Refusing to clean a CHILD session with a live (${orchStatus}) orchestration. Only terminal child sessions are eligible for cleanup. Idle or orphaned live children must not be swept.`,
        };
    }

    // ── scan_completed_sessions ───────────────────────────────

    const scanTool = defineTool("scan_completed_sessions", {
        description:
            "Scan for terminal sessions that are eligible for cleanup. " +
            "Only sessions whose OWN orchestration is Completed, Failed, Terminated, or NotFound are returned; Workflow sessions never are. " +
            "Idle, zombie, orphaned, or otherwise live sessions are not cleanup candidates, including child sessions. " +
            "Pass only sessionId values from sessions[] to cleanup_session.",
        parameters: {
            type: "object" as const,
            properties: {
                graceMinutes: {
                    type: "number",
                    description:
                        "Only return sessions that completed/failed more than this many minutes ago. Default: 5",
                },
                includeOrphans: {
                    type: "boolean",
                    description:
                        "Deprecated/no-op. Orphaned live sessions are no longer cleanup candidates; only terminal sessions are returned.",
                },
            },
        },
        handler: async (args: { graceMinutes?: number; includeOrphans?: boolean }) => {
            const graceMinutes = args.graceMinutes ?? 5;
            const results: Array<{
                sessionId: string;
                parentSessionId?: string;
                status: string;
                title?: string;
                age: string;
                reason: string;
            }> = [];
            // Sessions whose status read failed: not candidates (nothing is deleted on a failed read).
            const unreadable: string[] = [];

            try {
                const allSessions = await catalog.listSessions();
                const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

                for (const session of allSessions) {
                    // Never touch system sessions
                    if (session.isSystem) continue;
                    // Nor Workflow sessions: they have no session-<id> orchestration (see evaluateCleanupEligibility).
                    if (session.sessionKind === "workflow") continue;

                    const read = await readOrchestrationStatus(session.sessionId);
                    if ("unreadable" in read) {
                        unreadable.push(session.sessionId);
                        continue;
                    }
                    const orchStatus = read;

                    const ageMs = Date.now() - session.updatedAt.getTime();
                    const ageStr = ageMs > 3_600_000
                        ? `${Math.round(ageMs / 3_600_000)}h`
                        : `${Math.round(ageMs / 60_000)}m`;

                    // Check for completed/failed orchestrations
                    if (
                        orchStatus.status === "Completed" ||
                        orchStatus.status === "Failed" ||
                        orchStatus.status === "Terminated" ||
                        orchStatus.status === "NotFound"
                    ) {
                        if (session.updatedAt < cutoff) {
                            results.push({
                                sessionId: session.sessionId,
                                parentSessionId: session.parentSessionId ?? undefined,
                                status: orchStatus.status,
                                title: session.title ?? undefined,
                                age: ageStr,
                                reason: `Orchestration ${orchStatus.status.toLowerCase()}`,
                            });
                        }
                        continue;
                    }
                }

                return {
                    found: results.length,
                    graceMinutes,
                    sessions: results,
                    ...(unreadable.length ? { unreadableCount: unreadable.length, unreadable: unreadable.slice(0, 20) } : {}),
                    guidance:
                        "Only terminal sessions are returned. Clean the returned sessions by their own sessionId — " +
                        "batch them via cleanup_session(sessionIds=[...]) or clean one at a time. " +
                        "Never sweep idle/zombie/orphaned live sessions; wait for their own orchestration to become terminal.",
                };
            } catch (err: any) {
                return { error: err.message, found: 0, sessions: [] };
            }
        },
    });

    // ── cleanup_session ──────────────────────────────────────

    /**
     * Clean a single session (target + descendants) after independently
     * re-verifying it is itself eligible. Returns a per-session result; shared
     * by the single and batch forms of cleanup_session.
     */
    async function cleanupOne(
        sessionId: string,
        graceMinutes: number,
        deleteReason: string,
    ): Promise<any> {
        const session = await catalog.getSession(sessionId);
        if (!session) {
            return { ok: false, sessionId, error: "Session not found" };
        }
        if (session.isSystem) {
            return { ok: false, sessionId, error: "Cannot delete system session" };
        }

        // Guardrail: independently re-verify the target is actually cleanable.
        // Prevents deleting a live root that the model inferred from stale
        // children (see evaluateCleanupEligibility).
        const eligibility = await evaluateCleanupEligibility(session, graceMinutes);
        if (!eligibility.eligible) {
            return { ok: false, sessionId, refused: true, status: eligibility.status, error: eligibility.reason };
        }

        // Delete all descendants first, then the session itself.
        const descendants = await catalog.getDescendantSessionIds(sessionId);
        let deletedCount = 0;
        for (const descId of descendants) {
            try {
                await catalog.softDeleteSession(descId);
                if (factStore) {
                    try { await factStore.deleteSessionFactsForSession(descId); } catch {}
                }
                try { await duroxideClient.deleteInstance(`session-${descId}`, true); } catch {}
                deletedCount++;
            } catch {}
        }

        await catalog.softDeleteSession(sessionId);
        if (factStore) {
            try { await factStore.deleteSessionFactsForSession(sessionId); } catch {}
        }
        try { await duroxideClient.deleteInstance(`session-${sessionId}`, true); } catch {}
        deletedCount++;

        return { ok: true, sessionId, deletedCount, reason: deleteReason, descendants: descendants.length };
    }

    const cleanupTool = defineTool("cleanup_session", {
        description:
            "Delete terminal session(s) and all their descendants. " +
            "Accepts a single sessionId OR a batch sessionIds[] — clean many stale sessions (e.g. all the children a scan returned) in one call. " +
            "Removes from CMS (soft-delete) and deletes the duroxide orchestration instance. " +
            "Independently re-verifies EACH target is terminal and REFUSES system sessions plus any live/non-terminal root or child session. " +
            "Only pass sessionIds that scan_completed_sessions returned in sessions[]. Idle/zombie/orphaned live sessions are never cleanup targets.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description: "A single session ID to clean up (must be a scan candidate, never an inferred parent). Use this OR sessionIds.",
                },
                sessionIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "A batch of terminal session IDs to clean up in one call. Each is gated independently; live/non-terminal targets are refused and reported, not deleted.",
                },
                reason: {
                    type: "string",
                    description: "Reason for cleanup (logged for auditing)",
                },
                graceMinutes: {
                    type: "number",
                    description: "Staleness threshold used to re-verify eligibility. Default: 5",
                },
            },
        },
        handler: async (args: { sessionId?: string; sessionIds?: string[]; reason?: string; graceMinutes?: number }) => {
            const graceMinutes = args.graceMinutes ?? 5;
            const deleteReason = args.reason ?? "Cleaned up by Sweeper Agent";

            try {
                // Batch mode: an explicit list of session ids. Each is gated and
                // cleaned independently so one bad id never blocks the rest.
                if (Array.isArray(args.sessionIds) && args.sessionIds.length > 0) {
                    const seen = new Set<string>();
                    const unique = args.sessionIds.filter(
                        (id) => typeof id === "string" && id !== "" && !seen.has(id) && (seen.add(id), true),
                    );

                    const results: any[] = [];
                    for (const id of unique) {
                        results.push(await cleanupOne(id, graceMinutes, deleteReason));
                    }

                    const cleaned = results.filter((r) => r.ok);
                    const refused = results.filter((r) => r.refused);
                    const failed = results.filter((r) => !r.ok && !r.refused);
                    const totalDeleted = cleaned.reduce((n, r) => n + (r.deletedCount ?? 0), 0);

                    return {
                        ok: true,
                        batch: true,
                        requested: unique.length,
                        cleanedCount: cleaned.length,
                        refusedCount: refused.length,
                        failedCount: failed.length,
                        totalDeleted,
                        reason: deleteReason,
                        results,
                    };
                }

                // Single mode (backward-compatible result shape).
                if (typeof args.sessionId === "string" && args.sessionId) {
                    return await cleanupOne(args.sessionId, graceMinutes, deleteReason);
                }

                return { ok: false, error: "Provide either sessionId (string) or a non-empty sessionIds array" };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    });

    // ── prune_orchestrations ─────────────────────────────────
    // Uses duroxide's bulk APIs for efficient cleanup at the orchestration level.
    // Modeled after toygres's system-pruner pattern.

    const pruneTool = defineTool("prune_orchestrations", {
        description:
            "Bulk prune duroxide orchestration state. " +
            "Two operations: (1) delete terminal (Completed/Failed/Terminated) orchestration " +
            "instances older than N minutes, and (2) prune old executions from all instances, " +
            "keeping only the last N executions per instance. " +
            "It then soft-deletes the session rows (older than the same cutoff) whose orchestration is NotFound; " +
            "a status read that fails deletes nothing (cmsUnreadable counts them). " +
            "This is a system-level operation that cleans up duroxide storage directly.",
        parameters: {
            type: "object" as const,
            properties: {
                deleteTerminalOlderThanMinutes: {
                    type: "number",
                    description:
                        "Delete completed/failed orchestration instances older than this many minutes. Default: 5",
                },
                keepExecutions: {
                    type: "number",
                    description:
                        "Keep only the last N executions per instance (current execution is never pruned). Default: 3",
                },
                batchLimit: {
                    type: "number",
                    description:
                        "Max instances to process per batch. Default: 1000",
                },
            },
        },
        handler: async (args: {
            deleteTerminalOlderThanMinutes?: number;
            keepExecutions?: number;
            batchLimit?: number;
        }) => {
            const deleteMinutes = args.deleteTerminalOlderThanMinutes ?? 5;
            const keepExecutions = args.keepExecutions ?? 3;
            const batchLimit = args.batchLimit ?? 1000;

            try {
                const cutoffMs = Date.now() - deleteMinutes * 60 * 1000;

                // Step 1: Delete terminal instances older than cutoff
                const deleteResult = await duroxideClient.deleteInstanceBulk({
                    completedBefore: cutoffMs,
                    limit: batchLimit,
                });

                // Step 2: Prune old executions across all instances
                const pruneResult = await duroxideClient.pruneExecutionsBulk(
                    { limit: batchLimit },
                    { keepLast: keepExecutions },
                );

                // Step 3: soft-delete the CMS rows whose orchestration no longer exists (NotFound: step 1 deleted it, or it
                // was deleted before), once the row is older than the same cutoff. A failed status read is not NotFound
                // (duroxide's getStatus throws only on an error): such a row is skipped and counted, never deleted.
                let cmsCleanedUp = 0;
                let cmsUnreadable = 0;
                try {
                    const cmsSessions = await catalog.listSessions();
                    for (const s of cmsSessions) {
                        if (s.isSystem) continue;
                        if (s.updatedAt.getTime() >= cutoffMs) continue;
                        const read = await readOrchestrationStatus(s.sessionId);
                        if ("unreadable" in read) {
                            cmsUnreadable++;
                            console.warn(`[sweeper] prune: could not read the status of session-${s.sessionId}; not deleted: ${read.unreadable}`);
                            continue;
                        }
                        if (read.status !== "NotFound") continue;
                        try {
                            await catalog.softDeleteSession(s.sessionId);
                            cmsCleanedUp++;
                        } catch {}
                    }
                } catch {}

                return {
                    ok: true,
                    deleteTerminal: {
                        instancesDeleted: deleteResult.instancesDeleted ?? 0,
                        executionsDeleted: deleteResult.executionsDeleted ?? 0,
                        eventsDeleted: deleteResult.eventsDeleted ?? 0,
                    },
                    pruneExecutions: {
                        instancesProcessed: pruneResult.instancesProcessed ?? 0,
                        executionsDeleted: pruneResult.executionsDeleted ?? 0,
                        eventsDeleted: pruneResult.eventsDeleted ?? 0,
                    },
                    cmsCleanedUp,
                    cmsUnreadable,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    });

    // ── get_system_stats ─────────────────────────────────────

    const statsTool = defineTool("get_system_stats", {
        description:
            "Get runtime statistics: total sessions, active count, completed count, " +
            "memory usage, uptime, and database connection info.",
        parameters: {
            type: "object" as const,
            properties: {},
        },
        handler: async () => {
            try {
                const allSessions = await catalog.listSessions();

                // Parse database host/name from store URL (strip credentials)
                let database: { host?: string; port?: string; name?: string; provider?: string } = {};
                if (opts.storeUrl) {
                    try {
                        const url = new URL(opts.storeUrl);
                        database.host = url.hostname;
                        database.port = url.port || "5432";
                        database.name = url.pathname.replace(/^\//, "") || "postgres";
                        // Detect provider from hostname
                        if (url.hostname.includes(".horizondb.azure.com")) database.provider = "Azure HorizonDB";
                        else if (url.hostname.includes(".postgres.database.azure.com")) database.provider = "Azure Flexible Server";
                        else if (url.hostname.includes(".azure.com")) database.provider = "Azure";
                        else database.provider = "PostgreSQL";
                    } catch {}
                }

                const stats = {
                    total: allSessions.length,
                    byState: {} as Record<string, number>,
                    systemSessions: 0,
                    subAgents: 0,
                    rootSessions: 0,
                    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    uptimeMinutes: Math.round(process.uptime() / 60),
                    database,
                };

                for (const s of allSessions) {
                    stats.byState[s.state] = (stats.byState[s.state] ?? 0) + 1;
                    if (s.isSystem) stats.systemSessions++;
                    if (s.parentSessionId) stats.subAgents++;
                    else stats.rootSessions++;
                }

                return stats;
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    return [scanTool, cleanupTool, pruneTool, statsTool];
}
