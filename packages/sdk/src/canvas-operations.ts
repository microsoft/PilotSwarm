/**
 * Canvas operations: the work behind draw_canvas, update_canvas, show_canvas,
 * read_canvas, canvas_kv and publish_canvas_app. They need no turn. The agent
 * bridge in session-proxy.ts spreads them into its controlToolBridge; a
 * caller without a turn can build its own set with another writer.
 *
 * The managed-session.ts tool handlers stay the single place for argument
 * checks and result shapes. These methods return plain objects or `{ error }`.
 *
 * The write chains (one per target session) and the tick states (one per
 * target and slot) are module state, so every writer on this worker shares
 * them.
 */

import nodeCrypto from "node:crypto";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { performance } from "node:perf_hooks";
import type { SessionCatalog } from "./cms.js";
import type { ArtifactStore } from "./session-store.js";
import type { FactStore } from "./facts-store.js";
import { extractCanvasAppManifest, canvasAppCard, normalizeCanvasResponseContract } from "./canvas-app-manifest.js";
import { CANVAS_KV_LIST_PAGE, CANVAS_KV_MAX_KEYS, readCanvasKv, writeCanvasKv, type CanvasKvEntry } from "./canvas-kv.js";
import { publishCanvasApp } from "./canvas-app-catalog.js";
import { CANVAS_SLOT_ERROR, WORKFLOW_SCRIPT_MUST_NAME_CANVAS, canvasArtifactFilename, normalizeCanvasSlot, eventSlot, latestCanvasEventData, latestCanvasRev } from "./canvas-support.js";
import { CANVAS_EVENT_WINDOW } from "../api/src/canvas-slots.js";
import { isOwnerOnlyArtifact } from "../api/src/session-authz.js";
import { ARTIFACT_OWNER_ONLY, ownerOnlyArtifactMessage } from "./artifact-tools.js";

export interface CanvasOperationDeps {
    catalog: SessionCatalog | null;
    artifactStore: ArtifactStore | null;
    /** Only publishCanvasApp reads it. */
    factStore: FactStore | null;
    /** The session that writes: the default target, the KV principal and the `by` of cross-session writes. */
    writerSessionId: string;
    workerNodeId: string | undefined;
    /** publishCanvasApp provenance. */
    agentIdentity: string | null;
    /**
     * "agent": a tick that comes too early is refused, and canvas_kv reads inside a Workflow agent step's subtree
     * hide person rows (D9). "script": a tick waits out the rest of the interval, and canvas_kv reads every row.
     */
    mode: "agent" | "script";
    /** Test seam: the clock of the script-mode tick wait only. Default: the monotonic clock. */
    tickClock?: CanvasTickClock;
    /**
     * Review S5 (#376): a synchronous check before each write. A turn's bridge passes its fence
     * (control-bridge-fence.ts), which throws once the turn or its activity attempt has ended; the write then
     * returns `{ error }` and writes nothing more. A writer without a turn passes none.
     */
    fence?: (tool: string, step: string) => void;
}

async function latestCanvasDataRev(catalog: any, sessionId: string, slot = 1): Promise<number> {
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, CANVAS_EVENT_WINDOW, ["session.canvas_data"],
    );
    let latest = 0;
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row as any)?.data?.dataRev);
        if (Number.isFinite(rev) && rev > latest && Number.isInteger(rev)) latest = rev;
    }
    return latest;
}

// Write serialization, one chain per target session: parallel draws and
// ticks on one target (in one assistant message, or from several writers)
// would otherwise race the derive-write-record section and mint duplicate
// revisions. Writes to one target keep their call order across slots; writes
// to different targets do not wait for each other.
const canvasChains = new Map<string, Promise<void>>();

/**
 * Runs `op` after every write already queued for `target`. The place in the
 * queue is taken at call time, so callers must not await anything between
 * choosing the target and calling this.
 */
export function enqueueCanvasWrite<T>(target: string, op: () => Promise<T>): Promise<T> {
    const prev = canvasChains.get(target) ?? Promise.resolve();
    const run = prev.then(op);
    const tail = run.then(() => undefined, () => undefined);
    canvasChains.set(target, tail);
    void tail.then(() => {
        if (canvasChains.get(target) === tail) canvasChains.delete(target);
    });
    return run;
}

// Per-slot tick throttle (the plane makes ticks cheap; a runaway loop must
// not flood viewers). One state per `${targetSessionId}:${slot}` for the
// whole worker: a child ticking its own canvas and its parent's dashboard are
// separate budgets, and two writers ticking the same slot share one.
export const CANVAS_TICK_MIN_INTERVAL_MS = 100;

interface CanvasTickState {
    /** The last ACTUAL admission time on the tick clock, or null before the first. */
    last: number | null;
    /** Script ticks that hold a place and have not been admitted yet. */
    pending: number;
}
const canvasTickStates = new Map<string, CanvasTickState>();
// Past this many keys, a gate call first drops the states that no longer limit anything.
const CANVAS_TICK_STATE_SWEEP_AT = 1024;

/** The tick clock: monotonic milliseconds and a sleep. Injectable for tests. */
export interface CanvasTickClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}
const monotonicNow = (): number => performance.now();
const monotonicTickClock: CanvasTickClock = {
    now: monotonicNow,
    sleep: (ms) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.ceil(ms)))),
};

