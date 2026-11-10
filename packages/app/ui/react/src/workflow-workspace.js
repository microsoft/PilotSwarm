import React from "react";
import { useControllerSelector } from "./use-controller-state.js";
import { workflowModelFromKey, workflowSessionModelKey } from "../../core/src/workflow-words.js";
import { selectWorkflowViewSnapshot, workflowReadModelView, workflowViewSnapshotEqual } from "../../core/src/workflow-view.js";
import {
    projectWorkflowV2, workflowV2Activity, workflowV2BranchPickKey, workflowV2DraftInProgress, workflowV2NoticeBadge, workflowV2OpenCalls, workflowV2ShownNotices,
    workflowV2SelectionAfterBranchChange,
} from "../../core/src/workflow-v2-view.js";
import {
    workflowV2DefinitionControls, workflowV2DraftEditor, workflowV2RunCommandNotice, workflowV2RunControls, workflowV2RunVariables,
    workflowV2TestControls, workflowV2TestResponder, workflowV2TestRunsShown,
} from "../../core/src/workflow-v2-commands.js";
import {
    WorkflowV2Banners, WorkflowV2DefinitionPanel, WorkflowV2DraftEditor, WorkflowV2DraftTools, WorkflowV2NoGraph, WorkflowV2NodeContent,
    WorkflowV2RunActivity, WorkflowV2RunCommandNotice, WorkflowV2RunControls, WorkflowV2RunPicker, WorkflowV2TestAnswer, WorkflowV2TestClock,
    WorkflowV2TestInterceptions, WorkflowV2TestPanel, WorkflowV2Variables, WorkflowV2YamlView,
} from "./workflow-v2-panels.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";
import { WorkflowGraph } from "./workflow-graph.js";

const h = React.createElement;
const EMPTY_EVENTS = [];

/**
 * Batch 6 (r-3): what the side pane shows instead of Step details, one at a time (the view's `sidePanel`), and its
 * title. The header's icon buttons choose one; a panel the workflow does not offer now (no run's activity yet, no test
 * run, nothing to publish) shows Step details instead.
 */
export const WORKFLOW_SIDE_PANEL_TITLES = Object.freeze({
    definition: "Publish review", test: "Test review", calls: "Test calls", variables: "Variables", draft: "YAML tools",
    activity: "Run activity", notices: "Notices", log: "Step log",
});

