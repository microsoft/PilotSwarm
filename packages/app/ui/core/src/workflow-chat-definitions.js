/**
 * Workflow Simplified stage 2.1b: the Workflow tab on a chat's own Workflow Definitions (spec "definitions" R1, R4–R6;
 * "editing" E2-1..E2-8; the coordinator's 2.1 readings Q1–Q10). A definition belongs to the chat and has revisions 1, 2,
 * 3; each Workflow runs the revision it started with. These helpers turn the server's list
 * (listChatWorkflowDefinitions) and reads (readChatWorkflowDefinition) into what the tab shows. Pure; the server decides
 * every save, start and delete.
 */
import { workflowChildrenOf, workflowStateOf } from "./workflow-owner.js";
import { WORKFLOW_RUN_STATE_WORDS, workflowShortTime } from "./workflow-words.js";
import { workflowV2LineDiff, workflowV2RunCommandFailure } from "./workflow-v2-commands.js";
import { formatLocalTime } from "./formatting.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() ? value.trim() : null);
const int = value => (Number.isSafeInteger(value) ? value : null);

/**
 * Stage 2.2: an agent's test runs on a test bench, a service session (service_kind workflow-test; the SDK's test-bench.ts):
 * never a Workflow, never a row of the session list.
 */
export const WORKFLOW_TEST_BENCH_KIND = "workflow-test";

/** Whether a session row is an agent's test bench (stage 2.2). */
export function isWorkflowTestBench(session) {
    return isRecord(session) && session.serviceKind === WORKFLOW_TEST_BENCH_KIND;
}

/** The most revision reads one chat keeps (each is immutable: a revision never changes once saved). */
export const CHAT_DEFINITION_READS_MAX = 20;

/** A time as the Workflow tab shows it: the clock alone when it is today, else the date too (local time). */
export function chatShownTime(value) {
    const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) return null;
    return formatLocalTime(ms, { clock: new Date().toDateString() === new Date(ms).toDateString() });
}

/** Whether a chat's definitions were read, as a list (the tab then shows them; otherwise it groups the chat's Workflows as stage 1 did). */
export function chatDefinitionsLoaded(entry) {
    return isRecord(entry) && Array.isArray(entry.items);
}

function revisionOf(item) {
    const test = isRecord(item.lastTest) && ["passed", "failed", "running"].includes(item.lastTest.verdict) ? item.lastTest : null;
    return {
        revision: item.revision, valid: item.valid === true, semver: text(item.semver), basedOn: int(item.basedOn),
        actor: isRecord(item.actor) ? item.actor : null, imported: item.imported === true, createdAt: text(item.createdAt),
        errorCount: int(item.errorCount) ?? 0,
        // Stage 2.2: the newest agent test of this revision, only when one ran.
        lastTest: test ? { testId: text(test.testId), verdict: test.verdict, at: text(test.at) } : null,
        // Stage 2.3: the package version a locked definition's revision is (P5), or null for the chat's own.
        package: isRecord(item.package) && text(item.package.semver)
            ? { packageName: text(item.package.packageName), semver: text(item.package.semver), cardDigest: text(item.package.cardDigest) } : null,
    };
}

/** Stage 2.2: a revision's last agent test in words ("Last test · passed 17:42", "Test running"), or null when none ran. */
export function chatLastTestWords(revision, timeOf = chatShownTime) {
    const test = revision?.lastTest;
    if (!test) return null;
    if (test.verdict === "running") return "Test running";
    const at = test.at ? timeOf(test.at) : null;
    return `Last test · ${test.verdict}${at ? ` ${at}` : ""}`;
}

/**
 * A chat's definitions as the tab shows them: each { definitionId, name, currentRevision, newestValidRevision, deleted,
 * updatedAt, revisions (newest first), workflows ([{ sessionId, number, revision, runStatus, createdAt }], the ones that
 * started, oldest first and numbered from 1), drafts (a stage 1 Workflow that never started, imported as a revision; Q5:
 * shown as that revision, never as a Workflow), newestId (the newest Workflow) }. Live ones by name, then deleted ones
 * that still have Workflows (their finished Workflows keep their copies, R6).
 */
