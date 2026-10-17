/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Orchestrations 1.0.75 and later opt into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
/**
 * Contracts:
 * - "agent-handoff-v2" (1.0.75+): handoff activity names and tag.
 * - "turn-control-v1" (1.0.81+): turns run as runTurnV4/runTurnEpochV4 with
 *   TURN_CONTROL_CAPABILITY; every other routed activity keeps the handoff
 *   names and tag.
 */
export type ActivityRoutingContract = "agent-handoff-v2" | "turn-control-v1";
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
    getSessionStatus: "getSessionStatusV2",
    listChildSessions: "listChildSessionsV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(AGENT_HANDOFF_CAPABILITY);
}

/**
 * Session workspaces (1.0.80): the turns of a session that has, or had, a
 * workspace, and the checkWorkspace and releaseWorkspace activities, go only
 * to workers that declare this tag. During a rolling deploy, an older worker
 * would run such a turn in its own folder, and it lacks the two activities.
 * The tag stands for the handoff contract as well: every worker that
 * declares it also declares AGENT_HANDOFF_CAPABILITY.
 */
export const WORKSPACE_CAPABILITY = "pilotswarm.workspaces.v1";

export function routeWorkspaceActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Session workspaces require Duroxide activity tag routing support");
    }
    return task.withTag(WORKSPACE_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any, versionedHandler = handler): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], versionedHandler);
}

/**
 * Session turn control (1.0.81): turns whose Stop and Steer go through the
 * CMS run only on workers that declare this tag. An older worker would run
 * the turn without listening for controls, while 1.0.81 no longer races a
 * Stop event. Every worker that declares it also declares
 * AGENT_HANDOFF_CAPABILITY and WORKSPACE_CAPABILITY.
 */
export const TURN_CONTROL_CAPABILITY = "pilotswarm.turn-control.v1";
export const TURN_CONTROL_ACTIVITY_NAMES = {
    runTurn: "runTurnV4",
    runTurn2: "runTurnEpochV4",
} as const;

/**
 * Route a V4 turn with only the turn-control capability tag. Fail closed
 * when the runtime cannot express that tag; never schedule an untagged turn.
 */
export function routeTurnControlActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Session turn control requires Duroxide activity tag routing support");
    }
    return task.withTag(TURN_CONTROL_CAPABILITY);
}

/** Register a turn-control activity name. The legacy and handoff names stay registered by registerHandoffActivity. */
export function registerTurnControlActivity(runtime: any, name: keyof typeof TURN_CONTROL_ACTIVITY_NAMES, handler: any): void {
    runtime.registerActivity(TURN_CONTROL_ACTIVITY_NAMES[name], handler);
}

/**
 * Cron prechecks (1.0.82): runCronPrecheck goes only to workers that declare
 * this tag. An older worker lacks the activity. Every worker that declares it
 * also declares the handoff, workspace and turn-control tags.
 */
export const CRON_PRECHECK_CAPABILITY = "pilotswarm.cron-precheck.v1";

export function routeCronPrecheckActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Cron prechecks require Duroxide activity tag routing support");
    }
    return task.withTag(CRON_PRECHECK_CAPABILITY);
}
