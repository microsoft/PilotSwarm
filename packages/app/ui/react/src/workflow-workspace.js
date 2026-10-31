import React from "react";
import { useControllerSelector } from "./use-controller-state.js";
import { layoutWorkflowGraph, workflowNodeViews } from "../../core/src/workflow-view.js";

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
    React.useEffect(() => {
        controller.ensureWorkflowDefinition(sessionId);
    }, [controller, sessionId, events]);
    const nodes = React.useMemo(() => workflowNodeViews(view.definition, events, live), [view.definition, events, live]);
    const selected = nodes.find(node => node.id === view.selectedNodeId)
        || nodes.find(node => node.id === live?.current)
        || nodes.find(node => node.id === view.definition?.initial)
        || nodes[0];
    const select = nodeId => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: nodeId } });
        controller.dispatch({ type: "ui/sidePaneTab", tab: "canvas" });
        controller.dispatch({ type: "canvas/flip", sessionId, slot: 1 });
    };
    return { sessionId, session, view, nodes, selected, select, live };
}

function Duration({ ms }) {
    return typeof ms === "number" && Number.isFinite(ms)
        ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
        : "Not recorded";
}

function WorkflowGraph({ definition, nodes, selected, select }) {
    const hostRef = React.useRef(null);
    const [width, setWidth] = React.useState(640);
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
    return React.createElement("div", { ref: hostRef, className: "ps-workflow-graph-scroll" },
        React.createElement("svg", {
            className: "ps-workflow-graph", viewBox: `0 0 ${layout.width} ${layout.height}`,
            width: layout.width, height: layout.height, role: "group", "aria-label": "Workflow graph",
        },
        React.createElement("defs", null,
            React.createElement("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" },
                React.createElement("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }))),
        layout.edges.map(edge => React.createElement("g", { key: `${edge.from}:${edge.outcome}`, className: "ps-workflow-edge" },
            React.createElement("path", { d: edge.path, markerEnd: `url(#${markerId})` }),
            React.createElement("text", { x: edge.labelX, y: edge.labelY, textAnchor: "middle" },
                edge.outcome.length > 20 ? `${edge.outcome.slice(0, 19)}…` : edge.outcome,
                React.createElement("title", null, edge.outcome)))),
        nodes.map(node => {
            const box = layout.positions.get(node.id);
            return React.createElement("g", {
                key: node.id, className: `ps-workflow-node is-${node.state}${node.id === selected?.id ? " is-selected" : ""}`,
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
                node.type === "terminal" ? `ends · ${node.outcome || "terminal"}` : `${node.runtime || "script"} · ${node.outcome || node.state}`),
            React.createElement("text", { x: box.width - 12, y: 57, textAnchor: "end", className: "ps-workflow-node-meta" },
                node.runs ? `×${node.runs}${node.partial ? " loaded" : ""}` : ""),
            React.createElement("title", null, node.id));
        })));
}

export function WorkflowMainPane({ controller, log, icon }) {
    const { sessionId, session, view, nodes, selected, select, live } = useWorkflowView(controller);
    const splitRef = React.useRef(null);
    const dragRef = React.useRef(false);
    const height = view.logHeight || 210;
    const resizeLog = next => {
        const max = Math.max(100, (splitRef.current?.clientHeight || 500) - 170);
        controller.dispatch({ type: "ui/workflowView", sessionId,
            view: { logHeight: Math.max(100, Math.min(max, next)) } });
    };
    return React.createElement("section", { className: "ps-workflow-main", "aria-label": "Workflow session" },
        React.createElement("header", { className: "ps-workflow-main-header" },
            React.createElement("strong", null, icon, view.definition?.name || session?.title || "Workflow"),
            React.createElement("span", { className: "ps-workflow-status" }, live?.status || session?.status || "Starting"),
            React.createElement("button", { type: "button", className: "ps-mini-button", disabled: !selected,
                onClick: () => select(selected.id) }, "Node details")),
        React.createElement("div", { ref: splitRef, className: "ps-workflow-split",
            style: { gridTemplateRows: `minmax(150px, 1fr) 12px minmax(100px, min(${height}px, 60%))` } },
            React.createElement("div", { className: "ps-workflow-graph-region" },
                view.definition
                    ? React.createElement(WorkflowGraph, { definition: view.definition, nodes, selected, select })
                    : React.createElement("div", { className: "ps-workflow-empty", role: view.error ? "alert" : "status" },
                        view.error || "Loading workflow graph…",
                        view.error ? React.createElement("button", { type: "button", className: "ps-mini-button",
                            onClick: () => controller.ensureWorkflowDefinition(sessionId, { retry: true }) }, "Retry") : null)),
            React.createElement("div", {
                className: "ps-workflow-log-resizer", role: "separator", tabIndex: 0,
                "aria-label": "Resize execution log", "aria-orientation": "horizontal",
                "aria-valuemin": 100, "aria-valuemax": Math.max(100, (splitRef.current?.clientHeight || 500) - 170),
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
        React.createElement("div", { className: "ps-chat-composer is-workflow" },
            React.createElement("div", { className: "ps-composer-readonly" }, "Workflow session")));
}

export function WorkflowNodePane({ controller }) {
    const { view, selected, select, nodes } = useWorkflowView(controller);
    const [tab, setTab] = React.useState("details");
    const tabId = React.useId();
    if (!selected) return React.createElement("div", { className: "ps-workflow-empty" },
        view.error || "Select a workflow node to inspect it.");
    const property = (label, value) => React.createElement("div", { className: "ps-workflow-property", key: label },
        React.createElement("span", null, label), React.createElement("strong", null, value));
    const result = selected.result;
    return React.createElement("section", { className: "ps-workflow-node-details", "aria-label": "Workflow node details" },
        React.createElement("header", null,
            React.createElement("small", null, "SELECTED NODE"),
            React.createElement("h2", null, selected.id),
            React.createElement("p", null, selected.type === "script" ? `${selected.runtime || "Script"} · ${selected.state}` : `Terminal · ${selected.state}`)),
        React.createElement("div", { className: "ps-workflow-detail-tabs", role: "tablist", "aria-label": "Node detail views" },
            [["details", "Details"], ["output", "Output"], ["history", "History"]].map(([id, title]) =>
                React.createElement("button", { key: id, id: `${tabId}-${id}`, role: "tab", type: "button",
                    "aria-selected": tab === id, onClick: () => setTab(id) }, title))),
        React.createElement("div", { className: "ps-workflow-detail-content", role: "tabpanel", "aria-labelledby": `${tabId}-${tab}` },
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
                selected.type === "terminal" ? React.createElement("p", null, result?.summary || "The workflow ends at this node.") : null,
                React.createElement("h3", null, "Latest tools"),
                Array.isArray(result?.toolCalls) && result.toolCalls.length
                    ? result.toolCalls.map((tool, i) => React.createElement("div", { className: "ps-workflow-tool", key: i },
                        `${tool.name || "Tool"} · ${tool.ok === false ? "failed" : "completed"}`))
                    : React.createElement("p", null, "No tool details in the loaded history."))
                : tab === "output"
                    ? React.createElement(React.Fragment, null,
                        React.createElement("p", null, "Latest recorded result for this node."),
                        React.createElement("pre", null, result
                            ? String(result.error || result.reason || result.outputPreview || result.summary || "No output was recorded.")
                            : "This node has no result in the loaded history."))
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
