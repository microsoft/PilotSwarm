import React from "react";
import { createPortal } from "react-dom";
import { useControllerSelector } from "./use-controller-state.js";
import { selectWorkflowViewSnapshotFor, workflowNodeViews, workflowParentWorking, workflowReadModelView, workflowViewSnapshotEqual } from "../../core/src/workflow-view.js";
import { formatSeconds, projectWorkflowV2, workflowV2Activity, workflowV2BranchPickKey, workflowV2SelectionAfterBranchChange } from "../../core/src/workflow-v2-view.js";
import {
    WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT, workflowV2DefinitionControls, workflowV2DraftEditor, workflowV2JsonObjectDraft, workflowV2RunCommandNotice,
    workflowV2RunControls, workflowV2RunVariables, workflowV2SampleInputs, workflowV2TestControls, workflowV2TestModeListed, workflowV2TestResponder,
} from "../../core/src/workflow-v2-commands.js";
import { formatLocalTime } from "../../core/src/formatting.js";
import { workflowNodeSummary } from "../../core/src/workflow-node-summary.js";
import {
    WORKFLOW_AGENT_LOG_VISITS, workflowAgentLogChats, workflowAgentNodeLog, workflowBaseInstructionsMatch, workflowBaseInstructionsReadable,
} from "../../core/src/workflow-agent-log.js";
import {
    selectWorkflowTabContext, workflowChildModel, workflowDefinitionName, workflowDefinitionsOf, workflowFailureText, workflowStarted,
    workflowPanelHeight, workflowStateOf, workflowTabContextEqual, WORKFLOW_DEFINITION_PANELS, WORKFLOW_PANEL_HEIGHT_MIN, WORKFLOW_RUN_PANELS,
} from "../../core/src/workflow-owner.js";
import {
    WorkflowV2AgentLog, WorkflowV2Diagnostics, WorkflowV2DraftEditor, WorkflowV2NoGraph, WorkflowV2NodeSummary, WorkflowV2RevisionCompare,
    WorkflowV2RunCommandNotice,
    WorkflowV2RunPicker, WorkflowV2TestAnswer, WorkflowV2TestClock, WorkflowV2TestInterceptions, WorkflowV2TestPanel, WorkflowV2Variables,
    WorkflowV2YamlView,
} from "./workflow-v2-panels.js";
import { WorkflowGraph } from "./workflow-graph.js";
import { ModalDialog } from "./modal-dialog.js";

const h = React.createElement;
const EMPTY = Object.freeze({});
const EMPTY_EVENTS = Object.freeze([]);
const LIST_READ_LIMIT = 10;

/**
 * Workflow Simplified, stage 1 (spec draft 3, sections 06–08, 11, 12): the Workflow tab. It shares the right block with
 * the canvas (L1) and shows the definitions of the session whose chat is in the middle, or the Workflow of the agent
 * node chat that is: a header row (the definition picker and the Definition | Workflows switch, L4), then the
 * definition's graph or its Workflows, and a bottom panel (L5), closed by default. On a phone the bottom panel is a
 * sheet with a visible way back (12).
 *
 * On the tested engine each Workflow is still a workflow child session; this tab reads them through the same reads the
 * old workflow screen made (ensureWorkflowDefinition, ensureWorkflowReadModel, the session's events) and sends the same
 * commands (sendWorkflowRunCommand). Every command is the server's decision.
 */

/** One workflow child's view parts, fresh for `sessionId` (a store change for another child is never paired with it). */
function useWorkflowChild(controller, sessionId) {
    const selected = useControllerSelector(controller, state => selectWorkflowViewSnapshotFor(state, sessionId), workflowViewSnapshotEqual);
    const snapshot = selected.sessionId === (sessionId ?? null) ? selected : selectWorkflowViewSnapshotFor(controller.getState(), sessionId);
    const { session, history, canvas, view, places } = snapshot;
    const events = history?.events || EMPTY_EVENTS;
    const selectedRunId = view.selectedRunId ?? null;
    const sessionUpdatedAt = session?.updatedAt ?? null;
    // New events, another run selection or a changed session row ask for the read model again (as the workflow screen did).
    React.useEffect(() => {
        if (sessionId) controller.ensureWorkflowDefinition(sessionId);
    }, [controller, sessionId, events, selectedRunId, sessionUpdatedAt]);
    const { readModel, readModelAfterSeq, workflowModel, error } = workflowReadModelView(view);
    const olderHistory = view.olderHistory ?? null;
    const live = canvas?.dataPayload;
    const projection = React.useMemo(() => {
        if (view.definition?.shape !== "v2" && !readModel && !workflowModel) return null;
        const projected = projectWorkflowV2({ definition: view.definition, readModel, workflowModel, selectedRunId, events, readModelAfterSeq, olderHistory });
        return !projected.definition && view.definition && view.definition.shape !== "v2" ? null : projected;
    }, [view.definition, readModel, workflowModel, selectedRunId, readModelAfterSeq, events, olderHistory]);
    const legacyNodes = React.useMemo(() => projection ? [] : workflowNodeViews(view.definition, events, live), [projection, view.definition, events, live]);
    return { sessionId, session, view, places, events, projection, readModel, workflowModel, readError: error, legacyNodes,
        definition: projection ? projection.definition : view.definition, nodes: projection ? projection.nodes : legacyNodes };
}

/** The definition's graph with no run on it (07): the same read model, without overlaying any run. */
function useDefinitionProjection(child) {
    const { view, workflowModel } = child;
    return React.useMemo(() => {
        if (view.definition?.shape !== "v2" && !workflowModel) return null;
        return projectWorkflowV2({ definition: view.definition, readModel: null, workflowModel, selectedRunId: null, events: EMPTY_EVENTS });
    }, [view.definition, workflowModel]);
}

/** A time people read: the clock alone when it is today, else the date too (local time, as everywhere). */
function shownTime(value) {
    const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) return null;
    const today = new Date().toDateString() === new Date(ms).toDateString();
    return formatLocalTime(ms, { clock: today });
}

/** A duration as m:ss or h:mm:ss (W1 "took"). */
function tookText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const END_EVENTS = new Set(["workflow.completed", "workflow.failed", "workflow.cancelled", "workflow.stopped"]);

/** When a Workflow started and how long it took, from its own events (its live run's start and end). */
function workflowTimes(events, runId = null) {
    let started = null;
    let ended = null;
    for (const event of Array.isArray(events) ? events : []) {
        const data = event?.data && typeof event.data === "object" ? event.data : {};
        if (data.mode === "test" || (runId && data.runId && data.runId !== runId)) continue;
        const at = Date.parse(event?.createdAt ?? "");
        if (!Number.isFinite(at)) continue;
        if (event.eventType === "workflow.started" && started === null) started = at;
        if (END_EVENTS.has(event.eventType)) ended = at;
    }
    return { started, took: started === null ? null : (ended ?? Date.now()) - started };
}

/** The tone class of a state chip. */
function StateChip({ state, className = "" }) {
    if (!state) return null;
    return h("span", { className: `ps-wf-state is-${state.tone}${className ? ` ${className}` : ""}`, "data-state": state.key }, state.label);
}

