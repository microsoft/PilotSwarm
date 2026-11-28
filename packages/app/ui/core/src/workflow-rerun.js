/**
 * Phase 3 I7 (design §7): "Re-run from here…" in one shared model. Whether the button may open and why not, the confirm
 * sheet's words (the source revision always preselected, a newer one that fits offered, OQ1's inherited tool grant, the
 * Reused disclosure with carried messages), the supply editor's fields and checks, one operation id per intent (N5), and
 * how a re-run's reused and supplied visits read in the header, graph, Node panel, timeline and Log. The output is checked
 * here for JSON syntax, size and depth only (R2-S4): Start's own 422 says what does not match the schema. Pure.
 */
import { randomUuid } from "./random-id.js";
import { workflowDuration, workflowOutcomeWord, workflowShortTime } from "./workflow-words.js";
import { formatLocalTime } from "./formatting.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() ? value : null);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Server limits the sheet checks before Start (design §3.5, §6.1): output nesting, the default output size, and the note. */
export const WORKFLOW_RERUN_MAX_DEPTH = 64;
export const WORKFLOW_RERUN_MAX_OUTPUT_BYTES = 256 * 1024;
export const WORKFLOW_RERUN_NOTE_MAX_CHARS = 2_000;

/** The button's tooltip: why it is off, in one sentence each (design §7.2), and what it does when on. */
export const WORKFLOW_RERUN_TIPS = Object.freeze({
    active: "This Workflow is still running. Stop it first.",
    viewer: "Only the owner or an admin can start a Workflow.",
    ownerEnded: "The session that owns this Workflow has ended.",
    firstVisit: "This is the first step. Use Run again… instead.",
    lane: "To re-run this lane, choose the parallel step.",
    swept: "This Workflow was cleaned up. Use Run again… instead.",
    enabled: "Start a new Workflow that reuses the steps before this one.",
});

export const WORKFLOW_RERUN_MODE_WORDS = Object.freeze({
    run_again: "Run this step again",
    continue: "Keep this step's result and go on",
    supply: "Supply this step's result and go on",
});

const MODES = new Set(["run_again", "continue", "supply"]);
const ACTIVE_RUNS = new Set(["admitted", "running", "paused"]);
const ENDED_OWNERS = new Set(["completed", "cancelled", "failed", "deleted"]);
// rerun.ts › isCancelledByRunEnd: a visit the run's end cancelled has no result to keep.
const RUN_END_WINNERS = new Set(["cancel", "delete", "stop", "deadline", "controller"]);

const inLane = visit => isRecord(visit?.branch) || (text(visit?.scopeId) !== null && visit.scopeId !== "root");
const cancelledByRunEnd = visit => visit?.status !== "completed"
    || (visit.resultKind === "runtime_error" && visit.outcome === "cancelled" && RUN_END_WINNERS.has(visit.winner ?? ""));

/**
 * The modes a visit offers besides Run this step again (rerun.ts › modesAvailableFor): `continue` for a step with a result,
 * `supply` for a top-level script or agent step that completed (not exhausted) and does not set supply: never. Pure.
 */
function keptModes(visit, node) {
    const type = node?.type ?? null;
    const modes = [];
    if (type !== "terminal" && !cancelledByRunEnd(visit)) modes.push("continue");
    if (!inLane(visit) && visit?.status === "completed" && (type === "script" || type === "agent") && visit.outcome !== "exhausted"
        && node?.supply !== "never") modes.push("supply");
    return modes;
}

/**
 * Whether "Re-run from here…" may open, and its tooltip: { enabled, reason, title, mode }. `runStatus` is the source run's
 * status, `viewerAllowed` whether the reader may start Workflows (personCommands.viewer.allowed), `ownerStatus` the owning
 * session's status, `deleted` a swept Workflow; `visit` and `node` the step it re-runs from (none: the server picks it, as
 * the failure banner asks). A first visit opens in `mode` (supply, else continue) when it has one; null leaves the mode to
 * the server. Pure.
 */
