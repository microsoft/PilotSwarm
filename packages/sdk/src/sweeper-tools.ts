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
import { WORKFLOW_TEST_BENCH_KIND } from "./workflow/test-bench.js";
import { SWEEPER_ENDED_SESSION_STATES } from "./workflow/store.js";

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
    /** A controller that exists and has ended: its instance can be deleted (a NotFound one has nothing to delete). */
    const ENDED_ORCH = new Set(["Completed", "Failed", "Terminated"]);
    /**
     * A Workflow run the store still counts as active (admitted, running, or paused, before or after it began). The store
     * decides: such a run ends only through its controller, or through update_workflow operation recover when its
     * controller is gone (workflow/service.ts recoverWorkflowRun), never through the Sweeper.
     */
    const ACTIVE_WORKFLOW_RUN = new Set(["admitted", "running", "paused"]);

    type OrchestrationRead =
        | { status: string; instanceId: string; controllers?: string[] }
        | { unreadable: string }
        | { noRun: true }
        | { activeRun: { runId: string; status: string } }
        | { startUnresolved: true };

    /** One instance's status, or `unreadable` when the read fails (duroxide answers NotFound itself; it throws only on an error). */
    async function readInstanceStatus(instanceId: string): Promise<{ status: string; instanceId: string } | { unreadable: string }> {
        try {
            const st = await duroxideClient.getStatus(instanceId);
            const status = typeof st?.status === "string" && st.status ? st.status : null;
            return status ? { status, instanceId } : { unreadable: `the status read of ${instanceId} returned no status` };
        } catch (err: any) {
            return { unreadable: `${instanceId}: ${String(err?.message ?? err)}` };
        }
    }

    /**
     * A session's orchestration status, read from the instance that runs it, or `unreadable` when a read fails. duroxide's
     * getStatus answers `{ status: "NotFound" }` for an instance that does not exist and throws only on an error (a lost
     * connection, a timeout), so a thrown read is never taken for NotFound: the Sweeper deletes nothing on a failed read.
     *
     * - An ordinary session: `session-<id>`.
     * - A Workflow session: the store decides first. Any run it still counts as active (admitted, running or paused,
     *   before or after it began; a draft's test run included) makes the session `activeRun`, never a cleanup candidate,
     *   whatever its controllers read: a run admitted before its controller started, or one whose controller ended or is
     *   gone, is the product's to recover (update_workflow operation recover), not the Sweeper's to delete. With no run
     *   active, its status is its latest own run's controller's: a Workflow's live run (`session-<id>`), or a test bench's
     *   test run (`wft-<run>`); a test run of any other Workflow (a draft's test) is not its run. A Workflow session with no
     *   run of its own yet (a draft, tested or not) has nothing to read: `noRun`, never a cleanup candidate. A failed read
     *   of the store is `unreadable`, like a failed status read. `controllers` names its runs' controller instances, the
     *   ones a cleanup deletes.
     */
    async function readOrchestrationStatus(session: { sessionId: string; sessionKind?: string; serviceKind?: string | null;
        orchestrationId?: string | null; state?: string }): Promise<OrchestrationRead> {
        if (session.sessionKind !== "workflow") {
            const read = await readInstanceStatus(`session-${session.sessionId}`);
            // Review DR-01: a NotFound read of an ordinary session whose first message was accepted (its orchestration was
            // started) and that has not been seen to end is a start no worker has picked up yet, not an end, at any age.
            if ("status" in read && read.status === "NotFound" && session.orchestrationId && !SWEEPER_ENDED_SESSION_STATES.includes(String(session.state))) {
                return { startUnresolved: true };
            }
            return read;
        }
        let runs: Array<{ runId: string; controllerInstanceId: string; status: string; mode: string }>;
        try {
            if (typeof catalog.workflowStore !== "function") return { unreadable: "this catalog has no Workflow store" };
            runs = await catalog.workflowStore().listRuns(session.sessionId);
        } catch (err: any) {
            return { unreadable: `the Workflow runs of ${session.sessionId}: ${String(err?.message ?? err)}` };
        }
        const active = runs.find(run => ACTIVE_WORKFLOW_RUN.has(run.status));
        if (active) return { activeRun: { runId: active.runId, status: active.status } };
        const bench = session.serviceKind === WORKFLOW_TEST_BENCH_KIND;
        const own = bench ? runs : runs.filter(run => run.mode === "live");
        if (own.length === 0) return { noRun: true };
        const latest = own[own.length - 1];
        const read = await readInstanceStatus(latest.controllerInstanceId);
        if ("unreadable" in read) return read;
        return { ...read, controllers: [...new Set([latest.controllerInstanceId, ...runs.map(run => run.controllerInstanceId)])] };
    }

    /** The catalog's Workflow store, when it has the Sweeper's final check (a test double may not). */
    function sweeperStore(): { sweeperRowVersion: (id: string) => Promise<{ version: string; updatedAt: Date; deleted: boolean } | null>;
        sweeperSoftDelete: (input: { sessionId: string; version: string; cascade: boolean; orchestrationNotFound: boolean }) => Promise<any> } | null {
        const store = typeof catalog.workflowStore === "function" ? catalog.workflowStore() : null;
        return store && typeof store.sweeperSoftDelete === "function" && typeof store.sweeperRowVersion === "function" ? store : null;
    }

    /**
     * Review AR-02: the session row's version, read before the Sweeper judges the session; the final check refuses unless
     * the row still has it. Null without a final check (a test double), or when the row is gone.
     */
    async function readRowVersion(sessionId: string): Promise<{ version: string; updatedAt: Date; deleted: boolean } | null> {
        const store = sweeperStore();
        return store ? store.sweeperRowVersion(sessionId) : null;
    }

    /**
     * Reviews AS-02, AR-01..AR-03: the final check and the soft delete, in one transaction under the session row's lock
     * (WorkflowStore.sweeperSoftDelete), which every run admission takes first. It
     * refuses, deleting nothing, when the row changed since `version` was read (Changed), a Workflow run was admitted
     * (ActiveRun), an ordinary session judged NotFound has an accepted start not seen to end (StartUnresolved), or another transaction holds a
     * session the delete would change (Busy). With `cascade`, all its descendants go with it (a parent's lifecycle owns its
     * children's: a run still active under it ends with it). A catalog without the final check (a test double) deletes as
     * before, one row at a time.
     */
    async function softDeleteChecked(sessionId: string, version: { version: string } | null,
        options: { cascade: boolean; orchestrationNotFound: boolean })
        : Promise<{ deleted: string[] } | { refused: { status: string; detail: string } }> {
        const store = sweeperStore();
        if (store) {
            if (!version) return { refused: { status: "Changed", detail: "it was gone when the Sweeper read it" } };
            return store.sweeperSoftDelete({ sessionId, version: version.version, ...options });
        }
        const deleted: string[] = [];
        for (const descId of options.cascade ? await catalog.getDescendantSessionIds(sessionId) : []) {
            try {
                await catalog.softDeleteSession(descId);
                deleted.push(descId);
            } catch {}
        }
        await catalog.softDeleteSession(sessionId);
        deleted.push(sessionId);
        return { deleted };
    }

    /** The words of a refusal of the final check (softDeleteChecked). */
    function finalCheckRefusal(sessionId: string, refused: { status: string; detail: string }): string {
        switch (refused.status) {
            case "ActiveRun":
                return `Refusing to clean Workflow session ${sessionId}: ${refused.detail} (it was admitted after the Sweeper read the session). `
                    + "It ends through its controller; nothing was deleted.";
            case "StartUnresolved":
                return `Refusing to clean session ${sessionId}: ${refused.detail}. Nothing was deleted; a later scan reads it again.`;
            case "Busy":
                return `Refusing to clean session ${sessionId} for now: ${refused.detail}. Nothing was deleted; try again later.`;
            default:
                return `Refusing to clean session ${sessionId}: ${refused.detail}. Nothing was deleted; a later scan reads it again.`;
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
        session: { sessionId: string; parentSessionId: string | null; updatedAt: Date; sessionKind?: string; serviceKind?: string | null },
        graceMinutes: number,
    ): Promise<{ eligible: boolean; status: string; reason: string; instanceId?: string; controllers?: string[] }> {
        const read = await readOrchestrationStatus(session);
        if ("startUnresolved" in read) {
            return {
                eligible: false,
                status: "StartUnresolved",
                reason: "Refusing to clean a session whose first message was accepted and whose orchestration has not been seen to end: "
                    + "it reads NotFound because no worker has picked its start up yet. Only a terminal status or an ended state shows its end.",
            };
        }
        if ("activeRun" in read) {
            return {
                eligible: false,
                status: "ActiveRun",
                reason: `Refusing to clean a Workflow session whose run ${read.activeRun.runId} is still ${read.activeRun.status} in the store: `
                    + "it ends through its controller. If its controller is gone, update_workflow operation recover dispatches it again "
                    + "or ends it; the Sweeper never does.",
            };
        }
        if ("noRun" in read) {
            return {
                eligible: false,
                status: "NoRun",
                reason: "Refusing to clean a Workflow session that has no run of its own yet (a draft, or one not yet started): it has no orchestration to end.",
            };
        }
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
            return { eligible: true, status: orchStatus, reason: `Orchestration ${orchStatus.toLowerCase()}`, instanceId: read.instanceId,
                ...(read.controllers ? { controllers: read.controllers } : {}) };
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
            "Only sessions whose OWN orchestration is Completed, Failed, Terminated, or NotFound are returned " +
            "(a Workflow session's orchestration is its latest own run's controller; one with a run the store counts as active, " +
            "or with no run of its own yet, is never returned). " +
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

                    const read = await readOrchestrationStatus(session);
                    if ("noRun" in read || "activeRun" in read || "startUnresolved" in read) continue;
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
        // Review AR-02: the row's version first; everything read after it is checked against it under the final lock.
        const version = await readRowVersion(sessionId);
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

        // All descendants go with it (a parent's lifecycle owns its children's), then the session itself: one final check
        // of the session and every soft delete in one transaction (reviews AS-02, AR-01..AR-03).
        const result = await softDeleteChecked(sessionId, version, { cascade: true, orchestrationNotFound: eligibility.status === "NotFound" });
        if ("refused" in result) {
            return { ok: false, sessionId, refused: true, status: result.refused.status, error: finalCheckRefusal(sessionId, result.refused) };
        }
        let deletedCount = 0;
        for (const descId of result.deleted) {
            if (descId === sessionId) continue;
            if (factStore) {
                try { await factStore.deleteSessionFactsForSession(descId); } catch {}
            }
            try { await duroxideClient.deleteInstance(`session-${descId}`, true); } catch {}
            deletedCount++;
        }

        if (factStore) {
            try { await factStore.deleteSessionFactsForSession(sessionId); } catch {}
        }
        // The target's own orchestration instances: session-<id>, or a Workflow session's run controllers (session-<id> for
        // its live run, wft-<run> for a test run). The one the eligibility read is terminal; another is deleted only when
        // a read shows it has ended (a NotFound one has nothing to delete; a failed read deletes nothing).
        const instancesDeleted: string[] = [];
        for (const instanceId of eligibility.controllers ?? [`session-${sessionId}`]) {
            if (instanceId !== (eligibility.instanceId ?? `session-${sessionId}`)) {
                const read = await readInstanceStatus(instanceId);
                if (!("status" in read) || !ENDED_ORCH.has(read.status)) continue;
            }
            try {
                await duroxideClient.deleteInstance(instanceId, true);
                instancesDeleted.push(instanceId);
            } catch {}
        }
        deletedCount++;

        return { ok: true, sessionId, deletedCount, reason: deleteReason, descendants: result.deleted.length - 1, instancesDeleted };
    }

    const cleanupTool = defineTool("cleanup_session", {
        description:
            "Delete terminal session(s) and all their descendants. " +
            "The descendants go with it whatever their state (a parent's lifecycle owns its children's): " +
            "a Workflow run still active under a cleaned session ends with it. " +
            "Accepts a single sessionId OR a batch sessionIds[] — clean many stale sessions (e.g. all the children a scan returned) in one call. " +
            "Removes from CMS (soft-delete) and deletes the duroxide orchestration instance. " +
            "Independently re-verifies EACH target is terminal and REFUSES system sessions plus any live/non-terminal root or child session. " +
            "The final check and the delete are one transaction on the target's lock: a target that changed since it was read " +
            "(a run admitted, a message that started it), an ordinary session whose accepted start has not been seen to end " +
            "(it reads NotFound until a worker picks it up), or one with a session another transaction holds is refused and " +
            "nothing is deleted; leave it for a later scan. " +
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
            "It then soft-deletes the session rows (older than the same cutoff) whose orchestration is NotFound " +
            "(a Workflow session's: its latest own run's controller; one with a run the store counts as active, or with no run " +
            "of its own yet, is kept); " +
            "a status read that fails deletes nothing (cmsUnreadable counts them), and a row that changed since its read " +
            "(a run admitted, a message that started it), or has a session another transaction holds is kept (cmsRefused " +
            "counts them); an ordinary session whose accepted start has not been seen to end is not a candidate. " +
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
                let cmsRefused = 0;
                try {
                    const cmsSessions = await catalog.listSessions();
                    for (const s of cmsSessions) {
                        if (s.isSystem) continue;
                        if (s.updatedAt.getTime() >= cutoffMs) continue;
                        // Review AR-02: the row's version, read before its status, and its age again as of that read.
                        const version = await readRowVersion(s.sessionId);
                        if (sweeperStore() && (!version || version.deleted || version.updatedAt.getTime() >= cutoffMs)) continue;
                        const read = await readOrchestrationStatus(s);
                        if ("noRun" in read || "activeRun" in read || "startUnresolved" in read) continue;
                        if ("unreadable" in read) {
                            cmsUnreadable++;
                            console.warn(`[sweeper] prune: could not read the status of session ${s.sessionId}; not deleted: ${read.unreadable}`);
                            continue;
                        }
                        if (read.status !== "NotFound") continue;
                        try {
                            // The final check and the soft delete in one transaction (reviews AS-02, AR-01..AR-03): a row
                            // changed or started since its read, or one another transaction holds, is kept.
                            const result = await softDeleteChecked(s.sessionId, version, { cascade: false, orchestrationNotFound: true });
                            if ("refused" in result) {
                                cmsRefused++;
                                console.warn(`[sweeper] prune: ${finalCheckRefusal(s.sessionId, result.refused)}`);
                                continue;
                            }
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
                    cmsRefused,
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
