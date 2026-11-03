import { isJsonObject } from "./json.js";
import { WorkflowStoreError } from "./store.js";

/**
 * read_workflow's history pages (design 04 tool table: read_workflow "Bounded
 * history pagination"; R01 history; mock M04, M10).
 *
 * A run's node executions, inbox, outbox and (a test run's) intercepted
 * effects are each read one page at a time, newest first in one stable order:
 * an immutable key, then a unique id, so rows written at the same instant
 * keep their order. A read's first page of a section is its newest rows; its
 * `nextCursor` names the position after the page's last row, and a read with
 * that cursor returns the next page. Pages never repeat a row: each starts
 * strictly after the previous page's last key. The pages are separate reads,
 * not one snapshot. Over a stable result set (no row added below a position
 * already passed, none removed while paging) following the cursors lists
 * each row exactly once, without gaps. A row committed later is shown by a
 * later read: one newer than the
 * first page by a new first page; one whose key is older (its transaction
 * read the store's clock, or took its sequence, before an earlier row's
 * transaction committed) may sort below a position the pages already passed,
 * so the pass that began earlier does not list it and a new pass does. Rows
 * do change (a pending execution completes): each page shows its rows as
 * they are when it is read.
 *
 * The rows that are still open (pending executions, unclaimed input that has
 * not expired, pending deliveries, effects that still wait for an answer)
 * are the run's current state: the first read lists those that its pages do
 * not hold apart (open...), however old they are, at most
 * WORKFLOW_READ_OPEN_MAX each.
 *
 * A cursor is the JSON object a read returned, given back as it was. It binds
 * the workflow, the run, the section, the order and its format version, and
 * holds the exact key of the previous page's last row. A cursor that is not
 * one of these, or that names another workflow, run or section, is refused
 * (WORKFLOW_CURSOR_INVALID); nothing is guessed. It grants nothing: the read
 * that takes it is authorized as every read of that workflow is.
 */

/** A section of a run that a read pages. */
export type WorkflowReadSection = "executions" | "inbox" | "outbox" | "interceptions";

export const WORKFLOW_READ_SECTIONS: readonly WorkflowReadSection[] = ["executions", "inbox", "outbox", "interceptions"];

/** The rows of a section a first page holds when the read names no limit. */
export const WORKFLOW_READ_PAGE_DEFAULTS: Readonly<Record<WorkflowReadSection, number>> = Object.freeze({
    executions: 200, inbox: 50, outbox: 50, interceptions: 200,
});

/** The most rows a page of any section holds. */
export const WORKFLOW_READ_PAGE_MAX = 200;

/** The most open rows of a section a read lists apart from its page. */
export const WORKFLOW_READ_OPEN_MAX = 500;

/** The cursor format; a cursor of another version is refused, and the first page is read again. */
export const WORKFLOW_READ_CURSOR_VERSION = 1;

/** Where a section's next page starts: the exact key of the previous page's last row. */
export type WorkflowReadPosition =
    | { enteredAt: string; nodeExecutionId: string }
    | { seq: string }
    | { createdAt: string; exchangeId: string };

export type WorkflowReadCursor = {
    v: typeof WORKFLOW_READ_CURSOR_VERSION;
    workflowId: string;
    runId: string;
    section: WorkflowReadSection;
    order: "newest_first";
    after: WorkflowReadPosition;
};

/** A store time as the store writes it (isoUtc: microseconds, UTC). */
const EXACT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** A positive bigint sequence. */
const SEQUENCE = /^[1-9][0-9]{0,18}$/;
const ID_MAX = 256;

export function workflowReadCursor(workflowId: string, runId: string, section: WorkflowReadSection, after: WorkflowReadPosition): WorkflowReadCursor {
    return { v: WORKFLOW_READ_CURSOR_VERSION, workflowId, runId, section, order: "newest_first", after };
}

const invalidCursor = (message: string): WorkflowStoreError => new WorkflowStoreError("WORKFLOW_CURSOR_INVALID", message);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= ID_MAX;