export function workflowRerunButtonState({ runStatus = null, viewerAllowed = true, ownerStatus = null, deleted = false, visit = null, node = null } = {}) {
    const off = reason => ({ enabled: false, reason, title: WORKFLOW_RERUN_TIPS[reason], mode: null });
    if (ACTIVE_RUNS.has(runStatus)) return off("active");
    if (deleted === true) return off("swept");
    if (viewerAllowed === false) return off("viewer");
    if (ENDED_OWNERS.has(ownerStatus)) return off("ownerEnded");
    let mode = null;
    if (isRecord(visit)) {
        if (inLane(visit)) return off("lane");
        const first = !text(visit.predecessorId) && node?.initial === true && (visit.ordinal ?? 1) === 1;
        if (first) {
            const modes = keptModes(visit, node);
            if (!modes.length) return off("firstVisit");
            mode = modes.includes("supply") ? "supply" : "continue";
        }
    }
    return { enabled: true, reason: null, title: WORKFLOW_RERUN_TIPS.enabled, mode };
}

/** M6: a plan read's rerunPlan, an outcome only (in supply mode), never an output or a note. Pure. */
export function workflowRerunPlanQuery({ executionId = null, mode = null, revision = null, outcome = null } = {}) {
    return {
        ...(text(executionId) ? { executionId } : {}),
        ...(MODES.has(mode) ? { mode } : {}),
        ...(Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}),
        ...(mode === "supply" && text(outcome) ? { outcome } : {}),
    };
}

// ─── The supply editor ──────────────────────────────────────────────────────────────────────────────────────────────

const FIELD_TYPES = { string: "text", number: "number", integer: "whole number", boolean: "yes or no" };
const SCALAR = value => ["string", "number", "boolean"].includes(typeof value);

/**
 * A flat object outputSchema as one field per property ({ name, type, options, required, label, hint }), each a string,
 * number, integer, boolean or enum of scalars; null for any other schema (nested, arrays, none), which is edited as JSON. Pure.
 */
export function workflowRerunSupplyFields(schema) {
    if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
    const names = Object.keys(schema.properties);
    if (!names.length) return null;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = [];
    for (const name of names) {
        const property = schema.properties[name];
        if (!isRecord(property)) return null;
        const options = Array.isArray(property.enum) && property.enum.length && property.enum.every(SCALAR) ? [...property.enum] : null;
        if (!options && !Object.hasOwn(FIELD_TYPES, property.type)) return null;
        const needed = required.has(name);
        const kind = options ? `one of ${options.map(String).join(", ")}` : FIELD_TYPES[property.type];
        fields.push({ name, type: options ? "enum" : property.type, options, required: needed, label: needed ? `${name} *` : name,
            hint: needed ? `${kind} · required` : kind });
    }
    return fields;
}

const SKELETON = { string: "", number: 0, integer: 0, boolean: false, object: {}, array: [] };

/** The JSON a supply editor starts with: the schema's required keys with empty values, formatted; "" without a schema. Pure. */
export function workflowRerunOutputSkeleton(schema) {
    if (!isRecord(schema)) return "";
    if (schema.type !== "object" || !isRecord(schema.properties)) return "";
    const value = {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
        const property = isRecord(schema.properties[name]) ? schema.properties[name] : {};
        value[name] = Array.isArray(property.enum) && property.enum.length ? property.enum[0]
            : Object.hasOwn(SKELETON, property.type) ? structuredClone(SKELETON[property.type]) : null;
    }
    return JSON.stringify(value, null, 2);
}

/** Whether a JSON value nests deeper than `limit` (a top value is at depth 0, as the server's assertJsonValue counts). Pure. */
function tooDeep(value, limit, depth = 0) {
    if (depth > limit) return true;
    if (Array.isArray(value)) return value.some(item => tooDeep(item, limit, depth + 1));
    if (isRecord(value)) return Object.values(value).some(item => tooDeep(item, limit, depth + 1));
    return false;
}

const utf8Bytes = value => new TextEncoder().encode(value).length;

/** A value's size and depth checks: { ok, value, bytes, problems: [{ path, message }] }. */
function checkedValue(value, maxBytes) {
    const problems = [];
    if (tooDeep(value, WORKFLOW_RERUN_MAX_DEPTH)) {
        problems.push({ path: "/output", message: `The output is nested more than ${WORKFLOW_RERUN_MAX_DEPTH} levels deep.` });
        return { ok: false, value, bytes: null, problems };
    }
    const bytes = utf8Bytes(JSON.stringify(value));
    if (bytes > maxBytes) problems.push({ path: "/output", message: `The output is ${bytes} bytes; the limit is ${maxBytes} bytes.` });
    return { ok: problems.length === 0, value, bytes, problems };
}

