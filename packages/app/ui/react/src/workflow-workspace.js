import React from "react";
import { useControllerSelector } from "./use-controller-state.js";
import { layoutWorkflowGraph, workflowLogBounds, workflowNodeViews, workflowReadModelView } from "../../core/src/workflow-view.js";
import { projectWorkflowV2 } from "../../core/src/workflow-v2-view.js";
import {
    workflowV2DefinitionControls, workflowV2DraftEditor, workflowV2RunCommandNotice, workflowV2RunControls, workflowV2RunVariables,
    workflowV2TestControls, workflowV2TestResponder,
} from "../../core/src/workflow-v2-commands.js";
import {
    WorkflowV2Banners, WorkflowV2DefinitionPanel, WorkflowV2DefinitionToggle, WorkflowV2DraftEditor, WorkflowV2DraftToggle, WorkflowV2NoGraph,
    WorkflowV2NodeContent, WorkflowV2RunCommandNotice, WorkflowV2RunControls, WorkflowV2RunPicker, WorkflowV2TestAnswer, WorkflowV2TestClock,
    WorkflowV2TestInterceptions, WorkflowV2TestPanel, WorkflowV2TestToggle, WorkflowV2Variables, WorkflowV2VariablesToggle,
} from "./workflow-v2-panels.js";

const EMPTY_EVENTS = [];
const EMPTY_VIEW = {};

function useWorkflowView(controller) {
    const sessionId = useControllerSelector(controller, state => state.sessions.activeSessionId);
    const session = useControllerSelector(controller, state => state.sessions.byId[sessionId]);
    const history = useControllerSelector(controller, state => state.history.bySessionId.get(sessionId));
    const canvas = useControllerSelector(controller, state => state.canvas.bySessionId[sessionId]);
    const view = useControllerSelector(controller, state => state.ui.workflowViews?.[sessionId]) || EMPTY_VIEW;
    const events = history?.events || EMPTY_EVENTS;
    const live = canvas?.dataPayload;
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
    const v2 = React.useMemo(() => {
        if (view.definition?.shape !== "v2" && !readModel && !workflowModel) return null;
        const projected = projectWorkflowV2({ definition: view.definition, readModel, workflowModel, selectedRunId, events, readModelAfterSeq, olderHistory });
        // Only a legacy definition falls back to the legacy view. A v2 definition is never redrawn once the
        // read model says there is no graph (invalid or unavailable); the no-graph panel explains why.
        return !projected.definition && view.definition && view.definition.shape !== "v2" ? null : projected;
    }, [view.definition, readModel, workflowModel, selectedRunId, readModelAfterSeq, events, olderHistory]);
    const definition = v2 ? v2.definition : view.definition;
    const legacyNodes = React.useMemo(() => v2 ? [] : workflowNodeViews(view.definition, events, live), [v2, view.definition, events, live]);
    const nodes = v2 ? v2.nodes : legacyNodes;
    const selected = nodes.find(node => node.id === view.selectedNodeId)
        || (v2 ? nodes.find(node => node.pending) : nodes.find(node => node.id === live?.current))
        || nodes.find(node => node.id === definition?.initial)
        || nodes[0];
    const terminal = events.findLast(event => ["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(event?.eventType));
    const status = v2 ? v2.status.label : terminal?.eventType.slice("workflow.".length)
        || (["completed", "failed", "cancelled"].includes(session?.status) ? session.status : live?.status || session?.status || "Starting");
    const select = nodeId => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: nodeId } });
        controller.dispatch({ type: "ui/sidePaneTab", tab: "canvas" });
        controller.dispatch({ type: "canvas/flip", sessionId, slot: 1 });
    };
    // A person's run controls (INACTIVE): only the selection's own read model can offer them, for the run it shows, and only
    // when it says which commands the workflow takes from people.
    const runCommand = view.runCommand ?? null;
    const runControls = React.useMemo(() => v2 ? workflowV2RunControls(readModel, runCommand) : null, [v2, readModel, runCommand]);
    const variables = React.useMemo(() => v2 ? workflowV2RunVariables(readModel, runCommand) : null, [v2, readModel, runCommand]);
    // The definition is the workflow's, whichever run is selected: the last read model of any selection says it.
    const publication = React.useMemo(() => v2 ? workflowV2DefinitionControls(readModel ?? workflowModel, runCommand) : null,
        [v2, readModel, workflowModel, runCommand]);
    const draftEditor = React.useMemo(() => v2 ? workflowV2DraftEditor(readModel ?? workflowModel, runCommand) : null,
        [v2, readModel, workflowModel, runCommand]);
    const testControls = React.useMemo(() => v2 ? workflowV2TestControls(readModel ?? workflowModel, runCommand) : null,
        [v2, readModel, workflowModel, runCommand]);
    // The shown test run's answers and clock: only the selection's own read model says which run that is.
    const testResponder = React.useMemo(() => v2 ? workflowV2TestResponder(readModel, runCommand) : null, [v2, readModel, runCommand]);
    const runNotice = workflowV2RunCommandNotice(runCommand);
    return { sessionId, session, view, nodes, selected, select, live, status, v2, definition, readError,
        workflowModel, selectedRunId, ownModelLoaded: readModel != null, runControls, variables, publication, draftEditor, testControls, testResponder,
        runNotice };
}