function sweepCanvasTickStates(t: number): void {
    if (canvasTickStates.size < CANVAS_TICK_STATE_SWEEP_AT) return;
    for (const [key, state] of canvasTickStates) {
        if (state.pending === 0 && (state.last === null || t - state.last >= CANVAS_TICK_MIN_INTERVAL_MS)) {
            canvasTickStates.delete(key);
        }
    }
}

function tickRefusal(key: string): string {
    const slot = key.slice(key.lastIndexOf(":") + 1);
    return `ticking slot ${slot} faster than ${CANVAS_TICK_MIN_INTERVAL_MS} ms apart — aggregate your changes into fewer, larger ticks`;
}

/**
 * Agent mode, decided at once at call time. A tick is refused while a script
 * tick on the same key waits for its turn, or less than
 * CANVAS_TICK_MIN_INTERVAL_MS after the last admitted tick. A refusal stamps
 * nothing; an admitted tick stamps its time.
 */
export function canvasTickGate(key: string, now: () => number = monotonicNow): { refused: string } | { admitted: true } {
    const t = now();
    sweepCanvasTickStates(t);
    const state = canvasTickStates.get(key);
    if (state && (state.pending > 0 || (state.last !== null && t - state.last < CANVAS_TICK_MIN_INTERVAL_MS))) {
        return { refused: tickRefusal(key) };
    }
    if (state) state.last = t;
    else canvasTickStates.set(key, { last: t, pending: 0 });
    return { admitted: true };
}

/** Script mode, at call time, before the tick is queued: hold a place on the key. */
export function reserveScriptTick(key: string, now: () => number = monotonicNow): void {
    sweepCanvasTickStates(now());
    const state = canvasTickStates.get(key);
    if (state) state.pending += 1;
    else canvasTickStates.set(key, { last: null, pending: 1 });
}

/**
 * Script mode, inside the target's write chain, when the tick's turn comes:
 * waits until CANVAS_TICK_MIN_INTERVAL_MS have passed since the last admitted
 * tick (re-reading the clock after every sleep), then stamps the actual time
 * and gives back the place reserveScriptTick took. The place is given back
 * even if the wait fails.
 */
export async function waitForScriptTickTurn(key: string, clock: CanvasTickClock = monotonicTickClock): Promise<void> {
    let state = canvasTickStates.get(key);
    if (!state) {
        state = { last: null, pending: 1 };
        canvasTickStates.set(key, state);
    }
    try {
        for (;;) {
            const t = clock.now();
            if (state.last === null || t - state.last >= CANVAS_TICK_MIN_INTERVAL_MS) {
                state.last = t;
                return;
            }
            await clock.sleep(state.last + CANVAS_TICK_MIN_INTERVAL_MS - t);
        }
    } finally {
        state.pending = Math.max(0, state.pending - 1);
    }
}

/** Test seam: how many tick keys the worker holds. */
export function canvasTickKeyCount(): number {
    return canvasTickStates.size;
}

// How far up the parent chain a canvas target may be, in hops from the writer.
const CANVAS_TARGET_MAX_HOPS = 8;

const NO_PARENT_AGENT = 'session_id "parent": this session has no parent agent.';
function workflowHasNoCanvas(sessionId: string): string {
    return `session_id ${sessionId.slice(0, 8)} is a Workflow, and a Workflow has no canvas. Use session_id "parent" to write to the agent that started it.`;
}

/**
 * Cross-session canvas targeting: ANCESTORS ONLY. A sub-agent may
 * draw on its parent's (or grandparent's, or the root's) surface —
 * never a sibling's, a child's, or a stranger's. Worker-trusted,
 * the same stance as fromArtifact; the walk is the catalog's parent
 * chain, capped at CANVAS_TARGET_MAX_HOPS. A chain that repeats an id is
 * a lineage error.
 *
 * `"parent"` names the agent that started the Workflow when the writer is
 * a Workflow or sits below one, and the direct parent otherwise; that
 * candidate then passes the same checks as an explicit ancestor id. A
 * Workflow session is never a target, and a script (mode "script") must
 * name one.
 */