function useWorkflowView(controller) {
    // UI-1: one selector for every part, all derived from the same state's active session.
    const { sessionId, session, history, view, places, parentWorking } = useControllerSelector(controller, selectWorkflowViewSnapshot, workflowViewSnapshotEqual);
    const events = history?.events || EMPTY_EVENTS;
    const selectedRunId = view.selectedRunId ?? null;
    const sessionUpdatedAt = session?.updatedAt ?? null;
    // New events, another run selection or a changed session row (a draft's new revision) ask for the read model again.
    React.useEffect(() => {
        controller.ensureWorkflowDefinition(sessionId);
    }, [controller, sessionId, events, selectedRunId, sessionUpdatedAt]);
    // `view.readModel` is the object readWorkflowV2View returns, fetched by the controller (ensureWorkflowReadModel)
    // for the run selection it records. Only a model read for this selection is overlaid; a model read for another one
    // still says what graph the workflow has (or that it has none) while this selection's own model loads or fails,
    // and its run is never shown. Its watermark (`readModelAfterSeq`) is the highest event sequence the controller had
    // loaded before it fetched that read model; it only lets older pause/resume events stop contradicting the snapshot.
    const { readModel, readModelAfterSeq, workflowModel, error: readError } = workflowReadModelView(view);
    // The older history a person loaded (loadOlderWorkflowHistory) joins the selection's own model, for the run it shows only.
    const olderHistory = view.olderHistory ?? null;
    // OF-S2-7: the model of the chat that owns the Workflow (its agent nodes use it unless their start chose one).
    const chatModelKey = useControllerSelector(controller, state => workflowSessionModelKey(state.sessions.byId,
        state.sessions.byId?.[sessionId]?.parentSessionId ?? null));
    const chatModel = React.useMemo(() => workflowModelFromKey(chatModelKey), [chatModelKey]);
    const v2 = React.useMemo(() => {
        if (!view.definition && !readModel && !workflowModel) return null;
        // A definition is never redrawn once the read model says there is no graph (invalid or unavailable); the no-graph
        // panel explains why.
        return projectWorkflowV2({ definition: view.definition, readModel, workflowModel, selectedRunId, events, readModelAfterSeq, olderHistory, chatModel });
    }, [view.definition, readModel, workflowModel, selectedRunId, readModelAfterSeq, events, olderHistory, chatModel]);
    const definition = v2 ? v2.definition : null;
    const nodes = v2 ? v2.nodes : EMPTY_EVENTS;
    const selected = nodes.find(node => node.id === view.selectedNodeId)
        || nodes.find(node => node.pending)
        || nodes.find(node => node.id === definition?.initial)
        || nodes[0];
    const terminal = events.findLast(event => ["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(event?.eventType));
    const status = v2 ? v2.status.label : terminal?.eventType.slice("workflow.".length)
        || (["completed", "failed", "cancelled"].includes(session?.status) ? session.status : session?.status || "Starting");
    // Brings the side pane up on its canvas side (on a phone, the details layer), showing what the view says it shows.
    const openSide = () => {
        controller.dispatch({ type: "ui/sidePaneTab", tab: "canvas" });
        controller.dispatch({ type: "canvas/flip", sessionId, slot: 1 });
    };
    // Selecting a step shows its details in the side pane, whatever panel it showed (batch 6, r-3).
    const select = (nodeId, { open = true } = {}) => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: nodeId, sidePanel: null } });
        if (open) openSide();
    };
    const showSide = (panel, { open = true } = {}) => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: panel } });
        if (open) openSide();
    };
    // A person's run controls: only the selection's own read model can offer them, for the run it shows, and only
    // when it says which commands the workflow takes from people.
    const runCommand = view.runCommand ?? null;
    const runControls = React.useMemo(() => v2 ? workflowV2RunControls(readModel, runCommand) : null, [v2, readModel, runCommand]);
    const variables = React.useMemo(() => v2 ? workflowV2RunVariables(readModel, runCommand) : null, [v2, readModel, runCommand]);
    // The definition is the workflow's, whichever run is selected: the last read model of any selection says it.
    const publication = React.useMemo(() => v2 ? workflowV2DefinitionControls(readModel ?? workflowModel, runCommand) : null,
        [v2, readModel, workflowModel, runCommand]);
    // The draft editor's model names the session it was read for (UI-1), so the YAML editor never takes another's.
    const draftEditor = React.useMemo(() => {
        const editor = v2 ? workflowV2DraftEditor(readModel ?? workflowModel, runCommand) : null;
        return editor ? { ...editor, sessionId } : null;
    }, [v2, readModel, workflowModel, runCommand, sessionId]);
    const testControls = React.useMemo(() => v2 ? workflowV2TestControls(readModel ?? workflowModel, runCommand) : null,
        [v2, readModel, workflowModel, runCommand]);
    // The shown test run's answers and clock: only the selection's own read model says which run that is.
    const testResponder = React.useMemo(() => v2 ? workflowV2TestResponder(readModel, runCommand) : null, [v2, readModel, runCommand]);
    const runNotice = workflowV2RunCommandNotice(runCommand);
    // The definition's read model, whichever run is shown (the YAML tab reads its revision).
    const definitionModel = v2 ? readModel ?? workflowModel ?? null : null;
    // What the side pane offers now (r-3): the run's activity once it has some, the notices (and a failed read), a test
    // run's calls, and the panels the commands above offer.
    const activity = v2?.bound && v2.runId && (v2.ending || workflowV2Activity(events, { runId: v2.runId }).length) ? v2.runId : null;
    // Owner batch 7 (H1): while the parent agent is still writing the latest revision, its errors are said calmly and not counted.
    const drafting = v2 ? workflowV2DraftInProgress(v2, parentWorking) : null;
    const notices = workflowV2ShownNotices(v2?.banners, { draftInProgress: drafting });
    // A test run's calls only while the server's test mode is on (Workflow Simplified, spec 16).
    const test = workflowV2TestRunsShown(v2?.readModel) ? v2?.readModel?.run?.test ?? null : null;
    const offered = { definition: Boolean(publication?.controls.length), test: Boolean(testControls), calls: Boolean(test),
        variables: Boolean(variables), draft: Boolean(draftEditor), activity: Boolean(activity), notices: Boolean(notices.length || readError), log: true };
    const sidePanel = typeof view.sidePanel === "string" && offered[view.sidePanel] === true ? view.sidePanel : null;
    // r-1: the main pane shows the graph or the YAML. Graph by default.
    const mainTab = v2 && view.mainTab === "yaml" ? "yaml" : "graph";
    // The answer to a save from the YAML tab shows in that tab; every other command's answer shows in the side pane.
    const noticeInYaml = Boolean(runNotice?.operation === "replace_definition" && mainTab === "yaml" && sidePanel !== "draft");
    return { sessionId, session, view, places, nodes, selected, select, openSide, showSide, status, v2, definition, readError,
        workflowModel, selectedRunId, ownModelLoaded: readModel != null, runControls, variables, publication, draftEditor, testControls, testResponder,
        runNotice, events, definitionModel, activity, notices, drafting, test, sidePanel, mainTab, noticeInYaml };
}

