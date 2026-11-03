import { projectWorkflowV2ReadModel } from "./workflow-v2-view.js";

/**
 * Which run of a v2 workflow a view shows (the portal's run picker, the TUI's workflow view): the options, their labels
 * and the notes, from the workflow's last read model (`runs` of readWorkflowV2View: { runId, mode: "live" | "test",
 * status, revision, outcome }) and the selection (`ui.workflowViews[sessionId].selectedRunId`, null for the live run).
 * Nothing here fetches: the controller's ensureWorkflowReadModel reads the selected run.
 */

const RUN_STATUS_WORDS = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"]);
const RUN_OPTION_LIMIT = 100;
const OUTCOME_LABEL_LIMIT = 20;
const TITLE_OUTCOME_LIMIT = 300;

const bounded = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** A long id keeps its start and its end, so ids that share a prefix stay apart; the title carries the whole id. */
const shortId = id => id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
/** An own property only: a prototype key or an inherited value is never read as run data. */
const own = (object, key) => object !== null && typeof object === "object" && Object.hasOwn(object, key) ? object[key] : undefined;

function runFacts(run) {
    const mode = own(run, "mode"), status = own(run, "status"), outcome = own(run, "outcome"), revision = own(run, "revision");
    return {
        mode: mode === "live" || mode === "test" ? mode : null,
        status: typeof status === "string" && RUN_STATUS_WORDS.has(status) ? status : null,
        outcome: typeof outcome === "string" && outcome !== "" ? outcome : null,
        revision: Number.isSafeInteger(revision) ? revision : null,
        runId: own(run, "runId"),
    };
}

/**
 * One option's text. Kind, status, revision and the short id are fixed-size and always present; only the outcome
 * is cut (at 20 characters), so long outcomes can never hide which run an option is. `kindText` replaces the kind's
 * word (the live run's own option says "Live run").
 */
function runLabel(run, kindText = null) {
    const facts = runFacts(run);
    const kind = kindText ?? (facts.mode === "live" ? "Live" : facts.mode === "test" ? "Test" : "Run (mode not recognized)");
    const outcome = facts.outcome ? ` (${bounded(facts.outcome, OUTCOME_LABEL_LIMIT)})` : "";
    const revision = facts.revision === null ? "" : ` · revision ${facts.revision}`;
    return `${kind} · ${facts.status ?? "status unknown"}${outcome}${revision} · ${shortId(facts.runId)}`;
}

/** The tooltip: the whole id and every known field; only an outcome beyond 300 characters is cut. */
function runTitle(run) {
    const facts = runFacts(run);
    const parts = [facts.runId, facts.mode ? `${facts.mode} run` : "mode not recognized", facts.status ?? "status unknown"];
    if (facts.revision !== null) parts.push(`revision ${facts.revision}`);
    if (facts.outcome) parts.push(`outcome ${bounded(facts.outcome, TITLE_OUTCOME_LIMIT)}`);
    return parts.join(" · ");
}

/**
 * What the picker shows, from the workflow's last read model (any selection's: the run list is workflow-wide), the
 * selection, whether the selection's own model is loaded, and its read error. Pure; never throws. Entries that are not
 * a run are counted and left out. A selected id that is not in the list is kept as its own option, never replaced.
 */
export function workflowV2RunPickerModel({ workflowModel = null, selectedRunId = null, ownModelLoaded = false, error = null } = {}) {
    const selection = typeof selectedRunId === "string" && selectedRunId !== "" ? selectedRunId : null;
    const projected = workflowModel ? projectWorkflowV2ReadModel(workflowModel) : null;
    const list = projected?.ok ? projected.runs : null;
    const runs = [];
    const seen = new Set();
    let malformed = 0;
    for (const item of list || []) {
        const id = own(item, "runId");
        if (item === null || typeof item !== "object" || Array.isArray(item) || typeof id !== "string" || id === "" || seen.has(id)) {
            malformed += 1;
            continue;
        }
        seen.add(id);
        runs.push(item);
    }
    const modeOf = run => runFacts(run).mode;
    const idOf = run => own(run, "runId");
    const live = runs.find(run => modeOf(run) === "live");
    // The live run is listed once, as the first option (value ""); the others follow.
    const shown = runs.filter(run => run !== live).slice(0, RUN_OPTION_LIMIT);
    const options = [{ value: "", kind: "live", title: live ? `The workflow's live run: ${runTitle(live)}` : "The workflow's live run",
        label: live ? runLabel(live, "Live run") : "Live run" }];
    for (const run of shown) options.push({ value: idOf(run), kind: modeOf(run) ?? "other", label: runLabel(run), title: runTitle(run) });
    let missing = false;
    // The live run chosen by its id is the live run's own option.
    const liveSelected = selection !== null && live !== undefined && selection === idOf(live);
    if (selection !== null && !seen.has(selection)) {
        missing = true;
        options.push({ value: selection, kind: "missing", title: selection,
            label: `Selected run ${shortId(selection)} · ${list ? "not in the run list that was read" : "run list not loaded"}` });
    } else if (selection !== null && !liveSelected && !shown.some(run => idOf(run) === selection)) {
        const run = runs.find(item => idOf(item) === selection);
        options.push({ value: selection, kind: modeOf(run) ?? "other", label: runLabel(run), title: runTitle(run) });
    }
    const notes = [];
    if (!list) notes.push({ level: "info", text: workflowModel ? "The run list is unavailable." : "Run list not loaded yet." });
    else if (runs.length === 0 && malformed === 0) notes.push({ level: "info", text: "No runs yet." });
    if (malformed) notes.push({ level: "warning", text: `${malformed} run ${malformed === 1 ? "entry" : "entries"} in the run list could not be read and ${malformed === 1 ? "is" : "are"} not listed.` });
    if (runs.length > RUN_OPTION_LIMIT) notes.push({ level: "info", text: `Showing the first ${RUN_OPTION_LIMIT} of ${runs.length} runs.` });
    if (missing && list) notes.push({ level: "warning", text: "This run is not in the run list that was read; only what is loaded for it is shown." });
    if (error) notes.push({ level: "error", text: "This run could not be read. Your selection is kept." });
    else if (!ownModelLoaded) notes.push({ level: "info", text: selection === null ? "Reading the live run…" : "Reading this run…" });
    return { selection, value: liveSelected ? "" : selection ?? "", options, notes, runsKnown: Boolean(list), runCount: runs.length, malformed, missing };
}
