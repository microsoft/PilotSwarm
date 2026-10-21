/**
 * Admin Console settings tree: collapse, cursor and keyboard rules (issue 181
 * R24). Pure functions over the full row list the selector builds; both the
 * portal and the TUI render the result and send the same key intents.
 *
 * Rows carry `id`, `kind` (section | subsection | group | package |
 * canvasApp), `depth` and `parentId`. Only the Packages and Canvas Apps
 * sections and their groups collapse; the keyboard cursor moves over those
 * two sections only, because the other sections own their own keys.
 */

export const ADMIN_TREE_COLLAPSIBLE_SECTIONS = ["agents", "canvasApps"];

/** Which collapsible section a row belongs to (its root), or null. */
export function adminTreeRoot(rowsById, row) {
    let current = row;
    for (let guard = 0; current && guard < 8; guard++) {
        if (!current.parentId) return ADMIN_TREE_COLLAPSIBLE_SECTIONS.includes(current.id) ? current.id : null;
        current = rowsById.get(current.parentId);
    }
    return null;
}

export function isAdminTreeCollapsible(row) {
    return Boolean(row) && (row.kind === "group" || (row.kind === "section" && ADMIN_TREE_COLLAPSIBLE_SECTIONS.includes(row.id)));
}

/** The ids of every ancestor of `id`, nearest first. */
export function adminTreeAncestors(rows, id) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const out = [];
    let current = byId.get(id);
    for (let guard = 0; current?.parentId && guard < 8; guard++) {
        out.push(current.parentId);
        current = byId.get(current.parentId);
    }
    return out;
}

/**
 * Visible rows: a row is hidden when any ancestor is collapsed. Collapsible
 * rows gain `collapsible` and `collapsed`; every row gains `navigable` (the
 * keyboard cursor may stop on it) and `cursor`.
 */
export function buildVisibleAdminTree(rows, collapsedIds, cursorId) {
    const collapsed = new Set(Array.isArray(collapsedIds) ? collapsedIds : []);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const hidden = new Set();
    const out = [];
    for (const row of rows) {
        if (row.parentId && (hidden.has(row.parentId) || collapsed.has(row.parentId))) {
            hidden.add(row.id);
            continue;
        }
        const collapsible = isAdminTreeCollapsible(row);
        out.push({
            ...row,
            collapsible,
            collapsed: collapsible && collapsed.has(row.id),
            navigable: Boolean(adminTreeRoot(byId, row)),
            cursor: Boolean(cursorId) && row.id === cursorId,
        });
    }
    return out;
}

/** Ids the cursor may move over, in display order. */
export function adminTreeNavigableIds(visibleRows) {
    return visibleRows.filter((row) => row.navigable).map((row) => row.id);
}

/**
 * The row the keyboard acts on: the stored cursor when it is still visible
 * and navigable; else the selected row; else the active section's root row.
 */
export function effectiveAdminTreeCursor(visibleRows, storedCursor, section) {
    const navigable = visibleRows.filter((row) => row.navigable);
    if (storedCursor && navigable.some((row) => row.id === storedCursor)) return storedCursor;
    const selected = navigable.find((row) => row.selected && (row.kind === "package" || row.kind === "canvasApp"));
    if (selected) return selected.id;
    const root = section === "canvasApps" ? "canvasApps" : section === "packages" ? "agents" : null;
    if (root && navigable.some((row) => row.id === root)) return root;
    return navigable[0]?.id ?? null;
}

/** Collapsed ids with `ids` opened. */
export function expandAdminTreeIds(collapsedIds, ids) {
    const open = new Set(ids);
    return (Array.isArray(collapsedIds) ? collapsedIds : []).filter((id) => !open.has(id));
}

/** Collapsed ids with `id` toggled. */
export function toggleAdminTreeId(collapsedIds, id) {
    const list = Array.isArray(collapsedIds) ? collapsedIds : [];
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/**
 * The window of `rows` to draw in `height` lines so the cursor stays in view
 * (the TUI's scroll; the portal scrolls a container instead). Returns the
 * slice plus how many rows are hidden above and below.
 */
export function windowAdminTreeRows(rows, cursorId, height) {
    const size = Math.max(1, Math.floor(Number(height) || 0));
    if (rows.length <= size) return { rows, above: 0, below: 0 };
    const index = Math.max(0, rows.findIndex((row) => row.id === cursorId));
    let start = Math.max(0, index - Math.floor(size / 2));
    start = Math.min(start, rows.length - size);
    return { rows: rows.slice(start, start + size), above: start, below: rows.length - start - size };
}