/** The Workflow tab (06). */
export function WorkflowTab({ controller, mobile = false }) {
    const context = useControllerSelector(controller, selectWorkflowTabContext, workflowTabContextEqual);
    const byId = useControllerSelector(controller, state => state.sessions.byId);
    const views = useControllerSelector(controller, state => state.ui.workflowViews);
    const tabs = useControllerSelector(controller, state => state.ui.workflowTabs);
    const ownerId = context.ownerId;
    const shownId = context.workflowId;
    const shownSession = shownId ? byId?.[shownId] ?? null : null;
    const key = ownerId ?? shownId;
    const tab = (key && tabs?.[key]) || EMPTY;
    const setTab = React.useCallback(patch => {
        if (key) controller.dispatch({ type: "ui/workflowTab", ownerId: key, patch });
    }, [controller, key]);
    const definitions = React.useMemo(() => {
        const owned = ownerId ? workflowDefinitionsOf(byId, ownerId, views) : [];
        if (owned.length || !shownSession) return owned;
        // A Workflow whose session is not loaded: its own definition alone.
        const view = views?.[shownId] ?? null;
        const started = workflowStarted(shownSession, view);
        return [{ name: workflowDefinitionName(shownSession, view), children: [shownId], workflows: started ? [{ sessionId: shownId, number: 1 }] : [],
            newestId: shownId, startable: !started }];
    }, [byId, ownerId, views, shownId, shownSession]);
    const shownName = shownSession ? workflowDefinitionName(shownSession, views?.[shownId] ?? null) : null;
    const definition = definitions.find(item => item.name === (tab.definition ?? shownName)) ?? definitions.find(item => item.name === shownName)
        ?? definitions[0] ?? null;
    const view = tab.view === "definition" || tab.view === "workflows" ? tab.view : shownId ? "workflows" : "definition";
    const workflow = shownId && definition ? definition.workflows.find(item => item.sessionId === shownId) ?? null : null;
    // A failed Workflow counts on the badge until it is opened (O6).
    const shownState = workflow ? workflowStateOf(shownSession, views?.[shownId] ?? null) : null;
    React.useEffect(() => {
        if (workflow && view === "workflows" && shownState?.key === "failed") controller.dispatch({ type: "ui/workflowSeen", sessionId: workflow.sessionId });
    }, [controller, workflow?.sessionId, view, shownState?.key]);
    // Opening one Workflow, here or in the session list, selects its row (W2); going back to the list selects the session.
    const openWorkflow = React.useCallback(id => {
        setTab({ view: "workflows", workflowId: id, definition: definition?.name ?? null });
        const target = id ?? ownerId;
        if (target) controller.dispatch({ type: "sessions/selected", sessionId: target });
    }, [controller, setTab, ownerId, definition?.name]);
    const askChat = React.useCallback(text => {
        controller.setPrompt(text, text.length);
        if (typeof document !== "undefined") document.querySelector(".ps-prompt-input")?.focus?.();
    }, [controller]);
    if (!definition) {
        // D8: nothing to show yet.
        return h("section", { className: "ps-wf-tab is-empty", "aria-label": "Workflow" },
            h("div", { className: "ps-wf-empty" },
                h("p", { className: "ps-wf-empty-title" }, "No workflow definitions."),
                h("p", null, "Ask the chat to create one.")));
    }
    const count = definition.workflows.length;
    return h("section", { className: `ps-wf-tab${mobile ? " is-mobile" : ""}`, "aria-label": "Workflow", "data-view": view, "data-definition": definition.name },
        h("header", { className: "ps-wf-tab-head" },
            h(DefinitionPicker, { definitions, chosen: definition.name, views,
                onChoose: name => setTab({ definition: name, workflowId: null }), onNew: () => askChat("Create a new workflow definition: ") }),
            h("div", { className: "ps-wf-switch", role: "tablist", "aria-label": "Definition or Workflows" },
                h("button", { type: "button", role: "tab", "aria-selected": view === "definition", className: view === "definition" ? "is-on" : "",
                    onClick: () => setTab({ view: "definition" }) }, "Definition"),
                h("button", { type: "button", role: "tab", "aria-selected": view === "workflows", className: view === "workflows" ? "is-on" : "",
                    onClick: () => setTab({ view: "workflows" }) }, `Workflows · ${count}`))),
        view === "definition"
            ? h(DefinitionView, { key: definition.newestId, controller, definition, tab, setTab, mobile, ownerTitle: byId?.[ownerId]?.title ?? null,
                ownerWorking: ownerId ? workflowParentWorking(byId?.[ownerId]) : false, onStarted: id => openWorkflow(id), askChat })
            : workflow
                ? h(WorkflowRunView, { key: workflow.sessionId, controller, definition, workflow, tab, setTab, mobile, onOpen: openWorkflow,
                    nodeStateId: context.nodeStateId })
                : h(WorkflowList, { controller, definition, byId, views, onOpen: openWorkflow, onStart: () => setTab({ view: "definition", start: true }),
                    onAnother: () => setTab({ view: "definition", another: true }) }));
}

/** D1: the session's definitions, with the newest revision and how many Workflows each has; New definition asks the chat. */
function DefinitionPicker({ definitions, chosen, views, onChoose, onNew }) {
    const id = `wf-def-${React.useId().replace(/:/g, "")}`;
    const option = definition => {
        const model = workflowChildModel(views?.[definition.newestId] ?? null);
        const revision = Number.isSafeInteger(model?.definition?.currentRevision) ? `revision ${model.definition.currentRevision}` : null;
        const count = definition.workflows.length;
        return [definition.name, revision, `${count} ${count === 1 ? "Workflow" : "Workflows"}`].filter(Boolean).join(" · ");
    };
    return h("span", { className: "ps-wf-picker" },
        h("label", { htmlFor: id, className: "ps-sr-only" }, "Workflow definition"),
        h("select", { id, className: "ps-workflow-input ps-wf-picker-select", value: chosen,
            onChange: event => { if (event.target.value === "__new__") onNew(); else onChoose(event.target.value); } },
            definitions.map(definition => h("option", { key: definition.name, value: definition.name }, option(definition))),
            h("option", { value: "__new__" }, "New definition… (asks the chat)")));
}

/**
 * The definition's newest revision line (07, D3), when it is not valid: one line over the graph. While the session that
 * owns it is still working (its chat is in a turn: it is writing the definition), the line is calm (owner batch 7, H1):
 * `{ text, calm }`, or null for a valid revision.
 */
function revisionLine(model, { writing = false, writer = null } = {}) {
    const revision = model?.revision;
    if (!revision || !Number.isSafeInteger(revision.revision)) return null;
    if (revision.valid !== false) return null;
    const diagnostics = (Array.isArray(revision.diagnostics) ? revision.diagnostics : []).filter(item => item && item.severity !== "warning");
    const first = diagnostics[0] ?? null;
    const where = first && Number.isSafeInteger(first.line) ? `line ${first.line}: ` : "";
    const why = first?.message ? ` · ${where}${first.message}` : "";
    const graphRevision = Number.isSafeInteger(model?.graph?.revision) && model.graph.revision !== revision.revision ? model.graph.revision : null;
    const showing = graphRevision ? ` Showing revision ${graphRevision}.` : "";
    if (writing) {
        const count = diagnostics.length;
        return { calm: true, text: `${writer ?? "The chat"} is still writing this definition. Revision ${revision.revision} has `
            + `${count || "unlisted"} error${count === 1 ? "" : "s"} so far.${showing}` };
    }
    return { calm: false, text: `Revision ${revision.revision} not valid${why}.${showing}` };
}

/**
 * The selected node in the Definition view (D9 Node; finding 7): what it does in one sentence, its input and time limit,
 * an agent node's chat and what its agent is told, and where each outcome goes, in the words the run's Node panel uses
 * (workflowNodeSummary). No run: nothing about visits or results.
 */
