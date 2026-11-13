/**
 * Durable recipient intake: frozen 1.0.83 and live 1.0.84 on the native
 * duroxide runtime and PostgreSQL (design docs/proposals/workflow-durable-
 * intake.md 3, 5.5, 6.2 and section 8). The orchestration, its continue-as-
 * new, the real worker activities (V5/V6 normal and epoch turns) over the real CMS,
 * and the real intake activities over the real workflow store run as a
 * worker runs them; the frozen handler is registered by this test alone
 * (workflow-intake-native-fixture.js). Test doubles (TEST_DOUBLES): the
 * model session is scripted, the session manager is a fake, the workspace
 * provider of the last case is the fake provider, and the CMS provider
 * budget store is hidden. A failing case records its evidence (boundary,
 * native histories, activity calls, intake rows, transcript records) before
 * its fixture closes; a passing one records a compact receipt.
 *
 * - An enveloped copy is claimed and held; decide binds it and starts a turn
 *   of its own that carries it in the selected turn's `intake` field under
 *   its version's capability tag; the model gets the item's canonical text before
 *   the turn's prompt; sent, the invocation ends completed in the store; the
 *   transcript records the item once, as its plain copy would be; the
 *   session then continues as new on its selected version with nothing of the intake.
 * - An attempt that sends and fails retries across a continue-as-new that
 *   carries the retry marker and the retry's count; the retry carries the
 *   same invocation, completes it, and turn start records the item no
 *   second time.
 * - A run that ends before its send leaves the invocation not dispatched,
 *   settled so in the store.
 * - Decision A1: a closed workspace gate refuses the first attempt before
 *   any model run, and the invocation is parked for the gate; a person's
 *   message ends the gate's wait, and its turn, past the gate this time,
 *   carries the same invocation to completion.
 * - Exposure protocol revision 2: each carrying turn's `intake` field has the
 *   batch with its claims, an attempt id recorded for that activity, and
 *   `sentBefore` only on the invocation's own retry; the real store admits
 *   an attempt's include before its send (its exposure record names the
 *   first admitted attempt), and a run that never asks leaves none.
 *
 * These cover the orchestration's own boundaries natively; they are not an
 * activation, a mixed-version, a crash-redelivery or a model qualification.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { admitAndSend, INTAKE_NATIVE_VARIANTS, scheduled, eventText, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-intake-native-fixture.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/intake.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { WORKFLOW_COMMAND_QUEUE } from "../../src/workflow/runtime.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT } from "../../src/orchestration/state.ts";

const getEnv = useSuiteEnv(import.meta.url);
/**
 * The sender a workflow's message is recorded with (batch 7, w-4; SF-2): kind workflow, named by its session (a send's
 * text names no workflow), with the header's type and ids, read from the message's own header.
 */
const workflowSender = text => {
    const field = name => new RegExp(`\\b${name}=(\\S+?)[\\s\\]]`).exec(text)?.[1] ?? null;
    return { kind: "workflow", display: `workflow ${field("from").slice(0, 8)}`, workflow: { type: "message", sessionId: field("from"), runId: field("run") } };
};

/** A run that sends: the real store admits the carried items first (exposure r2), as ManagedSession asks before its send. */
const sends = result => async (_call, _prompt, opts) => {
    expect(await admitAndSend(opts)).not.toBe("omit");
    return { events: [], ...result };
};
const callsOf = (h, name) => h.calls.filter(call => call.name === name
    && (call.input?.sessionId === h.sessionId || call.input?.recipientSessionId === h.sessionId));
const waiting = ({ history }) => history.some(event => event.kind === "QueueSubscribed");

/** The recipient's transcript records of one client message id. */
async function recordsOf(h, clientMessageId) {
    const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
    return events.filter(event => Array.isArray(event.data?.clientMessageIds) && event.data.clientMessageIds.includes(clientMessageId));
}