export function chatDefinitionsModel(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const item of items) {
        if (!isRecord(item) || !text(item.definitionId) || !text(item.name)) continue;
        const revisions = (Array.isArray(item.revisions) ? item.revisions : [])
            .filter(entry => isRecord(entry) && int(entry.revision) !== null && entry.revision >= 1).map(revisionOf)
            .sort((a, b) => b.revision - a.revision);
        const rows = (Array.isArray(item.workflows) ? item.workflows : []).filter(entry => isRecord(entry) && text(entry.workflowSessionId));
        const started = rows.filter(entry => entry.runStatus !== null && entry.runStatus !== undefined);
        const workflows = started.map((entry, index) => ({ sessionId: entry.workflowSessionId, number: index + 1, revision: int(entry.revision),
            runStatus: text(entry.runStatus), createdAt: text(entry.createdAt) }));
        const deleted = Boolean(item.deletedAt);
        if (deleted && !workflows.length) continue;
        out.push({
            definitionId: item.definitionId, name: item.name, currentRevision: int(item.currentRevision) ?? 0,
            newestValidRevision: int(item.newestValidRevision), source: text(item.source), deleted, deletedAt: text(item.deletedAt),
            updatedAt: text(item.updatedAt), revisions, workflows,
            // Stage 2.3 (E2-7, P5, P6): a package's definition is locked; its package, and a newer version offered for the next Workflow.
            locked: item.locked === true, packageName: text(item.packageName),
            // Formal L1: a person's copy of a package's definition, and what it was copied from.
            copiedFrom: isRecord(item.copiedFrom) && text(item.copiedFrom.name) && int(item.copiedFrom.revision) !== null
                ? { name: text(item.copiedFrom.name), revision: int(item.copiedFrom.revision),
                    packageName: isRecord(item.copiedFrom.package) ? text(item.copiedFrom.package.packageName) : null,
                    semver: isRecord(item.copiedFrom.package) ? text(item.copiedFrom.package.semver) : null }
                : null,
            packageUpdate: isRecord(item.packageUpdate) && text(item.packageUpdate.semver) ? { semver: text(item.packageUpdate.semver) } : null,
            drafts: rows.filter(entry => entry.runStatus === null || entry.runStatus === undefined)
                .map(entry => ({ sessionId: entry.workflowSessionId, revision: int(entry.revision), createdAt: text(entry.createdAt) })),
            newestId: workflows.length ? workflows[workflows.length - 1].sessionId : null,
            children: rows.map(entry => entry.workflowSessionId),
        });
    }
    return out.sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.name.localeCompare(b.name) || a.definitionId.localeCompare(b.definitionId));
}

/** The definition shown when none is chosen: the live one saved most recently, else the first. */
export function chatDefinitionDefault(definitions) {
    const live = definitions.filter(item => !item.deleted);
    if (!live.length) return definitions[0] ?? null;
    return live.reduce((best, item) => ((Date.parse(item.updatedAt ?? "") || 0) > (Date.parse(best.updatedAt ?? "") || 0) ? item : best), live[0]);
}

/** The definition a Workflow (or a never-started stage 1 child) belongs to, with its row: { definition, workflow, draft }, or null. */
export function chatDefinitionOfWorkflow(definitions, sessionId) {
    if (!sessionId) return null;
    for (const definition of definitions) {
        const workflow = definition.workflows.find(item => item.sessionId === sessionId) ?? null;
        if (workflow) return { definition, workflow, draft: null };
        const draft = definition.drafts.find(item => item.sessionId === sessionId) ?? null;
        if (draft) return { definition, workflow: null, draft };
    }
    return null;
}

/**
 * UX2R-F1: a definition's newest Workflow, for the notice the Definition view shows when the tab opened on it by itself
 * after a Workflow ran ("Workflow #2 · Completed", one click away): { sessionId, number, text }, or null without one. Its
 * state as its row says it (workflowStateOf, from `byId` and `views`), else the list's run status in its one word.
 */
export function chatLatestWorkflow(definition, byId = null, views = null) {
    const workflow = Array.isArray(definition?.workflows) ? definition.workflows.at(-1) ?? null : null;
    if (!isRecord(workflow) || !text(workflow.sessionId)) return null;
    const row = isRecord(byId) && Object.hasOwn(byId, workflow.sessionId) ? byId[workflow.sessionId] : null;
    const state = row ? workflowStateOf(row, isRecord(views) ? views[workflow.sessionId] ?? null : null) : null;
    const status = workflow.runStatus === "cancelled" || workflow.runStatus === "stopped" ? "canceled" : workflow.runStatus === "admitted" ? "running" : workflow.runStatus;
    const word = state?.label ?? (typeof status === "string" && Object.hasOwn(WORKFLOW_RUN_STATE_WORDS, status) ? WORKFLOW_RUN_STATE_WORDS[status] : null);
    return { sessionId: workflow.sessionId, number: workflow.number, text: `Workflow #${workflow.number}${word ? ` · ${word}` : ""}` };
}