/** The position of a section's cursor, checked for that section; throws WORKFLOW_CURSOR_INVALID. */
function positionOf(section: WorkflowReadSection, after: unknown): WorkflowReadPosition {
    if (!isJsonObject(after)) throw invalidCursor("cursor.after must be the position a read's nextCursor holds.");
    const keys = Object.keys(after).sort().join(",");
    if (section === "executions") {
        if (keys !== "enteredAt,nodeExecutionId" || typeof after.enteredAt !== "string" || !EXACT_TIME.test(after.enteredAt) || !isId(after.nodeExecutionId)) {
            throw invalidCursor("cursor.after must be { enteredAt, nodeExecutionId } of a node execution, as a read gave it.");
        }
        return { enteredAt: after.enteredAt, nodeExecutionId: after.nodeExecutionId };
    }
    if (section === "outbox") {
        if (keys !== "createdAt,exchangeId" || typeof after.createdAt !== "string" || !EXACT_TIME.test(after.createdAt) || !isId(after.exchangeId)) {
            throw invalidCursor("cursor.after must be { createdAt, exchangeId } of a sent message, as a read gave it.");
        }
        return { createdAt: after.createdAt, exchangeId: after.exchangeId };
    }
    if (keys !== "seq" || typeof after.seq !== "string" || !SEQUENCE.test(after.seq)) {
        throw invalidCursor(`cursor.after must be { seq } of ${section === "inbox" ? "an input" : "an intercepted effect"}, as a read gave it.`);
    }
    return { seq: after.seq };
}

/**
 * A cursor a read was given (its nextCursor, given back as it was), checked for the workflow read (`workflowId`) and,
 * when the read names one, its run (`runId`): its version, workflow, run, section, order and position. Throws
 * WORKFLOW_CURSOR_INVALID for anything else; it says what is wrong and never guesses.
 */
export function parseWorkflowReadCursor(value: unknown, workflowId: string, runId: string | null): WorkflowReadCursor {
    if (!isJsonObject(value)) throw invalidCursor("cursor must be the nextCursor object a read returned, given back as it was.");
    if (Object.keys(value).sort().join(",") !== "after,order,runId,section,v,workflowId") {
        throw invalidCursor("cursor must have exactly the fields of a read's nextCursor: v, workflowId, runId, section, order and after.");
    }
    if (value.v !== WORKFLOW_READ_CURSOR_VERSION) {
        throw invalidCursor(`This cursor is from another version of the read (${JSON.stringify(value.v)}); read the first page again.`);
    }
    if (value.workflowId !== workflowId) throw invalidCursor("This cursor is for another workflow.");
    if (!isId(value.runId)) throw invalidCursor("cursor.runId must be a run id.");
    if (runId !== null && value.runId !== runId) throw invalidCursor("This cursor is for another run than the one named.");
    const section = value.section;
    if (typeof section !== "string" || !(WORKFLOW_READ_SECTIONS as readonly string[]).includes(section)) {
        throw invalidCursor(`cursor.section must be one of ${WORKFLOW_READ_SECTIONS.join(", ")}.`);
    }
    if (value.order !== "newest_first") throw invalidCursor("cursor.order must be newest_first.");
    const typed = section as WorkflowReadSection;
    return workflowReadCursor(workflowId, value.runId, typed, positionOf(typed, value.after));
}

/** The page size of a read: `limit` when it names one (1 to WORKFLOW_READ_PAGE_MAX), otherwise the section's default. */
export function workflowReadLimit(limit: unknown, section: WorkflowReadSection): number {
    if (limit === undefined || limit === null) return WORKFLOW_READ_PAGE_DEFAULTS[section];
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_READ_PAGE_MAX) {
        throw new WorkflowStoreError("WORKFLOW_READ_INVALID", `limit must be an integer from 1 to ${WORKFLOW_READ_PAGE_MAX}.`);
    }
    return limit;
}

/**
 * The HTTP status of each refusal a read of a workflow gives (the human read adapter, readWorkflow; the agent tool
 * answers the code itself): what does not exist 404, an invalid read 400.
 */
export const WORKFLOW_READ_STATUS: Readonly<Record<string, number>> = Object.freeze({
    WORKFLOW_NOT_FOUND: 404, RUN_NOT_FOUND: 404, EXECUTION_NOT_FOUND: 404, KV_REVISION_NOT_FOUND: 404, DEFINITION_REVISION_NOT_FOUND: 404, WORKFLOW_CURSOR_INVALID: 400,
    WORKFLOW_READ_INVALID: 400,
});
