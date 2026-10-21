/**
 * The package-reviewer's guided review, drawn on the session canvas. The page
 * is a fixed template filled from the SAVED report and the server's own diff
 * of the exact candidate and baseline, so the canvas shows the same digest-
 * bound review as the panel. Package-derived text is embedded as escaped JSON
 * and reaches the DOM only through textContent: package content cannot add
 * markup, script or controls. The page declares no canvas actions and holds
 * no approval control.
 *
 * @module
 */

import type { AgentPackageReviewDiff, ReviewFileChange } from "./agent-package-review-diff.js";
import type { PackageReviewReport } from "./package-review-report-store.js";

/** Patch lines shown per file; the review panel shows the rest. */
export const GUIDE_PATCH_LINES = 400;
/** Total patch text embedded in one page. */
export const GUIDE_PATCH_BUDGET_CHARS = 400_000;

export interface PackageReviewGuideCanvasInput {
    diff: Pick<AgentPackageReviewDiff, "candidate" | "baseline" | "baselineSource" | "changes">;
    report: PackageReviewReport;
}

interface GuideFile {
    path: string;
    status: string;
    group: string;
    additions: number | null;
    deletions: number | null;
    flagged: string | null;
    changedKeys: string[];
    patch: string[] | null;
    hiddenLines: number;
    note: string | null;
}

/** JSON that is safe inside a <script type="application/json"> element. */
function embedJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

/** The data the page renders. Exported for tests. */
export function buildPackageReviewGuideData(input: PackageReviewGuideCanvasInput) {
    const { diff, report } = input;
    const byPath = new Map(diff.changes.map((change) => [change.path, change]));
    let budget = GUIDE_PATCH_BUDGET_CHARS;
    const files = new Map<string, GuideFile>();
    const fileFor = (change: ReviewFileChange): GuideFile => {
        const existing = files.get(change.path);
        if (existing) return existing;
        let patch: string[] | null = null;
        let hiddenLines = 0;
        let note: string | null = null;
        if (typeof change.diff === "string" && change.diff.length) {
            const lines = change.diff.split("\n");
            const shown = lines.slice(0, GUIDE_PATCH_LINES);
            const chars = shown.reduce((sum, line) => sum + line.length + 1, 0);
            if (chars <= budget) {
                budget -= chars;
                patch = shown;
                hiddenLines = lines.length - shown.length;
            } else {
                note = "Patch left out of this page to keep it small; open the file in the review panel.";
            }
        } else if (change.flagged) {
            note = `Content shown as hashes only (${change.flagged}): old ${change.oldSha256 || "-"}, new ${change.newSha256 || "-"}.`;
        } else {
            note = "No textual patch; open the file in the review panel.";
        }
        const file: GuideFile = {
            path: change.path, status: change.status, group: change.group,
            additions: Number.isInteger(change.additions) ? change.additions! : null,
            deletions: Number.isInteger(change.deletions) ? change.deletions! : null,
            flagged: change.flagged ?? null, changedKeys: change.changedKeys ?? [],
            patch, hiddenLines, note,
        };
        files.set(change.path, file);
        return file;
    };
    const steps = report.content.guide.map((step) => ({
        step: step.step,
        detail: step.detail,
        files: (step.paths ?? []).map((path) => {
            const change = byPath.get(path);
            return change ? fileFor(change) : { path, unchanged: true };
        }),
    }));
    const c = diff.candidate;
    return {
        candidate: { name: c.name, semver: c.semver, packageId: c.packageId, versionId: c.versionId, sha256: c.sha256 },
        baseline: diff.baseline
            ? { semver: diff.baseline.semver, versionId: diff.baseline.versionId, sha256: diff.baseline.sha256 }
            : null,
        baselineSource: diff.baselineSource,
        report: {
            reportId: report.reportId,
            createdAt: report.createdAt instanceof Date ? report.createdAt.toISOString() : String(report.createdAt ?? ""),
            author: report.author ? `${report.author.provider}:${report.author.subject}` : "unknown",
            sessionId: report.sessionId,
        },
        analysis: report.content.analysis,
        facts: report.content.facts,
        risks: report.content.risks,
        steps,
        changes: diff.changes.map((change) => ({
            path: change.path, status: change.status, group: change.group,
            additions: Number.isInteger(change.additions) ? change.additions : null,
            deletions: Number.isInteger(change.deletions) ? change.deletions : null,
            flagged: change.flagged ?? null,
        })),
    };
}

