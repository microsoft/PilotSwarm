/**
 * The live execution view of a workflow session: a canvas page the
 * worker draws once when the run starts (the graph) and then updates with a
 * data tick after every step and at the end. The page renders the state it
 * is sent, so a cold load replays the latest tick and shows the same view.
 *
 * The state is folded from the session's own `workflow.*` events, so every
 * activity computes it the same way and a late or repeated tick is harmless.
 */
import { describeWorkflowWait, type CompiledWorkflow, type WorkflowWaitAt } from "./compiler.js";

export const WORKFLOW_CANVAS_SLOT = 1;
export const WORKFLOW_CANVAS_NAME = "Workflow";
const RECENT_STEPS = 40;
const PREVIEW_CHARS = 400;

export type WorkflowNodeState = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface WorkflowCanvasState {
    status: "running" | "completed" | "failed" | "cancelled";
    name: string | null;
    current: string | null;
    step: number;
    nodes: Record<string, { state: WorkflowNodeState; runs: number; lastOutcome?: string; lastDurationMs?: number }>;
    /** Times each transition was taken, keyed `${from}\u0001${outcome}`. */
    taken: Record<string, number>;
    steps: Array<{ step: number; node: string; outcome?: string; durationMs?: number; tools?: number; failedTools?: number; until?: number; state: WorkflowNodeState }>;
    /** While a wait state is waiting: when it ends, in epoch milliseconds. */
    waitingUntil?: number;
    outcome?: string;
    summary?: string;
    output?: string;
    error?: string;
    reason?: string;
}

interface WorkflowEventLike {
    eventType: string;
    data?: any;
}

function clip(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text || text === "null") return undefined;
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** A clock wait in a few characters, for a graph node: "daily 02:00", "Mon 09:30", "day 1 06:00", "hourly :15". */
export function shortWaitAt(at: WorkflowWaitAt): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${pad(at.hour ?? 0)}:${pad(at.minute)}`;
    if (at.hour === undefined) return `hourly :${pad(at.minute)}`;
    if (at.dayOfWeek !== undefined) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.dayOfWeek]} ${time}`;
    if (at.dayOfMonth !== undefined) return `day ${at.dayOfMonth} ${time}`;
    return `daily ${time}`;
}

