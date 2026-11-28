/**
 * Phase 3 I7 (M1): the check a client makes before it sends a re-run. rerunFrom on startSessionWorkflowDefinition and
 * rerunPlan on readWorkflow go only to a server that advertises workflows.rerun: true. An older server ignores rerunFrom and
 * would start a fresh run from step 1, so a missing advert, one without rerun, or a bootstrap that cannot be read fails closed
 * (501 WORKFLOW_API_UNAVAILABLE) before anything is sent. Every other call is sent as it is.
 */

/** Whether this call sends a re-run: a rerunFrom or rerunPlan that the request builder sends (not absent, not null). */
export function sendsWorkflowRerun(name, params) {
    const field = name === "startSessionWorkflowDefinition" ? "rerunFrom" : name === "readWorkflow" ? "rerunPlan" : null;
    return field !== null && params?.[field] !== undefined && params?.[field] !== null;
}

/** Resolves when `readCapabilities()` (the server's `workflows` advert) says rerun: true; rejects 501 otherwise. */
export async function requireWorkflowRerun(readCapabilities) {
    const advert = await Promise.resolve().then(readCapabilities).catch(() => null);
    if (advert?.rerun === true) return;
    throw Object.assign(new Error("This PilotSwarm portal predates Workflow re-run from a step (workflows.rerun is not advertised); "
        + "upgrade pilotswarm-web before calling rerun_from or rerun_plan."), { code: "WORKFLOW_API_UNAVAILABLE", status: 501 });
}