/** The number the next Workflow of a definition gets. */
export function chatNextWorkflowNumber(definition) {
    return (definition?.workflows?.length ?? 0) + 1;
}

/** Who saved a revision, as a person reads it (E2-2): "by the chat", "by Affan Dar", "imported". */
export function chatRevisionAuthorWords(revision) {
    if (revision?.imported) return "imported";
    const actor = revision?.actor;
    if (actor?.kind === "chat") return "by the chat";
    if (actor?.kind === "user") return `by ${text(actor.display) ?? "a person"}`;
    if (actor?.kind === "system") return actor.name === "imported" ? "imported" : "by the system";
    return null;
}

/**
 * One option of the revision picker: "Revision 6 · newest · by the chat · 09:41 · not valid · version 1.2.0" (`time` as
 * shown). UX2D-F8: `compact` (a phone, where the closed picker cut its author and time): the number, whether it is valid,
 * who and when, "6 · not valid · the chat · 09:41": the clock without seconds, another day's date without its year, and
 * neither "newest" nor the version (c0bb4171 DEV: "3 · newest · the chat · 22:18:01 · not valid" was 422 px in 320 px).
 */
export function chatRevisionOptionLabel(revision, { time = null, current = false, compact = false } = {}) {
    if (!revision) return "";
    if (compact) {
        const who = chatRevisionAuthorWords(revision);
        const when = text(time)?.replace(/^\d{4}-/, "").replace(/(\d{1,2}:\d{2}):\d{2}/, "$1") ?? null;
        return [String(revision.revision), revision.valid ? null : "not valid", who ? who.replace(/^by /, "") : null, when].filter(Boolean).join(" · ");
    }
    return [`Revision ${revision.revision}${current ? " · newest" : ""}`, chatRevisionAuthorWords(revision), text(time),
        revision.valid ? null : "not valid", revision.semver ? `version ${revision.semver}` : null].filter(Boolean).join(" · ");
}

const ACTIVE_RUN_STATUSES = new Set(["admitted", "running", "paused"]);

/**
 * What the Delete dialog says (UX2D-F10): what leaves, then what its Workflows keep, each in agreeing number ("Each of its
 * 3 Workflows keeps the revision it ran."), and that one not ended (running or paused) blocks it only when there is one.
 * { what, keep }.
 */
export function chatDeleteWords(definition) {
    const count = Array.isArray(definition?.revisions) ? definition.revisions.length : 0;
    const name = text(definition?.name) ?? "This definition";
    const what = `${name} and its ${count === 1 ? "revision" : `${count} revisions`} leave this chat's definitions: the chat can no longer change or start it.`;
    const workflows = Array.isArray(definition?.workflows) ? definition.workflows : [];
    if (workflows.length === 0) return { what, keep: "It has no Workflows." };
    const kept = workflows.length === 1 ? "Its Workflow keeps the revision it ran." : `Each of its ${workflows.length} Workflows keeps the revision it ran.`;
    const running = workflows.filter(item => ACTIVE_RUN_STATUSES.has(item?.runStatus)).length;
    return { what, keep: running
        ? `${kept} ${running === 1 ? "One of them has not ended" : `${running} of them have not ended`}, so it cannot be deleted until ${running === 1 ? "it ends" : "they end"}.`
        : kept };
}

/**
 * OF-S2-8 (owner, 2026-11-07T23:18Z): what the closed revision picker shows, the number alone ("6"); its open list keeps
 * each revision's detail (chatRevisionOptionLabel), and the line under the pickers says the rest (chatRevisionInfoWords).
 */
export function chatRevisionFace(revision) {
    return Number.isSafeInteger(revision) ? String(revision) : "—";
}