export async function resolveCanvasTarget(deps: CanvasOperationDeps, requested: unknown): Promise<{ target: string; crossSession: boolean } | { error: string }> {
    const writer = deps.writerSessionId;
    const requestedId = String(requested ?? "").trim();
    if (!requestedId) {
        if (deps.mode === "script") return { error: WORKFLOW_SCRIPT_MUST_NAME_CANVAS };
        return { target: writer, crossSession: false };
    }

    // The writer, then each ancestor by parentSessionId. A link to a row the
    // catalog no longer has still counts as an ancestor id (row null), as it
    // always did; the walk stops there.
    const chain: Array<{ id: string; row: any }> = [];
    const visited = new Set<string>();
    let cursor: string | null = writer;
    for (let hops = 0; hops <= CANVAS_TARGET_MAX_HOPS && cursor; hops++) {
        let row: any;
        try {
            row = (await deps.catalog?.getSession?.(cursor)) ?? null;
        } catch (err: any) {
            return { error: `could not verify the session lineage: ${err?.message || String(err)}` };
        }
        chain.push({ id: cursor, row });
        visited.add(cursor);
        const next: string | null = row?.parentSessionId ?? null;
        if (next && visited.has(next)) {
            return { error: `could not verify the session lineage: the parent chain repeats at ${next.slice(0, 8)}` };
        }
        cursor = next;
    }
    const isWorkflow = (row: any): boolean => row?.sessionKind === "workflow";
    // An id above the writer: a link in the walked chain after the writer, and not a Workflow.
    const ancestorTarget = (id: string): { target: string; crossSession: boolean } | { error: string } => {
        const ancestor = chain.slice(1).find((link) => link.id === id);
        if (!ancestor) {
            return { error: `session_id ${id} is not an ancestor of this session — canvas tools may target only your parent chain (parent, grandparent, root)` };
        }
        if (isWorkflow(ancestor.row)) return { error: workflowHasNoCanvas(id) };
        return { target: id, crossSession: true };
    };

    if (requestedId === "parent") {
        const workflow = chain.find((link) => isWorkflow(link.row));
        const candidate: string | null = (workflow ? workflow.row.parentSessionId : chain[0]?.row?.parentSessionId) ?? null;
        if (!candidate) return { error: NO_PARENT_AGENT };
        return ancestorTarget(candidate);
    }
    if (requestedId === writer) {
        if (isWorkflow(chain[0]?.row)) return { error: workflowHasNoCanvas(writer) };
        return { target: writer, crossSession: false };
    }
    return ancestorTarget(requestedId);
}

/**
 * D9: the rows an agent session inside a Workflow agent step's subtree may
 * read. A row a person or a share link wrote, or a legacy row with no writer
 * (read back as kind "user"), is not one of them.
 */
export function visibleToAgentStep(entry: CanvasKvEntry): boolean {
    return entry.by?.kind === "agent";
}

/**
 * D9: how canvas_kv get and list, and read_canvas, treat what a person wrote
 * for this reader. "hide" when the reader is a Workflow agent step's child
 * or sits below one; "fail" when its lineage cannot be read: the read
 * returns `error` and no data, so a failed read never looks like an empty
 * store. A script reads everything. Read on every call, never cached: the
 * lineage is the authority.
 */
async function agentStepReadMode(deps: CanvasOperationDeps): Promise<{ mode: "show" | "hide" } | { mode: "fail"; error: string }> {
    if (deps.mode === "script") return { mode: "show" };
    if (!deps.catalog?.workflowStore) return { mode: "show" };
    try {
        const lineage = await deps.catalog.workflowStore().readWorkflowLineage(deps.writerSessionId);
        return { mode: lineage?.agentRoot ? "hide" : "show" };
    } catch (err: any) {
        return { mode: "fail", error: `could not verify the session lineage: ${err?.message || String(err)}` };
    }
}

/**
 * D9: the most store pages one canvas_kv list in an agent step's subtree
 * reads. A canvas holds at most CANVAS_KV_MAX_KEYS live keys, so a store that
 * does not change during the list is read to its end in
 * CANVAS_KV_MAX_KEYS / CANVAS_KV_LIST_PAGE + 1 pages (the last one short or
 * empty). One more page leaves room for writes during the read.
 */
export const AGENT_STEP_LIST_MAX_PAGES = Math.floor(CANVAS_KV_MAX_KEYS / CANVAS_KV_LIST_PAGE) + 2;

/**
 * D9: canvas_kv list for a reader in an agent step's subtree. Only agent
 * rows, and a cursor that never names a hidden row: nextAfter is the key of
 * the last row returned, and it is set only when another agent row follows.
 * The store is read in whole pages, past hidden rows, until limit + 1 agent
 * rows are found or the rows run out, so neither the cursor nor its
 * presence depends on a hidden row. Each page is a separate read, so writes
 * between them can keep putting new hidden rows ahead of the cursor: after
 * AGENT_STEP_LIST_MAX_PAGES pages the list stops with an error and returns
 * no rows, never a short page that would look like the end of the data.
 */
async function listForAgentStep(
    store: Parameters<typeof readCanvasKv>[0], target: string, slot: number, principal: Parameters<typeof readCanvasKv>[3],
    query: { prefix?: string; limit?: number; after?: string },
) {
    const limit = Math.max(1, Math.min(CANVAS_KV_LIST_PAGE, Math.floor(Number(query.limit) || CANVAS_KV_LIST_PAGE)));
    const visible: CanvasKvEntry[] = [];
    let after = query.after;
    let policy: Awaited<ReturnType<typeof readCanvasKv>>["policy"] | undefined;
    for (let pages = 1; ; pages++) {
        const read = await readCanvasKv(store, target, slot, principal, { prefix: query.prefix, limit: CANVAS_KV_LIST_PAGE, after });
        policy ??= read.policy;
        visible.push(...read.entries.filter(visibleToAgentStep));
        if (visible.length > limit || !read.nextAfter) break;
        if (pages >= AGENT_STEP_LIST_MAX_PAGES) {
            return { error: `list read ${AGENT_STEP_LIST_MAX_PAGES} store pages and the canvas data was still changing, so nothing is returned; call list again` };
        }
        after = read.nextAfter;
    }
    const entries = visible.slice(0, limit);
    return { entries, ...(visible.length > limit ? { nextAfter: entries[limit - 1].key } : {}), policy };
}