const STYLE = `
:root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e;
  --accent:#58a6ff; --warn:#d29922; --add:rgba(46,160,67,.18); --del:rgba(248,81,73,.18); --hunk:rgba(56,139,253,.12);
  --addfg:#3fb950; --delfg:#f85149; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --bg:#ffffff; --panel:#f6f8fa; --border:#d0d7de;
  --fg:#1f2328; --muted:#656d76; --accent:#0969da; --warn:#9a6700; --addfg:#1a7f37; --delfg:#cf222e; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
header { padding: 12px 16px; border-bottom: 1px solid var(--border); }
header h1 { margin: 0 0 4px; font-size: 16px; }
.banner { display: inline-block; margin-bottom: 6px; padding: 2px 8px; border: 1px solid var(--warn); border-radius: 4px;
  color: var(--warn); font-size: 12px; font-weight: 600; letter-spacing: .03em; }
.meta { color: var(--muted); font-size: 12px; font-family: var(--mono); overflow-wrap: anywhere; }
.body { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); min-height: 0; }
nav { overflow: auto; border-right: 1px solid var(--border); padding: 8px 0; }
nav button { display: flex; gap: 8px; width: 100%; padding: 6px 12px; border: 0; background: none; color: inherit;
  font: inherit; text-align: left; cursor: pointer; }
nav button:hover { background: var(--panel); }
nav button[aria-current="step"] { background: var(--panel); box-shadow: inset 3px 0 0 var(--accent); color: var(--fg); }
nav .num { min-width: 1.6em; color: var(--muted); font-family: var(--mono); }
main { overflow: auto; padding: 16px 20px; min-width: 0; }
main h2 { margin: 0 0 8px; font-size: 18px; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; }
ul { padding-left: 20px; }
li { margin: 4px 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; }
td.path { font-family: var(--mono); overflow-wrap: anywhere; }
.file { margin: 14px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.file > summary { display: flex; gap: 10px; align-items: baseline; padding: 6px 10px; background: var(--panel); cursor: pointer;
  font-family: var(--mono); font-size: 13px; }
.file > summary .p { flex: 1; overflow-wrap: anywhere; }
.file .note { margin: 0; padding: 8px 10px; color: var(--muted); }
.counts .a { color: var(--addfg); } .counts .d { color: var(--delfg); }
.flag { color: var(--warn); }
.patch { margin: 0; overflow: auto; max-height: 60vh; font: 12px/1.45 var(--mono); }
.patch div { min-width: max-content; padding: 0 10px; white-space: pre; }
.patch .is-add { background: var(--add); } .patch .is-del { background: var(--del); }
.patch .is-hunk { background: var(--hunk); color: var(--muted); } .patch .is-meta { color: var(--muted); }
footer { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); flex-wrap: wrap; }
footer button { padding: 4px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: inherit;
  font: inherit; cursor: pointer; }
footer button:disabled { opacity: .45; cursor: default; }
footer .where { margin-left: auto; color: var(--muted); font-size: 12px; }
@media (max-width: 700px) { .body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  nav { max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--border); } }
`;