/**
 * OF-S2-8 (owner, 2026-11-07T23:18Z): the dimmed line under the Definition and Rev pickers, for the revision shown: who
 * saved it, when (local, no seconds), its version, "newest", "not valid" (always kept: a phone wraps the line, never cuts
 * it), and for a package's definition "from <package> <version> · locked". [{ key, text }] in that order, or [] when the
 * revision is not in the list. `time`: its saving time as the tab shows times; `timeTitle`: the same time in full. Pure.
 */
export function chatRevisionInfoWords(definition, revisionNumber, { time = null, timeTitle = null } = {}) {
    const revision = Array.isArray(definition?.revisions) ? definition.revisions.find(item => item.revision === revisionNumber) ?? null : null;
    if (!revision) return [];
    const parts = [];
    const who = chatRevisionAuthorWords(revision);
    if (who) parts.push({ key: "author", text: who });
    const when = text(time)?.replace(/(\d{1,2}:\d{2}):\d{2}/, "$1") ?? null;
    if (when) parts.push({ key: "time", text: when, title: text(timeTitle) });
    if (revision.semver) parts.push({ key: "version", text: `version ${revision.semver}` });
    if (revision.revision === definition.currentRevision) parts.push({ key: "newest", text: "newest" });
    if (!revision.valid) parts.push({ key: "not-valid", text: "not valid" });
    const words = chatPackageDefinitionWords(definition, revisionNumber);
    if (words) parts.push({ key: "package", text: words.line.replace(/^From /, "from ") });
    return parts;
}

/** One option of the definition picker: its name, "locked" for a package's (stage 2.3), and "deleted" for one deleted that still has Workflows. */
export function chatDefinitionOptionLabel(definition) {
    return [definition.name, definition.locked ? "locked" : null, definition.deleted ? "deleted" : null].filter(Boolean).join(" · ");
}

/**
 * Stage 2.3 (E2-7, P5, P6): what the Definition view says about a package's definition, or null for the chat's own:
 * { line: "From release-tools 1.2.0 · locked", semver, update: "Version 1.3.0 is available" or null }. `revision`: the
 * revision shown (its package version; a running Workflow keeps the version it started with).
 */
export function chatPackageDefinitionWords(definition, revision = null) {
    if (!definition?.locked) return null;
    const shown = definition.revisions.find(item => item.revision === revision) ?? definition.revisions[0] ?? null;
    const semver = shown?.package?.semver ?? null;
    const name = definition.packageName ?? shown?.package?.packageName ?? "a package";
    return {
        line: `From ${name}${semver ? ` ${semver}` : ""} · locked`,
        semver,
        update: definition.packageUpdate && !definition.deleted ? `Version ${definition.packageUpdate.semver} is available` : null,
    };
}

/**
 * Which Workflow tab a chat gets: "chat" (its own definitions) or "stage1" (its Workflows grouped by name, as stage 1 shows
 * them). Stage 1 when the definitions are not read (or this connection has none), when the Workflow shown is in no
 * definition, and (review S2UI-F4) when the chat has no definitions but has Workflow children (retained stage 1 Workflows
 * 0107 did not import): they stay reachable. A chat with neither gets its own (empty) tab. `byId`: the session rows. Pure.
 */
export function chatWorkflowTabKind(definitions, { ownerId = null, workflowId = null, byId = null } = {}) {
    if (!definitions) return "stage1";
    if (workflowId && !chatDefinitionOfWorkflow(definitions, workflowId)) return "stage1";
    if (definitions.length === 0 && ownerId && byId) {
        const children = Object.values(byId).some(row => isRecord(row) && row.parentSessionId === ownerId && row.sessionKind === "workflow"
            && !row.deletedAt && !isWorkflowTestBench(row));
        if (children) return "stage1";
    }
    return "chat";
}

/**
 * Review S2UI-F3: the move to a chat's definition (the definition picker's choice, and Make a copy's new definition): its
 * view at its newest revision, with no Workflow selected or remembered; and, when a Workflow of the chat is the session
 * shown, the chat is selected instead (a Workflow shown names its own definition first). { patch, selectOwner }. Pure.
 */
export function chatDefinitionChoice(definitionId, { workflowShown = false, view = null } = {}) {
    return {
        patch: { chatDefinitionId: definitionId, chatRevision: null, workflowId: null, definitionPanel: null, ...(view ? { view } : {}) },
        selectOwner: Boolean(workflowShown),
    };
}

/**
 * Stage 2 review S2UI-F1: the editor once a save of `submittedText` came back as `revision`. The text typed while it waited
 * stays: when the editor still holds what was sent, it is that revision, saved; otherwise the later edit is kept, unsaved,
 * based on the revision just saved (Save is offered for it). Pure.
 */