/**
 * D9 for the canvas document: a reader in an agent step's subtree gets the
 * document only when its stored bytes are the ones the last draw wrote. A
 * person can replace canvas.html after a draw (an artifact upload or copy),
 * but only draw_canvas writes canvas_live's doc_sha: the SHA-256 of the
 * UTF-8 bytes it stored. So the SHA-256 of the stored bytes themselves (not
 * of the text they decode to) is compared with it: a mismatch, or no
 * recorded hash, is a refusal; a failed read of the record is an error. A
 * binary artifact is refused as downloadArtifactText refuses it.
 * On a match it returns the text, decoded as downloadArtifactText decodes
 * it, and the canvas_live row it read: the one snapshot that read_canvas's
 * includeData answers from, so the data never comes from a second read that
 * could fail or see a later draw.
 */
async function readAgentStepDocument(
    artifactStore: ArtifactStore, catalog: any, target: string, slot: number,
): Promise<{ error: string } | { text: string; row: any }> {
    const filename = canvasArtifactFilename(slot);
    const doc = await artifactStore.downloadArtifact(target, filename);
    if (doc.isBinary) throw new Error(`Artifact '${filename}' is binary and cannot be read as text.`);
    let row: any;
    try {
        if (await catalog.canvasLiveAvailable?.()) {
            const rows = await catalog.getCanvasLive?.(target);
            row = (rows || []).find((r: any) => Number(r.slot) === slot);
        }
    } catch (err: any) {
        return { error: `could not verify the canvas document: ${err?.message || String(err)}` };
    }
    const recorded = String(row?.docSha || "");
    if (recorded && recorded === createHash("sha256").update(doc.body).digest("hex")) {
        return { text: doc.body.toString("utf8"), row };
    }
    return { error: `the document in canvas slot ${slot} does not match the last draw_canvas there, so a session in a Workflow agent step cannot read it (${filename} may have been replaced after the draw); draw the canvas again` };
}

export type CanvasOperations = Pick<ReturnType<typeof createCanvasOperations>,
    "drawCanvas" | "updateCanvas" | "showCanvas" | "readCanvas" | "canvasKv" | "publishCanvasApp">;