/**
 * R2-S4: a supplied output typed as JSON, checked here for its syntax, its size (`maxBytes`, the plan's maxOutputBytes) and a
 * nesting depth of at most 64; empty is null. Whether it matches the schema is Start's to say. Pure.
 */
export function workflowRerunOutputCheck(source, { maxBytes = WORKFLOW_RERUN_MAX_OUTPUT_BYTES } = {}) {
    const raw = String(source ?? "").trim();
    if (!raw) return checkedValue(null, maxBytes);
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        return { ok: false, value: undefined, bytes: null, problems: [{ path: "/output", message: `Not valid JSON: ${error?.message ?? "it does not parse."}` }] };
    }
    return checkedValue(value, maxBytes);
}

/** The output the fields give: { ok, value, problems }; a blank optional field is left out. */
function fieldsOutput(fields, values) {
    const value = {};
    const problems = [];
    for (const field of fields) {
        const raw = isRecord(values) ? values[field.name] : undefined;
        if (raw === undefined || raw === null || raw === "") {
            if (field.required) problems.push({ path: `/output/${field.name}`, message: `${field.name} is required.` });
            continue;
        }
        if (field.type === "number" || field.type === "integer") {
            const number = typeof raw === "number" ? raw : Number(String(raw).trim());
            if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
                problems.push({ path: `/output/${field.name}`, message: `${field.name} must be ${field.type === "integer" ? "a whole number" : "a number"}.` });
                continue;
            }
            value[field.name] = number;
        } else if (field.type === "boolean") {
            value[field.name] = raw === true || raw === "true";
        } else {
            value[field.name] = raw;
        }
    }
    return { ok: problems.length === 0, value, problems };
}

const contractOf = plan => (isRecord(plan?.supplyContract) ? plan.supplyContract : null);

/** The draft's supplied output, from its fields or its JSON, checked as Start's pre-claim check would (size, depth). Pure. */
export function workflowRerunDraftOutput(draft, plan) {
    const contract = contractOf(plan);
    const maxBytes = Number.isSafeInteger(contract?.maxOutputBytes) ? contract.maxOutputBytes : WORKFLOW_RERUN_MAX_OUTPUT_BYTES;
    const fields = workflowRerunSupplyFields(contract?.resolvedOutputSchema);
    if (draft?.view === "fields" && fields) {
        const built = fieldsOutput(fields, draft.values);
        return built.ok ? checkedValue(built.value, maxBytes) : { ...built, bytes: null };
    }
    return workflowRerunOutputCheck(draft?.outputText, { maxBytes });
}

/** JSON with its object keys sorted, so the same value reads the same whichever editor wrote it. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

/** What Start would be asked for: equal identities ask for the same Workflow (N5). */
function draftIdentity(draft, plan) {
    const output = workflowRerunDraftOutput(draft, plan);
    const shownOutput = output.ok ? canonical(output.value) : draft.view === "fields" ? canonical(draft.values ?? {}) : String(draft.outputText ?? "");
    return JSON.stringify([draft.mode, draft.revision, draft.outcome, shownOutput, draft.note]);
}

/**
 * The sheet's draft as it opens (N5): the plan's mode, the source revision (Decision 8: always preselected), no outcome,
 * the supply editor on Fields for a flat schema (JSON with a skeleton otherwise), an empty Why, and an operation id. Pure but
 * for `mint`.
 */
export function workflowRerunDraft(plan, { mint = randomUuid } = {}) {
    const schema = contractOf(plan)?.resolvedOutputSchema ?? null;
    return {
        mode: MODES.has(plan?.mode) ? plan.mode : "run_again",
        revision: Number.isSafeInteger(plan?.revision?.source) ? plan.revision.source : null,
        outcome: null,
        view: workflowRerunSupplyFields(schema) ? "fields" : "json",
        values: {},
        outputText: workflowRerunOutputSkeleton(schema),
        note: "",
        operationId: mint(),
    };
}