/** Fold a workflow session's events, oldest first, into the canvas state. */
export function foldWorkflowCanvasState(events: WorkflowEventLike[], graph?: CompiledWorkflow | null): WorkflowCanvasState {
    const state: WorkflowCanvasState = { status: "running", name: graph?.name ?? null, current: null, step: 0, nodes: {}, taken: {}, steps: [] };
    const node = (id: string) => (state.nodes[id] ??= { state: "idle", runs: 0 });
    for (const id of Object.keys(graph?.states ?? {})) node(id);
    const stepEntry = (step: number, id: string) => {
        let entry = state.steps.find((s) => s.step === step);
        if (!entry) {
            entry = { step, node: id, state: "running" };
            state.steps.push(entry);
        }
        return entry;
    };
    let lastFinished: { node: string; outcome: string } | null = null;
    let waiting: { node: string; step: number } | null = null;
    // The run count: exact from the event's `visit` when the fold sees only
    // a recent window of a long run, else counted here.
    const countRun = (n: { runs: number }, visit: unknown) => {
        n.runs = Number.isInteger(visit) && Number(visit) > 0 ? Math.max(n.runs, Number(visit)) : n.runs + 1;
    };
    const settleWait = (outcomeState: WorkflowNodeState) => {
        if (!waiting) return;
        const n = node(waiting.node);
        if (n.state === "waiting") n.state = outcomeState;
        if (outcomeState === "done") n.lastOutcome = "elapsed";
        const entry = state.steps.find((s) => s.step === waiting!.step);
        if (entry && entry.state === "waiting") {
            entry.state = outcomeState;
            if (outcomeState === "done") entry.outcome = "elapsed";
        }
        waiting = null;
        delete state.waitingUntil;
    };
    for (const event of events) {
        const data = event?.data ?? {};
        switch (event?.eventType) {
            case "workflow.started":
                state.name = data.name ?? state.name;
                for (const n of Array.isArray(data.states) ? data.states : []) if (n?.id) node(String(n.id));
                break;
            case "workflow.state_started":
            case "workflow.state_waiting": {
                const id = String(data.stateId ?? "");
                if (!id) break;
                settleWait("done");
                if (lastFinished) {
                    const key = `${lastFinished.node}\u0001${lastFinished.outcome}`;
                    state.taken[key] = (state.taken[key] ?? 0) + 1;
                    lastFinished = null;
                }
                const n = node(id);
                countRun(n, data.visit);
                state.current = id;
                state.step = Math.max(state.step, Number(data.step) || 0);
                const entry = stepEntry(Number(data.step) || state.step, id);
                if (event.eventType === "workflow.state_waiting") {
                    n.state = "waiting";
                    entry.state = "waiting";
                    const until = Number(data.until);
                    if (Number.isFinite(until)) {
                        entry.until = until;
                        state.waitingUntil = until;
                    }
                    waiting = { node: id, step: entry.step };
                    lastFinished = { node: id, outcome: "elapsed" };
                } else {
                    n.state = "running";
                }
                break;
            }
            case "workflow.state_completed": {
                const id = String(data.stateId ?? "");
                if (!id) break;
                const n = node(id);
                const ok = data.exitCode === 0 || data.resultSource === "reported" || data.resultSource === "stdout";
                n.state = ok ? "done" : "failed";
                n.lastOutcome = data.outcome;
                n.lastDurationMs = data.durationMs;
                const tools = Array.isArray(data.toolCalls) ? data.toolCalls : [];
                Object.assign(stepEntry(Number(data.step) || state.step, id), {
                    outcome: data.outcome,
                    durationMs: data.durationMs,
                    tools: tools.length,
                    failedTools: tools.filter((t: any) => t?.ok === false).length,
                    state: n.state,
                });
                lastFinished = typeof data.outcome === "string" ? { node: id, outcome: data.outcome } : null;
                break;
            }
            case "workflow.state_failed":
            case "workflow.state_cancelled": {
                const id = String(data.stateId ?? "");
                if (!id) break;
                const n = node(id);
                n.state = event.eventType === "workflow.state_failed" ? "failed" : "cancelled";
                Object.assign(stepEntry(Number(data.step) || state.step, id), { state: n.state, durationMs: data.durationMs });
                lastFinished = null;
                break;
            }
            case "workflow.completed":
            case "workflow.failed":
            case "workflow.cancelled": {
                state.status = event.eventType === "workflow.completed" ? "completed"
                    : event.eventType === "workflow.failed" ? "failed" : "cancelled";
                // A wait the run ended during did not finish.
                settleWait(state.status === "completed" ? "done" : "cancelled");
                state.step = Math.max(state.step, Number(data.steps) || 0);
                // A run that reached a terminal state: mark it and the edge into it.
                const reachedTerminal = data.outcome !== undefined && typeof data.stateId === "string";
                if (reachedTerminal) {
                    if (lastFinished) {
                        const key = `${lastFinished.node}\u0001${lastFinished.outcome}`;
                        state.taken[key] = (state.taken[key] ?? 0) + 1;
                    }
                    const terminal = node(data.stateId);
                    terminal.state = state.status === "completed" ? "done" : state.status === "failed" ? "failed" : "cancelled";
                    terminal.runs = 1;
                    state.current = data.stateId;
                }
                if (data.summary) state.summary = String(data.summary);
                lastFinished = null;
                if (data.outcome !== undefined) state.outcome = String(data.outcome);
                const output = clip(data.outputPreview);
                if (output) state.output = output;
                if (data.error) state.error = String(data.error);
                if (data.reason) state.reason = String(data.reason);
                // A node still marked running when the run ended was stopped.
                for (const n of Object.values(state.nodes)) {
                    if (n.state === "running") n.state = state.status === "completed" ? "done" : "cancelled";
                }
                for (const s of state.steps) {
                    if (s.state === "running") s.state = state.status === "completed" ? "done" : "cancelled";
                }
                break;
            }
            default:
                break;
        }
    }
    if (state.steps.length > RECENT_STEPS) state.steps = state.steps.slice(-RECENT_STEPS);
    return state;
}

