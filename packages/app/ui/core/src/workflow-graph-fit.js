/**
 * UX round 1 (owner 2026-11-26, G1 and P1): how the Workflow graph's view is placed. Pure; the React Flow view uses it.
 *
 * - Fit to screen (the button) shows the whole graph, however small that makes it (down to WORKFLOW_FIT_MIN_ZOOM).
 * - An automatic fit (the first view of a graph, a display mode change) keeps the steps readable: when the whole graph
 *   fits only below WORKFLOW_LEGIBLE_ZOOM, it shows the main path (the happy path's column) whole if that fits at
 *   WORKFLOW_READABLE_ZOOM or more, else the top of the main path at that zoom; the rest is reached by panning
 *   (workflowFirstViewport).
 * - A selected step out of view (the Node panel opened under it, a phone's sheet over it, a visit chosen in the Log) is
 *   brought into view by the smallest pan, keeping the zoom (workflowRevealViewport).
 *
 * A view is { x, y, zoom } as React Flow keeps it: a graph point (gx, gy) is drawn at (gx * zoom + x, gy * zoom + y).
 */

/** The zoom a readable view uses: a step's 13 px name is drawn at about 10 px. */
export const WORKFLOW_READABLE_ZOOM = 0.75;
/**
 * An automatic fit keeps the whole graph at this zoom or more (a full screen view of a medium graph, as people used it in
 * UX round 1); below it, the steps cannot be read and it shows a readable view instead.
 */
export const WORKFLOW_LEGIBLE_ZOOM = 0.5;
/** The least zoom Fit to screen goes to, so the whole graph shows on a phone too. */
export const WORKFLOW_FIT_MIN_ZOOM = 0.02;
/** The room, in pixels, kept between a readable view's graph and the area's edges, and around a revealed step. */
export const WORKFLOW_VIEW_MARGIN_PX = 16;

const finite = value => typeof value === "number" && Number.isFinite(value);
const boxOf = value => (value && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height)
    && value.width >= 0 && value.height >= 0 ? value : null);
const viewOf = value => (value && finite(value.x) && finite(value.y) && finite(value.zoom) && value.zoom > 0 ? value : null);
const positive = (value, fallback) => (finite(value) && value > 0 ? value : fallback);
const atLeastZero = (value, fallback) => (finite(value) && value >= 0 ? value : fallback);

/**
 * The box around the graph's main path: every step and join bar of the happy path (the edges the layout marks `spine`,
 * R4), at the places they are drawn (`places`: Map id -> { x, y, width, height }, workflowGraphPlaces), with the room
 * its end chips take beside it (R2, `layout.chipRoom`; a join bar's are its parallel step's). Null when the graph has no
 * happy path, none of its boxes is placed, or its extent is not a finite number.
 */
export function workflowMainPathBounds(layout, places) {
    const ids = new Set();
    for (const edge of Array.isArray(layout?.edges) ? layout.edges : []) {
        if (edge?.spine !== true) continue;
        ids.add(edge.from);
        ids.add(edge.to);
    }
    const chips = layout?.chipRoom instanceof Map ? layout.chipRoom : new Map();
    const parallelOf = new Map([...(layout?.joins?.values?.() ?? [])].map(join => [join?.id, join?.parallel]));
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const id of ids) {
        const box = boxOf(places?.get?.(id));
        if (!box) continue;
        const room = atLeastZero(Number(chips.get(id) ?? chips.get(parallelOf.get(id))), 0);
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width + room);
        bottom = Math.max(bottom, box.y + box.height);
    }
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };
    return Object.values(bounds).every(finite) ? bounds : null;
}

/**
 * The first view of a graph (and an automatic refit): `whole`, the view that fits the whole graph (`bounds`) into `area`
 * ({ width, height }), when its zoom is at least `legible`; else the main path (`focus`, workflowMainPathBounds; the
 * whole graph when null) fitted whole when it fits at `readable` or more (up to `maxZoom`), centred; else the graph's top
 * (where the main path starts, with its Start mark) at `readable` (or `maxZoom`, when smaller), centred on the main path
 * across (a main path wider than the area, as on a phone, starts at its left margin instead). Across, the graph never
 * leaves room on a side it could fill: a graph narrower than the area is centred, a wider one keeps its edges at or past
 * the area's. A readable view keeps a run's current step (`current`, its box) in view by the smallest pan. Pure.
 */