/**
 * The draft after an edit (`patch`). N5: a new operation id whenever the mode, revision, outcome, output or note asked of
 * Start changes, so a refused Start edited and sent again is a new request; the same values (a double-click, a retry, Fields
 * and JSON holding the same value) keep the id, so a repeat is answered with the first receipt. Pure but for `mint`.
 */
export function workflowRerunDraftChange(draft, patch, { mint = randomUuid, plan = null } = {}) {
    const next = { ...draft, ...patch };
    return { ...next, operationId: draftIdentity(next, plan) === draftIdentity(draft, plan) ? draft.operationId : mint() };
}

/**
 * Whether Start may be pressed now: { ok, reason }. Not while the plan is refused for this reader or its revision does not
 * fit; in supply, not before an outcome is chosen, the plan's preview of it is valid, the output checks, and the Why is
 * filled (at most 2,000 characters). Pure.
 */
export function workflowRerunCanStart(draft, plan) {
    const no = reason => ({ ok: false, reason });
    if (!isRecord(plan) || !isRecord(draft)) return no("Reading the plan…");
    if (plan.allowed === false) return no(text(plan.blockedReason) ?? "This Start would be refused.");
    if (plan.revision?.fits === false) {
        const first = Array.isArray(plan.revision.problems) ? plan.revision.problems[0] : null;
        return no(`Revision ${plan.revision.target} does not fit${text(first?.message) ? `: ${first.message}` : "."}`);
    }
    if (draft.mode !== "supply") return { ok: true, reason: null };
    if (!text(draft.outcome)) return no("Choose an outcome.");
    if (isRecord(plan.supply) && plan.supply.outcome === draft.outcome && plan.supply.valid === false) {
        return no(text(plan.supply.problems?.[0]?.message) ?? `Outcome '${draft.outcome}' cannot be supplied.`);
    }
    const output = workflowRerunDraftOutput(draft, plan);
    if (!output.ok) return no(output.problems[0]?.message ?? "The output does not check.");
    const note = String(draft.note ?? "");
    if (!note.trim()) return no("Say why this result is supplied.");
    if ([...note].length > WORKFLOW_RERUN_NOTE_MAX_CHARS) return no("The reason is longer than 2,000 characters.");
    return { ok: true, reason: null };
}

/**
 * Start's request for the draft: the visit the plan shows (so Start makes what was previewed), its mode, the revision, and
 * in supply the result and the Why; the sheet's operation id. A re-run takes its source's inputs, so it sends none. Pure.
 */
export function workflowRerunStartRequest(draft, { plan, definitionId = null }) {
    const rerunFrom = { workflowId: plan.of.workflowId, executionId: plan.from.executionId, mode: draft.mode };
    if (draft.mode === "supply") {
        rerunFrom.result = { outcome: draft.outcome, output: workflowRerunDraftOutput(draft, plan).value ?? null };
        rerunFrom.note = String(draft.note ?? "").trim();
    }
    return { ...(definitionId ? { definitionId } : {}), revision: draft.revision, operationId: draft.operationId, rerunFrom };
}

/** Start's pre-claim 422 RERUN_SUPPLIED_RESULT_INVALID as problems to show with the output ([{ path, message }]); [] otherwise. Pure. */
export function workflowRerunStartProblems(error) {
    if (error?.code !== "RERUN_SUPPLIED_RESULT_INVALID") return [];
    const listed = Array.isArray(error.details?.problems) ? error.details.problems.filter(item => isRecord(item) && text(item.message)) : [];
    if (listed.length) return listed.map(item => ({ path: text(item.path) ?? "/output", message: item.message }));
    return text(error.message) ? [{ path: "/output", message: error.message }] : [];
}

// ─── The sheet ──────────────────────────────────────────────────────────────────────────────────────────────────────

const numbered = (numberOf, workflowId) => {
    const number = typeof numberOf === "function" && text(workflowId) ? numberOf(workflowId) : null;
    return Number.isSafeInteger(number) ? `#${number}` : null;
};

/** A definition's Workflows by number (a session definition's workflows list): a function from a Workflow id to its number, or null. */
export function workflowRerunNumbers(definition) {
    const byId = new Map((Array.isArray(definition?.workflows) ? definition.workflows : [])
        .filter(item => isRecord(item) && text(item.sessionId) && Number.isSafeInteger(item.number)).map(item => [item.sessionId, item.number]));
    return id => byId.get(id) ?? null;
}