/** The read model's last failure for the selected run, in the Notices panel, with a Retry that asks again now. */
function WorkflowReadError({ controller, sessionId, message }) {
    if (!message) return null;
    return React.createElement("div", { className: "ps-workflow-read-error", role: "alert",
        style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "0.8rem", color: "var(--ps-danger)",
            borderBottom: "1px solid var(--ps-border)", overflowWrap: "anywhere" } },
    React.createElement("span", { style: { flex: 1, minWidth: 0 } }, `The workflow's current status could not be read: ${message}`),
    React.createElement("button", { type: "button", className: "ps-mini-button",
        onClick: () => controller.ensureWorkflowReadModel(sessionId, { force: true }) }, "Retry"));
}

const MAIN_TABS = [["graph", "Graph"], ["yaml", "YAML"]];

/**
 * The workflow screen has no composer bar: its header already names the workflow, and nobody types into it (flow-09).
 *
 * Batch 6 (r-1, r-2, r-3): the pane stays still. A compact header (the name, the status, Graph | YAML, the run picker and
 * the icon tools), and under it the graph or the YAML, nothing else. Every panel opens in the side pane from its icon
 * button, whose pressed look says the side pane shows it; a second press goes back to Step details. The graph stays
 * mounted while the YAML is shown, so it comes back at the same zoom and place.
 */