/** JSON safe to place inside a <script> element. */
function scriptJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

/**
 * The canvas page for one workflow. Self-contained: no network, no storage;
 * every string from the definition reaches the page as text, never markup.
 */
export function buildWorkflowCanvasHtml(workflow: CompiledWorkflow, initial: WorkflowCanvasState): string {
    const graph = {
        name: workflow.name,
        entry: workflow.initial,
        nodes: Object.values(workflow.states).map((n) => n.type === "script"
            ? { id: n.id, type: "script", runtime: n.runtime, next: n.next }
            : n.type === "wait"
                ? { id: n.id, type: "wait", seconds: n.seconds, ...(n.at ? { at: shortWaitAt(n.at) } : {}), schedule: describeWorkflowWait(n), next: n.next }
                : { id: n.id, type: "terminal", outcome: n.outcome, next: {} }),
    };
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow</title>
<style>
  html, body { margin: 0; background: #0f1520; color: #d7dde8; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  body { padding: 14px 16px 24px; box-sizing: border-box; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 10px; }
  h1 { font-size: 15px; margin: 0; font-weight: 700; color: #f2f5fa; }
  .pill { padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; border: 1px solid currentColor; }
  .pill.running { color: #6cb6ff; } .pill.completed { color: #5fd38d; } .pill.failed { color: #ff7b72; } .pill.cancelled { color: #e3b341; }
  .meta { color: #8b96a8; }
  .note { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: #1a2230; white-space: pre-wrap; word-break: break-word; }
  .note.failed { border-left: 3px solid #ff7b72; } .note.cancelled { border-left: 3px solid #e3b341; } .note.completed { border-left: 3px solid #5fd38d; }
  .graph { width: 100%; overflow-x: auto; background: #121a27; border: 1px solid #243042; border-radius: 8px; }
  svg { display: block; margin: 0 auto; }
  .node rect { fill: #1b2433; stroke: #3a4a62; stroke-width: 1.5; }
  .node text { fill: #d7dde8; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .node .sub { fill: #8b96a8; font-size: 10.5px; }
  .node.running rect { stroke: #6cb6ff; stroke-width: 2.5; animation: pulse 1.2s ease-in-out infinite; }
  .node.done rect { stroke: #5fd38d; fill: #15281e; }
  .node.failed rect { stroke: #ff7b72; fill: #2c1719; }
  .node.cancelled rect { stroke: #e3b341; fill: #2a2414; }
  .node.wait rect { stroke-dasharray: 2 4; }
  .node.waiting rect { stroke: #d2a8ff; stroke-width: 2.5; stroke-dasharray: 6 4; fill: #1f1a2c; }
  .node.entry rect { stroke-dasharray: 5 3; }
  .node.done.entry rect, .node.running.entry rect, .node.failed.entry rect, .node.cancelled.entry rect { stroke-dasharray: none; }
  .node.terminal rect { fill: #161d29; stroke: #5c6b82; stroke-dasharray: 3 3; }
  .node.terminal.done rect, .node.terminal.failed rect, .node.terminal.cancelled rect { stroke-dasharray: none; }
  .edge path { fill: none; stroke: #4a5a74; stroke-width: 1.4; }
  .edge text { fill: #8b96a8; font: 10.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; paint-order: stroke; stroke: #121a27; stroke-width: 3px; }
  .edge.taken path { stroke: #5fd38d; stroke-width: 2.2; }
  .edge.taken text { fill: #5fd38d; }
  .runs { fill: #6cb6ff; font-size: 10.5px; }
  @keyframes pulse { 50% { stroke-opacity: 0.35; } }
  h2 { font-size: 12px; margin: 16px 0 6px; color: #8b96a8; text-transform: uppercase; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #1f2a3a; white-space: nowrap; }
  td.out { white-space: normal; }
  th { color: #8b96a8; font-weight: 600; }
  td.state-running { color: #6cb6ff; } td.state-waiting { color: #d2a8ff; } td.state-done { color: #5fd38d; } td.state-failed { color: #ff7b72; } td.state-cancelled { color: #e3b341; }
  .empty { color: #8b96a8; padding: 6px 8px; }
</style>
</head>
<body>
<header>
  <h1 id="name"></h1>
  <span id="status" class="pill"></span>
  <span id="where" class="meta"></span>
</header>
<p id="note" class="note" hidden></p>
<div class="graph"><svg id="graph" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Workflow graph"></svg></div>
<h2>Steps</h2>
<table><thead><tr><th>#</th><th>Node</th><th>Outcome</th><th>Time</th><th>Tools</th></tr></thead><tbody id="steps"></tbody></table>
<script id="graph-data" type="application/json">${scriptJson(graph)}</script>
<script id="initial-state" type="application/json">${scriptJson(initial)}</script>
<script>
(function () {
  var graph = JSON.parse(document.getElementById("graph-data").textContent);
  var SVG = "http://www.w3.org/2000/svg";
  var W = 184, H = 46, GAP_X = 46, GAP_Y = 70, PAD = 30, SIDE = 90;
  var byId = {};
  graph.nodes.forEach(function (n) { byId[n.id] = n; });
  function isTerminal(id) { return byId[id] && byId[id].type === "terminal"; }

  // Script states by breadth-first distance from the initial state;
  // unreachable ones after them; every terminal state on the last row.
  var layer = {}; var order = [graph.entry]; layer[graph.entry] = 0;
  for (var i = 0; i < order.length; i++) {
    var n = byId[order[i]]; if (!n) continue;
    Object.keys(n.next || {}).forEach(function (k) {
      var t = n.next[k];
      if (t && byId[t] && !isTerminal(t) && layer[t] === undefined) { layer[t] = layer[n.id] + 1; order.push(t); }
    });
  }
  var maxLayer = 0;
  graph.nodes.forEach(function (n) { if (!isTerminal(n.id) && layer[n.id] !== undefined && layer[n.id] > maxLayer) maxLayer = layer[n.id]; });
  graph.nodes.forEach(function (n) { if (!isTerminal(n.id) && layer[n.id] === undefined) layer[n.id] = maxLayer + 1; });
  graph.nodes.forEach(function (n) { if (!isTerminal(n.id) && layer[n.id] > maxLayer) maxLayer = layer[n.id]; });
  var lastLayer = maxLayer + 1;
  graph.nodes.forEach(function (n) { if (isTerminal(n.id)) layer[n.id] = lastLayer; });
  var rows = [];
  graph.nodes.forEach(function (n) { (rows[layer[n.id]] = rows[layer[n.id]] || []).push(n.id); });
  var widest = Math.max.apply(null, rows.map(function (r) { return r ? r.length : 0; }).concat([1]));
  // Side lanes: edges that skip rows run down the left, back edges up the right.
  var width = Math.max(360, widest * W + (widest - 1) * GAP_X + PAD * 2 + SIDE * 2);
  var pos = {};
  rows.forEach(function (row, li) {
    if (!row) return;
    var rowWidth = row.length * W + (row.length - 1) * GAP_X;
    var x0 = (width - rowWidth) / 2;
    row.forEach(function (id, j) { pos[id] = { x: x0 + j * (W + GAP_X), y: PAD + li * (H + GAP_Y) }; });
  });
  var height = PAD + lastLayer * (H + GAP_Y) + H + PAD;

  var svg = document.getElementById("graph");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  function el(name, attrs, parent) {
    var e = document.createElementNS(SVG, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  var defs = el("defs", {}, svg);
  [["arrow", "#4a5a74"], ["arrow-taken", "#5fd38d"]].forEach(function (a) {
    var m = el("marker", { id: a[0], viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", fill: a[1] }, m);
  });
  var edgeLayer = el("g", {}, svg), nodeLayer = el("g", {}, svg);
  var edges = [];
  var lanes = 0;
  graph.nodes.forEach(function (n) {
    var outs = Object.keys(n.next || {});
    outs.forEach(function (outcome, k) {
      var target = n.next[outcome];
      var a = pos[n.id], b = pos[target]; if (!a || !b) return;
      var sx = a.x + W / 2 + (k - (outs.length - 1) / 2) * 16, sy = a.y + H;
      var d, lx, ly, anchor = "middle";
      if (layer[target] - layer[n.id] > 1) {
        // Skips a row: around the left side, clear of the states between.
        var lane = PAD + 16 + (lanes++ % 4) * 12;
        var ay0 = a.y + H / 2, by0 = b.y + H / 2;
        d = "M" + a.x + "," + ay0 + " C" + lane + "," + ay0 + " " + lane + "," + ay0 + " " + lane + "," + (ay0 + 30)
          + " L" + lane + "," + (by0 - 30) + " C" + lane + "," + by0 + " " + lane + "," + by0 + " " + (b.x - 2) + "," + by0;
        lx = lane + 4; ly = ay0 + 24; anchor = "start";
      } else if (b.y > a.y) {
        var tx = b.x + W / 2, ty = b.y;
        d = "M" + sx + "," + sy + " C" + sx + "," + (sy + GAP_Y / 2) + " " + tx + "," + (ty - GAP_Y / 2) + " " + tx + "," + ty;
        lx = (sx + tx) / 2; ly = (sy + ty) / 2;
      } else {
        // Back edge or self loop: around the right-hand side.
        var side = Math.max(a.x, b.x) + W + 26 + k * 10;
        var by = b.y + H / 2, ay = a.y + H / 2;
        d = "M" + (a.x + W) + "," + ay + " C" + side + "," + ay + " " + side + "," + by + " " + (b.x + W) + "," + by;
        lx = side - 4; ly = (ay + by) / 2;
      }
      var g = el("g", { "class": "edge" }, edgeLayer);
      el("path", { d: d, "marker-end": "url(#arrow)" }, g);
      var t = el("text", { x: lx, y: ly, "text-anchor": anchor }, g);
      t.textContent = outcome;
      edges.push({ key: n.id + "\\u0001" + outcome, g: g, path: g.firstChild });
    });
  });
  var nodeEls = {};
  graph.nodes.forEach(function (n) {
    var p = pos[n.id];
    var terminal = n.type === "terminal";
    var cls = "node" + (terminal ? " terminal outcome-" + n.outcome : "") + (n.type === "wait" ? " wait" : "") + (n.id === graph.entry ? " entry" : "");
    var g = el("g", { "class": cls, transform: "translate(" + p.x + "," + p.y + ")" }, nodeLayer);
    el("rect", { width: W, height: H, rx: terminal ? H / 2 : 8 }, g);
    var t = el("text", { x: terminal ? 18 : 10, y: 19 }, g); t.textContent = n.id.length > 22 ? n.id.slice(0, 21) + "…" : n.id;
    var label = terminal ? "ends · " + n.outcome : n.type === "wait" ? (n.at ? "wait · " + n.at : "wait · " + secs(n.seconds)) : n.runtime;
    var sub = el("text", { x: terminal ? 18 : 10, y: 36, "class": "sub" }, g); sub.textContent = label;
    var runs = el("text", { x: W - 10, y: 19, "text-anchor": "end", "class": "runs" }, g);
    var title = el("title", {}, g); title.textContent = n.type === "wait" && n.schedule ? n.id + " · " + n.schedule : n.id;
    nodeEls[n.id] = { g: g, sub: sub, runs: runs, base: cls, runtime: label, terminal: terminal };
  });

  function secs(s) {
    if (s % 86400 === 0) return (s / 86400) + " d";
    if (s % 3600 === 0) return (s / 3600) + " h";
    if (s % 60 === 0) return (s / 60) + " min";
    return s + " s";
  }
  function fmt(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
    return Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s";
  }
  function text(id, value) { document.getElementById(id).textContent = value; }
  function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch (e) { return new Date(ms).toISOString().slice(11, 19); }
  }

  function applyData(state) {
    if (!state || typeof state !== "object") return;
    text("name", state.name || graph.name);
    var status = document.getElementById("status");
    status.className = "pill " + (state.status || "running");
    status.textContent = state.status || "running";
    var waitingNow = state.status === "running" && typeof state.waitingUntil === "number";
    text("where", waitingNow
      ? "step " + state.step + " · " + state.current + " waiting until " + clock(state.waitingUntil)
      : state.status === "running" && state.current
        ? "step " + state.step + " · running " + state.current
        : state.step ? state.step + " step" + (state.step === 1 ? "" : "s") : "starting");
    var note = document.getElementById("note");
    var noteText = state.status === "failed" ? (state.error ? "Failed: " + state.error : "Outcome failed" + (state.summary ? " — " + state.summary : ""))
      : state.status === "cancelled" ? (state.reason ? "Stopped: " + state.reason : "Outcome cancelled" + (state.summary ? " — " + state.summary : ""))
      : state.status === "completed" ? "Outcome " + (state.outcome || "?") + (state.summary ? " — " + state.summary : "") + (state.output ? "\\n" + state.output : "")
      : "";
    note.hidden = !noteText;
    note.className = "note " + (state.status || "");
    note.textContent = noteText;
    Object.keys(nodeEls).forEach(function (id) {
      var n = (state.nodes || {})[id] || { state: "idle", runs: 0 };
      var e = nodeEls[id];
      e.g.setAttribute("class", e.base + " " + n.state);
      e.runs.textContent = !e.terminal && n.runs > 1 ? "×" + n.runs : "";
      var sub = e.terminal ? e.runtime : e.runtime + (n.lastOutcome ? " → " + n.lastOutcome : "") + (n.lastDurationMs !== undefined ? " · " + fmt(n.lastDurationMs) : "");
      e.sub.textContent = sub.length > 27 ? sub.slice(0, 26) + "…" : sub;
    });
    edges.forEach(function (e) {
      var taken = (state.taken || {})[e.key] > 0;
      e.g.setAttribute("class", "edge" + (taken ? " taken" : ""));
      e.path.setAttribute("marker-end", taken ? "url(#arrow-taken)" : "url(#arrow)");
    });
    var body = document.getElementById("steps");
    while (body.firstChild) body.removeChild(body.firstChild);
    var steps = (state.steps || []).slice().reverse();
    if (!steps.length) {
      var tr0 = document.createElement("tr"); var td0 = document.createElement("td");
      td0.colSpan = 5; td0.className = "empty"; td0.textContent = "No steps yet.";
      tr0.appendChild(td0); body.appendChild(tr0);
    }
    steps.forEach(function (s) {
      var tr = document.createElement("tr");
      var shown = s.outcome || (s.state === "running" ? "running…" : s.state === "waiting" && s.until ? "waiting until " + clock(s.until) : s.state);
      [String(s.step), s.node, shown, fmt(s.durationMs),
        s.tools ? s.tools + (s.failedTools ? " (" + s.failedTools + " failed)" : "") : ""].forEach(function (v, i) {
        var td = document.createElement("td");
        td.textContent = v;
        if (i === 2) td.className = "state-" + s.state;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  window.applyData = applyData;
  applyData(JSON.parse(document.getElementById("initial-state").textContent));
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (m && m.type === "canvas-data" && m.data) applyData(m.data);
  });
})();
</script>
</body>
</html>
`;
}

// ─── Writing the canvas ─────────────────────────────────────────

/** Draws and updates a workflow session's canvas. */
export interface WorkflowCanvasPublisher {
    draw(sessionId: string, html: string): Promise<void>;
    tick(sessionId: string, state: WorkflowCanvasState): Promise<void>;
}

const CANVAS_DATA_MAX_BYTES = 32_768;

/** Trim the state until it fits one canvas data tick. */
export function fitWorkflowCanvasState(state: WorkflowCanvasState): WorkflowCanvasState {
    let fitted = state;
    while (Buffer.byteLength(JSON.stringify(fitted), "utf8") > CANVAS_DATA_MAX_BYTES && fitted.steps.length > 0) {
        fitted = { ...fitted, steps: fitted.steps.slice(Math.ceil(fitted.steps.length / 2)) };
    }
    if (Buffer.byteLength(JSON.stringify(fitted), "utf8") > CANVAS_DATA_MAX_BYTES) {
        fitted = { ...fitted, output: undefined, error: fitted.error?.slice(0, 400) };
    }
    return fitted;
}

async function latestCanvasDataRev(catalog: any, sessionId: string, slot: number): Promise<number> {
    const rows = await catalog.getSessionEventsBefore(sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_data"]);
    let latest = 0;
    for (const row of rows || []) {
        if ((Number(row?.data?.slot) || 1) !== slot) continue;
        const rev = Number(row?.data?.dataRev);
        if (Number.isInteger(rev) && rev > latest) latest = rev;
    }
    return latest;
}

/**
 * The same writes the agent's draw_canvas and update_canvas tools make
 * (artifact, `session.canvas_updated`, the canvas cache and live plane;
 * `session.canvas_data` for a tick), done by the worker for a workflow.
 */
export function createWorkflowCanvasPublisher(opts: {
    catalog: any;
    artifactStore: { uploadArtifact(sessionId: string, filename: string, content: string, contentType?: string, opts?: any): Promise<unknown> } | null;
    workerNodeId?: string;
}): WorkflowCanvasPublisher | null {
    const { catalog, artifactStore } = opts;
    if (!catalog || !artifactStore) return null;
    const slot = WORKFLOW_CANVAS_SLOT;
    return {
        async draw(sessionId, html) {
            const { canvasArtifactFilename, latestCanvasRev } = await import("../canvas-support.js");
            const seedRev = await latestCanvasRev(catalog, sessionId, slot);
            const rev = typeof catalog.mintCanvasRev === "function"
                ? await catalog.mintCanvasRev(sessionId, slot, seedRev)
                : seedRev + 1;
            await artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(slot), html, "text/html", { pinned: true });
            const sizeBytes = Buffer.byteLength(html, "utf8");
            await catalog.recordEvents(sessionId, [{
                eventType: "session.canvas_updated",
                data: { rev, slot, name: WORKFLOW_CANVAS_NAME, sizeBytes, note: "Workflow execution", workspace: null },
            }], opts.workerNodeId);
            try { await catalog.upsertSessionCanvas?.(sessionId, slot, WORKFLOW_CANVAS_NAME, rev, sizeBytes); } catch { /* self-heals */ }
            try { await catalog.setCanvasKvManifest?.(sessionId, slot, null); } catch { /* no KV for this page */ }
            try {
                if (await catalog.canvasLiveAvailable?.()) {
                    const { createHash } = await import("node:crypto");
                    const sha = createHash("sha256").update(html, "utf8").digest("hex");
                    await catalog.upsertCanvasLiveDoc?.(sessionId, slot, { rev, sha }, sessionId);
                }
            } catch { /* live viewers resync from events */ }
        },
        async tick(sessionId, state) {
            const payload = fitWorkflowCanvasState(state) as unknown as Record<string, unknown>;
            try {
                if (await catalog.canvasLiveAvailable?.()) {
                    await catalog.upsertCanvasLiveTick?.(sessionId, slot, { data: payload }, sessionId, CANVAS_DATA_MAX_BYTES);
                }
            } catch { /* the event below is the durable copy */ }
            const dataRev = (await latestCanvasDataRev(catalog, sessionId, slot)) + 1;
            await catalog.recordEvents(sessionId, [{
                eventType: "session.canvas_data",
                data: { dataRev, slot, sizeBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"), payload },
            }], opts.workerNodeId);
        },
    };
}