function NodeFacts({ node }) {
    if (!node) return h("p", { className: "ps-wf-muted" }, "Select a node to see it.");
    const row = (label, value) => value === null || value === undefined || value === "" ? null
        : h("div", { className: "ps-wf-fact", key: label }, h("span", null, label), h("strong", null, value));
    const summary = workflowNodeSummary(node, { execution: null });
    const input = node.input !== undefined ? JSON.stringify(node.input) : node.forEach ? `each item of ${typeof node.forEach === "string" ? node.forEach : "its list"}` : null;
    return h("section", { className: "ps-wf-def-node", "aria-label": "Node" },
        h("p", { className: "ps-wf-node-head" }, h("strong", null, node.id), ` · ${node.typeWord ?? node.label ?? node.type}`),
        summary.what ? h("p", { className: "ps-wf-what", "data-node-what": "true" }, summary.what) : null,
        h("div", { className: "ps-wf-facts" },
            row("Input", input),
            row("Time limit", Number.isFinite(node.timeoutSeconds) ? formatSeconds(node.timeoutSeconds) : null),
            summary.agent ? row("Chat", summary.agent.chatMode) : null),
        summary.agent?.told ? h("details", { className: "ps-wf-told" }, h("summary", null, "What the agent is told"), h("pre", null, summary.agent.told))
            : summary.agent?.toldWords ? h("p", { className: "ps-wf-muted" }, summary.agent.toldWords) : null,
        summary.next.lines.length || summary.next.failure ? h("div", { className: "ps-wf-next", "aria-label": "Next" },
            h("h3", null, "Next"),
            h("ul", null, summary.next.lines.map(line => h("li", { key: line.label, "data-route": line.label }, line.text))),
            summary.next.failure ? h("p", { className: "ps-wf-muted" }, summary.next.failure) : null) : null);
}

/** How far one arrow key moves the bottom panel's edge, and Shift or Page Up/Down. */
const PANEL_STEP = 16;
const PANEL_BIG_STEP = 64;
/** What stays above the bottom panel: the graph's minimum (L5) and the bars over it. */
const PANEL_ROOM_ABOVE = 190;

/**
 * The bottom panel (L5): one panel at a time, closed by default; a phone shows it as a sheet with a way back (12). Open,
 * it keeps ONE height whatever tab shows (owner feedback 2026-11-06: no jumping between Node, Log and Variables), and
 * its contents scroll inside. Its top edge is a handle: drag it, or focus it and use the arrow keys (Shift or Page
 * Up/Down for bigger steps, Home and End for the smallest and largest); a double-click puts the default back. The
 * height is remembered per device class in the profile settings (workflowPanelHeights).
 */
function BottomPanel({ controller, panels, panel, onPanel, mobile, children, extra = null }) {
    const sheetRef = React.useRef(null);
    const device = mobile ? "phone" : "desktop";
    const stored = useControllerSelector(controller, state => state.ui.workflowPanelHeights?.[device] ?? null);
    const [dragHeight, setDragHeight] = React.useState(null);
    const [room, setRoom] = React.useState(Infinity);
    // The panel's container height bounds it: the graph keeps its minimum above it.
    React.useEffect(() => {
        const box = sheetRef.current?.parentElement;
        if (!box) return undefined;
        const measure = () => {
            const height = box.getBoundingClientRect().height;
            if (height > 0) setRoom(current => (current === height - PANEL_ROOM_ABOVE ? current : Math.max(WORKFLOW_PANEL_HEIGHT_MIN, height - PANEL_ROOM_ABOVE)));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        return () => observer.disconnect();
    }, [Boolean(panel)]);
    const height = workflowPanelHeight({ [device]: dragHeight ?? stored ?? undefined }, device, room);
    const keep = next => controller.dispatch({ type: "ui/workflowPanelHeight", device,
        height: next === null ? null : workflowPanelHeight({ [device]: next }, device, room) });
    // The phone's Back gesture closes the sheet first (12): the sheet adds one history entry while it is open.
    React.useEffect(() => {
        if (!mobile || !panel || typeof window === "undefined") return undefined;
        let closedByBack = false;
        const entry = { psWorkflowSheet: true };
        window.history.pushState(entry, "");
        const onPop = () => { closedByBack = true; onPanel(null); };
        window.addEventListener("popstate", onPop);
        return () => {
            window.removeEventListener("popstate", onPop);
            if (!closedByBack && window.history.state?.psWorkflowSheet) window.history.back();
        };
    }, [mobile, Boolean(panel)]);
    const labels = { node: "Node", log: "Log", variables: "Variables", revisions: "Revisions", test: "Test" };
    const tabs = h("div", { className: "ps-wf-panel-tabs", role: "tablist", "aria-label": "Workflow panel" },
        panels.map(id => h("button", { key: id, type: "button", role: "tab", "aria-selected": panel === id, className: panel === id ? "is-on" : "",
            onClick: () => onPanel(panel === id && !mobile ? null : id) }, labels[id])));
    if (!panel) return h("div", { ref: sheetRef, className: "ps-wf-panel is-closed" }, tabs, extra);
    const onPointerDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = next => setDragHeight(workflowPanelHeight({ [device]: startHeight - (next.clientY - startY) }, device, room));
        const up = next => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            keep(startHeight - (next.clientY - startY));
            setDragHeight(null);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
    };
    const onKeyDown = event => {
        const big = event.shiftKey ? PANEL_BIG_STEP : PANEL_STEP;
        const by = { ArrowUp: big, ArrowDown: -big, PageUp: PANEL_BIG_STEP, PageDown: -PANEL_BIG_STEP }[event.key];
        if (by !== undefined) { event.preventDefault(); keep(height + by); }
        else if (event.key === "Home") { event.preventDefault(); keep(WORKFLOW_PANEL_HEIGHT_MIN); }
        else if (event.key === "End") { event.preventDefault(); keep(Number.isFinite(room) ? room : height + PANEL_BIG_STEP * 4); }
    };
    return h("div", { ref: sheetRef, className: `ps-wf-panel${mobile ? " is-sheet" : ""}`, "data-panel": panel, style: { height: `${height}px` } },
        h("div", { className: "ps-wf-panel-resize", role: "separator", tabIndex: 0, "aria-orientation": "horizontal",
            "aria-label": "Resize the bottom panel", "aria-valuemin": WORKFLOW_PANEL_HEIGHT_MIN,
            "aria-valuemax": Number.isFinite(room) ? Math.round(room) : undefined, "aria-valuenow": Math.round(height),
            title: "Drag, or use the arrow keys, to resize. Double-click puts it back.",
            onPointerDown, onKeyDown, onDoubleClick: () => keep(null) }),
        h("div", { className: "ps-wf-panel-bar" },
            mobile ? h("button", { type: "button", className: "ps-mini-button ps-wf-back", onClick: () => onPanel(null) }, "← Graph") : null,
            tabs, extra,
            mobile ? null : h("button", { type: "button", className: "ps-wf-panel-close", "aria-label": "Close the panel", title: "Close", onClick: () => onPanel(null) }, "✕")),
        h("div", { className: "ps-wf-panel-body" }, children));
}