export function WorkflowMainPane({ controller, icon, onNodeSelected, mobile = false, onOpenSide = null }) {
    const { sessionId, session, view, places, nodes, selected, select, openSide, showSide, status, v2, definition, readError, workflowModel, selectedRunId,
        ownModelLoaded, runControls, variables, publication, draftEditor, testControls, runNotice, definitionModel, activity, notices, drafting, test,
        sidePanel, mainTab, noticeInYaml } = useWorkflowView(controller);
    const tabsId = `wf-tabs-${React.useId().replace(/:/g, "")}`;
    // The side pane is on screen beside this pane: a desktop's canvas column, open on its canvas side.
    const sideOpen = useControllerSelector(controller, state => state.ui.canvasOpen === true && state.ui.sidePaneTab !== "workspace");
    const sideShown = sideOpen && !mobile;
    // A refused or unconfirmed command answers the person's own click: it shows in the side pane, which comes up for a new
    // one if it is not on screen (a save from the YAML tab is answered in that tab).
    const noticeKey = runNotice && !noticeInYaml ? `${view.runCommand?.operationId ?? ""}:${view.runCommand?.phase ?? ""}` : null;
    const seenNotice = React.useRef({ sessionId, key: noticeKey });
    React.useEffect(() => {
        const seen = seenNotice.current;
        seenNotice.current = { sessionId, key: noticeKey };
        if (noticeKey && seen.sessionId === sessionId && seen.key !== noticeKey && !sideShown) openSide();
    }, [sessionId, noticeKey]);
    // On a phone, Step details cover the whole screen: tapping a step on the graph only selects it, and a second tap on the
    // step the person selected, or Step details, opens them. "Selected" here is the person's own choice (view.selectedNodeId),
    // not the step the view shows by default (the current or first step), so a first tap on that one does not open it.
    // Elsewhere selecting a step opens its details beside the graph, as before, and so does mobile Zen, which leaves Zen for
    // the details it asks for (onNodeSelected). Step details always opens (`open`).
    const selectNode = (id, { open = false } = {}) => {
        if (onOpenSide && (open || id === view.selectedNodeId)) {
            select(id, { open: false });
            onOpenSide({ sessionId, panel: null, nodeId: id });
            return;
        }
        select(id, { open: !onOpenSide && (open || !mobile || Boolean(onNodeSelected) || id === view.selectedNodeId) });
        onNodeSelected?.();
    };
    // A panel's icon button: pressed while the side pane shows that panel (a second press goes back to Step details);
    // otherwise it shows the panel and brings the side pane up (on a phone, the details layer).
    // A host without a side pane of its own (a Master of Agents panel; UI-2) takes the request instead: it opens this
    // workflow where one is, on that panel, its step, its run and any unsaved YAML.
    const panelButton = (panel, props) => {
        const shown = sideShown && sidePanel === panel;
        return h(WorkflowToolButton, { ...props, "aria-expanded": shown,
            onClick: () => (onOpenSide ? onOpenSide({ sessionId, panel, nodeId: selected?.id ?? null })
                : shown ? showSide(null, { open: false }) : showSide(panel)) });
    };
    const setTab = tab => controller.dispatch({ type: "ui/workflowView", sessionId, view: { mainTab: tab } });
    const onTabKey = event => {
        const at = MAIN_TABS.findIndex(([id]) => id === mainTab);
        const next = event.key === "ArrowRight" ? (at + 1) % MAIN_TABS.length : event.key === "ArrowLeft" ? (at + MAIN_TABS.length - 1) % MAIN_TABS.length
            : event.key === "Home" ? 0 : event.key === "End" ? MAIN_TABS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        setTab(MAIN_TABS[next][0]);
        if (typeof document !== "undefined") document.getElementById(`${tabsId}-${MAIN_TABS[next][0]}`)?.focus();
    };
    // f-03: where this person moved the step boxes, per workflow, kept in their profile settings and saved once at the end of
    // each drag. A workflow is keyed by its session's id: it is the workflow's for good, through every revision, and known
    // before the read model (whose workflowId arrives later and would move the boxes after the first fit).
    const layoutKey = `session:${sessionId}`;
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: layoutKey, steps, at: Date.now() }),
        [controller, layoutKey]);
    // f-06: the graph's view (x, y, zoom) is remembered for this workflow, so tabs, panels and sessions give it back exactly.
    const onGraphView = React.useCallback(graphView => controller.dispatch({ type: "ui/workflowView", sessionId, view: { graphView } }),
        [controller, sessionId]);
    // UI7-2: shown for any notice or a failed read; quiet notices alone have no count and no tint.
    const noticeBadge = workflowV2NoticeBadge(notices, Boolean(readError));
    const openCalls = workflowV2OpenCalls(test);
    const title = definition?.name || session?.title || "Workflow";
    return h("section", { className: "ps-workflow-main", "aria-label": "Workflow session", "data-tab": mainTab },
        // One compact header (of-02): the name on one line (ellipsis; the whole name on hover and to screen readers), the
        // status as its own badge beside it, Graph | YAML (r-1), and the run picker and the icon tools (of-04) after it. At
        // desktop widths it is one row; a narrow screen wraps the tools to a second row.
        h("header", { className: "ps-workflow-main-header" },
            h("strong", { className: "ps-workflow-main-title" }, icon, h("span", { className: "ps-workflow-main-name", title }, title)),
            // Review 19:27Z (D-W13): one word; its detail ("Canceled at once", why it is not certain) is its tooltip.
            h("span", { className: "ps-workflow-status", ...(v2?.status?.detail ? { title: v2.status.detail } : {}) }, status),
            v2 ? h("div", { className: "ps-workflow-main-tabs", role: "tablist", "aria-label": "Workflow view", onKeyDown: onTabKey },
                MAIN_TABS.map(([id, label]) => h("button", { key: id, id: `${tabsId}-${id}`, type: "button", role: "tab", "aria-selected": mainTab === id,
                    "aria-controls": `${tabsId}-${id}-panel`, tabIndex: mainTab === id ? 0 : -1, onClick: () => setTab(id) }, label))) : null,
            h("div", { className: "ps-workflow-main-tools" },
                v2 ? h(WorkflowV2RunPicker, { controller, sessionId, workflowModel, selectedRunId, ownModelLoaded, error: readError }) : null,
                runControls ? h(WorkflowV2RunControls, { controller, sessionId, model: runControls }) : null,
                variables ? panelButton("variables", { label: "Variables", glyph: "variables" }) : null,
                // "Publish…" for a draft, "Start…" for a published workflow without its live run.
                publication?.controls.length ? panelButton("definition", { label: publication.state === "draft" ? "Publish…" : "Start…",
                    glyph: publication.state === "draft" ? "publish" : "start", "data-definition-state": publication.state }) : null,
                testControls ? panelButton("test", { label: "Test…", glyph: "test" }) : null,
                panelButton("log", { label: "Step log", glyph: "log" }),
                activity ? panelButton("activity", { label: "Run activity", glyph: "activity" }) : null,
                noticeBadge.shown ? panelButton("notices", { label: "Notices", glyph: "notices", badge: noticeBadge.count || null, badgeLevel: noticeBadge.level,
                    title: noticeBadge.count ? `${noticeBadge.count} ${noticeBadge.count === 1 ? "notice" : "notices"} about this workflow and its run.`
                        : "Notes about this workflow. None needs your attention now." }) : null,
                test ? panelButton("calls", { label: "Test calls", glyph: "calls", badge: openCalls || null, badgeLevel: openCalls ? "warning" : null,
                    title: openCalls ? `${openCalls} ${openCalls === 1 ? "call waits" : "calls wait"} for an answer.` : "The test run's calls and its virtual clock." }) : null,
                h(WorkflowToolButton, { label: "Step details", glyph: "details", disabled: !selected, "aria-expanded": sideShown && sidePanel === null,
                    onClick: () => selectNode(selected.id, { open: true }) }))),
        h("div", { id: `${tabsId}-graph-panel`, className: "ps-workflow-graph-region", hidden: mainTab !== "graph" || undefined,
            ...(v2 ? { role: "tabpanel", "aria-labelledby": `${tabsId}-graph` } : {}) },
            definition
                ? h(WorkflowGraph, { definition, nodes, selected, select: selectNode, scope: sessionId, viewport: view.graphView ?? null, onViewport: onGraphView,
                    places, onPlaces })
                : v2 ? h(WorkflowV2NoGraph, { projection: v2, drafting })
                : h("div", { className: "ps-workflow-empty", role: view.error ? "alert" : "status" },
                    view.error || "Loading workflow graph…",
                    view.error ? h("button", { type: "button", className: "ps-mini-button",
                        onClick: () => controller.ensureWorkflowDefinition(sessionId, { retry: true }) }, "Retry") : null)),
        // r-2: a draft this person may change is edited here at full height; any other revision is shown read-only.
        mainTab === "yaml" ? h("div", { id: `${tabsId}-yaml-panel`, className: "ps-workflow-yaml-tab", role: "tabpanel", "aria-labelledby": `${tabsId}-yaml` },
            draftEditor
                ? h(WorkflowV2DraftEditor, { key: sessionId, controller, sessionId, model: draftEditor, savedEdit: view.draftEdit ?? null,
                    notice: noticeInYaml ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice: runNotice }) : null,
                    tools: panelButton("draft", { label: "YAML tools", glyph: "tools",
                        title: "Compare saved versions, and change an agent step's inputs without writing YAML." }) })
                : h(WorkflowV2YamlView, { key: sessionId, controller, sessionId, model: definitionModel, reads: view.definitionRevisions ?? null })) : null);
}

