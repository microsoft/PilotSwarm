/**
 * Fake WorkspaceProvider for the session-workspace tests
 * (docs/proposals/session-workspaces.md, sections 4.2 and 9).
 *
 * It records every call in order and plays back scripted outcomes, scoped per
 * worker and/or per session. It never touches the filesystem: the PilotSwarm
 * path check is the code under test, so the fake only hands out paths.
 *
 * Outcomes for script(outcome, scope):
 *   { type: "ok", path?, adopt? }                     success; path defaults to root path + folder
 *   { type: "fail", code, message?, retryAfterMs? }   { ok: false, ... } (a thrown Error for listRoots/release)
 *   { type: "hang" }                                  never settles until releaseHangs() or reset()
 *   { type: "delay", ms }                             waits, then the default behavior
 *   { type: "throw", error? }                         rejects with an Error
 * Every outcome takes `times` (omitted = every call). When the count runs out,
 * the call falls back to the next matching script, then to the default.
 * Scope: { method = "ensureAttached", workerNodeId?, sessionId? }. The most
 * specific match wins (session + worker, then session, then worker, then all);
 * among equals, the newest script wins.
 *
 * Records: { seq, method, req, workerNodeId, sessionId, outcome, pending,
 * result? , error? }. `req` and `result` are deep copies. `error` is a plain
 * { name, message, code? } object, not the Error that was thrown.
 *
 * Filters (callsFor, pendingCalls, releaseHangs) are a function, or an object
 * whose keys are compared with the record first and with record.req second,
 * so { sessionId: "s1", turnIndex: 2 } works.
 *
 * onCall listeners run twice per call: phase "call" synchronously when the
 * call starts, and phase "settle" when it settles. A listener that throws
 * makes that call reject with the listener's error.
 */
import path from "node:path";

const METHODS = new Set(["listRoots", "ensureAttached", "release"]);
const OUTCOMES = new Set(["ok", "fail", "hang", "delay", "throw"]);

const copyRoots = list => list.map(({ name, path: rootPath }) => ({ name, path: rootPath }));
const clone = value => (value === undefined ? undefined : structuredClone(value));

function specificity(entry) {
    return (entry.sessionId != null ? 2 : 0) + (entry.workerNodeId != null ? 1 : 0);
}

function matches(record, filter) {
    if (!filter) return true;
    if (typeof filter === "function") return filter(record);
    return Object.entries(filter).every(([key, value]) =>
        (key in record ? record[key] : record.req?.[key]) === value);
}

function describeError(err) {
    return { name: err?.name ?? "Error", message: err?.message ?? String(err), ...(err?.code ? { code: err.code } : {}) };
}

function checkOutcome(outcome) {
    if (!outcome || !OUTCOMES.has(outcome.type)) throw new TypeError(`fake provider: unknown outcome type ${outcome?.type}`);
    if (outcome.times !== undefined && !(Number.isInteger(outcome.times) && outcome.times > 0)) {
        throw new TypeError("fake provider: times must be a positive integer");
    }
    if (outcome.type === "fail" && !outcome.code) throw new TypeError("fake provider: fail needs a code");
    if (outcome.type === "delay" && !(outcome.ms >= 0)) throw new TypeError("fake provider: delay needs ms >= 0");
}