/** The Definition view (07). `definition.newestId` is the workflow child whose definition it shows. */
function DefinitionView({ controller, definition, tab, setTab, mobile, onStarted, ownerTitle = null, ownerWorking = false }) {
    const child = useWorkflowChild(controller, definition.newestId);
    const { sessionId, view, workflowModel, places } = child;
    const projection = useDefinitionProjection(child);
    const graph = projection ? projection.definition : view.definition;
    const nodes = projection ? projection.nodes : child.legacyNodes;
    const selected = nodes.find(node => node.id === view.selectedNodeId) || nodes.find(node => node.id === graph?.initial) || nodes[0] || null;
    const runCommand = view.runCommand ?? null;
    const publication = React.useMemo(() => workflowV2DefinitionControls(workflowModel, runCommand), [workflowModel, runCommand]);
    const editor = React.useMemo(() => {
        const made = workflowV2DraftEditor(workflowModel, runCommand);
        return made ? { ...made, sessionId } : null;
    }, [workflowModel, runCommand, sessionId]);
    const startControl = definition.startable && publication
        ? publication.controls.find(control => control.operation === "publish_and_start" || control.operation === "start") ?? null : null;
    const [mode, setMode] = React.useState("graph");
    const [starting, setStarting] = React.useState(false);
    // Run again (W8): another Workflow from this definition. On the tested engine the chat starts it with the same YAML.
    const startedAlready = !definition.startable && definition.workflows.length > 0;
    const [asking, setAsking] = React.useState(false);
    // "Start…" from the Workflows list opens the Start form here once the definition's commands are read.
    React.useEffect(() => {
        if (!tab.start) return;
        if (startControl) {
            setTab({ start: false });
            if (startControl.enabled) setStarting(true);
        } else if (!definition.startable) setTab({ start: false });
    }, [tab.start, startControl?.enabled, definition.startable]);
    // "Start another…" from the Workflows list opens its form here.
    React.useEffect(() => {
        if (!tab.another) return;
        setTab({ another: false });
        if (startedAlready) setAsking(true);
    }, [tab.another, startedAlready]);
    // Test mode (spec 16): hidden unless the server lists a test operation for this workflow (PILOTSWARM_WORKFLOW_TEST_MODE=on).
    const testing = workflowV2TestModeListed(workflowModel);
    const panels = testing ? [...WORKFLOW_DEFINITION_PANELS, "test"] : WORKFLOW_DEFINITION_PANELS;
    const panel = panels.includes(tab.definitionPanel) ? tab.definitionPanel : null;
    const select = id => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } });
        // A desktop click opens the node's facts; a phone tap only selects, and a second tap opens them (12).
        if (!mobile || id === view.selectedNodeId) setTab({ definitionPanel: "node" });
    };
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: `session:${sessionId}`, steps, at: Date.now() }),
        [controller, sessionId]);
    const onGraphView = React.useCallback(graphView => controller.dispatch({ type: "ui/workflowView", sessionId, view: { graphView } }), [controller, sessionId]);
    const line = revisionLine(workflowModel, { writing: ownerWorking, writer: ownerTitle });
    const revision = Number.isSafeInteger(workflowModel?.revision?.revision) ? workflowModel.revision.revision : null;
    const notice = workflowV2RunCommandNotice(runCommand);
    const nextNumber = definition.workflows.length + 1;
    return h("div", { className: "ps-wf-body" },
        h("div", { className: "ps-wf-bar" },
            h("span", { className: "ps-wf-bar-text" }, revision !== null ? `Revision ${revision}` : null),
            startControl ? h("button", { type: "button", className: "ps-mini-button is-primary", "data-action": "start", disabled: !startControl.enabled,
                title: startControl.enabled ? `Start Workflow #${nextNumber}` : startControl.title, onClick: () => setStarting(true) }, "Start…") : null,
            startedAlready ? h("button", { type: "button", className: "ps-mini-button is-primary", "data-action": "start-another",
                title: `Ask the chat to start ${definition.name} #${nextNumber} from this definition`, onClick: () => setAsking(true) }, "Start another…") : null,
            h("button", { type: "button", className: "ps-mini-button", "aria-pressed": mode === "yaml", onClick: () => setMode(mode === "yaml" ? "graph" : "yaml") }, "YAML"),
            h("button", { type: "button", className: "ps-mini-button", "aria-pressed": panel === "revisions",
                onClick: () => setTab({ definitionPanel: panel === "revisions" ? null : "revisions" }) }, "Compare")),
        line ? h("p", { className: `ps-wf-line ${line.calm ? "is-quiet" : "is-error"}`, role: "status", "data-drafting": line.calm ? "true" : undefined },
            line.text) : null,
        notice ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice }) : null,
        h("div", { className: "ps-wf-main", hidden: mode !== "graph" || undefined },
            graph ? h(WorkflowGraph, { definition: graph, nodes, selected, select, scope: sessionId, viewport: view.graphView ?? null, onViewport: onGraphView,
                places: places ?? null, onPlaces, mobile })
                // No graph to draw: the line above says why; its errors are listed under it (folded while the chat writes).
                : projection && line ? (line.calm
                    ? h("details", { className: "ps-wf-errors" }, h("summary", null, "Errors so far"), h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics }))
                    : h("div", { className: "ps-wf-errors" }, h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics })))
                : projection ? h(WorkflowV2NoGraph, { projection })
                : h("p", { className: "ps-wf-muted" }, view.error || "Loading the workflow definition…")),
        mode === "yaml" ? h("div", { className: "ps-wf-main ps-wf-yaml" },
            editor ? h(WorkflowV2DraftEditor, { key: sessionId, controller, sessionId, model: editor, savedEdit: view.draftEdit ?? null })
                : h(WorkflowV2YamlView, { key: sessionId, controller, sessionId, model: workflowModel, reads: view.definitionRevisions ?? null })) : null,
        h(BottomPanel, { controller, panels, panel, mobile, onPanel: id => setTab({ definitionPanel: id }) },
            panel === "node" ? h(NodeFacts, { node: selected })
                : panel === "test" ? h(TestPanel, { controller, child, runCommand })
                : panel === "revisions"
                    ? (revision !== null && revision >= 2
                        ? h(WorkflowV2RevisionCompare, { controller, sessionId, latest: revision, reads: view.definitionRevisions ?? null })
                        : h("p", { className: "ps-wf-muted" }, revision === null ? "Loading the revisions…" : "Only one revision so far."))
                    : null),
        starting && startControl ? h(StartDialog, { controller, sessionId, publication, control: startControl, name: definition.name, number: nextNumber,
            onClose: () => setStarting(false), onStarted: () => { setStarting(false); onStarted(sessionId); } }) : null,
        asking ? h(StartDialog, { controller, sessionId, name: definition.name, number: nextNumber,
            publication: { inputsSchema: publication?.inputsSchema ?? graphInputsSchema(workflowModel), revision, publishedRevision: revision,
                state: "published", valid: true },
            onAsk: ({ inputs, vars }) => controller.startAnotherWorkflow(sessionId, { inputs, vars }),
            onClose: () => setAsking(false), onStarted: () => setAsking(false) }) : null);
}

/** The inputs schema of a definition's graph, when its read model has one; null otherwise. */
function graphInputsSchema(model) {
    const schema = model?.graph?.inputsSchema;
    return schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
}

/**
 * The Test panel of the Definition view: test mode (spec 16), shown only when the server lists a test operation for the
 * workflow (the deployment sets PILOTSWARM_WORKFLOW_TEST_MODE=on). It is the old screen's test review, its test runs
 * and, for the test run chosen, its held calls, its virtual clock and the answer form, from the same components. Test
 * runs are not Workflows: they show here only.
 */
function TestPanel({ controller, child, runCommand }) {
    const { sessionId, session, view, readModel, workflowModel, readError } = child;
    const controls = React.useMemo(() => workflowV2TestControls(readModel ?? workflowModel, runCommand), [readModel, workflowModel, runCommand]);
    const responder = React.useMemo(() => workflowV2TestResponder(readModel, runCommand), [readModel, runCommand]);
    const run = readModel?.run && readModel.run.mode === "test" ? readModel.run : null;
    const answering = view.answeringInterceptionId ?? null;
    return h("div", { className: "ps-wf-test", "data-panel": "test" },
        controls ? h(WorkflowV2TestPanel, { controller, sessionId, model: controls })
            : h("p", { className: "ps-wf-muted" }, workflowModel?.definition?.state === "published" ? WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT
                : "This workflow takes no test from people."),
        h(WorkflowV2RunPicker, { controller, sessionId, workflowModel, selectedRunId: view.selectedRunId ?? null, ownModelLoaded: readModel != null,
            error: readError }),
        run?.test ? h("div", { className: "ps-workflow-test-calls" },
            h(WorkflowV2TestInterceptions, { test: run.test, controller, sessionId, responder, answering, history: run.history ?? null,
                onLoadOlder: restart => controller.loadOlderWorkflowHistory(sessionId, { restart }), parentSessionId: session?.parentSessionId ?? null }),
            responder?.advance ? h(WorkflowV2TestClock, { controller, sessionId, responder }) : null,
            responder?.respond && answering
                ? h(WorkflowV2TestAnswer, { controller, sessionId, responder, interceptionId: answering, parentSessionId: session?.parentSessionId ?? null })
                : null) : null);
}