/** A local date ("2026-11-27"), for OQ1's note. */
const dateOf = value => {
    const full = formatLocalTime(value);
    return full ? full.split(" ")[0] : null;
};

/**
 * The confirm sheet's words for `plan` and the person's `draft` (design §7.2): its title and what it starts; the visit it
 * re-runs from; the revisions (the source's, checked unless another is chosen; the newest valid one when newer: unselected if
 * it fits, disabled with its reason if not); a locked package's note (N8); the modes, the supply outcomes and their next
 * steps; OQ1's inherited grant note; a refused reader's reason (`blocked`, shown instead of Start); what Start does; the
 * Reused disclosure with carried messages (R2-S6); the warnings. Pure.
 */
export function workflowRerunSheet(plan, { draft = null, name = null, sourceNumber = null, nextNumber = null, sourceStartedAt = null,
    locked = false, supplyNever = false } = {}) {
    const source = Number.isSafeInteger(sourceNumber) ? `#${sourceNumber}` : "the Workflow";
    const next = Number.isSafeInteger(nextNumber) ? `#${nextNumber}` : "a new Workflow";
    const from = isRecord(plan?.from) ? plan.from : {};
    const revision = isRecord(plan?.revision) ? plan.revision : {};
    const chosen = draft?.revision ?? revision.source ?? null;
    const revisions = Number.isSafeInteger(revision.source)
        ? [{ value: revision.source, label: `${revision.source}  the one ${source} ran`, checked: chosen === revision.source, disabled: false, reason: null }] : [];
    if (Number.isSafeInteger(revision.newestValid) && revision.newestValid > (revision.source ?? 0)) {
        const newest = revision.newestValid;
        if (revision.newestValidFits === true) {
            revisions.push({ value: newest, label: `${newest}  newest · Revision ${newest} also fits`, checked: chosen === newest, disabled: false, reason: null });
        } else {
            const reason = text(revision.newestValidProblem?.message) ?? "it could not be checked.";
            revisions.push({ value: newest, label: `${newest}  newest · does not fit: ${reason}`, checked: false, disabled: true, reason });
        }
    }
    const modes = (Array.isArray(plan?.modesAvailable) ? plan.modesAvailable : []).filter(mode => MODES.has(mode))
        .map(mode => ({ value: mode, label: WORKFLOW_RERUN_MODE_WORDS[mode], checked: (draft?.mode ?? plan?.mode) === mode }));
    const contract = contractOf(plan);
    const nextOf = outcome => (isRecord(plan?.supply) && plan.supply.outcome === outcome ? plan.supply.next : contract?.nextByOutcome?.[outcome]) ?? null;
    const outcomes = (Array.isArray(contract?.outcomes) ? contract.outcomes : []).map(outcome => {
        const to = nextOf(outcome);
        return { value: outcome, label: `${outcome} → ${to ? `${to.stateId} · visit ${to.visit}` : "no route"}` };
    });
    const visit = `${from.stateId ?? "?"} · visit ${from.visit ?? "?"}`;
    const mode = draft?.mode ?? plan?.mode;
    let effect;
    if (mode === "supply") {
        const outcome = text(draft?.outcome);
        const to = outcome ? nextOf(outcome) : null;
        effect = outcome ? `${visit} does not run; supplied as '${outcome}'.${to ? ` Runs ${to.stateId} next.` : ""}` : `${visit} does not run; its result is supplied.`;
    } else if (mode === "continue") {
        const first = isRecord(plan?.runs?.first) ? plan.runs.first : null;
        effect = `Keeps ${visit}'s result.${first ? ` Runs ${first.stateId} next.` : ""}`;
    } else {
        effect = `Runs ${visit} again.`;
    }
    const reused = isRecord(plan?.reused) ? plan.reused : {};
    const carried = isRecord(plan?.carried) && Number.isSafeInteger(plan.carried.count) && plan.carried.count > 0
        ? `Carried inputs: ${plan.carried.count} (${(Array.isArray(plan.carried.contracts) ? plan.carried.contracts : []).join(", ")})` : null;
    const startedOn = sourceStartedAt !== null ? dateOf(sourceStartedAt) : null;
    return {
        title: `Re-run ${text(name) ?? "this Workflow"} ${source} from here`,
        sub: `Starts ${next}. ${source} stays as it is.`,
        from: visit,
        revisions,
        revisionNote: locked ? "This package's revisions attached to the session are offered. Use Update on the Definition tab to attach a newer version." : null,
        modes,
        supplyNote: supplyNever && !modes.some(item => item.value === "supply") ? "This step sets supply: never." : null,
        outcomes,
        outputHint: contract && contract.resolvedOutputSchema == null ? "Optional JSON output (no outputSchema on this step)." : null,
        grantNote: plan?.grantSource === "inherited" ? `Scripts use the tools this session gave ${source}${startedOn ? ` on ${startedOn}` : ""}.` : null,
        blocked: plan?.allowed === false ? text(plan.blockedReason) ?? "This Start would be refused." : null,
        effect,
        reused: {
            summary: `Reused: ${plural(Number.isSafeInteger(reused.visits) ? reused.visits : 0, "step")}`,
            lines: (Array.isArray(reused.steps) ? reused.steps : []).filter(isRecord).map(step => `${step.stateId} · ${plural(step.visits, "visit")}`),
            carried,
        },
        problems: revision.fits === false ? (Array.isArray(revision.problems) ? revision.problems : []).map(item => item?.message).filter(text) : [],
        warnings: (Array.isArray(plan?.warnings) ? plan.warnings : []).map(item => item?.message).filter(text),
        start: `Start ${next}`,
    };
}

