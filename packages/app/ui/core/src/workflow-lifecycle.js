/**
 * OF-S2-4 (owner, 2026-11-07T19:14Z): "the first time a wf definition is created, just pop open the wf panel. and from
 * then on if the user shuts it down, just put a yellow dot whenever there is a lifecycle event (e.g. wf def, or instance
 * started paused canceled etc)".
 *
 * - B and d, auto-open (OF-S2-4d, owner 19:45Z: "if I switch to a chat with a yellow dot on the workflow and it was the
 *   first time the dot had appeared then I want the panel to auto open. Follow the same behavior as canvas"; review of
 *   2ada4690, F1): the panel opens once per chat for the person, by one rule, whether they are in the chat when its first
 *   definition is made or arrive at it later (a switch or a page load): the profile (which holds the receipt) and a
 *   successful read of the chat's definitions list have both happened, the chat has a definition or a Workflow, and its
 *   panel was never on screen (canvas prefs `lastViewedWorkflowAt` 0 or absent, merged by MAX across devices). No
 *   freshness test: the server's times are never compared with this browser's clock (workflowArrivalAutoOpen).
 * - C, the dot: the newest lifecycle change of the chat's definitions and Workflows, as a time, against the time the
 *   Workflow panel last showed (canvas prefs `lastViewedWorkflowAt`, "canvas/viewed" with `workflowAt`, profile-merged by
 *   MAX). Lifecycle changes: a definition created, a revision saved (by anyone), a definition deleted; an agent test
 *   started or finished; a Workflow started, paused, resumed, canceling, canceled, completed, failed or waiting for input.
 *   Node visits, variable changes and ordinary updates are not: a Workflow's own changes count only when its state key
 *   changes, never for `updatedAt` alone.
 *
 * Times are the server's (a definition's revision `createdAt`, a test's `at`, `deletedAt`, a Workflow row's `createdAt`
 * and, once ended, its `updatedAt`), so a change made while this page was closed shows too. A state key change of a
 * Workflow still running (paused, resumed, canceling) has no time of its own: it is the time its row changed when this
 * page saw the key change (workflowLifecycleObserve), kept in ui.workflowLifecycle; a Workflow known only from the list has
 * no such time and lights nothing (F4: never this browser's clock, which would reach the receipt merged by MAX).
 */
import { isWorkflowChild, workflowChildModel, workflowChildrenOf, workflowStarted, workflowStateOf } from "./workflow-owner.js";
import { chatDefinitionsLoaded } from "./workflow-chat-definitions.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const msOf = value => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);

/** C: the slowest the portal reads the active chat's definitions while the Workflow panel is closed. */
export const WORKFLOW_LIFECYCLE_READ_MS = 30_000;

/** Review F5: where a key was read from, from the least to the most exact: the definitions list, the row, the read model. */
const SOURCE_RANK = Object.freeze({ list: 0, row: 1, model: 2 });

/**
 * A Workflow's lifecycle key and where it was read (`source`): its state (running, waiting, paused, canceling, canceled,
 * completed, failed), or null. While the panel is closed a Workflow's read model is not read again, but its row is (the
 * session list's poll): a row that says paused, or running again, wins over a model that still says the other, but only
 * when the row changed after the model was read (review F6: `readModelAt`, the row the model was read with; the person's
 * own pause or resume in the panel is the model's at once, not the next poll's).
 */
function lifecycleEntryOf(session, view) {
    if (!workflowStarted(session, view)) return null;
    const key = workflowStateOf(session, view)?.key ?? null;
    if (!key) return null;
    const model = workflowChildModel(view);
    const modelled = Array.isArray(model?.runs) && model.runs.some(run => isRecord(run) && run.mode === "live");
    const read = msOf(view?.readModelAt);
    const updated = msOf(session?.updatedAt);
    const rowNewer = !modelled || !Number.isFinite(read) || (Number.isFinite(updated) && updated > read);
    // The engine shows a paused Workflow's row as "waiting" (workflowStateOf's stateFromRow).
    if (rowNewer && session?.status === "waiting" && key === "running") return { key: "paused", source: "row" };
    if (rowNewer && session?.status === "running" && key === "paused") return { key: "running", source: "row" };
    return { key, source: modelled ? "model" : "row" };
}

/** The stored run statuses of the chat's definitions list, for Workflows whose rows are not loaded. */
const LISTED_KEYS = { admitted: "running", running: "running", paused: "paused", completed: "completed", failed: "failed", cancelled: "canceled",
    stopped: "canceled" };

/**
 * C: each of a chat's Workflows by its lifecycle key (`keys`, { [sessionId]: key }) and where that key was read (`sources`,
 * { [sessionId]: "list" | "row" | "model" }): from its row (and its read model when loaded), else from the chat's
 * definitions list. Node visits and variable changes never change a key.
 */