// Builds the page from the embedded data with textContent only.
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("guide-data").textContent);
  var app = document.getElementById("app");
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  var STATUS = { added: "A", removed: "D", modified: "M" };
  var pages = [{ kind: "overview", label: "Overview" }];
  data.steps.forEach(function (s, i) { pages.push({ kind: "step", label: s.step, index: i }); });
  pages.push({ kind: "risks", label: "Open risks (" + data.risks.length + ")" });
  var current = 0;

  var c = data.candidate, b = data.baseline;
  var header = add(el("header"),
    el("div", "banner", "ADVISORY · NOT AN APPROVAL · package-reviewer"),
    el("h1", null, "Guided review · " + c.name + "@" + c.semver),
    el("div", "meta", "Candidate " + c.versionId + " · sha256:" + c.sha256),
    el("div", "meta", b ? "Baseline (" + data.baselineSource + ") " + b.semver + " · " + b.versionId + " · sha256:" + b.sha256
      : "Baseline: none (new package)"),
    el("div", "meta", "Report " + data.report.reportId + " · " + data.report.createdAt + " · by " + data.report.author));
  var nav = el("nav"); nav.setAttribute("aria-label", "Review steps");
  var main = el("main"); main.setAttribute("aria-live", "polite");
  var prev = el("button", null, "← Previous"), next = el("button", null, "Next →"), pos = el("span");
  prev.type = next.type = "button";
  var footer = add(el("footer"), prev, pos, next,
    el("span", "where", "Decide in Admin console → Packages → Pending Approval. This page cannot approve or reject."));
  add(app, header, add(el("div", "body"), nav, main), footer);

  function counts(f) {
    if (f.additions == null) return null;
    return add(el("span", "counts"), el("span", "a", "+" + f.additions), document.createTextNode(" "), el("span", "d", "−" + f.deletions));
  }
  function patchClass(line) {
    if (line.indexOf("@@") === 0) return "is-hunk";
    if (line.indexOf("+++ ") === 0 || line.indexOf("--- ") === 0) return "is-meta";
    if (line.charAt(0) === "+") return "is-add";
    if (line.charAt(0) === "-") return "is-del";
    return "";
  }
  function fileCard(f) {
    var card = el("details", "file"); card.open = true;
    if (f.unchanged) {
      add(card, add(el("summary"), el("span", "p", f.path)),
        el("p", "note", "Not changed against the baseline, or not in the candidate. Open it from the review panel's file list if needed."));
      return card;
    }
    add(card, add(el("summary"), el("span", null, STATUS[f.status] || "?"), el("span", "p", f.path),
      f.flagged ? el("span", "flag", "⚠ " + f.flagged) : null, el("span", "meta", f.group), counts(f)));
    if (f.changedKeys && f.changedKeys.length) add(card, el("p", "note", "Changed keys: " + f.changedKeys.join(", ")));
    if (f.patch) {
      var pre = el("div", "patch");
      f.patch.forEach(function (line) { pre.appendChild(el("div", patchClass(line), line || " ")); });
      add(card, pre);
      if (f.hiddenLines) add(card, el("p", "note", f.hiddenLines + " more lines: see the review panel."));
    }
    if (f.note) add(card, el("p", "note", f.note));
    return card;
  }
  function list(items, empty) {
    if (!items.length) return el("p", "meta", empty);
    var ul = el("ul"); items.forEach(function (t) { ul.appendChild(el("li", null, t)); }); return ul;
  }
  function render() {
    var page = pages[current];
    main.textContent = "";
    if (page.kind === "overview") {
      add(main, el("h2", null, "Overview"), el("p", "prose", data.analysis), el("h3", null, "Verified facts"), list(data.facts, "No facts recorded."));
      add(main, el("h3", null, "Changed files (" + data.changes.length + ")"));
      var table = el("table"), head = el("tr");
      ["", "Path", "Risk group", "Lines"].forEach(function (h) { head.appendChild(el("th", null, h)); });
      table.appendChild(head);
      data.changes.forEach(function (f) {
        var row = el("tr");
        add(row, el("td", null, STATUS[f.status] || "?"), el("td", "path", f.path + (f.flagged ? "  ⚠ " + f.flagged : "")),
          el("td", null, f.group), add(el("td"), counts(f)));
        table.appendChild(row);
      });
      add(main, table);
    } else if (page.kind === "step") {
      var s = data.steps[page.index];
      add(main, el("h2", null, "Step " + (page.index + 1) + " · " + s.step), el("p", "prose", s.detail));
      s.files.forEach(function (f) { main.appendChild(fileCard(f)); });
    } else {
      add(main, el("h2", null, "Open risks"), list(data.risks, "No open risks recorded."));
    }
    Array.prototype.forEach.call(nav.children, function (n, i) {
      if (i === current) n.setAttribute("aria-current", "step"); else n.removeAttribute("aria-current");
    });
    prev.disabled = current === 0; next.disabled = current === pages.length - 1;
    pos.textContent = (current + 1) + " / " + pages.length;
    main.scrollTop = 0;
  }
  pages.forEach(function (p, i) {
    var item = add(el("button"), el("span", "num", p.kind === "step" ? String(p.index + 1) : "•"), el("span", null, p.label));
    item.type = "button";
    item.addEventListener("click", function () { current = i; render(); });
    nav.appendChild(item);
  });
  prev.addEventListener("click", function () { if (current > 0) { current--; render(); } });
  next.addEventListener("click", function () { if (current < pages.length - 1) { current++; render(); } });
  document.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" && current < pages.length - 1) { current++; render(); }
    if (e.key === "ArrowLeft" && current > 0) { current--; render(); }
  });
  render();
})();
`;

/** The complete, self-contained canvas document. */
export function renderPackageReviewGuideHtml(input: PackageReviewGuideCanvasInput): string {
    const data = buildPackageReviewGuideData(input);
    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        + "<title>Guided package review</title><style>" + STYLE + "</style></head><body>"
        + "<div id=\"app\"></div>"
        + "<script type=\"application/json\" id=\"guide-data\">" + embedJson(data) + "</script>"
        + "<script>" + SCRIPT + "</script></body></html>";
}