/** The read model's last failure for the selected run, beside the graph, with a Retry that asks again now. */
function WorkflowReadError({ controller, sessionId, message }) {
    if (!message) return null;
    return React.createElement("div", { className: "ps-workflow-read-error", role: "alert",
        style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "0.8rem", color: "var(--ps-danger)",
            borderBottom: "1px solid var(--ps-border)", overflowWrap: "anywhere" } },
    React.createElement("span", { style: { flex: 1, minWidth: 0 } }, `The workflow's current state could not be read: ${message}`),
    React.createElement("button", { type: "button", className: "ps-mini-button",
        onClick: () => controller.ensureWorkflowReadModel(sessionId, { force: true }) }, "Retry"));
}

function Duration({ ms }) {
    return typeof ms === "number" && Number.isFinite(ms)
        ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
        : "Not recorded";
}

function WorkflowGraph({ definition, nodes, selected, select, banners }) {
    const hostRef = React.useRef(null);
    const [width, setWidth] = React.useState(640);
    const [zoomMode, setZoomMode] = React.useState("fit");
    const markerId = `wf-arrow-${React.useId().replace(/:/g, "")}`;
    React.useEffect(() => {
        const host = hostRef.current;
        const resize = () => setWidth(Math.max(300, host.clientWidth - 16));
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(host);
        return () => observer.disconnect();
    }, []);
    const layout = React.useMemo(() => layoutWorkflowGraph(definition, width), [definition, width]);
    const zoom = zoomMode === "fit" ? Math.min(1, width / layout.width) : 1;
    return React.createElement("div", { className: "ps-workflow-graph-view" },
        React.createElement(WorkflowV2Banners, { banners }),
        React.createElement("div", { className: "ps-workflow-graph-tools" },
            React.createElement("span", null, "Full graph · scroll to explore"),
            React.createElement("button", { type: "button", className: "ps-mini-button", "aria-pressed": zoomMode === "fit",
                onClick: () => setZoomMode("fit") }, "Fit"),
            React.createElement("button", { type: "button", className: "ps-mini-button", "aria-pressed": zoomMode === "actual",
                onClick: () => setZoomMode("actual") }, "100%")),
        React.createElement("div", { ref: hostRef, className: "ps-workflow-graph-scroll", tabIndex: 0,
            role: "region", "aria-label": "Scrollable workflow graph" },
        React.createElement("svg", {
            className: "ps-workflow-graph", viewBox: `0 0 ${layout.width} ${layout.height}`,
            width: layout.width * zoom, height: layout.height * zoom, role: "group", "aria-label": "Workflow graph",
        },
        React.createElement("defs", null,
            React.createElement("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" },
                React.createElement("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }))),
        layout.edges.map(edge => React.createElement("g", { key: `${edge.from}:${edge.to}`, className: "ps-workflow-edge",
            "data-from": edge.from, "data-to": edge.to, "data-kind": edge.kind,
            "aria-label": `${edge.from}: ${edge.outcome} → ${edge.to}${edge.kind === "error" ? " (runtime error route)" : ""}` },
            React.createElement("path", { d: edge.path, markerEnd: `url(#${markerId})`,
                strokeDasharray: edge.kind === "error" ? "5 4" : undefined }),
            React.createElement("text", { x: edge.labelX, y: edge.labelY, textAnchor: "middle" },
                edge.outcome.length > 20 ? `${edge.outcome.slice(0, 19)}…` : edge.outcome,
                React.createElement("title", null, edge.outcome)))),
        nodes.map(node => {
            const box = layout.positions.get(node.id);
            return React.createElement("g", {
                key: node.id, className: `ps-workflow-node is-${node.state}${node.id === selected?.id ? " is-selected" : ""}`,
                "data-phase": node.phase,
                transform: `translate(${box.x},${box.y})`, role: "button", tabIndex: 0,
                "data-node-id": node.id, "aria-label": `Inspect ${node.id}`, "aria-pressed": node.id === selected?.id,
                onClick: () => select(node.id),
                onKeyDown: event => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node.id); }
                },
            },
            React.createElement("rect", { width: box.width, height: box.height, rx: node.type === "terminal" ? 30 : 8 }),
            React.createElement("text", { x: 14, y: 23, className: "ps-workflow-node-name" },
                node.id.length > 23 ? `${node.id.slice(0, 22)}…` : node.id),
            React.createElement("text", { x: 14, y: 43, className: "ps-workflow-node-meta" },
                node.shape === "v2" ? node.label.slice(0, 30) : node.type === "terminal" ? `ends · ${node.outcome || "terminal"}` : `${node.runtime || "script"} · ${node.outcome || node.state}`),
            node.shape === "v2" ? React.createElement("text", { x: 14, y: 58, className: "ps-workflow-node-meta" },
                node.stateLabel.length > 24 ? `${node.stateLabel.slice(0, 23)}…` : node.stateLabel) : null,
            React.createElement("text", { x: box.width - 12, y: node.shape === "v2" ? 58 : 57, textAnchor: "end", className: "ps-workflow-node-meta" },
                node.runs ? `×${node.runs}${node.partial ? " loaded" : ""}` : ""),
            React.createElement("title", null, node.shape === "v2" ? `${node.id} · ${node.label} · ${node.stateLabel}` : node.id));
        }))));
}