export function createFakeWorkspaceProvider(opts = {}) {
    let roots = copyRoots(opts.roots ?? []);
    // Snapshot, so reset() restores what the test passed, not a later mutation.
    const initialAdopt = clone(opts.adopt);
    let globalAdopt = clone(initialAdopt);
    const rootAdopt = new Map();
    let scripts = [];
    let scriptOrder = 0;
    let seq = 0;
    const calls = [];
    // Call starts and settles in the order they happened, for holderState().
    const events = [];
    const listeners = new Set();
    // Calls held by a hang or a delay; reset() must settle all of them so no
    // test leaves a timer or an unsettled await behind.
    const parked = new Set();

    function emit(record, phase) {
        for (const fn of [...listeners]) fn(record, phase);
    }

    function adoptFor(rootName) {
        const adopt = rootAdopt.has(rootName) ? rootAdopt.get(rootName) : globalAdopt;
        return adopt == null ? undefined : clone(adopt);
    }

    function successFor(req, pathOverride, adoptOverride) {
        const rootName = req?.workspace?.root;
        const root = roots.find(r => r.name === rootName);
        const adopt = adoptOverride !== undefined ? clone(adoptOverride) : adoptFor(rootName);
        let attachPath = pathOverride;
        if (attachPath === undefined) {
            if (!root) throw new Error(`fake provider: scripted ok needs a path for unknown root "${rootName}"`);
            attachPath = path.join(root.path, req.workspace.folder ?? "");
        }
        // Omitted adopt means adopt nothing (section 4.2), so leave the key out.
        return adopt === undefined ? { ok: true, path: attachPath } : { ok: true, path: attachPath, adopt };
    }

    function defaultBehavior(method, req) {
        if (method === "listRoots") return copyRoots(roots);
        if (method === "release") return undefined;
        const rootName = req?.workspace?.root;
        if (!roots.some(r => r.name === rootName)) {
            return { ok: false, code: "WORKSPACE_ROOT_UNKNOWN", message: `workspace root "${rootName}" is not known to this provider` };
        }
        return successFor(req);
    }

    // Outcomes that settle at once. hang and delay decide only *when* to settle.
    function settleValue(method, req, outcome) {
        switch (outcome?.type) {
            case undefined:
            case "hang":
            case "delay":
                return defaultBehavior(method, req);
            case "ok":
                return method === "ensureAttached" ? successFor(req, outcome.path, outcome.adopt) : defaultBehavior(method, req);
            case "fail": {
                const message = outcome.message ?? `${outcome.code} (scripted)`;
                if (method !== "ensureAttached") throw Object.assign(new Error(message), { code: outcome.code });
                return outcome.retryAfterMs === undefined
                    ? { ok: false, code: outcome.code, message }
                    : { ok: false, code: outcome.code, message, retryAfterMs: outcome.retryAfterMs };
            }
            case "throw": {
                const { error } = outcome;
                if (error instanceof Error) throw error;
                throw new Error(error ?? "fake provider: scripted throw");
            }
            default:
                throw new TypeError(`fake provider: cannot settle with ${outcome.type}`);
        }
    }

    function take(record) {
        let best = null;
        for (const entry of scripts) {
            if (entry.method !== record.method) continue;
            if (entry.workerNodeId != null && entry.workerNodeId !== record.workerNodeId) continue;
            if (entry.sessionId != null && entry.sessionId !== record.sessionId) continue;
            if (!best || specificity(entry) > specificity(best)
                || (specificity(entry) === specificity(best) && entry.order > best.order)) best = entry;
        }
        if (!best) return undefined;
        if (best.remaining !== Infinity && --best.remaining === 0) scripts = scripts.filter(e => e !== best);
        return best.outcome;
    }

    function invoke(method, req) {
        // The fake acts on the request as it was at call time, like a remote service would.
        const input = clone(req);
        const record = {
            seq: ++seq,
            method,
            req: clone(req),
            workerNodeId: req?.workerNodeId ?? null,
            sessionId: req?.sessionId ?? null,
            outcome: "default",
            pending: true,
        };
        calls.push(record);
        events.push({ kind: "call", record });
        // Synchronous so a test can prove the provider ran before a later step.
        try {
            emit(record, "call");
        } catch (err) {
            record.pending = false;
            record.error = describeError(err);
            return Promise.reject(err);
        }
        const outcome = take(record);
        if (outcome) record.outcome = outcome.type;

        return new Promise((resolve, reject) => {
            const finish = settleWith => {
                record.pending = false;
                events.push({ kind: "settle", record });
                let value;
                let error;
                try {
                    value = settleValue(method, input, settleWith);
                    record.result = clone(value);
                } catch (err) {
                    error = err;
                    record.error = describeError(err);
                }
                try {
                    emit(record, "settle");
                } catch (listenerError) {
                    reject(listenerError);
                    return;
                }
                if (error !== undefined) reject(error);
                else resolve(value);
            };
            if (outcome?.type === "hang" || outcome?.type === "delay") {
                const slot = { record, kind: outcome.type, timer: null, finish };
                if (outcome.type === "delay") {
                    slot.timer = setTimeout(() => { parked.delete(slot); finish(undefined); }, outcome.ms);
                }
                parked.add(slot);
                return;
            }
            // A real provider never settles in the same tick; neither does the fake.
            queueMicrotask(() => finish(outcome));
        });
    }

    function releaseParked(slot, settleWith) {
        clearTimeout(slot.timer);
        parked.delete(slot);
        slot.finish(settleWith);
    }

    function holderState() {
        const state = new Map();
        const dead = new Set();
        // Walk starts and settles in the order they happened, as the lease
        // service would see them. An attach checks the holder when it starts
        // and takes the hold when it succeeds, so overlapping attaches resolve
        // to the one that finished last.
        for (const { kind, record } of events) {
            if (!record.sessionId) continue;
            const holder = state.get(record.sessionId);
            if (record.method === "ensureAttached") {
                if (kind === "call" && holder && !holder.released && holder.workerNodeId !== record.workerNodeId) dead.add(record.sessionId);
                if (kind === "settle" && record.result?.ok) {
                    state.set(record.sessionId, { workerNodeId: record.workerNodeId, turnIndex: record.req?.turnIndex, released: false });
                }
            } else if (record.method === "release" && kind === "settle") {
                // release deletes only the caller's own entry (section 5.3).
                if (holder && !record.error && holder.workerNodeId === record.workerNodeId) holder.released = true;
            }
        }
        return { state, dead };
    }

    return {
        // --- WorkspaceProvider ---
        listRoots: () => invoke("listRoots", undefined),
        ensureAttached: req => invoke("ensureAttached", req),
        release: req => invoke("release", req),

        // --- test-only helpers ---
        calls,

        setRoots(list) {
            roots = copyRoots(list);
        },

        /** adopt = null or undefined: adopt nothing. Pass { root } to scope it to one root. */
        setAdopt(adopt, { root } = {}) {
            if (root === undefined) globalAdopt = clone(adopt);
            else if (adopt === undefined) rootAdopt.delete(root);
            else rootAdopt.set(root, clone(adopt));
        },

        script(outcome, { method = "ensureAttached", workerNodeId, sessionId } = {}) {
            if (!METHODS.has(method)) throw new TypeError(`fake provider: unknown method ${method}`);
            checkOutcome(outcome);
            scripts.push({
                method,
                workerNodeId: workerNodeId ?? null,
                sessionId: sessionId ?? null,
                outcome: { ...outcome },
                remaining: outcome.times ?? Infinity,
                order: ++scriptOrder,
            });
        },

        /** With a scope, drops only scripts with exactly that scope. */
        clearScripts(scope) {
            if (!scope) { scripts = []; return; }
            const method = scope.method ?? "ensureAttached";
            scripts = scripts.filter(e => !(e.method === method
                && e.workerNodeId === (scope.workerNodeId ?? null) && e.sessionId === (scope.sessionId ?? null)));
        },

        /** Lets hung calls go on. settleWith: an ok, fail or throw outcome; omitted = default behavior. */
        releaseHangs(filter, settleWith) {
            if (settleWith && !["ok", "fail", "throw"].includes(settleWith.type)) {
                throw new TypeError("fake provider: releaseHangs settles with ok, fail or throw only");
            }
            let count = 0;
            for (const slot of [...parked]) {
                if (slot.kind !== "hang" || !matches(slot.record, filter)) continue;
                releaseParked(slot, settleWith);
                count++;
            }
            return count;
        },

        pendingCalls(filter) {
            return calls.filter(r => r.pending && matches(r, filter));
        },

        /** fn(record, phase): phase "call" when a call starts, "settle" when it settles. */
        onCall(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        callsFor(method, filter) {
            return calls.filter(r => r.method === method && matches(r, filter));
        },

        lastAttach(sessionId) {
            return calls.findLast(r => r.method === "ensureAttached" && r.sessionId === sessionId);
        },

        holders() {
            return holderState().state;
        },

        deadHolderSeen(sessionId) {
            return holderState().dead.has(sessionId);
        },

        /**
         * Clears scripts and adopt overrides, and settles every hung or delayed
         * call with the default behavior. Keeps roots, calls and listeners
         * unless { roots } or { clearCalls: true } is passed. seq keeps rising.
         */
        reset({ roots: nextRoots, clearCalls = false } = {}) {
            scripts = [];
            for (const slot of [...parked]) releaseParked(slot, undefined);
            rootAdopt.clear();
            globalAdopt = clone(initialAdopt);
            if (nextRoots) roots = copyRoots(nextRoots);
            if (clearCalls) {
                calls.length = 0;
                events.length = 0;
            }
        },
    };
}