/** One side-pane panel (r-3): its title and a way back to Step details, the answer to the last command, then the panel. */
function WorkflowSidePanel({ controller, workflow, log, notice }) {
    const { sessionId, session, view, v2, events, sidePanel: panel, readError, publication, testControls, testResponder, variables, draftEditor,
        definition, activity, notices, test } = workflow;
    const title = panel === "definition" ? (publication.state === "draft" ? "Publish review" : "Start the live run")
        : panel === "variables" && Number.isSafeInteger(variables.revision) ? `Variables · revision ${variables.revision}`
            : WORKFLOW_SIDE_PANEL_TITLES[panel];
    const body = panel === "definition" ? h(WorkflowV2DefinitionPanel, { controller, sessionId, model: publication, versionsNow: view.agentVersions ?? null })
        : panel === "test" ? h(WorkflowV2TestPanel, { controller, sessionId, model: testControls })
        // A test run's held calls, its virtual clock and the answer form for the call being answered.
        : panel === "calls" ? h("div", { className: "ps-workflow-test-calls" },
            h(WorkflowV2TestInterceptions, { test, controller, sessionId,
                responder: testResponder, answering: view.answeringInterceptionId ?? null, history: v2.readModel.run.history ?? null,
                onLoadOlder: restart => controller.loadOlderWorkflowHistory(sessionId, { restart }), parentSessionId: session?.parentSessionId ?? null }),
            testResponder?.advance ? h(WorkflowV2TestClock, { controller, sessionId, responder: testResponder }) : null,
            testResponder?.respond && view.answeringInterceptionId
                ? h(WorkflowV2TestAnswer, { controller, sessionId, responder: testResponder, interceptionId: view.answeringInterceptionId,
                    parentSessionId: session?.parentSessionId ?? null }) : null)
        : panel === "variables" ? h(WorkflowV2Variables, { controller, sessionId, model: variables })
        // The agent steps whose inputs the step-input editor changes (owner decision q6), and what it has read.
        : panel === "draft" ? h(WorkflowV2DraftTools, { controller, sessionId, model: draftEditor, revisionReads: view.definitionRevisions ?? null,
            agentSteps: (definition?.states || []).filter(state => state?.type === "agent").map(state => state.id),
            stepInput: view.stepInput ?? null, stepInputPreview: view.stepInputPreview ?? null, unsaved: Boolean(view.draftDirty) })
        // Why the shown run ended, and who did what in it (owner decision q14; mocks M09, M14).
        : panel === "activity" ? h(WorkflowV2RunActivity, { ending: v2.ending, events, runId: activity })
        : panel === "notices" ? h("div", { className: "ps-workflow-notices" },
            h(WorkflowReadError, { controller, sessionId, message: readError }), h(WorkflowV2Banners, { banners: notices }))
        : log ? h("div", { className: "ps-workflow-log" }, log)
        : h("p", { className: "ps-workflow-empty" }, "The step log is not available here.");
    return h("div", { className: `ps-workflow-side-panel is-${panel}`, "data-panel": panel },
        h("div", { className: "ps-workflow-side-bar" },
            h("h2", null, title),
            h(WorkflowToolButton, { label: "Back to Step details", glyph: "close",
                onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: null } }) })),
        notice,
        h("div", { className: "ps-workflow-side-body" }, body));
}

