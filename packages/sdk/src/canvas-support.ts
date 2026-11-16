/**
 * Canvas helpers shared by the session bridge (session-proxy.ts) and the app
 * catalog (canvas-app-catalog.ts). Kept in their own module so the catalog
 * can be exercised without importing the whole bridge, and so the bridge and
 * the catalog can never disagree about slot names or revision derivation.
 *
 * The session canvas: one reserved artifact per session slot, drawn by the
 * agent with draw_canvas and rendered live in the portal. The revision is
 * derived from the durable session.canvas_updated event log, not a counter
 * column — see docs/proposals/session-canvas.md.
 */

import { CANVAS_EVENT_WINDOW, normalizeCanvasSlot as slotOrNull } from "../api/src/canvas-slots.js";

/** The slot limit, slot names and slot normalization live in pilotswarm-sdk/api (canvas-slots.js). */
export { CANVAS_SLOT_MAX, CANVAS_SLOT_RANGE, CANVAS_SLOT_ERROR, normalizeCanvasSlot, canvasArtifactFilename } from "../api/src/canvas-slots.js";

export const CANVAS_ARTIFACT_FILENAME = "canvas.html";

/** A Workflow script's canvas call names its target: the canvas resolver and the script tool policy both refuse an omitted one with this. */
export const WORKFLOW_SCRIPT_MUST_NAME_CANVAS = 'A Workflow script must name a canvas: pass session_id "parent" (the agent that started this Workflow) or the session id of an agent above it.';

/** Event rows predate slots: a missing slot (undefined, null, "") means slot 1. A slot outside 1-10 names no slot (null), never slot 1. */
export function eventSlot(row: any): number | null {
    return slotOrNull(row?.data?.slot);
}

/**
 * Latest canvas draw's full data (rev + armed contract) from the durable
 * event log — the single authority. Reads a bounded window rather than
 * exactly one row and takes the max of the VALID revs it finds, so one
 * garbage event (rev missing, NaN, negative — injectable via
 * send_session_event, which validates nothing) cannot reset the sequence.
 *
 * No empty-coerce on failure: a transient read error that reads as "no
 * canvas" would mint rev 1 over a live rev-12 canvas. Callers route the
 * throw to a structured { error }.
 *
 * Window CANVAS_EVENT_WINDOW (60): ten interleaved slots can push one slot's
 * latest draw well past a ten-event window. The session_canvases table is the
 * fast path; this scan is the durable fallback.
 */
export async function latestCanvasEventData(catalog: any, sessionId: string, slot = 1): Promise<{ rev: number; responseContract?: Record<string, any>; data?: Record<string, any> }> {
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, CANVAS_EVENT_WINDOW, ["session.canvas_updated"],
    );
    let latest: { rev: number; responseContract?: Record<string, any>; data?: Record<string, any> } = { rev: 0 };
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row?.data as any)?.rev);
        if (Number.isFinite(rev) && Number.isInteger(rev) && rev > latest.rev) {
            latest = { rev, responseContract: (row?.data as any)?.responseContract, data: row?.data ?? {} };
        }
    }
    return latest;
}

/** The current canvas revision: table first (migration 0045), event scan as the durable fallback. */
export async function latestCanvasRev(catalog: any, sessionId: string, slot = 1): Promise<number> {
    try {
        const rows = await catalog.getSessionCanvases?.(sessionId);
        const hit = (rows || []).find((r: any) => Number(r.slot) === slot);
        if (hit && Number(hit.latestRev) > 0) return Number(hit.latestRev);
    } catch { /* fall through to the event scan */ }
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, CANVAS_EVENT_WINDOW, ["session.canvas_updated"],
    );
    let latest = 0;
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row?.data as any)?.rev);
        if (Number.isFinite(rev) && rev > latest && Number.isInteger(rev)) latest = rev;
    }
    return latest;
}
