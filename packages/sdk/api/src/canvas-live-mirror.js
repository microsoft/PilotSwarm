/**
 * The client-side canvas mirror: turns canvas-plane pushes (patch pings and
 * pointers) into complete `session.canvas_data`-shaped events, so every
 * consumer downstream keeps its whole-state contract while patches ride the
 * wire.
 *
 * Rules (docs/proposals/canvas-data-plane.md):
 * - A patch applies ONLY on contiguous seq (seq === mirror.seq + 1); anything
 *   else — a gap, a pointer-only ping, an unknown slot — triggers one
 *   coalesced snapshot resync with bounded retries. The row is
 *   the latest truth, so one fetch answers any number of missed pings.
 * - Merge semantics are RFC 7386, the same law the database applies
 *   (jsonb_merge_patch): objects deep-merge, null deletes, arrays and
 *   scalars replace. Two implementations of one small spec; the seq chain
 *   plus snapshot resync self-heal any drift.
 * - `kind: doc` pings reset the slot's mirror (a redraw resets the payload
 *   server-side too) and are NOT emitted as data — document changes reach
 *   consumers through the durable canvas_updated path they already ride.
 */

export function jsonMergePatch(target, patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return patch;
    }
    const base = target && typeof target === "object" && !Array.isArray(target) ? target : {};
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete out[key];
        } else if (typeof value === "object" && !Array.isArray(value)) {
            out[key] = jsonMergePatch(base[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * @param {object} opts
 * @param {(sessionId: string) => Promise<Array<{slot:number, seq:number, payload:object, updatedBy?:string}>>} opts.fetchSnapshot
 * @param {(sessionId: string, update: {slot:number, seq:number, payload:object, patch?:object}) => void} opts.emit
 */
export function createCanvasLiveMirror({
    fetchSnapshot, emit, reset = () => {},
    retryDelays = [100, 400],
    delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    onError = (_sessionId, error) => console.warn("Canvas live state unavailable; using durable ticks:", error?.code || error?.name || "Error"),
}) {
    // seq includes document pings; appliedSeq advances only after data emits.
    const bySession = new Map();
    // sessionId -> in-flight snapshot fetch (coalesces gap storms)
    const inflight = new Map();
    const targets = new Map();

    const slots = (sessionId) => {
        let m = bySession.get(sessionId);
        if (!m) {
            m = new Map();
            bySession.set(sessionId, m);
        }
        return m;
    };

    const resync = (sessionId) => {
        if (inflight.has(sessionId)) return inflight.get(sessionId);
        const m = slots(sessionId);
        const wanted = targets.get(sessionId) || new Map();
        targets.set(sessionId, wanted);
        const current = () => bySession.get(sessionId) === m;
        const run = Promise.resolve().then(async () => {
            for (let attempt = 0; ; attempt++) {
                let failure;
                let rows;
                let fetched = false;
                try {
                    rows = await fetchSnapshot(sessionId);
                    fetched = true;
                } catch (error) {
                    failure = error;
                }
                if (!current()) return false;
                if (fetched) {
                    for (const row of rows || []) {
                        const slot = Number(row.slot);
                        const seq = Number(row.seq) || 0;
                        if (!Number.isInteger(slot) || slot < 1 || slot > 5 || seq <= 0) continue;
                        const prev = m.get(slot);
                        // A snapshot can race a ping that already advanced us.
                        if (prev && prev.seq >= seq) continue;
                        const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
                        emit(sessionId, { slot, seq, payload });
                        m.set(slot, { seq, payload, appliedSeq: seq });
                    }
                    for (const [slot, seq] of wanted) {
                        if ((m.get(slot)?.seq || 0) >= seq) wanted.delete(slot);
                    }
                    if (!wanted.size) return true;
                    failure = new Error("Canvas live snapshot is behind the latest update");
                }
                if (!current()) return false;
                if (attempt >= retryDelays.length) {
                    onError(sessionId, failure);
                    return false;
                }
                await delay(retryDelays[attempt]);
                if (!current()) return false;
            }
        }).finally(() => {
            if (inflight.get(sessionId) === run) inflight.delete(sessionId);
        });
        inflight.set(sessionId, run);
        return run;
    };

    return {
        /** A plane ping for this session: {slot, seq, kind, patch?}. */
        onPing(sessionId, ping) {
            if (ping?.kind === "unavailable") {
                // The plane went away (server error/rollback). Release the
                // takeover so durable events resume feeding this session.
                this.forget(sessionId);
                return;
            }
            const slot = Number(ping?.slot);
            const seq = Number(ping?.seq);
            if (!Number.isInteger(slot) || slot < 1 || slot > 5 || !Number.isFinite(seq) || seq <= 0) return;
            const m = slots(sessionId);
            const prev = m.get(slot);
            if (ping.kind === "doc") {
                // Redraw: server reset the payload; mirror follows. No data
                // emit — canvas_updated carries document changes.
                if (prev && prev.seq >= seq) return;
                m.set(slot, { seq, payload: {}, appliedSeq: 0 });
                targets.get(sessionId)?.delete(slot);
                reset(sessionId, { slot, seq });
                return;
            }
            if (prev && seq === prev.seq) return; // duplicate delivery
            if (prev && seq < prev.seq) {
                // The plane's seq went BACKWARDS: the UNLOGGED row was
                // truncated (PG failover) and rebuilt from 1. The row is the
                // truth — drop our high-water mark and resync to whatever it
                // says, or every ping until seq climbs past the old mark
                // would read as "stale" and the canvas would freeze.
                m.delete(slot);
                reset(sessionId, { slot, seq: 0 });
                if (!targets.has(sessionId)) targets.set(sessionId, new Map());
                targets.get(sessionId).set(slot, Math.max(targets.get(sessionId).get(slot) || 0, seq));
                void resync(sessionId);
                return;
            }
            if (ping.patch && prev && seq === prev.seq + 1) {
                const payload = jsonMergePatch(prev.payload, ping.patch);
                emit(sessionId, { slot, seq, payload, patch: ping.patch });
                m.set(slot, { seq, payload, appliedSeq: seq });
                return;
            }
            if (!targets.has(sessionId)) targets.set(sessionId, new Map());
            targets.get(sessionId).set(slot, seq);
            void resync(sessionId);
        },
        /** Prime the mirror on subscribe — the LVC burst. */
        prime(sessionId) {
            return resync(sessionId);
        },
        /** Suppress only a durable tick whose shared sequence was applied. */
        covers(sessionId, slot, seq) {
            return Number.isFinite(Number(seq)) && Number(seq) > 0
                && (bySession.get(sessionId)?.get(Number(slot))?.appliedSeq || 0) >= Number(seq);
        },
        forget(sessionId) {
            bySession.delete(sessionId);
            targets.delete(sessionId);
            inflight.delete(sessionId);
        },
    };
}