/**
 * The workflow's side pane (the canvas column; on a phone, the details layer): Step details of the selected step, or the
 * panel the header chose (batch 6, r-3), with the answer to the person's last command above it. `log` is the step log
 * the side pane shows when it is chosen.
 */
export function WorkflowNodePane({ controller, log = null }) {
    const workflow = useWorkflowView(controller);
    const { sessionId, session, view, selected, select, nodes, v2, events, sidePanel, runNotice, noticeInYaml, drafting } = workflow;
    // The session rows loaded: the sessions under an agent step (owner decision q14; mock M14 "View owned subtree").
    const sessionsById = useControllerSelector(controller, state => state.sessions.byId);
    const [tab, setTab] = React.useState("details");
    // The branch a branch step's details show (owner batch 7, H2): kept for that workflow, run, parallel visit and step only
    // (workflowV2BranchPickKey); its default otherwise.
    const [branchPick, setBranchPick] = React.useState(null);
    const tabId = React.useId();
    const notice = runNotice && !noticeInYaml ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice: runNotice }) : null;
    if (sidePanel) return h(WorkflowSidePanel, { controller, workflow, log, notice });
    const details = () => {
        if (!selected && v2) return React.createElement(WorkflowV2NoGraph, { projection: v2, drafting });
        if (!selected) return React.createElement("div", { className: "ps-workflow-empty" },
            view.error || "Select a workflow step to see its details.");
        return React.createElement("section", { className: "ps-workflow-node-details", "aria-label": "Workflow step details" },
            React.createElement("header", null,
                React.createElement("small", null, "SELECTED STEP"),
                React.createElement("h2", null, selected.id),
                React.createElement("p", null, `${selected.label} · ${selected.stateLabel}`)),
            React.createElement("div", { className: "ps-workflow-detail-tabs", role: "tablist", "aria-label": "Step detail views" },
                [["details", "Details"], ["output", "Output"], ["history", "History"]].map(([id, title]) =>
                    React.createElement("button", { key: id, id: `${tabId}-${id}`, role: "tab", type: "button",
                        "aria-selected": tab === id, onClick: () => setTab(id) }, title))),
            React.createElement("div", { className: "ps-workflow-detail-content", role: "tabpanel", "aria-labelledby": `${tabId}-${tab}` },
                React.createElement(WorkflowV2NodeContent, {
                    tab, selected, nodes, select, openSession: sessionId => { controller.loadSession(sessionId).catch(() => {}); },
                    runOutput: v2?.status.terminalState === selected.id ? v2.output : null,
                    runError: v2?.status.terminalState === selected.id ? v2.error : null,
                    // One execution's own result, chosen in History for exactly the shown run and this state.
                    runId: v2?.runId ?? null, selection: view.selectedExecution ?? null, onTab: setTab,
                    // Why the visit ended, its activity and the sessions under an agent step (owner decision q14).
                    events: v2?.bound ? events : null, sessionsById,
                    // Ask the workflow's parent agent about the visit shown (owner decision q16): only for a workflow with a parent.
                    onAskParent: session?.parentSessionId && v2?.bound
                        ? (kind, note, executionId) => controller.askParentAboutStep(sessionId, { stateId: selected.id, executionId, kind, note }) : null,
                    onSelectExecution: (executionId, bound) => controller.selectWorkflowExecution(sessionId,
                        executionId === null ? null : { runId: v2?.runId ?? null, stateId: selected.id, executionId, ...(bound ?? {}) }),
                    // That execution's whole value (read for exactly the shown run), and the run's older history.
                    executionValues: view.executionValues ?? null,
                    onReadWholeValue: executionId => { controller.loadWorkflowExecutionValue(sessionId, { runId: v2?.runId ?? null, executionId }).catch(() => {}); },
                    history: v2?.bound ? v2?.readModel?.run?.history ?? null : null,
                    onLoadOlder: restart => { controller.loadOlderWorkflowHistory(sessionId, { restart }).catch(() => {}); },
                    // A branch step's details show the branch chosen by its picker (owner batch 7, H2).
                    branchIndex: branchPick?.key === workflowV2BranchPickKey(sessionId, v2?.runId ?? null, selected) ? branchPick.index : null,
                    // Re-check UI-RC2-3: another branch ends a result chosen in History for this step, so coming back does not revive it.
                    onBranch: index => {
                        setBranchPick({ key: workflowV2BranchPickKey(sessionId, v2?.runId ?? null, selected), index });
                        if (workflowV2SelectionAfterBranchChange(view.selectedExecution ?? null, selected.id) === null && view.selectedExecution) {
                            controller.selectWorkflowExecution(sessionId, null);
                        }
                    },
                    // The variables the current visit applied and the accepted ones, compared on request (mock M15).
                    kv: v2?.bound && v2?.runId ? {
                        accepted: v2.readModel?.run?.kvRevision ?? null, snapshots: view.kvRevisions ?? null, compare: view.kvCompare ?? null,
                        onCompare: (from, to) => { controller.compareWorkflowKvRevisions(sessionId, { runId: v2.runId, from, to }).catch(() => {}); },
                    } : null,
                })));
    }

    return notice ? h("div", { className: "ps-workflow-side" }, notice, details()) : details();
}
