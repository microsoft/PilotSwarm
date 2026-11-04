/**
 * Batch 6 (f-03): where a person moved the step boxes of a workflow's graph, kept in that person's portal profile
 * settings (`workflowLayouts`). Per workflow (its stable id, as the portal keys it): when it was last changed and the
 * steps' places, `{ at, steps: { stepId: [x, y] } }`. A step the graph no longer has is ignored where it is drawn and
 * dropped by the next save; a new step takes its automatic place.
 *
 * Bounded, because the profile is one document written whole: at most 50 workflows (the least recently changed are
 * dropped first), 200 steps each and 2,000 places in all; a workflow key is at most 256 characters, a step id at most
 * 128, and a place is whole pixels within ±100,000. Pure.
 */
export const WORKFLOW_LAYOUTS_MAX_WORKFLOWS = 50;
export const WORKFLOW_LAYOUT_MAX_STEPS = 200;
export const WORKFLOW_LAYOUTS_MAX_PLACES = 2_000;
const KEY_MAX = 256;
const STEP_ID_MAX = 128;
const COORDINATE_MAX = 100_000;

const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const usableKey = (key, max) => typeof key === "string" && key.length > 0 && key.length <= max && key !== "__proto__";

/** A place `[x, y]` as whole pixels, or null. */
function placeOf(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > COORDINATE_MAX || Math.abs(y) > COORDINATE_MAX) return null;
    return [Math.round(x), Math.round(y)];
}

/** One workflow's step places, bounded and cleaned, or null when none is usable. */
export function normalizeWorkflowLayoutSteps(steps) {
    if (!isRecord(steps)) return null;
    const out = {};
    let count = 0;
    for (const [id, value] of Object.entries(steps)) {
        if (count >= WORKFLOW_LAYOUT_MAX_STEPS) break;
        if (!usableKey(id, STEP_ID_MAX)) continue;
        const place = placeOf(value);
        if (!place) continue;
        out[id] = place;
        count += 1;
    }
    return count > 0 ? out : null;
}

/** Every workflow's places as stored, bounded: the most recently changed first, within the caps above. */
export function normalizeWorkflowLayouts(value) {
    if (!isRecord(value)) return {};
    const entries = [];
    for (const [key, entry] of Object.entries(value)) {
        if (!usableKey(key, KEY_MAX) || !isRecord(entry)) continue;
        const steps = normalizeWorkflowLayoutSteps(entry.steps);
        if (!steps) continue;
        const at = Number(entry.at);
        entries.push([key, { at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0, steps }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const kept = {};
    let workflows = 0;
    let places = 0;
    for (const [key, entry] of entries) {
        if (workflows >= WORKFLOW_LAYOUTS_MAX_WORKFLOWS) break;
        const count = Object.keys(entry.steps).length;
        if (places + count > WORKFLOW_LAYOUTS_MAX_PLACES) continue;
        kept[key] = entry;
        workflows += 1;
        places += count;
    }
    return kept;
}

/**
 * The stored places with one workflow's changed (`steps`, at time `at`), or removed (`steps` null or empty: Reset
 * layout). Returns `layouts` itself when nothing changes.
 */
export function workflowLayoutsWith(layouts, key, steps, at) {
    if (!usableKey(key, KEY_MAX)) return layouts;
    const current = isRecord(layouts) ? layouts : {};
    const next = normalizeWorkflowLayoutSteps(steps);
    if (!next) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) return layouts;
        const rest = { ...current };
        delete rest[key];
        return rest;
    }
    return normalizeWorkflowLayouts({ ...current, [key]: { at, steps: next } });
}