export function WorkflowMainPane({ controller, log, icon, showFooter = true, onNodeSelected }) {
    const { sessionId, session, view, nodes, selected, select, status, v2, definition, readError, workflowModel, selectedRunId, ownModelLoaded,
        runControls, variables, publication, draftEditor, testControls, testResponder, runNotice } = useWorkflowView(controller);
    const variablesId = `wf-vars-${React.useId().replace(/:/g, "")}`;
    const variablesOpen = Boolean(variables && view.variablesOpen);
    const publicationId = `wf-publish-${React.useId().replace(/:/g, "")}`;
    const publicationOpen = Boolean(publication?.controls.length && view.definitionOpen);
    const draftId = `wf-draft-${React.useId().replace(/:/g, "")}`;
    const draftOpen = Boolean(draftEditor && view.draftOpen);
    const testId = `wf-test-${React.useId().replace(/:/g, "")}`;
    const testOpen = Boolean(testControls && view.testOpen);
    const splitRef = React.useRef(null);
    const dragRef = React.useRef(false);
    const [splitHeight, setSplitHeight] = React.useState(500);
    React.useEffect(() => {
        const element = splitRef.current;
        const observer = new ResizeObserver(() => setSplitHeight(element.clientHeight));
        observer.observe(element);
        setSplitHeight(element.clientHeight);
        return () => observer.disconnect();
    }, []);
    const { min, max, height } = workflowLogBounds(splitHeight, view.logHeight ?? 210);
    const resizeLog = next => {
        controller.dispatch({ type: "ui/workflowView", sessionId,
            view: { logHeight: workflowLogBounds(splitRef.current?.clientHeight || splitHeight, next).height } });
    };
    const selectNode = id => {
        select(id);
        onNodeSelected?.();
    };
    return React.createElement("section", { className: "ps-workflow-main", "aria-label": "Workflow session" },
        React.createElement("header", { className: "ps-workflow-main-header", style: { flexWrap: "wrap" } },
            React.createElement("strong", null, icon, definition?.name || session?.title || "Workflow"),
            React.createElement("span", { className: "ps-workflow-status" }, status),
            v2 ? React.createElement(WorkflowV2RunPicker, { controller, sessionId, workflowModel, selectedRunId, ownModelLoaded, error: readError }) : null,
            runControls ? React.createElement(WorkflowV2RunControls, { controller, sessionId, model: runControls }) : null,
            variables ? React.createElement(WorkflowV2VariablesToggle, { controller, sessionId, open: variablesOpen, controls: variablesId }) : null,
            React.createElement(WorkflowV2DraftToggle, { controller, sessionId, model: draftEditor, open: draftOpen, controls: draftId }),
            React.createElement(WorkflowV2DefinitionToggle, { controller, sessionId, model: publication, open: publicationOpen, controls: publicationId }),
            React.createElement(WorkflowV2TestToggle, { controller, sessionId, model: testControls, open: testOpen, controls: testId }),
            React.createElement("button", { type: "button", className: "ps-mini-button", disabled: !selected,
                onClick: () => selectNode(selected.id) }, "Node details")),
        React.createElement(WorkflowReadError, { controller, sessionId, message: readError }),
        React.createElement(WorkflowV2RunCommandNotice, { controller, sessionId, notice: runNotice }),
        draftOpen ? React.createElement(WorkflowV2DraftEditor, { controller, sessionId, model: draftEditor, id: draftId }) : null,
        publicationOpen ? React.createElement(WorkflowV2DefinitionPanel, { controller, sessionId, model: publication, id: publicationId }) : null,
        testOpen ? React.createElement(WorkflowV2TestPanel, { controller, sessionId, model: testControls, id: testId }) : null,
        variablesOpen ? React.createElement(WorkflowV2Variables, { controller, sessionId, model: variables, id: variablesId }) : null,
        v2?.readModel?.run?.test ? React.createElement(WorkflowV2TestInterceptions, { test: v2.readModel.run.test, controller, sessionId,
            responder: testResponder, answering: view.answeringInterceptionId ?? null, history: v2.readModel.run.history ?? null,
            onLoadOlder: restart => controller.loadOlderWorkflowHistory(sessionId, { restart }) }) : null,
        testResponder?.advance ? React.createElement(WorkflowV2TestClock, { controller, sessionId, responder: testResponder }) : null,
        testResponder?.respond && view.answeringInterceptionId
            ? React.createElement(WorkflowV2TestAnswer, { controller, sessionId, responder: testResponder, interceptionId: view.answeringInterceptionId }) : null,
        React.createElement("div", { ref: splitRef, className: "ps-workflow-split",
            style: { gridTemplateRows: `minmax(150px, 1fr) 12px ${height}px` } },
            React.createElement("div", { className: "ps-workflow-graph-region" },
                definition
                    ? React.createElement(WorkflowGraph, { definition, nodes, selected, select: selectNode, banners: v2?.banners })
                    : v2 ? React.createElement(WorkflowV2NoGraph, { projection: v2 })
                    : React.createElement("div", { className: "ps-workflow-empty", role: view.error ? "alert" : "status" },
                        view.error || "Loading workflow graph…",
                        view.error ? React.createElement("button", { type: "button", className: "ps-mini-button",
                            onClick: () => controller.ensureWorkflowDefinition(sessionId, { retry: true }) }, "Retry") : null)),
            React.createElement("div", {
                className: "ps-workflow-log-resizer", role: "separator", tabIndex: 0,
                "aria-label": "Resize execution log", "aria-orientation": "horizontal",
                "aria-valuemin": min, "aria-valuemax": max,
                "aria-valuenow": height,
                onPointerDown: event => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = true;
                },
                onPointerMove: event => {
                    if (dragRef.current) resizeLog(splitRef.current.getBoundingClientRect().bottom - event.clientY - 6);
                },
                onPointerUp: () => { dragRef.current = false; },
                onPointerCancel: () => { dragRef.current = false; },
                onLostPointerCapture: () => { dragRef.current = false; },
                onDoubleClick: () => resizeLog(210),
                onKeyDown: event => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault(); resizeLog(height + (event.key === "ArrowUp" ? 24 : -24));
                    }
                },
            }, React.createElement("span", { "aria-hidden": true })),
            React.createElement("div", { className: "ps-workflow-log" }, log)),
        showFooter ? React.createElement("div", { className: "ps-chat-composer is-workflow" },
            React.createElement("div", { className: "ps-composer-readonly" }, "Workflow session")) : null);
}