describe.each(INTAKE_NATIVE_VARIANTS)("workflow durable intake: native $version ($turnName, $contract)", ({ version, turnName, epochTurnName, turnTag, intakeNativeCase }) => {
    it("an epoch-start turn answers a real Workflow request and its response wakes the controller", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        let requestId;
        let response;
        let fixture;
        const script = async (_call, prompt, opts) => {
            expect(prompt).toContain("type=request");
            requestId = /\brequest=([^\s\]]+)/.exec(prompt)?.[1];
            expect(requestId).toEqual(expect.any(String));
            const runId = /\brun=([^\s\]]+)/.exec(prompt)?.[1];
            const run = await fixture.store.readRun(runId);
            expect(run).not.toBeNull();
            // Wait until the controller is blocked on its command queue, so initial collection cannot substitute for a wake.
            await vi.waitFor(async () => {
                const info = await fixture.client.getInstanceInfo(run.controllerInstanceId);
                const history = await fixture.client.readExecutionHistory(run.controllerInstanceId, info.currentExecutionId);
                expect(history.some(event => event.kind === "QueueSubscribed" && eventText(event).includes(WORKFLOW_COMMAND_QUEUE))).toBe(true);
            }, { timeout: 30_000, interval: 50 });
            expect(opts.controlToolBridge.respondSessionRequest).toBeTypeOf("function");
            response = JSON.parse(await opts.controlToolBridge.respondSessionRequest({
                request_id: requestId, operation_id: "approve", response: { approved: true },
            }));
            return { type: "completed", content: "approved", events: [] };
        };
        await intakeNativeCase(getEnv(), "epoch request response and wake", script, { inlineClient: true, workflowController: true }, async h => {
            fixture = h;
            await h.start({ iteration: 1, transcriptEpoch: 1, epochStartPending: true, epochStartIteration: 1 });
            await h.until(waiting, "the epoch session waits for a request");
            const created = await createWorkflow({ catalog: h.catalog, store: h.store, duroxideClient: h.client }, {
                workflowSessionId: randomUUID(), parentSessionId: h.sessionId,
                operationId: "epoch-request", actor: { kind: "system", name: "native-intake-test" }, notifyParent: false,
                yaml: `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: epoch-request, version: "1.0.0" }
initial: ask
contracts:
  Approval@1: { schema: true, response: { schema: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false } } }
states:
  ask:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    timeoutSeconds: 3600
    transition: { next: { responded: done, declined: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`, start: { inputs: {} },
            });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            expect(created.receipt.run.runId).toEqual(expect.any(String));
            const completed = () => h.store.readRun(created.receipt.run.runId);
            await h.until(async () => response !== undefined && (await completed())?.status === "completed",
                "the native response wakes and completes the request workflow", 30_000);
            expect(response).toMatchObject({ ok: true });
            expect(await h.store.readRequest(requestId)).toMatchObject({ status: "responded" });
            expect(await completed()).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { approved: true } });
            expect(await h.q("SELECT state FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [requestId]))
                .toEqual([{ state: "dispatched" }]);
            const controller = (await completed()).controllerInstanceId;
            const controllerInfo = await h.client.getInstanceInfo(controller);
            const controllerHistory = await h.client.readExecutionHistory(controller, controllerInfo.currentExecutionId);
            expect(controllerHistory.some(event => eventText(event).includes('"type":"workflow-wake"')
                && eventText(event).includes('"reason":"response"') && eventText(event).includes(requestId))).toBe(true);
            const turns = callsOf(h, epochTurnName);
            expect(turns).toHaveLength(1);
            expect(turns[0].tag).toBe(turnTag);
            expect(turns[0].input).toMatchObject({ epochStart: true, transcriptEpoch: 1 });
            expect(callsOf(h, turnName)).toHaveLength(0);
            expect(scheduled((await h.histories())[0], epochTurnName)).toHaveLength(1);
        });
    });
    it("a claimed copy is bound and carried by a turn of its own; sent, it ends completed, recorded once; the session continues as new on its version", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        await intakeNativeCase(getEnv(), "arrival to completion", sends({ type: "completed", content: "noted" }), {}, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            const done = await h.until(async ({ info }) => {
                const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
                return row?.processing === "completed" && Number(info.currentExecutionId) >= 2;
            }, "the invocation ends completed and the session continues as new");
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
            expect(row).toMatchObject({ state: "admitted", processing: "completed" });

            // One model run: the item's canonical text, then the intake's own-turn prompt.
            expect(h.prompts).toHaveLength(1);
            expect(h.prompts[0].startsWith(`${expected.text}\n\n`)).toBe(true);
            expect(h.prompts[0]).toContain(INTERNAL_SYSTEM_TURN_PROMPT);
            // The selected turn ran under its version's tag with the bound invocation in its own field: the batch with
            // its claims, the attempt's recorded id, and no retry flag (exposure r2, section 2).
            const turns = callsOf(h, turnName);
            expect(turns.map(turn => turn.tag)).toEqual([turnTag]);
            expect(turns[0].input.intake).toEqual({
                invocationId: row.invocationId, attemptId: expect.any(String), sentBefore: false,
                items: [{ exchangeId: input.envelope.exchangeId, claimId: row.claimId, clientMessageId: expected.clientMessageId, text: expected.text }],
            });
            // The store admitted the include before the send: its exposure record names this attempt.
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId))
                .toMatchObject({ invocationId: row.invocationId, recipientSessionId: h.sessionId, attemptId: turns[0].input.intake.attemptId });
            expect(h.calls.some(call => /^runTurn(2|V3|V4|EpochV4)?$/.test(call.name))).toBe(false);
            // The store writes, each under the workflow-request tag: the claim, the bind, then the end.
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.claim).map(call => call.tag)).toEqual([WORKFLOW_REQUEST_CAPABILITY]);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.tag])).toEqual([
                ["bind", WORKFLOW_REQUEST_CAPABILITY], ["end", WORKFLOW_REQUEST_CAPABILITY],
            ]);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle)[1].input).toMatchObject({ invocationId: row.invocationId, outcome: "completed" });

            // The transcript records the item once, as its plain copy would be; the plain copy itself is never read.
            const records = await recordsOf(h, expected.clientMessageId);
            expect(records.map(event => [event.eventType, event.data.content, event.data.sender])).toEqual([["system.message", expected.text, workflowSender(expected.text)]]);
            const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
            expect(events.some(event => JSON.stringify(event.data ?? {}).includes(`plain-${input.envelope.exchangeId}`))).toBe(false);

            // One turn in the first execution; continue-as-new keeps this version and carries no intake.
            const [first, ...later] = await h.histories();
            expect(scheduled(first, turnName)).toHaveLength(1);
            expect(done.info.orchestrationVersion).toBe(version);
            const started = later.at(-1)[0];
            expect(started.kind).toBe("OrchestrationStarted");
            expect(eventText(started)).not.toContain('"intake":');
            expect(eventText(started)).not.toContain("intakeRetryInvocationId");
            expect(done.status.status).toBe("Running");
        });
    });

    it("an attempt that sends and fails retries across a continue-as-new carrying the marker; the retry carries the same invocation to completion, recorded once", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        await intakeNativeCase(getEnv(), "error retry across continue-as-new", async (call, _prompt, opts) => {
            expect(await admitAndSend(opts)).toBe("include");
            return call === 1 ? { type: "error", message: "the model call failed", events: [] } : { type: "completed", content: "noted", events: [] };
        }, {}, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            // The retry waits 15 s on a durable timer, continues as new, and its execution completes the invocation.
            await h.until(async ({ info }) => {
                const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
                return row?.processing === "completed" && Number(info.currentExecutionId) >= 3;
            }, "the retry completes the invocation", 150_000);
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);

            // Two model runs, each with the item's text first; two turns of the same invocation, the second its retry.
            expect(h.prompts).toHaveLength(2);
            for (const prompt of h.prompts) expect(prompt.startsWith(`${expected.text}\n\n`)).toBe(true);
            const turns = callsOf(h, turnName);
            expect(turns.map(turn => [turn.input.intake.invocationId, turn.input.retryCount ?? 0])).toEqual([[row.invocationId, 0], [row.invocationId, 1]]);
            // Exposure r2: each carrying activity has its own recorded attempt id; only the retry, which took the marker, says
            // sentBefore. The first attempt's admission recorded the exposure; the retry was admitted as the invocation's own retry.
            const [firstAttempt, retryAttempt] = turns.map(turn => turn.input.intake);
            expect([firstAttempt.sentBefore, retryAttempt.sentBefore]).toEqual([false, true]);
            expect(retryAttempt.attemptId).not.toBe(firstAttempt.attemptId);
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toMatchObject({ attemptId: firstAttempt.attemptId });
            // One bind; one end, completed.
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                ["bind", null], ["end", "completed"],
            ]);

            // Natively: the first execution schedules the failed attempt; its continue-as-new carries the invocation, the
            // retry marker and the owed retry with its count (review Q-W2-7); the next execution schedules the retry.
            const [first, second] = await h.histories();
            expect(scheduled(first, turnName)).toHaveLength(1);
            expect(scheduled(second, turnName)).toHaveLength(1);
            const restarted = eventText(second[0]);
            expect(second[0].kind).toBe("OrchestrationStarted");
            expect(restarted).toContain(`"intakeRetryInvocationId":"${row.invocationId}"`);
            expect(restarted).toContain('"ownedRetry":{"prompt":"');
            expect(restarted).toContain('"retryCount":1,"thrownTurnKey":null,"fresh":false}');

            // Turn start recorded the item on the first attempt and found it recorded on the retry.
            const records = await recordsOf(h, expected.clientMessageId);
            expect(records.map(event => [event.eventType, event.data.sender])).toEqual([["system.message", workflowSender(expected.text)]]);
        });
    });

    it("a run that ends before its send leaves the invocation not dispatched, and the store settles it so", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        // As ManagedSession answers a held Stop: before its send, so without asking the admission or including the items.
        await intakeNativeCase(getEnv(), "run ends before its send", () => ({ type: "stopped", reason: "Stopped by user", events: [] }), {}, async h => {
            const input = await h.send(1);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "not_dispatched",
                "the invocation ends not dispatched");
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
            expect(row).toMatchObject({ state: "admitted", processing: "not_dispatched" });
            expect(callsOf(h, turnName)).toHaveLength(1);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                ["bind", null], ["end", "not_dispatched"],
            ]);
            // The run never asked the admission: no exposure is recorded, and the end stands as asked.
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toBeNull();
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle)[1].result).toEqual({ ok: true, result: { ended: true } });
        });
    });

    it("decision A1: a closed workspace gate refuses the first attempt before any model run; a person's message ends the gate's wait and its turn carries the same invocation to completion", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-native-ws-"));
        fs.mkdirSync(path.join(root, "repo"), { recursive: true });
        const workspaceProvider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        workspaceProvider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held elsewhere", times: 1 });
        try {
            await intakeNativeCase(getEnv(), "gate A1: workspace refusal, then a person's message", sends({ type: "completed", content: "noted" }), {
                workspaceProvider,
                managerExtras: { holdWorkspaceFolders: vi.fn(), noteWorkspaceAttached: vi.fn(), releaseWorkspace: vi.fn(async () => ({ released: true })) },
            }, async h => {
                const input = await h.send(1);
                const expected = await h.expectedItem(input);
                await h.start({ config: { workspace: { schema: 1, root: "a", folder: "repo" } } });
                await h.until(waiting, "the session waits for its messages");
                await h.deliver(input);
                // The first attempt is refused at the workspace check: the session waits for the gate's retry.
                await h.until(({ status }) => {
                    const custom = h.customStatus(status);
                    return custom.status === "waiting" && custom.gate === "workspace";
                }, "the workspace gate refused the first attempt");
                expect(h.prompts).toHaveLength(0);
                expect(callsOf(h, turnName)).toHaveLength(1);
                const invocationId = callsOf(h, turnName)[0].input.intake.invocationId;

                await h.say("hello", "person-1");
                await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "completed",
                    "the message's turn completes the invocation");
                // The message's turn passed the gate this time and carried the same invocation; the model got the item first.
                const turns = callsOf(h, turnName);
                expect(turns.map(turn => turn.input.intake?.invocationId ?? null)).toEqual([invocationId, invocationId]);
                expect(h.prompts).toHaveLength(1);
                expect(h.prompts[0].startsWith(`${expected.text}\n\nhello`)).toBe(true);
                expect(workspaceProvider.callsFor("ensureAttached").length).toBeGreaterThanOrEqual(2);
                expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                    ["bind", null], ["end", "completed"],
                ]);
                // Exposure r2: the refused attempt never asked the admission; the message's attempt, with its own id, was admitted.
                expect(turns[1].input.intake.attemptId).not.toBe(turns[0].input.intake.attemptId);
                expect(turns.map(turn => turn.input.intake.sentBefore)).toEqual([false, false]);
                expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId: turns[1].input.intake.attemptId });
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