export function workflowFirstViewport({ whole, bounds, focus = null, current = null, area, legible = WORKFLOW_LEGIBLE_ZOOM,
    readable = WORKFLOW_READABLE_ZOOM, maxZoom = 1, margin = WORKFLOW_VIEW_MARGIN_PX } = {}) {
    const view = readableViewport({ whole, bounds, focus, area, legible, readable, maxZoom, margin });
    // UXP-TL-02: a run's current step (`current`, its box) stays in a readable view, by the smallest pan.
    if (!view || view === viewOf(whole) || !boxOf(current)) return view;
    return workflowRevealViewport(view, current, area, atLeastZero(margin, WORKFLOW_VIEW_MARGIN_PX)) ?? view;
}

function readableViewport({ whole, bounds, focus, area, legible, readable, maxZoom, margin }) {
    const fitted = viewOf(whole);
    const graph = boxOf(bounds);
    if (!fitted || !graph || !area || !finite(area.width) || !finite(area.height) || area.width <= 0 || area.height <= 0) return fitted;
    legible = positive(legible, WORKFLOW_LEGIBLE_ZOOM);
    readable = positive(readable, WORKFLOW_READABLE_ZOOM);
    maxZoom = positive(maxZoom, 1);
    margin = atLeastZero(margin, WORKFLOW_VIEW_MARGIN_PX);
    if (fitted.zoom >= legible) return fitted;
    const main = boxOf(focus) ?? graph;
    // An extent past the largest number makes no view.
    if (![graph.x + graph.width, graph.y + graph.height, main.x + main.width, main.y + main.height].every(finite)) return fitted;
    const roomX = Math.max(1, area.width - 2 * margin);
    const roomY = Math.max(1, area.height - 2 * margin);
    const mainZoom = Math.min(maxZoom, roomX / Math.max(1, main.width), roomY / Math.max(1, main.height));
    const zoom = mainZoom >= readable ? mainZoom : Math.min(readable, maxZoom);
    const centreX = main.x + main.width / 2;
    // A main path wider than the room (a phone) starts at the left margin: its steps show whole, its end chips run off.
    let x = main.width * zoom > roomX ? margin - main.x * zoom : area.width / 2 - centreX * zoom;
    const y = mainZoom >= readable ? area.height / 2 - (main.y + main.height / 2) * zoom : margin - Math.min(main.y, graph.y) * zoom;
    if (graph.width * zoom <= roomX) x = area.width / 2 - (graph.x + graph.width / 2) * zoom;
    else x = Math.min(margin - graph.x * zoom, Math.max(area.width - margin - (graph.x + graph.width) * zoom, x));
    return [x, y, zoom].every(finite) ? { x, y, zoom } : fitted;
}

/**
 * Owner G1/P2 (UX round 1): the view that shows `box` (a step's place in the graph) inside the visible part of the graph's
 * area (`visible`: { width, height } from the area's top left; a phone's sheet over the graph makes it shorter), with
 * `margin` around it, by the smallest pan, keeping the zoom; null when the box is already in view. A box larger than the
 * room keeps its top left in view. Pure.
 */
export function workflowRevealViewport(view, box, visible, margin = WORKFLOW_VIEW_MARGIN_PX) {
    const shown = viewOf(view);
    const place = boxOf(box);
    if (!shown || !place || !visible || !finite(visible.width) || !finite(visible.height) || visible.width <= 0 || visible.height <= 0) return null;
    margin = atLeastZero(margin, WORKFLOW_VIEW_MARGIN_PX);
    const { zoom } = shown;
    const along = (start, size, room, offset) => {
        const from = start * zoom + offset;
        const to = from + size * zoom;
        if (from >= margin && to <= room - margin) return 0;
        if (from < margin || size * zoom > room - 2 * margin) return margin - from;
        return room - margin - to;
    };
    const dx = along(place.x, place.width, visible.width, shown.x);
    const dy = along(place.y, place.height, visible.height, shown.y);
    if (dx === 0 && dy === 0) return null;
    const next = { x: shown.x + dx, y: shown.y + dy, zoom };
    return finite(next.x) && finite(next.y) ? next : null;
}