/** The Workflows list (08, W1): one row per Workflow of the definition, newest first. */
function WorkflowList({ controller, definition, byId, views, onOpen, onStart, onAnother }) {
    const rows = [...definition.workflows].reverse();
    const ids = rows.map(row => row.sessionId);
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    const stamp = rows.map(row => `${row.sessionId}:${byId?.[row.sessionId]?.updatedAt ?? ""}`).join(",");
    // The newest Workflows' states, revisions and times come from their read models and events.
    React.useEffect(() => {
        for (const id of ids.slice(0, LIST_READ_LIMIT)) {
            controller.ensureSessionHistory(id).catch(() => {});
            controller.ensureWorkflowReadModel(id).catch(() => {});
        }
    }, [controller, stamp]);
    return h("div", { className: "ps-wf-body" },
        rows.length === 0
            ? h("div", { className: "ps-wf-empty" }, h("p", null, "No Workflows yet."), definition.startable
                ? h("button", { type: "button", className: "ps-mini-button is-primary", onClick: onStart }, "Start…") : null)
            : h("div", { className: "ps-wf-list", role: "table", "aria-label": `Workflows of ${definition.name}` },
                h("div", { className: "ps-wf-list-row is-head", role: "row" },
                    ["#", "State", "Revision", "Started", "Took"].map(label => h("span", { key: label, role: "columnheader" }, label))),
                rows.map(row => {
                    const session = byId?.[row.sessionId] ?? null;
                    const view = views?.[row.sessionId] ?? null;
                    const state = workflowStateOf(session, view);
                    const model = workflowChildModel(view);
                    const live = Array.isArray(model?.runs) ? model.runs.find(run => run?.mode === "live") ?? null : null;
                    const times = workflowTimes(histories?.get?.(row.sessionId)?.events, live?.runId ?? null);
                    const reason = state?.key === "failed" && model?.run && model.run.mode !== "test" ? workflowFailureText(model.run) : null;
                    return h("button", { key: row.sessionId, type: "button", role: "row", className: "ps-wf-list-row", "data-session-id": row.sessionId,
                        "aria-label": `Open ${definition.name} #${row.number}`, onClick: () => onOpen(row.sessionId) },
                        h("span", { role: "cell", className: "ps-wf-list-number" }, `#${row.number}`),
                        h("span", { role: "cell", className: "ps-wf-list-state" }, h(StateChip, { state }),
                            reason ? h("span", { className: "ps-wf-list-reason" }, reason.replace(/^Failed /u, "")) : null),
                        h("span", { role: "cell" }, Number.isSafeInteger(live?.revision) ? String(live.revision) : "—"),
                        h("span", { role: "cell" }, times.started !== null ? shownTime(times.started) : "—"),
                        h("span", { role: "cell" }, times.took !== null ? tookText(times.took) : "—"));
                })),
        rows.length ? h("div", { className: "ps-wf-bar is-foot" },
            definition.startable
                ? h("button", { type: "button", className: "ps-mini-button is-primary", onClick: onStart }, "Start…")
                // Run again (W8): another Workflow from this definition, which the chat starts with the same YAML.
                : h("button", { type: "button", className: "ps-mini-button is-primary", "data-action": "start-another", onClick: onAnother },
                    "Start another…")) : null);
}

/** One Workflow (08): its header, controls by state, its failure first, its graph and its bottom panel. */
function WorkflowRunView({ controller, definition, workflow, tab, setTab, mobile, onOpen, nodeStateId = null }) {
    const child = useWorkflowChild(controller, workflow.sessionId);
    const { sessionId, session, view, places, events, projection, readModel, readError } = child;
    // Live while it is shown, also when its session's chat is the active session (the companion subscription).
    React.useEffect(() => controller.watchWorkflow(sessionId), [controller, sessionId]);
    // A Workflow is its live run: a test run chosen in the Definition view's Test panel (test mode) is not shown here.
    React.useEffect(() => {
        if (view.selectedRunId) controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedRunId: null } });
    }, [controller, sessionId, view.selectedRunId]);
    const nodes = child.nodes;
    const graph = child.definition;
    const chosen = nodeStateId && view.selectedNodeId == null ? nodeStateId : view.selectedNodeId;
    const selected = nodes.find(node => node.id === chosen) || (projection ? nodes.find(node => node.pending) : null)
        || nodes.find(node => node.id === graph?.initial) || nodes[0] || null;
    const state = workflowStateOf(session, view);
    const runCommand = view.runCommand ?? null;
    const runControls = React.useMemo(() => workflowV2RunControls(readModel, runCommand), [readModel, runCommand]);
    const variables = React.useMemo(() => workflowV2RunVariables(readModel, runCommand), [readModel, runCommand]);
    const notice = workflowV2RunCommandNotice(runCommand);
    const runId = projection?.runId ?? readModel?.run?.runId ?? null;
    const times = workflowTimes(events, runId);
    const revision = Number.isSafeInteger(projection?.readModel?.runRevision) ? projection.readModel.runRevision : null;
    const failure = state?.key === "failed" && readModel?.run && readModel.run.mode !== "test" ? workflowFailureText(readModel.run) : null;
    const [stopping, setStopping] = React.useState(false);
    // An agent node's Log shows its chat (finding 8); "Whole Workflow" shows every line of this Workflow.
    const [logScope, setLogScope] = React.useState("node");
    const controls = runControls?.controls ?? [];
    const has = operation => controls.find(control => control.operation === operation) ?? null;
    const pause = has("pause"), resume = has("resume"), stop = has("stop"), cancel = has("cancel");
    const panel = WORKFLOW_RUN_PANELS.includes(tab.runPanel) ? tab.runPanel : null;
    const select = (id, { open = false } = {}) => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } });
        // A tap selects; a second tap on the selected node, or a desktop click, opens its details (12).
        if (open || !mobile || id === view.selectedNodeId) setTab({ runPanel: "node" });
    };
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: `session:${sessionId}`, steps, at: Date.now() }),
        [controller, sessionId]);
    const onGraphView = React.useCallback(graphView => controller.dispatch({ type: "ui/workflowView", sessionId, view: { graphView } }), [controller, sessionId]);
    const number = workflow.number;
    return h("div", { className: "ps-wf-body", "data-session-id": sessionId },
        h("div", { className: "ps-wf-bar" },
            h(WorkflowNumberPicker, { definition, chosen: sessionId, onOpen }),
            h(StateChip, { state }),
            h("span", { className: "ps-wf-bar-text" }, [revision !== null ? `revision ${revision}` : null,
                times.started !== null ? shownTime(times.started) : null, times.took !== null ? tookText(times.took) : null].filter(Boolean).join(" · ")),
            h("span", { className: "ps-wf-bar-actions" },
                pause ? h("button", { type: "button", className: "ps-mini-button", "data-operation": "pause", disabled: !pause.enabled, title: pause.title,
                    onClick: () => controller.sendWorkflowRunCommand(sessionId, { operation: "pause", runId: runControls.runId }) }, pause.label) : null,
                resume ? h("button", { type: "button", className: "ps-mini-button", "data-operation": "resume", disabled: !resume.enabled, title: resume.title,
                    onClick: () => controller.sendWorkflowRunCommand(sessionId, { operation: "resume", runId: runControls.runId }) }, resume.label) : null,
                stop || cancel ? h("button", { type: "button", className: "ps-mini-button", "data-action": "stop-dialog",
                    disabled: !(stop?.enabled || cancel?.enabled), onClick: () => setStopping(true) }, "Stop…") : null)),
        failure ? h("p", { className: "ps-wf-line is-error", role: "status" }, failure) : null,
        readError ? h("p", { className: "ps-wf-line is-error", role: "alert" }, `This Workflow could not be read: ${readError} `,
            h("button", { type: "button", className: "ps-mini-button", onClick: () => controller.ensureWorkflowReadModel(sessionId, { force: true }) }, "Retry")) : null,
        notice ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice }) : null,
        h("div", { className: "ps-wf-main" },
            graph ? h(WorkflowGraph, { definition: graph, nodes, selected, select, scope: sessionId, viewport: view.graphView ?? null, onViewport: onGraphView,
                places: places ?? null, onPlaces, mobile })
                : projection ? h(WorkflowV2NoGraph, { projection })
                : h("p", { className: "ps-wf-muted" }, view.error || "Loading the Workflow…")),
        h(BottomPanel, { controller, panels: variables ? WORKFLOW_RUN_PANELS : WORKFLOW_RUN_PANELS.filter(id => id !== "variables"), panel, mobile,
            onPanel: id => setTab({ runPanel: id }) },
            panel === "node" ? h(RunNodePanel, { controller, child, selected,
                onLog: () => { setLogScope("node"); setTab({ runPanel: "log" }); } }) : null,
            panel === "log" ? h(RunLogPanel, { controller, events, runId, selected, scope: logScope, onScope: setLogScope,
                instructionsReadable: workflowBaseInstructionsReadable(readModel) }) : null,
            panel === "variables" ? (variables ? h(WorkflowV2Variables, { controller, sessionId, model: variables }) : h("p", { className: "ps-wf-muted" }, "No variables."))
                : null),
        stopping ? h(StopDialog, { controller, sessionId, runId: runControls?.runId ?? runId, title: `${definition.name} #${number}`, stop, cancel,
            onClose: () => setStopping(false) }) : null);
}

