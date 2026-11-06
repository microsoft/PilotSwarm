// Only navigation references are persisted: never drafts, transcripts or file contents.
export const VIEW_HISTORY_LIMIT = 10;
const text = value => typeof value === "string" && value.length <= 1024 ? value : null;
const SIDE_TABS = ["canvas", "workspace", "workflow"];
const WORKFLOW_TAB_VIEWS = ["definition", "workflows"];
/**
 * Review UI-D3: the Workflow tab's context of a view (the session that owns its Workflows, the Workflow it shows, its
 * definition and Definition | Workflows view), kept apart from the highlighted row. References only; null without an owner.
 */
function cleanWorkflowTab(value) {
    const ownerId = value && typeof value === "object" ? text(value.ownerId) : null;
    if (!ownerId) return null;
    return { ownerId, workflowId: text(value.workflowId), definition: text(value.definition),
        view: WORKFLOW_TAB_VIEWS.includes(value.view) ? value.view : null };
}
/** The ui/workflowTab patch that shows a view's Workflow tab context again. */
export function workflowTabPatch(tab) {
    return { workflowId: tab.workflowId, definition: tab.definition, view: tab.view };
}
/**
 * Review UI-D3: after a reload, the Workflow tab context the tab's saved current view had, when that view is of the
 * session now active and its owner's tab has nothing chosen in this page yet: { ownerId, patch }; else null. Pure.
 */
export function workflowTabOnReload(entry, state) {
    const tab = entry && entry.mode === "workspace" ? cleanWorkflowTab(entry.workflowTab) : null;
    if (!tab || !entry.sessionId || entry.sessionId !== state?.sessions?.activeSessionId) return null;
    if (state.ui?.workflowTabs?.[tab.ownerId]) return null;
    return { ownerId: tab.ownerId, patch: workflowTabPatch(tab) };
}
export function cleanView(value) {
    if (!value || !["workspace", "moa", "admin", "budget"].includes(value.mode)) return null;
    return {
        mode: value.mode, sessionId: text(value.sessionId),
        dashboardId: text(value.dashboardId), panelId: text(value.panelId),
        moaZen: value.moaZen === true,
        canvasOpen: value.canvasOpen === true, canvasMaximized: value.canvasMaximized === true,
        canvasZen: value.canvasZen === true,
        canvasSlot: Number.isInteger(value.canvasSlot) && value.canvasSlot >= 1 && value.canvasSlot <= 5 ? value.canvasSlot : 1,
        diagnosticsOpen: value.diagnosticsOpen === true,
        artifactSessionId: text(value.artifactSessionId), artifactFilename: text(value.artifactFilename),
        // Workflow Simplified (review UI-8): the Workflow row selected under its chat, and the right block's tab.
        workflowRowId: text(value.workflowRowId),
        sidePaneTab: SIDE_TABS.includes(value.sidePaneTab) ? value.sidePaneTab : "canvas",
        // Review UI-D3: the Workflow tab's context, restored with the view (choosing in the tab is not a visit).
        workflowTab: cleanWorkflowTab(value.workflowTab),
    };
}
export function viewKey(view) {
    if (view.mode === "moa") return JSON.stringify([view.mode, view.dashboardId, view.moaZen]);
    if (view.mode !== "workspace") return view.mode;
    return JSON.stringify([view.mode, view.sessionId, view.canvasOpen,
        view.canvasOpen ? view.canvasSlot : null, view.canvasMaximized, view.canvasZen,
        view.diagnosticsOpen, view.artifactSessionId, view.artifactFilename,
        view.workflowRowId ?? null, view.canvasOpen ? view.sidePaneTab ?? "canvas" : null]);
}
export function createViewHistory(saved) {
    let entries = [], index = -1;
    try {
        const parsed = JSON.parse(saved);
        if (parsed?.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length <= VIEW_HISTORY_LIMIT
            && Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < parsed.entries.length) {
            const cleaned = parsed.entries.map(cleanView);
            if (cleaned.every(Boolean)) { entries = cleaned; index = parsed.index; }
        }
    } catch { /* Bad or unavailable storage starts with an empty history. */ }
    return {
        get entries() { return entries; }, get index() { return index; },
        get current() { return entries[index]; },
        destination(delta) { return entries[index + delta] || null; },
        replace(view) { if (index >= 0) entries[index] = cleanView(view); },
        visit(view) {
            const next = cleanView(view); if (!next) return false;
            if (entries[index] && viewKey(entries[index]) === viewKey(next)) { entries[index] = next; return false; }
            entries = [...entries.slice(0, index + 1), next].slice(-VIEW_HISTORY_LIMIT);
            index = entries.length - 1; return true;
        },
        move(delta) { if (![-1, 1].includes(delta) || !entries[index + delta]) return null; index += delta; return entries[index]; },
        serialize() { return JSON.stringify({ version: 1, entries, index }); },
    };
}

export function navigationShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing
        || event.getModifierState?.("AltGraph")) return 0;
    const target = event.target;
    // The composer keeps a draft per session, so navigation is safe while it
    // is focused. Other editors (search, settings, etc.) retain native input.
    if (!target?.matches?.('textarea.ps-prompt-input')
        && (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'))) return 0;
    // Option changes event.key on macOS; code keeps the physical +/- keys
    // usable. Accept the unshifted = key as well as Shift+= and the numpad.
    if (["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-") return -1;
    if (["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" || event.key === "=") return 1;
    return 0;
}