export function createCanvasOperations(deps: CanvasOperationDeps) {
    const { catalog, artifactStore, factStore, workerNodeId } = deps;
    return {
        // ATOMICITY: drawCanvas persists the canvas_updated event HERE,
        // awaited, immediately after the byte write — derive, write, and
        // record happen inside one serialized section, so parallel tool
        // calls cannot mint duplicate revs. session-proxy's generic onEvent
        // persister treats canvas_updated as already-persisted (see
        // EPHEMERAL_TYPES); the persisted event is the live path.
        drawCanvas: async (args: { html?: string; fromArtifact?: { sessionId?: string; filename: string; expectedSha256?: string }; note?: string; responseContract?: Record<string, any>; slot?: number; name?: string; session_id?: string }) => {
            if (!artifactStore) return { error: "this worker has no artifact store" };
            if (!catalog) return { error: "canvas requires the CMS catalog" };
            // Review PRS-001: a Workflow agent's base instructions are the Workflow owner's only; a canvas is no way to read
            // them. Refused before anything is read or written, in read_artifact's words, whatever the source session.
            if (args.fromArtifact && isOwnerOnlyArtifact(args.fromArtifact.filename)) {
                return { error: `${ARTIFACT_OWNER_ONLY}: ${ownerOnlyArtifactMessage(args.fromArtifact.filename)} Nothing was drawn.` };
            }
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const rawName = args.name === undefined ? undefined : String(args.name).trim();
            if (rawName !== undefined && rawName.length > 60) {
                return { error: "name must be 60 characters or fewer" };
            }
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            const { target, crossSession } = resolved;
            const run = enqueueCanvasWrite(target, async () => {
                // Source resolution. fromArtifact pulls bytes store-side —
                // the same trust stance as read_artifact/write_artifact's
                // cross-session paths (the artifact layer is worker-trusted);
                // the model never carries the document.
                let html: string;
                let source: { kind: "artifact"; sessionId: string; filename: string; sha256: string } | undefined;
                if (args.fromArtifact) {
                    const from = args.fromArtifact;
                    const sourceSessionId = String(from.sessionId || deps.writerSessionId);
                    const filename = String(from.filename || "");
                    let body: Buffer;
                    try {
                        const fetched = await artifactStore.downloadArtifact(sourceSessionId, filename);
                        if (fetched.isBinary) throw new Error(`Artifact '${filename}' is binary and cannot be read as text.`);
                        body = fetched.body;
                    } catch (err: any) {
                        return { error: `could not read artifact ${filename} from session ${sourceSessionId}: ${err?.message || String(err)}` };
                    }
                    // A canvas stores UTF-8 and read_canvas returns the stored
                    // bytes. Other bytes would be stored altered (each bad
                    // sequence as U+FFFD), so they are refused before any write.
                    if (!isUtf8(body)) {
                        return { error: `artifact ${filename} is not valid UTF-8 text; nothing was drawn. Save it as UTF-8 and draw again.` };
                    }
                    const text = body.toString("utf8");
                    const fetchedBytes = body.length;
                    if (fetchedBytes > 900_000) {
                        return { error: `artifact ${filename} is ${fetchedBytes} bytes; the canvas cap is 900 KB` };
                    }
                    const sha256 = nodeCrypto.createHash("sha256").update(body).digest("hex");
                    if (from.expectedSha256 && sha256 !== from.expectedSha256) {
                        return { error: `SHA_MISMATCH: artifact ${filename} hashes ${sha256}, expected ${from.expectedSha256}; nothing was drawn` };
                    }
                    if (!text.trim()) {
                        return { error: `artifact ${filename} is empty; to clear the canvas pass html: ""` };
                    }
                    html = text;
                    source = { kind: "artifact", sessionId: sourceSessionId, filename, sha256 };
                } else {
                    html = String(args.html ?? "");
                }
                // Interface card: extract the embedded manifest, resolve the
                // EFFECTIVE contract (explicit argument wins; else the
                // manifest's, revalidated by the same normalizer; an invalid
                // embedded contract with no explicit override fails the draw
                // closed rather than arming nothing silently).
                const extraction = html ? extractCanvasAppManifest(html) : { manifest: null };
                let effectiveContract = args.responseContract;
                let manifestWarning: string | undefined;
                if (!effectiveContract && html) {
                    if (extraction.error && !args.fromArtifact) {
                        // Inline draw with a broken manifest attempt: tolerate —
                        // the author is iterating live and passed no contract —
                        // but SAY SO, or they first learn at reuse time when the
                        // fromArtifact draw fails closed.
                        manifestWarning = `CANVAS-APP-MANIFEST attempt is broken (${extraction.error}); drawn without it — fix the comment before saving this as an app.`;
                    } else if (extraction.error) {
                        return { error: `the artifact's CANVAS-APP-MANIFEST is broken: ${extraction.error}. Fix the stored app or pass an explicit responseContract.` };
                    }
                    if (extraction.manifest?.responseContract !== undefined) {
                        const normalized = normalizeCanvasResponseContract(extraction.manifest.responseContract);
                        if (normalized.error) {
                            return { error: `the embedded CANVAS-APP-MANIFEST contract is invalid: ${normalized.error}. Fix the stored app or pass an explicit responseContract.` };
                        }
                        effectiveContract = normalized.contract;
                    }
                }
                const app = canvasAppCard(extraction.manifest);
                const note = args.note ? String(args.note) : undefined;
                // Atomic rev mint (multi-writer safe), AFTER every
                // validation refusal above: the mint writes latest_rev
                // into the 0045 cache, and a rev minted for a draw
                // that then failed validation would unlock ticks on an
                // empty slot (latestCanvasRev is table-first). The
                // seed from the table/event read floors legacy
                // sessions whose cache row never landed. Residual
                // window: an upload/record failure AFTER the mint
                // burns a phantom rev — infra-failure only, and the
                // next successful draw overwrites it; read_canvas
                // stays honest because it is log-first.
                deps.fence?.("draw_canvas", "drawing the canvas");
                const seedRev = await latestCanvasRev(catalog, target, slot);
                const rev = typeof (catalog as any).mintCanvasRev === "function"
                    ? await (catalog as any).mintCanvasRev(target, slot, seedRev)
                    : seedRev + 1;
                await artifactStore.uploadArtifact(
                    target, canvasArtifactFilename(slot), html, "text/html",
                    // Pinned on EVERY draw, not just the first: uploads
                    // replace artifact metadata wholesale, so a pin set
                    // once at rev 1 was silently erased by rev 2.
                    { pinned: true } as any,
                );
                const sizeBytes = Buffer.byteLength(html, "utf8");
                // Durable commit BEFORE returning: a rev is only ever
                // advertised after both its bytes and its event exist.
                // The response contract rides the event so every
                // client learns it exactly where it learns the rev —
                // live push and cold snapshot alike, no extra fetch.
                await catalog.recordEvents(target, [{
                    eventType: "session.canvas_updated",
                    data: {
                        rev,
                        slot,
                        ...(rawName !== undefined ? { name: rawName } : {}),
                        sizeBytes,
                        ...(note ? { note } : {}),
                        ...(effectiveContract ? { responseContract: effectiveContract } : {}),
                        // canvas-ws: the page's declared access, checked
                        // (null when it declares none). It rides the
                        // event so the portal reads it with the rev it
                        // belongs to, never an older page's.
                        workspace: extraction.manifest?.workspace ?? null,
                        ...(extraction.error ? { manifestError: String(extraction.error).slice(0, 300) } : {}),
                        ...(source ? { source } : {}),
                        // Attribution: who actually drew this revision.
                        // Only present on cross-session draws, so the
                        // portal can badge "drawn by sub-agent X".
                        ...(crossSession ? { by: deps.writerSessionId } : {}),
                    },
                }], workerNodeId);
                // The per-slot cache (migration 0045). Non-fatal on
                // purpose: the event above is durable, and the next
                // draw falls back to the event scan if this row is
                // missing — failing the draw over a cache write would
                // invert the dependency.
                try {
                    await catalog.upsertSessionCanvas?.(target, slot, rawName ?? null, rev, sizeBytes);
                } catch { /* self-heals on the next draw */ }
                // The app's half of the KV write switch (Part D.3),
                // cached so a KV write never re-reads the document.
                // A document with no manifest clears it: the new page
                // declares nothing, so collaborators cannot write. A
                // failed cache write fails CLOSED: the previous app's
                // `viewers` switch must not stay armed for a page that
                // declared nothing, so clearing is retried and the
                // result tells the agent when neither landed.
                let kvManifestWarning: string | undefined;
                try {
                    await (catalog as any).setCanvasKvManifest?.(target, slot, extraction.manifest?.kv ?? null);
                } catch {
                    try {
                        await (catalog as any).setCanvasKvManifest?.(target, slot, null);
                    } catch {
                        kvManifestWarning = "the canvas KV manifest cache could not be written; collaborators may keep the previous app's write access until the next successful draw.";
                    }
                }
                if (kvManifestWarning) manifestWarning = manifestWarning ? `${manifestWarning} ${kvManifestWarning}` : kvManifestWarning;
                // The data plane (migration 0047): doc pointer for
                // live viewers + RESET of the data mirror — the new
                // page starts from its own initial state, never the
                // old page's stale ticks. Non-fatal: the plane is the
                // acceleration path, the event above is the truth.
                try {
                    if (await (catalog as any).canvasLiveAvailable?.()) {
                        const sha = createHash("sha256").update(html, "utf8").digest("hex");
                        await (catalog as any).upsertCanvasLiveDoc?.(target, slot, { rev, sha }, deps.writerSessionId);
                    }
                } catch { /* live viewers resync from events */ }
                return {
                    rev,
                    slot,
                    ...(rawName !== undefined ? { name: rawName } : {}),
                    sizeBytes,
                    ...(source ? { source } : {}),
                    ...(app ? { app } : {}),
                    ...(effectiveContract ? { responseContract: effectiveContract } : {}),
                    ...(manifestWarning ? { manifestWarning } : {}),
                };
            }).catch((err: any) => ({ error: err?.message || String(err) }));
            return run;
        },
        updateCanvas: async (args: { data?: Record<string, any>; patch?: Record<string, any>; note?: string; slot?: number; session_id?: string }) => {
            if (!catalog) return { error: "canvas requires the CMS catalog" };
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            const { target, crossSession } = resolved;
            const isPatch = args.patch !== undefined;
            const body = isPatch ? args.patch : args.data;
            // Rate limit at the source: the plane makes ticks cheap
            // enough that a runaway loop could flood viewers. Applies
            // per (target, slot) across every writer on this worker.
            // Decided or reserved synchronously, so the tick keeps its
            // place in the target's queue.
            const tickKey = `${target}:${slot}`;
            if (deps.mode === "agent") {
                const gate = canvasTickGate(tickKey);
                if ("refused" in gate) return { error: gate.refused };
            } else {
                reserveScriptTick(tickKey);
            }
            const run = enqueueCanvasWrite(target, async () => {
                if (deps.mode === "script") await waitForScriptTickTurn(tickKey, deps.tickClock);
                if ((await latestCanvasRev(catalog, target, slot)) === 0) {
                    return { error: `no canvas has been drawn in slot ${slot} — draw_canvas first; ticks patch an existing page` };
                }
                const planeAvailable = await (catalog as any).canvasLiveAvailable?.().catch(() => false);
                // The plane is where merges live. Without it (older
                // deployment), a patch has no current state to merge
                // against — refuse with the actionable alternative
                // instead of guessing.
                if (isPatch && !planeAvailable) {
                    return { error: "this deployment predates the canvas data plane — send data (the whole state) instead of patch" };
                }
                deps.fence?.("update_canvas", "writing the data");
                // Whole state after this write, whoever computes it:
                // the plane merges patches server-side; a plain PUT is
                // its own whole state.
                let mergedPayload: Record<string, unknown> = (body ?? {}) as Record<string, unknown>;
                let planeSeq: number | undefined;
                if (planeAvailable) {
                    const live = await (catalog as any).upsertCanvasLiveTick(
                        target, slot,
                        isPatch ? { patch: body } : { data: body },
                        deps.writerSessionId,
                        32_768,
                    );
                    if (live?.refused) {
                        return {
                            error: `the merged canvas state would exceed 32768 bytes`
                                + (live.currentSizeBytes != null ? ` (currently ${live.currentSizeBytes} bytes)` : "")
                                + `. Aggregate the data, remove stale keys (patch with null deletes), or redraw if the shape truly grew.`,
                        };
                    }
                    mergedPayload = live.payload ?? mergedPayload;
                    planeSeq = live.seq;
                }
                const sizeBytes = Buffer.byteLength(JSON.stringify(mergedPayload), "utf8");
                // Dual-write phase: the durable event carries the
                // MERGED whole state so pre-plane readers (older
                // portals, cold loads) stay complete. Flipping
                // PILOTSWARM_CANVAS_DURABLE_TICKS=0 ends this — only
                // after every reader in the environment prefers the
                // plane, and the completion checkpoint ships with
                // that flip.
                let dataRev: number | undefined;
                // The flag only silences durable ticks where the
                // plane actually took the write. Plane absent =
                // today's path stays, whatever the flag says —
                // otherwise a PUT would be written NOWHERE and still
                // report success.
                if (!planeAvailable || process.env.PILOTSWARM_CANVAS_DURABLE_TICKS !== "0") {
                    dataRev = (await latestCanvasDataRev(catalog, target, slot)) + 1;
                    await catalog.recordEvents(target, [{
                        eventType: "session.canvas_data",
                        data: {
                            dataRev,
                            slot,
                            sizeBytes,
                            payload: mergedPayload,
                            ...(planeSeq !== undefined ? { planeSeq } : {}),
                            ...(isPatch ? { patched: true } : {}),
                            ...(crossSession ? { by: deps.writerSessionId } : {}),
                            ...(args.note ? { note: String(args.note) } : {}),
                        },
                    }], workerNodeId);
                }
                return {
                    ...(dataRev !== undefined ? { dataRev } : {}),
                    ...(planeSeq !== undefined ? { seq: planeSeq } : {}),
                    slot,
                    sizeBytes,
                    mode: isPatch ? "patch" : "data",
                };
            }).catch((err: any) => ({ error: err?.message || String(err) }));
            return run;
        },
        // Bring an ALREADY-DRAWN canvas to the user's screen without
        // redrawing it: no bytes, no new rev, nothing marked unseen.
        // The portal routes the event through the same flip guards a
        // draw uses (active session, freshness, per-slot opt-out).
        showCanvas: async (args: { slot?: number; session_id?: string }) => {
            if (!catalog) return { error: "canvas requires the CMS catalog" };
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            const { target, crossSession } = resolved;
            const rev = await latestCanvasRev(catalog, target, slot);
            if (rev === 0) {
                return { error: `nothing has been drawn in slot ${slot} — draw_canvas first; show_canvas only presents an existing canvas` };
            }
            try {
                deps.fence?.("show_canvas", "presenting the canvas");
            } catch (err: any) {
                return { error: err?.message || String(err) };
            }
            await catalog.recordEvents(target, [{
                eventType: "session.canvas_presented",
                data: { slot, rev, ...(crossSession ? { by: deps.writerSessionId } : {}) },
            }], workerNodeId);
            return { presented: true, slot, rev };
        },
        // Door 3 of the canvas KV store: the agent. Same chokepoint
        // as the browser doors; the principal is the session itself.
        canvasKv: async (args: { op: "get" | "put" | "list" | "delete"; key?: string; value?: unknown; prefix?: string; limit?: number; after?: string; ifMatch?: number; slot?: number; session_id?: string }) => {
            if (!catalog) return { error: "canvas KV requires the CMS catalog" };
            if (typeof (catalog as any).canvasKvWrite !== "function") return { error: "this deployment's catalog predates the canvas KV store (migration 0064)" };
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            const { target } = resolved;
            const principal = { kind: "agent" as const, sessionId: deps.writerSessionId };
            const store = catalog as any;
            try {
                switch (args.op) {
                    case "get": {
                        if (!args.key) return { error: "key is required for get (use list with a prefix to browse)" };
                        const visibility = await agentStepReadMode(deps);
                        if (visibility.mode === "fail") return { error: visibility.error };
                        const read = await readCanvasKv(store, target, slot, principal, { key: args.key });
                        const hit = read.entries[0];
                        return hit && (visibility.mode === "show" || visibleToAgentStep(hit)) ? { found: true, ...hit } : { found: false, key: args.key };
                    }
                    case "list": {
                        const visibility = await agentStepReadMode(deps);
                        if (visibility.mode === "fail") return { error: visibility.error };
                        if (visibility.mode === "hide") {
                            return await listForAgentStep(store, target, slot, principal, { prefix: args.prefix, limit: args.limit, after: args.after });
                        }
                        const read = await readCanvasKv(store, target, slot, principal, { prefix: args.prefix, limit: args.limit, after: args.after });
                        return { entries: read.entries, ...(read.nextAfter ? { nextAfter: read.nextAfter } : {}), policy: read.policy };
                    }
                    case "put":
                    case "delete": {
                        if (!args.key) return { error: "key is required" };
                        const op = args.op === "put"
                            ? { op: "put" as const, key: args.key, value: args.value, ifMatch: args.ifMatch ?? null }
                            : { op: "delete" as const, key: args.key, ifMatch: args.ifMatch ?? null };
                        deps.fence?.("canvas_kv", `the ${args.op} of ${args.key}`);
                        const written = await writeCanvasKv(store, target, slot, principal, [op]);
                        const result = written.results[0];
                        return result.ok
                            ? { ok: true, key: result.key, rev: result.rev }
                            : { error: `${result.code}: ${result.error}`, key: result.key, ...(result.rev !== undefined ? { rev: result.rev } : {}) };
                    }
                    default:
                        return { error: `op must be get, put, list or delete (got ${String((args as any).op)})` };
                }
            } catch (err: any) {
                return { error: err?.message || String(err) };
            }
        },
        // The app catalog (interactive-canvas-apps Part F). Publish
        // copies the canvas bytes to a pinned `app-<name>.html`
        // artifact and writes ONE shared fact `apps/<name>` whose value
        // is the card — derived from the document's manifest, never
        // from the model's memory of it. Find is a ranked search over
        // that namespace (hybrid on an enhanced store, a plain listing
        // with a lexical filter on a base store).
        publishCanvasApp: async (args: { name?: string; description?: string; tags?: string[]; slot?: number; session_id?: string }) => {
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            return publishCanvasApp(
                {
                    artifactStore, catalog, factStore, sessionId: deps.writerSessionId, agentIdentity: deps.agentIdentity, workerNodeId,
                    fence: deps.fence ? (step) => deps.fence!("publish_canvas_app", step) : undefined,
                },
                { name: args.name, description: args.description, tags: args.tags, slot, target: resolved.target },
            );
        },
        readCanvas: async (args: { offset?: number; maxBytes?: number; manifestOnly?: boolean; includeData?: boolean; slot?: number; session_id?: string }) => {
            if (!artifactStore) return { error: "this worker has no artifact store" };
            if (!catalog) return { error: "canvas requires the CMS catalog" };
            const slot = normalizeCanvasSlot(args.slot);
            if (slot === null) return { error: CANVAS_SLOT_ERROR };
            const resolved = await resolveCanvasTarget(deps, args.session_id);
            if ("error" in resolved) return { error: resolved.error };
            const { target } = resolved;
            // D9: an agent step's subtree reads only a document a draw wrote.
            const visibility = await agentStepReadMode(deps);
            if (visibility.mode === "fail") return { error: visibility.error };
            // "What is the page showing right now?" — the plane's
            // last-value row, one PK read. Opt-in (the payload can be
            // 32 KB of model context) and independent of paging. In an
            // agent step's subtree it is the canvas_live row the document
            // was checked against (checkedDocument): one snapshot, never a
            // second read that could fail or see a later draw.
            let checkedRow: any;
            const liveState = async () => {
                if (!args.includeData) return {};
                try {
                    let hit = checkedRow;
                    if (visibility.mode !== "hide") {
                        if (!(await (catalog as any).canvasLiveAvailable?.())) return {};
                        const rows = await (catalog as any).getCanvasLive?.(target);
                        hit = (rows || []).find((r: any) => Number(r.slot) === slot);
                    }
                    return hit ? { live: { seq: hit.seq, data: hit.payload, updatedBy: hit.updatedBy, updatedAt: hit.updatedAt } } : {};
                } catch { return {}; }
            };
            const checkedDocument = async () => {
                const checked = await readAgentStepDocument(artifactStore, catalog, target, slot);
                if (!("error" in checked)) checkedRow = checked.row;
                return checked;
            };
            try {
                // Log FIRST: the event log is the single authority on
                // whether a canvas exists. Orphan bytes from a crashed
                // half-draw (or a user-uploaded canvas.html) read as
                // "not drawn" — the documented conservative answer.
                // Known window: a crash BETWEEN byte write and event
                // write on a redraw serves rev-N metadata over rev-N+1
                // bytes until the next successful draw. Self-healing;
                // accepted.
                if (args.manifestOnly) {
                    // The interface card without the bytes: embedded
                    // manifest summary from the stored document plus the
                    // ARMED contract from the latest draw event — the
                    // pair an inheriting agent needs to interpret
                    // canvas-action messages and author ticks.
                    const latest = await latestCanvasEventData(catalog, target, slot);
                    if (latest.rev === 0) return { exists: false };
                    const doc = visibility.mode === "hide"
                        ? await checkedDocument()
                        : { text: await artifactStore.downloadArtifactText(target, canvasArtifactFilename(slot)) };
                    if ("error" in doc) return { error: doc.error };
                    const docText = doc.text;
                    const extraction = extractCanvasAppManifest(docText);
                    const card = canvasAppCard(extraction.manifest);
                    // Events are writable via send_session_event with no
                    // validation — the armed contract re-passes the
                    // normalizer here so an injected megabyte "contract"
                    // cannot ride a cheap read into model context.
                    const armed = normalizeCanvasResponseContract(latest.responseContract);
                    return {
                        exists: true,
                        rev: latest.rev,
                        sizeBytes: Buffer.byteLength(docText, "utf8"),
                        ...(card ? { app: card } : {}),
                        ...(armed.contract ? { responseContract: armed.contract } : {}),
                        ...(extraction.error ? { manifestError: extraction.error } : {}),
                        ...(await liveState()),
                    };
                }
                const rev = await latestCanvasRev(catalog, target, slot);
                if (rev === 0) return { exists: false };
                const doc = visibility.mode === "hide"
                    ? await checkedDocument()
                    : { text: await artifactStore.downloadArtifactText(target, canvasArtifactFilename(slot)) };
                if ("error" in doc) return { error: doc.error };
                const text = doc.text;
                const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                const maxChars = Math.min(262_144, Math.max(1, Math.floor(Number(args.maxBytes) || 65_536)));
                const content = text.slice(offset, offset + maxChars);
                return {
                    exists: true,
                    rev,
                    sizeBytes: Buffer.byteLength(text, "utf8"),
                    // offset/paging are UTF-16 code units ("characters");
                    // sizeChars is the value offset reconciles against.
                    sizeChars: text.length,
                    offset,
                    content,
                    truncated: offset + content.length < text.length,
                    ...(await liveState()),
                };
            } catch (err: any) {
                return { error: err?.message || String(err) };
            }
        },
    };
}
