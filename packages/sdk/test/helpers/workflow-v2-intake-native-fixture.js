/**
 * Native fixture for orchestration 1.0.83's durable intake (INACTIVE; design
 * docs/proposals/workflow-durable-intake.md 5.5, 6.2 and section 8): one
 * disposable duroxide PostgreSQL provider and one native Runtime that serves
 * every capability tag, with:
 *
 * - 1.0.83 registered explicitly, by this test only, under the durable
 *   session name, with its continue-as-new target set to 1.0.83 itself (the
 *   production latest stays 1.0.82, which 1.0.83 refuses to continue to);
 * - the real activities of a worker (registerActivities, with the test
 *   option that registers runTurnV5) over the real CMS catalog, whose
 *   provider budget store is hidden (the budget gate is not under test
 *   here), and a fake session manager whose model session is scripted by
 *   the test: it calls the intake's send callback when it "sends";
 * - the real intake activities over the real workflow store
 *   (registerWorkflowIntakeActivities), and real outbox messages to the
 *   recipient session (intakeActivityFixture).
 *
 * Nothing is registered in a production registry, and no session starts on
 * 1.0.83 outside the test's own provider schema.
 */
import { createRequire } from "node:module";
import { vi, expect } from "vitest";
import { intakeActivityFixture } from "./workflow-v2-intake-activities-fixture.js";
import {
    AGENT_HANDOFF_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY, WORKSPACE_CAPABILITY,
} from "../../src/activity-routing.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { registerWorkflowIntakeActivities } from "../../src/workflow/v2/intake-activities.ts";
import { createRuntime, runLoop } from "../../src/orchestration_1_0_83/runtime.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../src/orchestration-registry.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

export const INTAKE_NATIVE_TIMEOUT = 180_000;
const VERSION = "1.0.83";
const TAGS = [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY];

/** 1.0.83 as this test registers it: the same code, with its continue-as-new target set to 1.0.83. */
function* intakeOrchestration83(ctx, input) {
    const runtime = yield* createRuntime(ctx, input, { currentVersion: VERSION, latestVersion: VERSION });
    if (runtime.state.orchestrationResult !== null) return runtime.state.orchestrationResult;
    return yield* runLoop(runtime);
}

/** The ActivityScheduled events of one activity name in a native history. */
export function scheduled(history, name) {
    const named = `"name":${JSON.stringify(name)}`;
    return history.filter(event => event.kind === "ActivityScheduled" && String(event.data).includes(named));
}

/** The text of a native event's data with JSON string escaping removed (nested inputs included), for plain-text checks. */
export function eventText(event) {
    let text = String(event.data);
    for (let level = 0; level < 4; level += 1) {
        const next = text.replaceAll("\\\\", "\\").replaceAll('\\"', '"');
        if (next === text) break;
        text = next;
    }
    return text;
}

/**
 * A model session scripted by `script(call, prompt, opts)`: the n-th call's
 * result. The script calls `opts.onBeforeInitialSend()` when its run "sends",
 * as ManagedSession does right before its initial send.
 */
function scriptedModelSession(script) {
    const prompts = [];
    const session = {
        abort() {},
        async runTurn(prompt, opts) {
            prompts.push(prompt);
            return script(prompts.length, prompt, opts);
        },
    };
    return { session, prompts };
}