// ─── How a re-run's visits read ─────────────────────────────────────────────────────────────────────────────────────

/** The header chip of a re-run (run.rerunOf): "Re-run of #2 from finish · visit 1", "Re-run of #2 · supplied provision · visit 1"; phone: "Re-run of #2". Pure. */
export function workflowRerunChip(rerunOf, { numberOf = null, phone = false } = {}) {
    if (!isRecord(rerunOf) || !text(rerunOf.workflowId)) return null;
    const of = `Re-run of ${numbered(numberOf, rerunOf.workflowId) ?? "an earlier Workflow"}`;
    if (phone || !text(rerunOf.stateId)) return of;
    const at = `${rerunOf.stateId} · visit ${Number.isSafeInteger(rerunOf.visit) ? rerunOf.visit : "?"}`;
    return rerunOf.mode === "supply" ? `${of} · supplied ${at}` : `${of} from ${at}`;
}

/** The re-runs of a Workflow (view.reruns) by number: "Re-run as #3" ("Re-run as #3, #4"); null when none is numbered. Pure. */
export function workflowRerunReruns(reruns, { numberOf = null } = {}) {
    const numbers = (Array.isArray(reruns) ? reruns : []).map(item => numbered(numberOf, item?.workflowId)).filter(Boolean);
    return numbers.length ? `Re-run as ${numbers.join(", ")}` : null;
}

const actorWords = actor => {
    if (!isRecord(actor)) return null;
    if (actor.kind === "agent") return "an agent";
    const name = text(actor.name) ?? text(actor.displayName) ?? text(actor.display);
    return name ?? (actor.kind === "user" ? "a person" : "the system");
};

/**
 * Where a visit of a re-run came from, or null for a visit that ran here: { kind, head, reason, origin, workflowId,
 * executionId, open, gone }. A reused visit says when it ran and how long it took in its origin; a supplied one that it did
 * not run, who supplied it, when, and why (its note). `numberOf` numbers a Workflow; `workflowNumber` is this one's. Pure.
 */
