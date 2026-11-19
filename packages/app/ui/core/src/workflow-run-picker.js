import { projectWorkflowReadModel, workflowSavedDefinitionRevision } from "./workflow-view.js";
import { workflowOutcomeWord, workflowRunStateWord } from "./workflow-words.js";

/**
 * Which run of a workflow a view shows (the portal's run picker, the TUI's workflow view): the options, their labels
 * and the notes, from the workflow's last read model (`runs` of readWorkflowView: { runId, mode: "live" | "test",
 * status, revision, outcome }) and the selection (`ui.workflowViews[sessionId].selectedRunId`, null for the live run).
 * Nothing here fetches: the controller's ensureWorkflowReadModel reads the selected run.
 */

const RUN_STATUS_WORDS = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"]);
const RUN_OPTION_LIMIT = 100;
const OUTCOME_LABEL_LIMIT = 20;
const TITLE_OUTCOME_LIMIT = 300;

const bounded = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
 * One option's text (review 19:27Z row 5): "Test · Canceled · blocked · revision 2", in the Workflow's words; no id (the
 * tooltip has it). Only the outcome is cut (at 20 characters). The Workflow's own option is "Workflow · revision 1": its
 * state is the view's title.
 */
function runLabel(run, own = false, savedRevision = null) {
    const facts = runFacts(run);
    const revision = savedRevision !== null ? ` · Saved definition revision ${savedRevision}`
        : facts.revision === null ? "" : ` · revision ${facts.revision}`;
    if (own) return `Workflow${revision}`;
    const kind = facts.mode === "live" ? "Workflow" : facts.mode === "test" ? "Test" : "Run · mode not recognized";
    const outcome = facts.outcome ? ` · ${bounded(workflowOutcomeWord(facts.outcome), OUTCOME_LABEL_LIMIT)}` : "";
    return `${kind} · ${workflowRunStateWord(facts.status) ?? "Not certain"}${outcome}${revision}`;
}

/** The tooltip: the whole id and every known field; only an outcome beyond 300 characters is cut. */
function runTitle(run, savedRevision = null) {
    const facts = runFacts(run);
    const parts = [facts.runId, facts.mode === "live" ? "Workflow" : facts.mode === "test" ? "Test" : "mode not recognized", workflowRunStateWord(facts.status) ?? "Not certain"];
    if (savedRevision !== null) parts.push(`Saved definition revision ${savedRevision}`);
    if (facts.revision !== null) parts.push(savedRevision !== null ? `Workflow copy revision ${facts.revision}` : `revision ${facts.revision}`);
    if (facts.outcome) parts.push(`outcome ${bounded(workflowOutcomeWord(facts.outcome), TITLE_OUTCOME_LIMIT)}`);
    return parts.join(" · ");
}

/**
 * What the picker shows, from the workflow's last read model (any selection's: the run list is workflow-wide), the
 * selection, whether the selection's own model is loaded, and its read error. Pure; never throws. Entries that are not
 * a run are counted and left out. A selected id that is not in the list is kept as its own option, never replaced.
 * `tests: false` leaves test runs out (Workflow Simplified, spec 16: test mode hidden; workflowTestRunsShown).
 */
export function workflowRunPickerModel({ workflowModel = null, selectedRunId = null, ownModelLoaded = false, error = null, tests = true } = {}) {
    const selection = typeof selectedRunId === "string" && selectedRunId !== "" ? selectedRunId : null;
    const projected = workflowModel ? projectWorkflowReadModel(workflowModel) : null;
    const savedRevision = workflowSavedDefinitionRevision(workflowModel);
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
        if (tests === false && runFacts(item).mode === "test") continue;
        seen.add(id);
        runs.push(item);
    }
    const modeOf = run => runFacts(run).mode;
    const idOf = run => own(run, "runId");
    const live = runs.find(run => modeOf(run) === "live");
    // The live run is listed once, as the first option (value ""); the others follow.
    const shown = runs.filter(run => run !== live).slice(0, RUN_OPTION_LIMIT);
    const options = [{ value: "", kind: "live", title: live ? `The Workflow: ${runTitle(live, savedRevision)}` : "The Workflow",
        label: live ? runLabel(live, true, savedRevision) : "Workflow" }];
    for (const run of shown) options.push({ value: idOf(run), kind: modeOf(run) ?? "other",
        label: runLabel(run, false, savedRevision), title: runTitle(run, savedRevision) });
    let missing = false;
    // The live run chosen by its id is the live run's own option.
    const liveSelected = selection !== null && live !== undefined && selection === idOf(live);
    if (selection !== null && !seen.has(selection)) {
        missing = true;
        options.push({ value: selection, kind: "missing", title: selection,
            label: `Chosen · ${list ? "not in the list that was read" : "list not loaded"}` });
    } else if (selection !== null && !liveSelected && !shown.some(run => idOf(run) === selection)) {
        const run = runs.find(item => idOf(item) === selection);
        options.push({ value: selection, kind: modeOf(run) ?? "other",
            label: runLabel(run, false, savedRevision), title: runTitle(run, savedRevision) });
    }
    const notes = [];
    // Review 19:27Z: in the Workflow's words; a test is not a Workflow, and neither is called a "run".
    if (!list) notes.push({ level: "info", text: workflowModel ? "The list is not available." : "The list is not loaded yet." });
    else if (runs.length === 0 && malformed === 0) notes.push({ level: "info", text: "Not started yet." });
    if (malformed) notes.push({ level: "warning", text: `${malformed} ${malformed === 1 ? "entry" : "entries"} in the list could not be read and ${malformed === 1 ? "is" : "are"} not listed.` });
    if (runs.length > RUN_OPTION_LIMIT) notes.push({ level: "info", text: `Showing the first ${RUN_OPTION_LIMIT} of ${runs.length}.` });
    if (missing && list) notes.push({ level: "warning", text: "This one is not in the list that was read; only what is loaded for it is shown." });
    if (error) notes.push({ level: "error", text: "This one could not be read. Your choice is kept." });
    else if (!ownModelLoaded) notes.push({ level: "info", text: selection === null ? "Reading the Workflow…" : "Reading this one…" });
    return { selection, value: liveSelected ? "" : selection ?? "", options, notes, runsKnown: Boolean(list), runCount: runs.length, malformed, missing };
}