/** The real CMS catalog with its provider budget store hidden; every other member is the catalog's own. */
function withoutBudgetGate(catalog) {
    return new Proxy(catalog, {
        get(target, prop) {
            if (prop === "providers") return undefined;
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/**
 * `script(call, prompt, opts)` plays the model session's n-th run (see
 * scriptedModelSession). `options.workspaceProvider` serves workspace
 * attaches (a fake provider), with `options.managerExtras` for the session
 * manager methods a workspace session needs.
 */
export async function intakeNativeFixture(env, script, options = {}) {
    const intake = await intakeActivityFixture(env);
    let worker = null;
    try {
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const workerNodeId = `${env.runId}-intake-native`;
        worker = new Runtime(provider, {
            workerNodeId, workerConcurrency: 2, orchestrationConcurrency: 1,
            dispatcherPollIntervalMs: 20, workerLockTimeoutMs: 10_000, maxSessionsPerRuntime: 10, sessionIdleTimeoutMs: 3_600_000,
            workerTagFilter: { defaultAnd: TAGS }, logLevel: "error",
        });
        const model = scriptedModelSession(script);
        // Only this fixture's session runs on this worker's scripted model; an instance an earlier test left in the schema
        // never reaches it.
        const ownSession = sessionId => {
            if (sessionId !== intake.recipientSessionId) throw new Error(`session ${sessionId} is not this test's`);
        };
        const sessionManager = {
            withRunTurnLock: async (sessionId, _operation, fn) => { ownSession(sessionId); return await fn(); },
            getOrCreate: async sessionId => { ownSession(sessionId); return model.session; },
            getModelSummary: () => undefined,
            getWorkspaceProvider: () => options.workspaceProvider ?? null,
            getFeatureFlagCache: () => null,
            invalidateWarmSession: async () => {},
            resetSessionState: async () => {},
            abortWarmSessionTurn: async () => false,
            dehydrate: async () => {},
            hydrate: async () => {},
            needsHydration: async () => false,
            ...(options.managerExtras ?? {}),
        };
        const calls = [];
        const overrides = {
            // The history size check reads this test's own provider.
            getOrchestrationStats: async (_ctx, input) => client.getOrchestrationStats(`session-${input.sessionId}`),
        };
        const adapter = {
            registerActivity(name, handler) {
                worker.registerActivity(name, async (ctx, input) => {
                    calls.push({ name, tag: ctx.tag?.() ?? null, input });
                    return (overrides[name] ?? handler)(ctx, input);
                });
            },
        };
        registerActivities(adapter, sessionManager, null, undefined, withoutBudgetGate(intake.catalog), provider,
            undefined, undefined, undefined, undefined, null, [], undefined, null, workerNodeId, null, { workflowIntakeTurns: true });
        // No fact store here: the knowledge index is empty.
        adapter.registerActivity("loadKnowledgeIndex", async () => ({ skills: [], asks: [] }));
        registerWorkflowIntakeActivities(adapter, intake.deps);
        worker.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, VERSION, intakeOrchestration83);
        await worker.start();

        const sessionId = intake.recipientSessionId;
        const instanceId = `session-${sessionId}`;
        /** Start the recipient's session on 1.0.83 in this test's provider schema only. */
        const start = (fields = {}) => client.startOrchestrationVersioned(instanceId, DURABLE_SESSION_ORCHESTRATION_NAME, {
            sessionId, config: {}, iteration: 0, blobEnabled: false, idleTimeout: -1, inputGracePeriod: -1, ...fields,
        }, VERSION);
        /** Deliver the copy that a durable send of exchange `input` puts on the recipient's queue: its envelope and its plain form. */
        const deliver = (input, prompt = "plain copy of the workflow message") => client.enqueueEvent(instanceId, "messages",
            JSON.stringify({ prompt, clientMessageIds: [`plain-${input.envelope.exchangeId}`], workflowIntake: input.envelope }));
        /** Deliver a person's prompt. */
        const say = (prompt, clientMessageId) => client.enqueueEvent(instanceId, "messages",
            JSON.stringify({ prompt, clientMessageIds: [clientMessageId] }));
        /** The session's custom status, parsed. */
        const customStatus = status => (typeof status.customStatus === "string" ? JSON.parse(status.customStatus) : status.customStatus ?? {});
        /** Wait for `check` on persisted native state (instance info, current execution's history, status, store rows). */
        const until = async (check, label, timeout = 120_000) => {
            let observed;
            await vi.waitFor(async () => {
                const info = await client.getInstanceInfo(instanceId);
                const history = await client.readExecutionHistory(instanceId, info.currentExecutionId);
                const status = await client.getStatus(instanceId);
                expect(status.status, `${label}: ${JSON.stringify(status)}`).not.toBe("Failed");
                const done = await check({ info, history, status });
                expect(done, label).toBe(true);
                observed = { info, history, status };
            }, { timeout, interval: 50 });
            return observed;
        };
        /** Every execution's history, oldest first. */
        const histories = async () => {
            const info = await client.getInstanceInfo(instanceId);
            const all = [];
            for (let execution = 1; execution <= Number(info.currentExecutionId); execution += 1) {
                all.push(await client.readExecutionHistory(instanceId, execution));
            }
            return all;
        };
        return {
            ...intake, client, provider, worker, calls, prompts: model.prompts, sessionId, instanceId, start, deliver, say, customStatus, until,
            histories,
            async close() {
                try { await worker.shutdown(3_000); } finally { await intake.close(); }
            },
        };
    } catch (error) {
        if (worker) await worker.shutdown(3_000).catch(() => {});
        await intake.close();
        throw error;
    }
}