/** "#3 ▾": the definition's Workflows, newest first, and the list of all of them (W3). */
function WorkflowNumberPicker({ definition, chosen, onOpen }) {
    const id = `wf-number-${React.useId().replace(/:/g, "")}`;
    return h("span", { className: "ps-wf-picker is-number" },
        h("label", { htmlFor: id, className: "ps-sr-only" }, "Workflow"),
        h("select", { id, className: "ps-workflow-input", value: chosen, onChange: event => onOpen(event.target.value === "__all__" ? null : event.target.value) },
            [...definition.workflows].reverse().map(item => h("option", { key: item.sessionId, value: item.sessionId }, `#${item.number}`)),
            h("option", { value: "__all__" }, "All Workflows")));
}

/**
 * The Node panel of a Workflow (W10; owner feedback 2026-11-06, finding 7): one view that says what the node does, where
 * it is now, how often it ran, its last result, an agent node's chat and what its agent is told, and where each outcome
 * goes (WorkflowV2NodeSummary). No Details / Output / History tabs inside the panel's tab: the Log has the visits.
 */
function RunNodePanel({ controller, child, selected, onLog = null }) {
    const { sessionId, view, projection } = child;
    const [branchPick, setBranchPick] = React.useState(null);
    if (!selected) return h("p", { className: "ps-wf-muted" }, "Select a node to see it.");
    if (selected.shape !== "v2") return h(LegacyNodePanel, { selected });
    const runId = projection?.runId ?? null;
    return h("section", { className: "ps-wf-node", "aria-label": "Node details" },
        h("p", { className: "ps-wf-node-head" }, h("strong", null, selected.id), ` · ${selected.label}`),
        h(WorkflowV2NodeSummary, {
            selected, nodes: child.nodes, runId,
            // An agent node's visits, with its chat, are in its Log (finding 8).
            onLog: selected.kind === "agent" ? onLog : null,
            select: id => controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } }),
            openSession: id => { controller.loadSession(id).catch(() => {}); },
            executionValues: view.executionValues ?? null,
            onReadWholeValue: executionId => { controller.loadWorkflowExecutionValue(sessionId, { runId, executionId }).catch(() => {}); },
            branchIndex: branchPick?.key === workflowV2BranchPickKey(sessionId, runId, selected) ? branchPick.index : null,
            onBranch: index => {
                setBranchPick({ key: workflowV2BranchPickKey(sessionId, runId, selected), index });
                if (workflowV2SelectionAfterBranchChange(view.selectedExecution ?? null, selected.id) === null && view.selectedExecution) {
                    controller.selectWorkflowExecution(sessionId, null);
                }
            },
        }));
}

/**
 * The Node panel of a version 1 Workflow (its nodes come from its events): what the old step details showed, in the
 * Workflow tab's words. Every value is text, never markup.
 */
function LegacyNodePanel({ selected }) {
    const [detailTab, setDetailTab] = React.useState("details");
    const result = selected.result ?? null;
    const row = (label, value) => h("div", { className: "ps-wf-fact", key: label }, h("span", null, label), h("strong", null, String(value)));
    const tabs = [["details", "Details"], ["output", "Output"]];
    return h("section", { className: "ps-wf-node", "aria-label": "Node details", "data-shape": "v1" },
        h("p", { className: "ps-wf-node-head" }, h("strong", null, selected.id),
            ` · ${selected.type === "terminal" ? "End" : "Script"} · ${String(selected.state ?? "")}`),
        h("div", { className: "ps-wf-node-tabs", role: "tablist", "aria-label": "Node detail views" },
            tabs.map(([id, title]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": detailTab === id,
                className: detailTab === id ? "is-on" : "", onClick: () => setDetailTab(id) }, title))),
        detailTab === "details"
            ? h("div", { className: "ps-wf-facts" },
                row("Ran", `${selected.runs ?? 0} ${selected.runs === 1 ? "time" : "times"}${selected.partial ? " in loaded history" : ""}`),
                row("Last outcome", selected.outcome || "Not recorded"),
                Object.keys(selected.next || {}).length
                    ? row("Next", Object.entries(selected.next).map(([outcome, target]) => `${outcome} → ${target}`).join(" · ")) : null,
                Array.isArray(result?.toolCalls) && result.toolCalls.length
                    ? row("Tools", result.toolCalls.map(tool => `${tool?.name || "Tool"}${tool?.ok === false ? " (failed)" : ""}`).join(" · ")) : null)
            : h("div", { className: "ps-wf-node-output" },
                h("pre", null, result
                    ? String(result.error || result.reason || result.outputPreview || result.summary || "No output was recorded.")
                    : "This node has no result in the loaded history."),
                result?.stderrTail ? h(React.Fragment, null, h("h3", null, "Standard error"), h("pre", null, String(result.stderrTail))) : null));
}

/**
 * The Log panel (W10; finding 8). For an agent node: its own Log with its chat (AgentNodeLog), or, switched, the whole
 * Workflow's. For any other node: the whole Workflow's, as before.
 */
function RunLogPanel({ controller, events, runId, selected, scope, onScope, instructionsReadable = true }) {
    if (!(selected?.shape === "v2" && selected.kind === "agent")) return h(WorkflowLog, { events, runId });
    return h("div", { className: "ps-wf-log-panel" },
        h("div", { className: "ps-wf-switch is-log", role: "group", "aria-label": "Log of" },
            [["node", `Node ${selected.id}`], ["all", "Whole Workflow"]].map(([id, label]) => h("button", { key: id, type: "button",
                "aria-pressed": scope === id, className: scope === id ? "is-on" : "", onClick: () => onScope(id) }, label))),
        scope === "all" ? h(WorkflowLog, { events, runId }) : h(AgentNodeLog, { controller, node: selected, events, runId, instructionsReadable }));
}

/**
 * An agent node's Log (finding 8): its visits with its chat, read with the same history reads as any session. Each chat
 * of the shown visits is read once; while the newest visit works, its chat is read again every 5 s and at each new line
 * of the Workflow (a catch-up of the newer events only).
 */
