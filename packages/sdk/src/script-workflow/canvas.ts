/**
 * The live execution view of a script workflow session: a canvas page the
 * worker draws once when the run starts (the graph) and then updates with a
 * data tick after every step and at the end. The page renders the state it
 * is sent, so a cold load replays the latest tick and shows the same view.
 *
 * The state is folded from the session's own `workflow.*` events, so every
 * activity computes it the same way and a late or repeated tick is harmless.
 */
import type { CompiledScriptWorkflow } from "./compiler.js";

export const WORKFLOW_CANVAS_SLOT = 1;
export const WORKFLOW_CANVAS_NAME = "Workflow";
const RECENT_STEPS = 40;
const PREVIEW_CHARS = 400;

export type WorkflowNodeState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface WorkflowCanvasState {
    status: "running" | "completed" | "failed" | "cancelled";
    name: string | null;
    current: string | null;
    step: number;
    nodes: Record<string, { state: WorkflowNodeState; runs: number; lastOutcome?: string; lastDurationMs?: number }>;
    /** Times each transition was taken, keyed `${from}\u0001${outcome}`. */
    taken: Record<string, number>;
    steps: Array<{ step: number; node: string; outcome?: string; durationMs?: number; tools?: number; failedTools?: number; state: WorkflowNodeState }>;
    outcome?: string;
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

/** Fold a workflow session's events, oldest first, into the canvas state. */
export function foldWorkflowCanvasState(events: WorkflowEventLike[], graph?: CompiledScriptWorkflow | null): WorkflowCanvasState {
    const state: WorkflowCanvasState = { status: "running", name: graph?.name ?? null, current: null, step: 0, nodes: {}, taken: {}, steps: [] };
    const node = (id: string) => (state.nodes[id] ??= { state: "idle", runs: 0 });
    for (const id of Object.keys(graph?.nodes ?? {})) node(id);
    const stepEntry = (step: number, id: string) => {
        let entry = state.steps.find((s) => s.step === step);
        if (!entry) {
            entry = { step, node: id, state: "running" };
            state.steps.push(entry);
        }
        return entry;
    };
    let lastFinished: { node: string; outcome: string } | null = null;
    for (const event of events) {
        const data = event?.data ?? {};
        switch (event?.eventType) {
            case "workflow.started":
                state.name = data.name ?? state.name;
                for (const n of Array.isArray(data.nodes) ? data.nodes : []) if (n?.id) node(String(n.id));
                break;
            case "workflow.node_started": {
                const id = String(data.nodeId ?? "");
                if (!id) break;
                if (lastFinished) {
                    const key = `${lastFinished.node}\u0001${lastFinished.outcome}`;
                    state.taken[key] = (state.taken[key] ?? 0) + 1;
                    lastFinished = null;
                }
                const n = node(id);
                n.state = "running";
                n.runs += 1;
                state.current = id;
                state.step = Math.max(state.step, Number(data.step) || 0);
                stepEntry(Number(data.step) || state.step, id);
                break;
            }
            case "workflow.node_completed": {
                const id = String(data.nodeId ?? "");
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
            case "workflow.node_failed":
            case "workflow.node_cancelled": {
                const id = String(data.nodeId ?? "");
                if (!id) break;
                const n = node(id);
                n.state = event.eventType === "workflow.node_failed" ? "failed" : "cancelled";
                Object.assign(stepEntry(Number(data.step) || state.step, id), { state: n.state, durationMs: data.durationMs });
                lastFinished = null;
                break;
            }
            case "workflow.completed":
            case "workflow.failed":
            case "workflow.cancelled": {
                state.status = event.eventType === "workflow.completed" ? "completed"
                    : event.eventType === "workflow.failed" ? "failed" : "cancelled";
                state.step = Math.max(state.step, Number(data.steps) || 0);
                if (lastFinished && event.eventType === "workflow.completed") {
                    const key = `${lastFinished.node}\u0001${lastFinished.outcome}`;
                    state.taken[key] = (state.taken[key] ?? 0) + 1;
                }
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
export function buildWorkflowCanvasHtml(workflow: CompiledScriptWorkflow, initial: WorkflowCanvasState): string {
    const graph = {
        name: workflow.name,
        entry: workflow.entry,
        nodes: Object.values(workflow.nodes).map((n) => ({ id: n.id, runtime: n.runtime, next: n.next })),
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
  .node.entry rect { stroke-dasharray: 5 3; }
  .node.done.entry rect, .node.running.entry rect, .node.failed.entry rect, .node.cancelled.entry rect { stroke-dasharray: none; }
  .end circle { fill: #1b2433; stroke: #8b96a8; stroke-width: 1.5; }
  .end text { fill: #8b96a8; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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
  td.state-running { color: #6cb6ff; } td.state-done { color: #5fd38d; } td.state-failed { color: #ff7b72; } td.state-cancelled { color: #e3b341; }
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
  var W = 150, H = 46, GAP_X = 46, GAP_Y = 70, PAD = 30, END = "\\u0000end";
  var byId = {};
  graph.nodes.forEach(function (n) { byId[n.id] = n; });

  // Layers by breadth-first distance from the entry; unreachable nodes last.
  var layer = {}; var order = [graph.entry]; layer[graph.entry] = 0;
  for (var i = 0; i < order.length; i++) {
    var n = byId[order[i]]; if (!n) continue;
    Object.keys(n.next || {}).forEach(function (k) {
      var t = n.next[k];
      if (t && byId[t] && layer[t] === undefined) { layer[t] = layer[n.id] + 1; order.push(t); }
    });
  }
  var maxLayer = 0;
  graph.nodes.forEach(function (n) { if (layer[n.id] === undefined) { layer[n.id] = -1; } else if (layer[n.id] > maxLayer) { maxLayer = layer[n.id]; } });
  graph.nodes.forEach(function (n) { if (layer[n.id] === -1) layer[n.id] = maxLayer + 1; });
  graph.nodes.forEach(function (n) { if (layer[n.id] > maxLayer) maxLayer = layer[n.id]; });
  var hasEnd = graph.nodes.some(function (n) { return Object.keys(n.next || {}).some(function (k) { return n.next[k] === null; }); });
  var rows = [];
  graph.nodes.forEach(function (n) { (rows[layer[n.id]] = rows[layer[n.id]] || []).push(n.id); });
  var widest = Math.max.apply(null, rows.map(function (r) { return r ? r.length : 0; }).concat([1]));
  var width = Math.max(360, widest * W + (widest - 1) * GAP_X + PAD * 2 + 80);
  var pos = {};
  rows.forEach(function (row, li) {
    if (!row) return;
    var rowWidth = row.length * W + (row.length - 1) * GAP_X;
    var x0 = (width - rowWidth) / 2;
    row.forEach(function (id, j) { pos[id] = { x: x0 + j * (W + GAP_X), y: PAD + li * (H + GAP_Y) }; });
  });
  var endY = PAD + (maxLayer + 1) * (H + GAP_Y);
  if (hasEnd) pos[END] = { x: width / 2 - 18, y: endY };
  var height = (hasEnd ? endY + 36 : PAD + (maxLayer + 1) * (H + GAP_Y) - GAP_Y + H) + PAD;

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
  graph.nodes.forEach(function (n) {
    var outs = Object.keys(n.next || {});
    outs.forEach(function (outcome, k) {
      var target = n.next[outcome] === null ? END : n.next[outcome];
      var a = pos[n.id], b = pos[target]; if (!a || !b) return;
      var sx = a.x + W / 2 + (k - (outs.length - 1) / 2) * 16, sy = a.y + H;
      var d, lx, ly;
      if (target === END) {
        var ex = b.x + 18, ey = b.y;
        d = "M" + sx + "," + sy + " C" + sx + "," + (sy + 40) + " " + ex + "," + (ey - 40) + " " + ex + "," + ey;
        lx = (sx + ex) / 2; ly = (sy + ey) / 2;
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
      var t = el("text", { x: lx, y: ly, "text-anchor": "middle" }, g);
      t.textContent = outcome;
      edges.push({ key: n.id + "\\u0001" + outcome, g: g, path: g.firstChild });
    });
  });
  var nodeEls = {};
  graph.nodes.forEach(function (n) {
    var p = pos[n.id];
    var g = el("g", { "class": "node" + (n.id === graph.entry ? " entry" : ""), transform: "translate(" + p.x + "," + p.y + ")" }, nodeLayer);
    el("rect", { width: W, height: H, rx: 8 }, g);
    var t = el("text", { x: 10, y: 19 }, g); t.textContent = n.id.length > 18 ? n.id.slice(0, 17) + "…" : n.id;
    var sub = el("text", { x: 10, y: 36, "class": "sub" }, g); sub.textContent = n.runtime;
    var runs = el("text", { x: W - 10, y: 19, "text-anchor": "end", "class": "runs" }, g);
    var title = el("title", {}, g); title.textContent = n.id;
    nodeEls[n.id] = { g: g, sub: sub, runs: runs, base: g.getAttribute("class"), runtime: n.runtime };
  });
  if (hasEnd) {
    var eg = el("g", { "class": "end", transform: "translate(" + pos[END].x + "," + pos[END].y + ")" }, nodeLayer);
    el("circle", { cx: 18, cy: 14, r: 13 }, eg);
    var et = el("text", { x: 18, y: 18, "text-anchor": "middle" }, eg); et.textContent = "end";
  }

  function fmt(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
    return Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s";
  }
  function text(id, value) { document.getElementById(id).textContent = value; }

  function applyData(state) {
    if (!state || typeof state !== "object") return;
    text("name", state.name || graph.name);
    var status = document.getElementById("status");
    status.className = "pill " + (state.status || "running");
    status.textContent = state.status || "running";
    text("where", state.status === "running" && state.current
      ? "step " + state.step + " · running " + state.current
      : state.step ? state.step + " step" + (state.step === 1 ? "" : "s") : "starting");
    var note = document.getElementById("note");
    var noteText = state.status === "failed" ? "Failed: " + (state.error || "unknown error")
      : state.status === "cancelled" ? "Stopped: " + (state.reason || "cancelled")
      : state.status === "completed" ? "Outcome " + (state.outcome || "?") + (state.output ? "\\n" + state.output : "")
      : "";
    note.hidden = !noteText;
    note.className = "note " + (state.status || "");
    note.textContent = noteText;
    Object.keys(nodeEls).forEach(function (id) {
      var n = (state.nodes || {})[id] || { state: "idle", runs: 0 };
      var e = nodeEls[id];
      e.g.setAttribute("class", e.base + " " + n.state);
      e.runs.textContent = n.runs > 1 ? "×" + n.runs : "";
      e.sub.textContent = e.runtime + (n.lastOutcome ? " → " + n.lastOutcome : "") + (n.lastDurationMs !== undefined ? " · " + fmt(n.lastDurationMs) : "");
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
      [String(s.step), s.node, s.outcome || (s.state === "running" ? "running…" : s.state), fmt(s.durationMs),
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