export function workflowLifecycleEntries(byId, ownerId, views = {}, definitionsEntry = null) {
    const keys = {};
    const sources = {};
    for (const session of workflowChildrenOf(byId, ownerId)) {
        const entry = lifecycleEntryOf(session, views?.[session.sessionId] ?? null);
        if (!entry) continue;
        keys[session.sessionId] = entry.key;
        sources[session.sessionId] = entry.source;
    }
    for (const item of Array.isArray(definitionsEntry?.items) ? definitionsEntry.items : []) {
        for (const row of Array.isArray(item?.workflows) ? item.workflows : []) {
            const id = typeof row?.workflowSessionId === "string" ? row.workflowSessionId : null;
            if (!id || keys[id] || !LISTED_KEYS[row.runStatus]) continue;
            keys[id] = LISTED_KEYS[row.runStatus];
            sources[id] = "list";
        }
    }
    return { keys, sources };
}

/** C: each of a chat's Workflows by its lifecycle key ({ [sessionId]: key }; workflowLifecycleEntries). */
export function workflowLifecycleKeys(byId, ownerId, views = {}, definitionsEntry = null) {
    return workflowLifecycleEntries(byId, ownerId, views, definitionsEntry).keys;
}

/**
 * C: the time of the lifecycle changes between two observations of the same chat's keys: a Workflow whose key changed is
 * dated by its row's `updatedAt` (the server's time of that change); one with no row (known only from the list) by
 * nothing (F4). A Workflow first seen is not a change here (its start is its own `createdAt`). Review F5: neither is a
 * key that changed only because a more exact source was read (`sources`: the list, then the row, then the read model;
 * a Workflow canceling at a page load reads running from its row first), nor a Workflow that stops waiting because its
 * answer arrived. 0 when nothing changed or there was no observation before.
 */
export function workflowLifecycleChangedAt(previousKeys, nextKeys, byId, previousSources = null, nextSources = null) {
    if (!isRecord(previousKeys) || !isRecord(nextKeys)) return 0;
    let at = 0;
    for (const [id, key] of Object.entries(nextKeys)) {
        const before = previousKeys[id];
        if (before === undefined || before === key) continue;
        if (before === "waiting" && key === "running") continue;
        if (isRecord(previousSources) && isRecord(nextSources)
            && (SOURCE_RANK[nextSources[id]] ?? 0) > (SOURCE_RANK[previousSources[id]] ?? 0)) continue;
        const updated = msOf(byId?.[id]?.updatedAt);
        if (Number.isFinite(updated)) at = Math.max(at, updated);
    }
    return at;
}