export function WorkflowNodePane({ controller }) {
    const { sessionId, view, selected, select, nodes, v2 } = useWorkflowView(controller);
    const [tab, setTab] = React.useState("details");
    const tabId = React.useId();
    if (!selected && v2) return React.createElement(WorkflowV2NoGraph, { projection: v2 });
    if (!selected) return React.createElement("div", { className: "ps-workflow-empty" },
        view.error || "Select a workflow node to inspect it.");
    const property = (label, value) => React.createElement("div", { className: "ps-workflow-property", key: label },
        React.createElement("span", null, label), React.createElement("strong", null, value));
    const result = selected.result;
    return React.createElement("section", { className: "ps-workflow-node-details", "aria-label": "Workflow node details" },
        React.createElement("header", null,
            React.createElement("small", null, "SELECTED NODE"),
            React.createElement("h2", null, selected.id),
            React.createElement("p", null, selected.shape === "v2" ? `${selected.label} · ${selected.stateLabel}`
                : selected.type === "script" ? `${selected.runtime || "Script"} · ${selected.state}` : `Terminal · ${selected.state}`)),
        React.createElement("div", { className: "ps-workflow-detail-tabs", role: "tablist", "aria-label": "Node detail views" },
            [["details", "Details"], ["output", "Output"], ["history", "History"]].map(([id, title]) =>
                React.createElement("button", { key: id, id: `${tabId}-${id}`, role: "tab", type: "button",
                    "aria-selected": tab === id, onClick: () => setTab(id) }, title))),
        React.createElement("div", { className: "ps-workflow-detail-content", role: "tabpanel", "aria-labelledby": `${tabId}-${tab}` },
            selected.shape === "v2" ? React.createElement(WorkflowV2NodeContent, {
                tab, selected, nodes, select, openSession: sessionId => { controller.loadSession(sessionId).catch(() => {}); },
                runOutput: v2?.status.terminalState === selected.id ? v2.output : null,
                runError: v2?.status.terminalState === selected.id ? v2.error : null,
                // One execution's own result, chosen in History for exactly the shown run and this state.
                runId: v2?.runId ?? null, selection: view.selectedExecution ?? null, onTab: setTab,
                onSelectExecution: executionId => controller.selectWorkflowExecution(sessionId,
                    executionId === null ? null : { runId: v2?.runId ?? null, stateId: selected.id, executionId }),
                // That execution's whole value (read for exactly the shown run), and the run's older history.
                executionValues: view.executionValues ?? null,
                onReadWholeValue: executionId => { controller.loadWorkflowExecutionValue(sessionId, { runId: v2?.runId ?? null, executionId }).catch(() => {}); },
                history: v2?.bound ? v2?.readModel?.run?.history ?? null : null,
                onLoadOlder: restart => { controller.loadOlderWorkflowHistory(sessionId, { restart }).catch(() => {}); },
            }) :
            tab === "details" ? React.createElement(React.Fragment, null,
                property("Executions", `${selected.runs}${selected.partial ? " in loaded history" : ""}`),
                property("Last outcome", selected.outcome || "Not recorded"),
                property("Duration", React.createElement(Duration, { ms: selected.durationMs })),
                selected.timeoutSeconds ? property("Timeout", `${selected.timeoutSeconds}s`) : null,
                React.createElement("h3", null, "Transitions"),
                Object.entries(selected.next || {}).map(([outcome, target]) =>
                    React.createElement("button", { key: outcome, type: "button", className: "ps-workflow-transition",
                        disabled: !nodes.some(node => node.id === target), onClick: () => select(target) },
                    outcome, " → ", target)),
                selected.type === "terminal" ? React.createElement("p", null, String(result?.summary || "The workflow ends at this node.")) : null,
                React.createElement("h3", null, "Latest tools"),
                Array.isArray(result?.toolCalls) && result.toolCalls.length
                    ? result.toolCalls.map((tool, i) => React.createElement("div", { className: "ps-workflow-tool", key: i },
                        `${tool?.name || "Tool"} · ${tool?.ok === false ? "failed" : "completed"}`))
                    : React.createElement("p", null, "No tool details in the loaded history."))
                : tab === "output"
                    ? React.createElement(React.Fragment, null,
                        React.createElement("p", null, "Latest result in the loaded history for this node."),
                        React.createElement("pre", null, result
                            ? String(result.error || result.reason || result.outputPreview || result.summary || "No output was recorded.")
                            : "This node has no result in the loaded history."),
                        result?.stderrTail ? React.createElement(React.Fragment, null,
                            React.createElement("h3", null, "Standard error"),
                            React.createElement("pre", null, String(result.stderrTail))) : null)
                    : React.createElement(React.Fragment, null,
                        React.createElement("p", null, "Most recent executions available in the loaded history."),
                        selected.history.length ? React.createElement("table", null,
                            React.createElement("thead", null, React.createElement("tr", null,
                                ["Step", "Outcome", "Duration"].map(label => React.createElement("th", { key: label }, label)))),
                            React.createElement("tbody", null, selected.history.map((event, i) => React.createElement("tr", { key: event.seq || i },
                                React.createElement("td", null, event.data.step ?? event.data.steps ?? "—"),
                                React.createElement("td", null, event.data.outcome || event.eventType.split(".").at(-1)),
                                React.createElement("td", null, React.createElement(Duration, { ms: event.data.durationMs }))))))
                            : React.createElement("p", null, "No executions in the loaded history."))));
}