export function chatEditorAfterSave(current, submittedText, revision) {
    const text = typeof current?.text === "string" ? current.text : submittedText;
    return text === submittedText ? { base: revision, text, dirty: false } : { base: revision, text, dirty: true };
}

/**
 * The Definition view's change controls (Delete…, Make a copy, Use it for the next Workflow), from who may change the
 * chat's definitions: `changeAccess`, the last revision read that said so (it is the chat's, not a revision's). Stage 2
 * review CO-1: while another revision is read, the controls stay as the last read said, instead of going and coming back.
 * { commands, mayChange, deleteEnabled, deleteTitle }.
 */
export function chatDefinitionChangeControls(definition, changeAccess) {
    const commands = Boolean(changeAccess?.personCommands) && !definition?.deleted;
    const allowed = changeAccess?.allowed === true;
    return {
        commands, mayChange: commands && allowed, deleteEnabled: allowed,
        deleteTitle: allowed ? `delete ${definition?.name ?? "it"}; its finished Workflows keep their copies`
            : text(changeAccess?.reason) ?? "Only this chat's owner or an admin can delete it.",
    };
}

/**
 * Formal L1: what a copy says about where it came from: "Copied from release-tools/release-watch revision 2 (release-tools
 * 1.3.0)", or null for a definition that is not a copy.
 */
export function chatCopiedFromWords(definition) {
    const from = definition?.copiedFrom;
    if (!from) return null;
    const version = from.packageName && from.semver ? ` (${from.packageName} ${from.semver})` : "";
    return `Copied from ${from.name} revision ${from.revision}${version}`;
}

/** The revision a definition's view shows: the one chosen when it exists, else its newest (null before its first save). */
export function chatShownRevision(definition, chosen = null) {
    if (!definition) return null;
    if (Number.isSafeInteger(chosen) && definition.revisions.some(item => item.revision === chosen)) return chosen;
    return definition.currentRevision >= 1 ? definition.currentRevision : null;
}

/**
 * Start for the revision shown (Q10: a person starts the revision they look at): { enabled, revision, title } — refused, with
 * why, for a deleted definition, a chat that cannot take a person's commands, or a revision with errors (E2-5).
 */
export function chatStartControl(definition, revision, { allowed = true, reason = null, personCommands = true } = {}) {
    // (Stage 2.3: a package's locked definition starts as the chat's own do; only its YAML cannot change.)
    if (!definition || !Number.isSafeInteger(revision)) return { enabled: false, revision: null, title: "Nothing to start yet." };
    const entry = definition.revisions.find(item => item.revision === revision) ?? null;
    if (definition.deleted) return { enabled: false, revision, title: `${definition.name} was deleted, so it cannot start.` };
    if (!personCommands) return { enabled: false, revision, title: "This deployment does not take Workflow commands from people; ask the chat to start it." };
    if (!allowed) return { enabled: false, revision, title: reason ?? "Only this chat's owner or an admin can start its Workflows." };
    if (!entry?.valid) return { enabled: false, revision, title: `Revision ${revision} has errors, so it cannot start.` };
    return { enabled: true, revision, title: null };
}

/** The key of one revision's read in ui.chatDefinitionReads[ownerId]. */
export function chatDefinitionReadKey(definitionId, revision) {
    return `${definitionId}:${revision}`;
}

/**
 * A revision read's view model for the Definition view: a read model the graph projection takes (as a Workflow's
 * readWorkflow overview has it; no runs), with the revision's diagnostics and graph. Null without a read.
 */
export function chatRevisionReadModel(definition, value) {
    if (!definition || !isRecord(value) || !isRecord(value.revision)) return null;
    const revision = value.revision;
    return {
        workflowId: definition.definitionId,
        definition: { state: "published", semver: text(revision.semver), currentRevision: revision.revision, publishedRevision: revision.revision },
        revision: { revision: revision.revision, valid: revision.valid === true, name: definition.name, definitionHash: text(revision.yamlSha256),
            diagnostics: Array.isArray(revision.diagnostics) ? revision.diagnostics : [] },
        graph: isRecord(value.graph) ? value.graph : null,
        runs: [],
    };
}