export function workflowVisitProvenance(visit, { numberOf = null, workflowNumber = null, now = Date.now() } = {}) {
    if (!isRecord(visit)) return null;
    const here = Number.isSafeInteger(workflowNumber) ? `#${workflowNumber}` : "this Workflow";
    if (isRecord(visit.supplied)) {
        const supplied = visit.supplied;
        const origin = isRecord(supplied.from) ? supplied.from : {};
        const from = numbered(numberOf, origin.workflowId);
        const by = actorWords(supplied.by);
        const at = text(supplied.at) ? workflowShortTime(supplied.at, now) : null;
        const gone = origin.originGone === true;
        return { kind: "supplied", head: [`✎ Supplied in ${here} (did not run)`, by ? `by ${by}` : null, at].filter(Boolean).join(" · "),
            reason: text(supplied.note), origin: `Replaced ${from ? `${from}'s` : "the earlier Workflow's"} visit`,
            workflowId: text(origin.workflowId), executionId: text(origin.executionId), open: gone ? null : `Open in ${from ?? "the earlier Workflow"}`, gone };
    }
    if (isRecord(visit.reused)) {
        const reused = visit.reused;
        const from = numbered(numberOf, reused.workflowId);
        const entered = Date.parse(visit.enteredAt ?? "");
        const ended = Date.parse(visit.endedAt ?? visit.completedAt ?? "");
        const ran = Number.isFinite(entered) ? `ran ${workflowShortTime(entered, now)}` : null;
        const took = Number.isFinite(entered) && Number.isFinite(ended) && ended >= entered ? `took ${workflowDuration(ended - entered)}` : null;
        const gone = reused.originGone === true;
        return { kind: "reused", head: [`Reused from ${from ?? "an earlier Workflow"}`, ran, took].filter(Boolean).join(" · "), reason: null, origin: null,
            workflowId: text(reused.workflowId), executionId: text(reused.executionId), open: gone ? null : `Open in ${from ?? "the earlier Workflow"}`, gone };
    }
    return null;
}

/**
 * A node card's re-run words for its shown visit (`provenance`, workflowVisitProvenance's kind): "Reused from #2", or
 * "Supplied (provisioned)" with the ✎ mark; never as a step that ran. Null for a visit that ran here. Pure.
 */
export function workflowRerunCardWords(visit, { numberOf = null } = {}) {
    if (!isRecord(visit)) return null;
    if (isRecord(visit.supplied)) {
        const outcome = text(visit.outcome) ? workflowOutcomeWord(visit.outcome) : "a result";
        return { provenance: "supplied", fact: `Supplied (${outcome})`, mark: { glyph: "✎", word: "supplied" },
            title: `Supplied (${outcome}), did not run` };
    }
    if (isRecord(visit.reused)) {
        const from = numbered(numberOf, visit.reused.workflowId);
        const fact = `Reused from ${from ?? "an earlier Workflow"}`;
        return { provenance: "reused", fact, mark: null, title: fact };
    }
    return null;
}

/**
 * The timeline's re-run band (design §7.2): how many of its frames were reused and supplied, the last of them (`end`, where
 * the re-run starts) and the supplied one, with its label ("15 reused from #2", "2 reused + 1 supplied"). Null when none. Pure.
 */
export function workflowRerunTimeline(frames, { sourceNumber = null } = {}) {
    let reused = 0, supplied = 0, end = -1, suppliedIndex = null;
    (Array.isArray(frames) ? frames : []).forEach((frame, index) => {
        if (frame?.supplied === true) { supplied += 1; end = index; suppliedIndex = index; } else if (frame?.reused === true) { reused += 1; end = index; }
    });
    if (end < 0) return null;
    const label = supplied ? `${reused} reused + ${supplied} supplied`
        : `${reused} reused from ${Number.isSafeInteger(sourceNumber) ? `#${sourceNumber}` : "an earlier Workflow"}`;
    return { reused, supplied, end, suppliedIndex, label };
}

/**
 * The Log's rows (workflowActivity's, newest first) with each run of reused lines folded into one row ({ fold: "reused",
 * count, rows, what: "15 steps reused from #2" }); a supplied line stays its own row. Pure.
 */
export function workflowRerunLogRows(rows, { numberOf = null } = {}) {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const last = out[out.length - 1];
        if (row?.eventType !== "workflow.state_reused") { out.push(row); continue; }
        if (last?.fold === "reused") { last.rows.push(row); continue; }
        out.push({ fold: "reused", rows: [row], at: row.at, atTitle: row.atTitle, seq: row.seq, from: row.reusedFrom ?? null });
    }
    return out.map(item => (item?.fold === "reused"
        ? { ...item, count: item.rows.length, what: `${plural(item.rows.length, "step")} reused from ${numbered(numberOf, item.from) ?? "an earlier Workflow"}` }
        : item));
}
