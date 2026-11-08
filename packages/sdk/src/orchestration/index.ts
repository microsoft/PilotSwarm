/**
 * Durable session orchestration v1.0.83: the latest version (owner decision 2026-11-08T15:30Z,
 * pse/decision/always-on-scope-20261108T1530). New sessions start here and every continue-as-new targets it; 1.0.82 is
 * frozen in orchestration_1_0_82/ and its sessions move here at their next continue-as-new. It is 1.0.82 plus the
 * durable workflow intake (design docs/proposals/workflow-durable-intake.md, revision 3 with amendment 2): its turns are
 * workflow request turns (controller 1.9.0's request, agent and parallel states). Its continue-as-new never targets an
 * older version (lifecycle.ts versionedContinueAsNew).
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

export function* durableSessionOrchestration_1_0_83(
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