/** Whether a read lets this caller save, start and delete: { allowed, reason, personCommands, yaml (the revision's, or null) }. */
export function chatReadAccess(value) {
    const viewer = isRecord(value?.viewer) ? value.viewer : null;
    return {
        allowed: viewer ? viewer.allowed === true : true,
        reason: text(viewer?.reason),
        personCommands: value?.personCommands === true,
        yaml: typeof value?.revision?.yaml === "string" ? value.revision.yaml : null,
    };
}

/**
 * Compare (E2-8): two revisions of a definition side by side, from their reads ({ phase, value, error }); the same shape
 * as a Workflow's revision compare (before, after, ready, failed, diff, summary). A side whose YAML this caller may not
 * read says so.
 */
export function chatRevisionCompare(readFrom, readTo, from, to) {
    const side = (revision, entry) => {
        const value = isRecord(entry?.value) ? entry.value : null;
        const yaml = typeof value?.revision?.yaml === "string" ? value.revision.yaml : null;
        return { revision, phase: entry?.phase ?? "missing", error: text(entry?.error), text: yaml, formatted: yaml !== null,
            hidden: Boolean(value) && yaml === null, valid: value ? value.revision?.valid === true : null };
    };
    const before = side(from, readFrom), after = side(to, readTo);
    const failed = [before, after].find(item => item.phase === "failed") ?? null;
    const hidden = [before, after].find(item => item.hidden) ?? null;
    const ready = before.text !== null && after.text !== null;
    const diff = ready ? workflowV2LineDiff(before.text, after.text) : null;
    const summary = failed ? `Revision ${failed.revision} could not be read: ${failed.error ?? "no reason given"}`
        : hidden ? "Only people who can change this definition can read its YAML."
            : !ready ? `Reading revisions ${from} and ${to}…`
                : diff.added || diff.removed ? `Revision ${from} → ${to}: +${diff.added} −${diff.removed} lines`
                    : `Revisions ${from} and ${to} are the same.`;
    return { before, after, ready, failed: failed ?? hidden, diff, summary };
}

/**
 * What a refused or unanswered save, start or delete says (E2-3: "Revision 6 was saved by the chat at 9:41 AM. Reload to
 * edit it."), with the time as this screen shows times (`timeOf`; UXFD-F14: the info line's form, workflowShortTime). { phase: "failed" | "unconfirmed", code, message,
 * stale (REVISION_STALE: the newest revision, to reload) }.
 */
export function chatDefinitionFailure(error, { timeOf = workflowShortTime } = {}) {
    const failure = workflowV2RunCommandFailure(error);
    const details = isRecord(error?.details) ? error.details : null;
    if (failure.code === "REVISION_STALE" && Number.isSafeInteger(details?.currentRevision)) {
        const by = chatRevisionAuthorWords({ actor: isRecord(details.savedBy) ? details.savedBy : null }) ?? "someone";
        const at = text(details.savedAt) ? timeOf(details.savedAt) : null;
        // Review 21:15Z: a refusal begins with what was not done, "Revision not saved: …".
        return { ...failure, stale: details.currentRevision,
            message: `Revision not saved: revision ${details.currentRevision} was saved ${by === "imported" ? "by an import" : by}${at ? ` at ${at}` : ""}. Reload to edit it.` };
    }
    // UX2D-F1: a stale refusal whose details did not come (an older server): Reload is still offered, and the words carry
    // no machine time.
    if (failure.code === "REVISION_STALE") {
        return { ...failure, stale: "newest", message: "Revision not saved: a newer revision was saved by someone else. Reload to edit it." };
    }
    if (failure.phase === "unconfirmed") {
        return { ...failure, stale: null, message: `No answer came, so it may or may not have happened: ${failure.message} Try again: the same request is not applied twice.` };
    }
    return { ...failure, stale: null };
}

/**
 * What asks a chat's definitions again: its own row changing (a turn of the chat saves or starts), and its Workflows
 * appearing, changing state or going away. A string; equal strings need no new read.
 */
export function chatDefinitionsStamp(byId, ownerId) {
    if (!ownerId) return "";
    const owner = byId?.[ownerId] ?? null;
    const children = workflowChildrenOf(byId, ownerId).map(session => `${session.sessionId}:${session.updatedAt ?? ""}:${session.status ?? ""}`);
    return [`${owner?.updatedAt ?? ""}:${owner?.status ?? ""}`, ...children].join(",");
}
