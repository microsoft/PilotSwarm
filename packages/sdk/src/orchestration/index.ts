/**
 * Durable session orchestration v1.0.86: a spawned child's workspace selection
 * (inherit, a record, null or "none", applied by applySessionWorkspaceSelection) and
 * the shared-workspace note in a Workflow agent step's sub-agent system message. Both
 * change what a spawn passes to its activities, so 1.0.85 (durable session titles) is
 * frozen in orchestration_1_0_85/ as release 0.8.12 shipped it. Turns keep the
 * tool-composition activity contract (LIVE_SESSION_PROXY_CONTRACT), with the workflow
 * intake, turn controls and workspace protocol.
 *
 * Flat event loop backed by a KV FIFO work buffer:
 *   1. `createRuntime` builds the mutable runtime and runs startup gates.
 *   2. `runLoop` repeatedly drains the durable message queue + timer fires into
 *      the KV FIFO, dispatches one unit of work, and continues-as-new when idle.
 *
 * Module layout:
 *   - state.ts        types, constants, createInitialState
 *   - utils.ts        pure helpers (prompt parsing, context usage, error checks)
 *   - lifecycle.ts    status, releaseAffinity, commands, child digest, CAN
 *   - queue.ts        KV FIFO, drain, decide
 *   - turn.ts         processPrompt, handleTurnResult, processTimer
 *   - agents.ts       sub-agent tracking, tool actions, shutdown cascade
 *   - runtime.ts      createRuntime, runLoop
 *   - intake-state.ts the intake state that continue-as-new carries (never KV)
 *   - intake-machine.ts the intake's pure transitions
 *   - intake-wiring.ts the intake's store writes from drain, the sweep and the wake
 *
 * @internal
 */
import type { OrchestrationInput } from "../types.js";
import { CURRENT_ORCHESTRATION_VERSION, createRuntime, runLoop } from "./runtime.js";
import { DURABLE_SESSION_LATEST_VERSION } from "../orchestration-version.js";

export { CURRENT_ORCHESTRATION_VERSION };

export function* durableSessionOrchestration_1_0_86(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const runtime = yield* createRuntime(ctx, input, {
        currentVersion: CURRENT_ORCHESTRATION_VERSION,
        latestVersion: DURABLE_SESSION_LATEST_VERSION,
    });
    if (runtime.state.orchestrationResult !== null) return runtime.state.orchestrationResult;
    return yield* runLoop(runtime);
}