/** Two key maps the same. */
export function workflowLifecycleKeysEqual(a, b) {
    if (a === b) return true;
    if (!isRecord(a) || !isRecord(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(key => a[key] === b[key]);
}

/**
 * C: the newest lifecycle change of a chat (server time, ms; 0 for none): its definitions' saves, tests and deletions;
 * its Workflows' starts and ends; and what this page saw (`observed`, the chat's record from workflowLifecycleObserve, or
 * its `at` alone): the key changes, and when each Workflow waiting for input was first seen waiting (review F8: never its
 * row's `updatedAt`, which every node visit moves).
 */
export function workflowLifecycleAt(byId, ownerId, views = {}, definitionsEntry = null, observed = 0) {
    const record = isRecord(observed) ? observed : null;
    let at = Number(record ? record.at : observed) || 0;
    const waitingSince = isRecord(record?.waiting) ? record.waiting : {};
    const take = value => {
        const ms = msOf(value);
        if (Number.isFinite(ms) && ms > at) at = ms;
    };
    for (const session of workflowChildrenOf(byId, ownerId)) {
        const view = views?.[session.sessionId] ?? null;
        const key = lifecycleEntryOf(session, view)?.key ?? null;
        if (!key) continue;
        take(session.createdAt);
        // An ended Workflow's row no longer changes, so its last change is its end; a waiting one asks the person, since it
        // was first seen waiting.
        if (key === "completed" || key === "failed" || key === "canceled") take(session.updatedAt);
        if (key === "waiting") take(waitingSince[session.sessionId]);
    }
    for (const item of Array.isArray(definitionsEntry?.items) ? definitionsEntry.items : []) {
        if (!isRecord(item)) continue;
        take(item.deletedAt);
        for (const revision of Array.isArray(item.revisions) ? item.revisions : []) {
            if (!isRecord(revision)) continue;
            take(revision.createdAt);
            if (isRecord(revision.lastTest)) take(revision.lastTest.at);
        }
        for (const row of Array.isArray(item.workflows) ? item.workflows : []) {
            if (isRecord(row) && row.runStatus !== null && row.runStatus !== undefined) take(row.createdAt);
        }
    }
    return at;
}

/** C: the newest lifecycle change of the chat whose Workflow tab context is `ownerId`, from the store's state. */
export function workflowLifecycleAtOf(state, ownerId) {
    if (!ownerId) return 0;
    return workflowLifecycleAt(state?.sessions?.byId, ownerId, state?.ui?.workflowViews, state?.ui?.chatDefinitions?.[ownerId] ?? null,
        state?.ui?.workflowLifecycle?.[ownerId] ?? 0);
}

/** C: whether the Workflow button's dot shows for `ownerId`: a lifecycle change newer than the panel last showed. */
export function workflowLifecycleNeedsAttention(state, ownerId) {
    if (!ownerId) return false;
    return workflowLifecycleAtOf(state, ownerId) > (Number(state?.canvas?.prefs?.[ownerId]?.lastViewedWorkflowAt) || 0);
}

/**
 * B and d: whether the Workflow panel opens for the chat `ownerId` (the Workflow tab's, selectWorkflowTabContext) now:
 * never on unknown state (the profile read, which holds the receipt, and a successful read of the chat's definitions list
 * must both have happened; a read that failed decides nothing), never for a chat with no
 * definition and no Workflow, never once the chat's panel was on screen (its receipt) or after it opened by itself in
 * this page. No time is compared (review F1).
 */
export function workflowArrivalAutoOpen(state, ownerId) {
    const ui = state?.ui;
    if (!ownerId || ui?.sessionViewsLoaded !== true || ui?.workflowAutoOpened?.[ownerId]) return false;
    const byId = state?.sessions?.byId;
    const owner = byId?.[ownerId];
    if (!isRecord(owner) || owner.isGroup || isWorkflowChild(owner)) return false;
    if ((Number(state?.canvas?.prefs?.[ownerId]?.lastViewedWorkflowAt) || 0) > 0) return false;
    const entry = ui?.chatDefinitions?.[ownerId] ?? null;
    if (!chatDefinitionsLoaded(entry) || entry.error) return false;
    return entry.items.length > 0 || workflowChildrenOf(byId, ownerId).some(session => workflowStarted(session, state?.ui?.workflowViews?.[session.sessionId] ?? null));
}

/**
 * Review F3: what makes the portal read the chat's definitions again while its panel is closed: the chat's status and its
 * Workflows' statuses (an agent turn that ends, a Workflow that starts, pauses or ends), never their `updatedAt` (every
 * agent turn and node visit would read the list again).
 */
export function chatLifecycleStamp(byId, ownerId) {
    if (!ownerId) return "";
    const owner = byId?.[ownerId] ?? null;
    return [`${owner?.status ?? ""}`, ...workflowChildrenOf(byId, ownerId).map(session => `${session.sessionId}:${session.status ?? ""}`)].join(",");
}

/**
 * C: the store's record of the Workflow tab's chat's Workflow keys after an action (ui.workflowLifecycle[ownerId] = { keys,
 * sources, waiting, at }): the keys now and where they were read, when each Workflow waiting for input was first seen
 * waiting (its row's `updatedAt` then, a server time; review F8), and `at` raised to the time of any key change since the
 * last record. A chat recorded for the first time starts at 0 (a page load sees no change). Returns the next
 * ui.workflowLifecycle, or the same object when nothing changed.
 */
export function workflowLifecycleObserve(lifecycle, byId, ownerId, views, definitionsEntry) {
    if (!ownerId || !isRecord(byId?.[ownerId]) || isWorkflowChild(byId[ownerId])) return lifecycle;
    const { keys, sources } = workflowLifecycleEntries(byId, ownerId, views, definitionsEntry);
    const previous = isRecord(lifecycle?.[ownerId]) ? lifecycle[ownerId] : null;
    if (previous && workflowLifecycleKeysEqual(previous.keys, keys) && workflowLifecycleKeysEqual(previous.sources, sources)) return lifecycle;
    const changed = previous ? workflowLifecycleChangedAt(previous.keys, keys, byId, previous.sources, sources) : 0;
    const at = Math.max(Number(previous?.at) || 0, changed);
    const waiting = {};
    for (const [id, key] of Object.entries(keys)) {
        if (key !== "waiting") continue;
        const kept = Number(previous?.waiting?.[id]);
        const updated = msOf(byId?.[id]?.updatedAt);
        const since = Number.isFinite(kept) && kept > 0 ? kept : Number.isFinite(updated) ? updated : 0;
        if (since) waiting[id] = since;
    }
    return { ...(isRecord(lifecycle) ? lifecycle : {}), [ownerId]: { keys, sources, waiting, at } };
}
