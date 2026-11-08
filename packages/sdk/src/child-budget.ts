/**
 * One budget of running children per chat (Workflow Simplified stage 2.4; stage 2 review S2RT-F3): a chat's running
 * sub-agents and its active Workflows share WORKFLOW_CHILD_BUDGET_MAX. spawn_agent (both its inline and its orchestrated
 * path) and a Workflow's Start count the same children, with the same rule, under an exclusive lock on the chat's row and
 * in the same transaction as the child's creation, so two creations at the same moment cannot both pass at 49.
 *
 * Counted, among the chat's direct children that are not deleted, system or service sessions (a test bench is a service
 * session):
 * - a sub-agent (any session that is not a Workflow) whose state is pending (made, not started yet) or running;
 * - a Workflow whose live run is admitted, running or paused;
 * - a Workflow a Start claimed and has not admitted yet (its creation records the chat's pin and it has no run): the claim
 *   is its reservation, kept across an interrupted creation, and reused when the same operation goes on.
 */
export const WORKFLOW_CHILD_BUDGET_MAX = 50;

/** The active statuses of a Workflow's live run that count (the same everywhere). */
export const CHILD_BUDGET_RUN_STATUSES: readonly string[] = ["admitted", "running", "paused"];

/** The sub-agent states that count. */
export const CHILD_BUDGET_AGENT_STATES: readonly string[] = ["pending", "running"];

/**
 * The count, as SQL over the quoted schema `s` (`"schema"`): $1 the chat, $2 a child to leave out (the one being made; ''
 * for none). Returns one row `{ n }`.
 */
export function childBudgetCountSql(s: string): string {
    return `SELECT count(*)::int AS n FROM ${s}.sessions c
     WHERE c.parent_session_id = $1 AND c.session_id <> $2 AND c.deleted_at IS NULL AND c.is_system IS NOT TRUE AND c.service_kind IS NULL
       AND ((c.session_kind IS DISTINCT FROM 'workflow' AND c.state IN (${CHILD_BUDGET_AGENT_STATES.map(state => `'${state}'`).join(", ")}))
         OR (c.session_kind = 'workflow' AND (
              EXISTS (SELECT 1 FROM ${s}.workflow_runs r WHERE r.workflow_session_id = c.session_id AND r.mode = 'live'
                        AND r.status IN (${CHILD_BUDGET_RUN_STATUSES.map(status => `'${status}'`).join(", ")}))
           OR (c.creation_config -> 'workflowV2' ? 'chatPin'
               AND NOT EXISTS (SELECT 1 FROM ${s}.workflow_runs r WHERE r.workflow_session_id = c.session_id)))))`;
}

/** The refusal's words, the same for spawn_agent and Start. */
export function childBudgetWords(count: number, max: number = WORKFLOW_CHILD_BUDGET_MAX): string {
    return `This chat already has ${count} running sub-agents and Workflows (max ${max}). Wait for some to end before starting another.`;
}

/**
 * spawn_agent's admission (S2RT-F3; coordinator decision: the switch is the boundary). With Workflows on (`workflowsOn`):
 * the shared budget, counted first (`countBudgetChildren`) and counted again atomically when the child is made (the
 * creation's `childBudget`). With Workflows off: exactly the admission before stage 2, its count of the direct sub-agents
 * that are running (`directChildren`) and no lock at the creation.
 */
export interface SpawnAgentAdmission {
    /** The children counted against the budget now. */
    count: number;
    /** The refusal's words when `count` reached `max`, else null. */
    refusal: string | null;
    /** The creation's options: the atomic budget with Workflows on; none with them off. */
    creation: { childBudget?: { max: number } };
}

export async function spawnAgentAdmission(input: {
    workflowsOn: boolean;
    parentSessionId: string;
    max: number;
    isSystem?: boolean;
    countBudgetChildren?: ((parentSessionId: string) => Promise<number>) | null;
    directChildren: () => Promise<ReadonlyArray<{ isSystem?: boolean; status?: string }>>;
}): Promise<SpawnAgentAdmission> {
    const budgeted = input.workflowsOn && typeof input.countBudgetChildren === "function";
    const count = budgeted
        ? await input.countBudgetChildren!(input.parentSessionId)
        : (await input.directChildren()).filter(child => !child.isSystem).filter(child => child.status === "running").length;
    const refusal = count < input.max ? null : budgeted
        ? `[SYSTEM: spawn_agent failed — you already have ${count} running sub-agents and Workflows (max ${input.max}). Wait for some to complete before spawning more.]`
        : `[SYSTEM: spawn_agent failed — you already have ${count} running sub-agents (max ${input.max}). Wait for some to complete before spawning more.]`;
    return { count, refusal, creation: spawnAgentCreationBudget(input.workflowsOn, input.isSystem === true, input.max) };
}

/** The creation's budget option for a sub-agent: the atomic budget only with Workflows on, and never for a system agent. */
export function spawnAgentCreationBudget(workflowsOn: boolean, isSystem: boolean, max: number): { childBudget?: { max: number } } {
    return workflowsOn && !isSystem ? { childBudget: { max } } : {};
}