function AgentNodeLog({ controller, node, events, runId, instructionsReadable = true }) {
    const [limit, setLimit] = React.useState(WORKFLOW_AGENT_LOG_VISITS);
    const chatIds = React.useMemo(() => workflowAgentLogChats(node, limit), [node, limit]);
    const chatKey = chatIds.join(",");
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    React.useEffect(() => {
        for (const id of chatIds) controller.ensureSessionHistory(id).catch(() => {});
    }, [controller, chatKey]);
    const working = node.current?.status === "pending" ? node.current.agent?.childSessionId ?? null : null;
    const lines = Array.isArray(events) ? events.length : 0;
    React.useEffect(() => {
        if (!working) return undefined;
        const read = () => { controller.ensureSessionHistory(working, { force: true }).catch(() => {}); };
        read();
        const timer = setInterval(read, 5_000);
        return () => clearInterval(timer);
    }, [controller, working, lines]);
    const chats = React.useMemo(() => new Map(chatIds.map(id => [id, histories?.get?.(id)?.events])), [chatKey, histories]);
    const failed = React.useMemo(() => new Set(chatIds.filter(id => histories?.get?.(id)?.loadState === "failed")), [chatKey, histories]);
    const log = React.useMemo(() => workflowAgentNodeLog({ node, events, chats, runId, limit }), [node, events, chats, runId, limit]);
    // The base instructions are read like any file of a session (the Workflow's), when a person opens their row; only by
    // the Workflow's owner (review SF-3): anyone else sees the summary row and is told so. The text read is shown only
    // when its sha256 is the recorded one (review SF-4); opened again, it is read again.
    const files = useControllerSelector(controller, state => state.files.bySessionId);
    const readInstructions = ref => {
        if (!instructionsReadable) return { ownerOnly: true };
        const preview = files?.[ref.sessionId]?.previews?.[ref.artifact];
        if (!preview) return null;
        const text = typeof preview.content === "string" && !preview.loading ? preview.content : null;
        if (text !== null && !workflowBaseInstructionsMatch(ref, text)) return { changed: true };
        return { loading: Boolean(preview.loading), text, error: preview.error ?? null };
    };
    const onInstructions = instructionsReadable
        ? ref => { controller.ensureFilePreview(ref.sessionId, ref.artifact, { force: true }).catch(() => {}); } : null;
    return h(WorkflowV2AgentLog, { log, failed, nodeId: node.id, readInstructions, onInstructions,
        onMore: () => setLimit(limit + WORKFLOW_AGENT_LOG_VISITS) });
}

/**
 * The Log panel (W10): this Workflow only, newest first, one sentence each. That is its live run's events and the
 * Workflow's own notices (no run id, such as a recovery request); a test run's events never show (test mode is hidden,
 * spec 16, and test runs are not Workflows).
 */
function WorkflowLog({ events, runId }) {
    const rows = React.useMemo(() => {
        const list = Array.isArray(events) ? events : EMPTY_EVENTS;
        const testRuns = new Set(list.filter(event => event?.eventType === "workflow.started" && event.data?.mode && event.data.mode !== "live")
            .map(event => event.data.runId));
        const own = list.filter(event => {
            const id = event?.data?.runId ?? null;
            return id === null || (!testRuns.has(id) && (runId === null || id === runId));
        });
        return workflowV2Activity(own, { runId: null, limit: 200 });
    }, [events, runId]);
    if (!rows.length) return h("p", { className: "ps-wf-muted" }, "Nothing has happened yet.");
    return h("ol", { className: "ps-wf-log", "aria-label": "Workflow log" },
        rows.map((row, index) => h("li", { key: row.seq ?? index, "data-level": row.level },
            row.at ? h("time", null, row.at) : null,
            h("span", null, row.what, row.who ? ` · ${row.who}` : ""))));
}

/** A dialog in the portal's style, closed by Escape, by its ✕ and by the backdrop. */
function Dialog({ title, onClose, children, footer, className = "" }) {
    const titleId = `wf-dialog-${React.useId().replace(/:/g, "")}`;
    const body = h("div", { className: "ps-modal-backdrop", onClick: onClose,
        onKeyDown: event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } } },
        h(ModalDialog, { className: `ps-modal is-narrow ps-wf-dialog${className ? ` ${className}` : ""}`, titleId },
            h("div", { className: "ps-modal-header" },
                h("div", { className: "ps-modal-title", id: titleId }, title),
                h("button", { type: "button", className: "ps-modal-close", onClick: onClose, "aria-label": "Close", title: "Close" }, "✕")),
            h("div", { className: "ps-modal-body ps-wf-dialog-body" }, children),
            footer ? h("div", { className: "ps-wf-dialog-foot" }, footer) : null));
    return typeof document === "undefined" ? body : createPortal(body, document.body);
}

/** W9, O7: one Stop dialog. Let started nodes finish (a graceful stop) or Cancel now; the close button says Keep running. */
function StopDialog({ controller, sessionId, runId, title, stop, cancel, onClose }) {
    const [choice, setChoice] = React.useState(stop?.enabled ? "stop" : "cancel");
    const [busy, setBusy] = React.useState(false);
    const send = async () => {
        if (!runId) return;
        setBusy(true);
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: choice, runId, confirmed: true });
        setBusy(false);
        if (result?.ok || result?.reason === "failed" || result?.reason === "unconfirmed") onClose();
    };
    const option = (value, label, note, control) => h("label", { className: `ps-wf-choice${control?.enabled ? "" : " is-disabled"}` },
        h("input", { type: "radio", name: "wf-stop", value, checked: choice === value, disabled: !control?.enabled, onChange: () => setChoice(value) }),
        h("span", null, h("strong", null, label), h("small", null, control?.enabled ? note : control?.title ?? "Not available for this Workflow.")));
    return h(Dialog, { title: `Stop ${title}`, onClose, className: "is-stop",
        footer: [
            h("button", { key: "keep", type: "button", className: "ps-mini-button", onClick: onClose }, "Keep running"),
            h("button", { key: "stop", type: "button", className: "ps-mini-button is-danger", "data-operation": choice, disabled: busy || !runId,
                onClick: send }, busy ? "Stopping…" : "Stop"),
        ] },
        h("div", { className: "ps-wf-choices", role: "radiogroup", "aria-label": "How to stop" },
            option("stop", "Let started nodes finish", "No new node starts. Started nodes get up to 60 s.", stop),
            option("cancel", "Cancel now", "Started nodes are interrupted.", cancel)),
        h("p", { className: "ps-wf-muted" }, "Effects that already happened are not undone."));
}

const DRAWABLE = new Set(["string", "number", "integer", "boolean"]);

/** Whether the Start form can draw a field for one input property (F-1); anything else is edited as JSON (F-4). */
function drawable(property) {
    if (!property || typeof property !== "object") return false;
    if (Array.isArray(property.enum)) return property.enum.every(value => ["string", "number", "boolean"].includes(typeof value));
    if (DRAWABLE.has(property.type)) return true;
    return property.type === "array" && property.items && typeof property.items === "object" && ["string", "number", "integer"].includes(property.items.type);
}

/** What a field's type is called (F-1). */
function typeWords(property) {
    if (Array.isArray(property?.enum)) return "one of a list";
    if (property?.type === "array") return property.items?.type === "string" ? "list of text" : "list of numbers";
    return { string: "text", number: "number", integer: "number", boolean: "yes or no" }[property?.type] ?? "value";
}

/** A list input as chips with ✕, and an add box (F-1). */
function ChipsField({ value, onChange, numbers, label }) {
    const [draft, setDraft] = React.useState("");
    const items = Array.isArray(value) ? value : [];
    const add = () => {
        const text = draft.trim();
        if (!text) return;
        const item = numbers ? Number(text) : text;
        if (numbers && !Number.isFinite(item)) return;
        onChange([...items, item]);
        setDraft("");
    };
    return h("span", { className: "ps-wf-chips" },
        items.map((item, index) => h("span", { key: `${index}:${String(item)}`, className: "ps-wf-chip" }, String(item),
            h("button", { type: "button", "aria-label": `Remove ${String(item)}`, onClick: () => onChange(items.filter((_, at) => at !== index)) }, "✕"))),
        h("input", { className: "ps-workflow-input ps-wf-chip-input", value: draft, "aria-label": `Add to ${label}`, placeholder: "+ add",
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => { if (event.key === "Enter") { event.preventDefault(); add(); } }, onBlur: add }));
}

/** One typed input field of the Start form (F-1). */
function InputField({ name, property, required, value, onChange }) {
    const id = `wf-in-${React.useId().replace(/:/g, "")}`;
    const head = [name, typeWords(property), required ? "required" : property?.default !== undefined ? `default ${JSON.stringify(property.default)}` : "optional"].join(" · ");
    let control;
    if (Array.isArray(property.enum)) {
        control = h("select", { id, className: "ps-workflow-input", value: JSON.stringify(value ?? null), onChange: event => onChange(JSON.parse(event.target.value)) },
            property.enum.map(option => h("option", { key: JSON.stringify(option), value: JSON.stringify(option) }, String(option))));
    } else if (property.type === "boolean") {
        control = h("input", { id, type: "checkbox", role: "switch", checked: value === true, onChange: event => onChange(event.target.checked) });
    } else if (property.type === "number" || property.type === "integer") {
        control = h("input", { id, type: "number", className: "ps-workflow-input", value: value ?? "",
            onChange: event => onChange(event.target.value === "" ? undefined : Number(event.target.value)) });
    } else if (property.type === "array") {
        control = h(ChipsField, { value, onChange, numbers: property.items?.type !== "string", label: name });
    } else {
        control = h("input", { id, type: "text", className: "ps-workflow-input", value: value ?? "", onChange: event => onChange(event.target.value) });
    }
    return h("div", { className: "ps-wf-field" }, h("label", { htmlFor: id }, head), control);
}

/**
 * F-1–F-7: Start asks only for what the definition needs, filled with sample values. With `onAsk` (Run again, W8) it is
 * the form for another Workflow of a started definition: the same fields, and its button asks the chat to start it
 * (`onAsk({ inputs, vars })`, answering { ok, reason }); nothing is sent to the engine from here.
 */
function StartDialog({ controller, sessionId, publication, control = null, name, number, onClose, onStarted, onAsk = null }) {
    const schema = publication.inputsSchema && typeof publication.inputsSchema === "object" ? publication.inputsSchema : null;
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
    const keys = Object.keys(properties);
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    const sample = React.useMemo(() => workflowV2SampleInputs(schema) ?? {}, [JSON.stringify(schema ?? null)]);
    const formable = keys.length > 0 && keys.every(key => drawable(properties[key]));
    const [asJson, setAsJson] = React.useState(!formable && keys.length > 0);
    const [values, setValues] = React.useState(() => ({ ...sample }));
    const [jsonText, setJsonText] = React.useState(() => JSON.stringify(sample, null, 2));
    const [varsOpen, setVarsOpen] = React.useState(false);
    const [varsText, setVarsText] = React.useState("{}");
    const [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const revision = publication.state === "draft" ? publication.revision : publication.publishedRevision;
    const toJson = () => { setJsonText(JSON.stringify(values, null, 2)); setAsJson(true); };
    const send = async () => {
        let inputs = values;
        if (keys.length === 0) inputs = {};
        else if (asJson) {
            const parsed = workflowV2JsonObjectDraft(jsonText, { label: "Inputs" });
            if (!parsed.ok) { setError(parsed.error); return; }
            inputs = parsed.value;
        }
        let vars;
        if (varsOpen) {
            const parsed = workflowV2JsonObjectDraft(varsText, { label: "Variables", optional: true });
            if (!parsed.ok) { setError(parsed.error); return; }
            vars = parsed.value && Object.keys(parsed.value).length ? parsed.value : undefined;
        }
        setError(null);
        setBusy(true);
        if (onAsk) {
            const asked = await onAsk({ inputs, vars });
            setBusy(false);
            if (asked?.ok) onStarted();
            else setError(asked?.reason || "The message to the chat was not sent.");
            return;
        }
        const command = control.operation === "start"
            ? { operation: "start", definitionHash: publication.publishedDefinitionHash, inputs, ...(vars ? { vars } : {}) }
            : { operation: "publish_and_start", expectedRevision: publication.revision, definitionHash: publication.definitionHash, inputs, ...(vars ? { vars } : {}) };
        const result = await controller.sendWorkflowRunCommand(sessionId, command);
        setBusy(false);
        if (result?.ok) onStarted();
        else if (result?.error) setError(result.error.message || "The Workflow was not started.");
    };
    return h(Dialog, { title: onAsk ? `Start another ${name}` : `Start ${name}`, onClose, className: "is-start",
        footer: [
            onAsk
                ? h("button", { key: "start", type: "button", className: "ps-mini-button is-primary", "data-action": "ask-start-another", disabled: busy,
                    onClick: send }, busy ? "Sending…" : `Ask the chat to start #${number}`)
                : h("button", { key: "start", type: "button", className: "ps-mini-button is-primary", "data-operation": control.operation,
                    disabled: busy || !control.enabled, title: control.enabled ? undefined : control.title, onClick: send }, busy ? "Starting…" : `Start #${number}`),
            // One way to leave without starting in words (the ✕ is the dialog's Close).
            h("button", { key: "cancel", type: "button", className: "ps-mini-button", onClick: onClose }, "Cancel"),
            h("span", { key: "note", className: "ps-wf-muted" }, onAsk
                ? `The chat starts ${name} #${number} from the same definition.`
                : `Workflow #${number} runs revision ${revision ?? "—"}.`),
        ] },
        h("p", { className: "ps-wf-muted ps-wf-dialog-sub" }, `revision ${revision ?? "—"} · ${publication.valid ? "valid" : "not valid"}`),
        keys.length === 0
            ? h("div", { className: "ps-wf-field" }, h("span", { className: "ps-wf-label" }, "Inputs"), h("p", { "data-field": "no-inputs" }, "Takes no inputs."))
            : asJson
                ? h("div", { className: "ps-wf-field" },
                    h("label", { htmlFor: `${sessionId}-inputs-json` }, "Inputs (JSON)"),
                    h("textarea", { id: `${sessionId}-inputs-json`, className: "ps-workflow-input is-code", rows: Math.min(10, Math.max(3, jsonText.split("\n").length)),
                        value: jsonText, spellCheck: false, onChange: event => setJsonText(event.target.value) }))
                : h(React.Fragment, null,
                    h("div", { className: "ps-wf-field-actions" }, h("button", { type: "button", className: "ps-link-button", onClick: toJson }, "Edit as JSON")),
                    keys.map(key => h(InputField, { key, name: key, property: properties[key], required: required.has(key), value: values[key],
                        onChange: value => setValues(current => {
                            const next = { ...current };
                            if (value === undefined) delete next[key]; else next[key] = value;
                            return next;
                        }) }))),
        h("div", { className: "ps-wf-field" },
            h("span", { className: "ps-wf-label" }, "Variables · optional"),
            varsOpen
                ? h("textarea", { className: "ps-workflow-input is-code", rows: 3, "aria-label": "Variables (JSON)", value: varsText, spellCheck: false,
                    onChange: event => setVarsText(event.target.value) })
                : h("p", null, "None. ", h("button", { type: "button", className: "ps-link-button", onClick: () => setVarsOpen(true) }, "Add"))),
        error ? h("p", { role: "alert", className: "ps-wf-line is-error" }, error) : null);
}

/**
 * The Workflow button's badge (L2, O6) for the session whose chat is on screen: Workflows waiting for input, and failed
 * ones not yet opened.
 */
export { workflowBadgeCount } from "../../core/src/workflow-owner.js";
