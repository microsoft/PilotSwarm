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
 *   option that registers runTurnV5) over the real CMS catalog;
 * - the real intake activities over the real workflow store
 *   (registerWorkflowIntakeActivities), and real outbox messages to the
 *   recipient session (intakeActivityFixture).
 *
 * Test doubles (TEST_DOUBLES, also in every evidence record): the model
 * session is scripted by the test (it asks the store's admission and calls
 * the include callback when it "sends", as ManagedSession does); the session
 * manager is a fake that hands out that model session; a workspace provider,
 * when a case gives one, is the fake provider; the CMS catalog's provider
 * budget store is hidden (the budget gate is not under test here). Everything
 * else listed above is real, the admission's store included.
 *
 * Evidence: a failure (a boundary that is not reached, an assertion after
 * it, a fixture setup that fails once its stores exist) records, before the
 * fixture closes its runtime and the suite drops its schemas, the boundary,
 * the cause, the last observation, every execution's native history, the
 * observed activity calls with their results or errors, the recipient's
 * intake and invocation rows and its canonical transcript records, bounded
 * and with no connection string, environment or credential. A boundary that
 * is not reached throws an error naming it, its cause the original failure;
 * any other failure is rethrown as itself. Either carries the evidence (or
 * the error that kept it from being read) and any shutdown error; neither is
 * turned into a success. A case that passes records a compact receipt of
 * what it persisted.
 *
 * Nothing is registered in a production registry, and no session starts on
 * 1.0.83 outside the test's own provider schema. A case may crash its
 * runtime and start another on the same provider (`restart`), to have a
 * work item delivered again with the same scheduled input.
 *
 * Snapshot mode (`snapshots: true`, Q-W2-7 adoption proofs): the worker's
 * activities get a real FilesystemSessionStore (versioned snapshots) over a
 * temporary directory, so each turn that sends a snapshot key runs the real
 * session lifecycle (the runTurn preamble, already-committed adoption, the
 * commit). The fake session manager then also names that state directory,
 * writes a session layout when it creates a session (as the SDK writes its
 * own), and each scripted model run appends one line (its run number and
 * prompt) to the layout's events.jsonl, so the committed conversation shows
 * which model runs it holds. `afterActivity(name, input, result)` may return
 * an error to throw in place of a completed activity's result: a completion
 * lost on the way back, after the real handler ran to its end (a transport
 * double, listed in the case's doubles; testDoublesOf).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { vi, expect } from "vitest";
import { intakeActivityFixture } from "./workflow-intake-activities-fixture.js";
import { makeSessionLayout } from "./snapshot-conformance.js";
import {
    AGENT_HANDOFF_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY, WORKSPACE_CAPABILITY,
} from "../../src/activity-routing.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { readSnapshotMarker } from "../../src/snapshot-protocol.ts";
import { registerWorkflowIntakeActivities } from "../../src/workflow/intake-activities.ts";
import { createRuntime, runLoop } from "../../src/orchestration/runtime.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../src/orchestration-registry.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

export const INTAKE_NATIVE_TIMEOUT = 180_000;
const VERSION = "1.0.83";
const TAGS = [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY];
/** What in these cases is real and what is a double; recorded with every piece of evidence. */
export const TEST_DOUBLES = Object.freeze({
    real: ["orchestration 1.0.83 (registered by this test only)", "duroxide native runtime and PostgreSQL provider",
        "worker activities (registerActivities, runTurnV5 by its test option)", "intake activities and workflow store", "CMS catalog"],
    doubles: ["model session: scripted by the case (it asks the real store's admission when it sends)",
        "session manager: fake (it records the config each turn gives it and declares no tools to a model)",
        "workspace provider: fake, when the case gives one", "CMS provider budget store: hidden"],
});

/** The doubles of one case: TEST_DOUBLES, with those of the snapshot mode and of a lost completion when the case uses them. */
export function testDoublesOf(options = {}) {
    if (!options.snapshots && !options.afterActivity) return TEST_DOUBLES;
    return Object.freeze({
        real: [...TEST_DOUBLES.real, ...(options.snapshots
            ? ["session lifecycle (runTurn preamble, already-committed adoption, commit) over a FilesystemSessionStore in a temporary directory"]
            : [])],
        doubles: [...TEST_DOUBLES.doubles,
            ...(options.snapshots
                ? ["session state directory: the layout the fake session manager writes on create; each scripted model run appends one line to its events.jsonl"]
                : []),
            ...(options.afterActivity
                ? ["transport: the case may throw an error in place of a completed activity's result (afterActivity), as a completion lost on the way back"]
                : [])],
    });
}
const EVIDENCE_LIMIT = 6_000;

function errorDetails(error) {
    return error instanceof Error
        ? { name: error.name, message: error.message, ...(error.code !== undefined ? { code: error.code } : {}), stack: error.stack }
        : { thrown: String(error) };
}

/** A value as bounded JSON: whole when short, otherwise its head and size. */
function bounded(value, limit = EVIDENCE_LIMIT) {
    let text;
    try { text = JSON.stringify(value); } catch (error) { return { unserializable: String(error?.message ?? error) }; }
    if (text === undefined) return null;
    return text.length <= limit ? JSON.parse(text) : { truncated: true, chars: text.length, head: text.slice(0, limit) };
}

function readOutcome(result) {
    return result.status === "fulfilled" ? { ok: true, value: result.value } : { ok: false, error: errorDetails(result.reason) };
}

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
 * As ManagedSession does before its initial send (exposure protocol revision
 * 2, section 4): the store's admission of the carried items, then, when
 * admitted, the include callback. Returns what the run sends ("include",
 * "omit", or "plain" when it carries nothing); a failed admission rejects.
 */
export async function admitAndSend(opts) {
    if (!opts?.intakeAdmission) return "plain";
    const decision = await opts.intakeAdmission.admit(new AbortController().signal);
    // Read immediately before the send, as ManagedSession does: an activity that may no longer send sends nothing.
    if (opts.intakeAdmission.eligible?.() === false) return "ended";
    if (decision === "include") opts.intakeAdmission.included();
    return decision;
}

/**
 * A model session scripted by `script(call, prompt, opts)`: the n-th call's
 * result. The script calls `admitAndSend(opts)` when its run "sends", as
 * ManagedSession admits and includes the items right before its initial
 * send; a run that ends before its send calls nothing. `onRun(call, prompt)`,
 * when given, is told of each run before the script plays it.
 */
function scriptedModelSession(script, onRun = null) {
    const prompts = [];
    const session = {
        abort() {},
        async runTurn(prompt, opts) {
            prompts.push(prompt);
            onRun?.(prompts.length, prompt);
            return script(prompts.length, prompt, opts);
        },
    };
    return { session, prompts };
}

/** A temporary state directory and a real versioned snapshot store over it (snapshot mode). */
function snapshotSpace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-snapshots-"));
    const stateDir = path.join(root, "session-state");
    fs.mkdirSync(stateDir, { recursive: true });
    return { root, stateDir, store: new FilesystemSessionStore(path.join(root, "session-store"), stateDir), dropped: [] };
}

/** The model-run lines of a session directory's events.jsonl (snapshot mode), oldest first; none when it has no file. */
function modelRunsIn(sessionDir) {
    let text;
    try { text = fs.readFileSync(path.join(sessionDir, "events.jsonl"), "utf8"); } catch { return []; }
    return text.split("\n").filter(line => line.includes('"modelRun"')).map(line => JSON.parse(line));
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
 * scriptedModelSession). `options.testOptions` adds to the worker's test-only
 * switches.
 * `options.workspaceProvider` serves workspace
 * attaches (a fake provider), with `options.managerExtras` for the session
 * manager methods a workspace session needs. `options.runtimeOptions` are
 * merged into each native runtime's options (shorter lock timeouts for a
 * crash case). `options.beforeActivity(name, input)`, when it returns a
 * promise, holds that activity's real handler until it settles (a held
 * write, to order a race); the handler itself is never replaced.
 * `options.snapshots` and `options.afterActivity`: see the file's comment.
 * `options.inlineClient` gives the worker's activities the test's store and
 * schemas, so a turn's workflow tools (update_workflow) can open the client
 * they use, as on a worker; `options.userAgents` and `options.systemAgents`
 * are the agents the worker loaded (registerActivities' lists).
 * `restart()` crashes the running runtime (its in-flight activity is never
 * completed by it: the lock it held runs out) and starts another on the
 * same provider with the same registrations, so a work item it held is
 * delivered again with the same scheduled input.
 */
export async function intakeNativeFixture(env, script, options = {}) {
    const intake = await intakeActivityFixture(env);
    const doubles = testDoublesOf(options);
    let worker = null;
    let snapshots = null;
    try {
        if (options.snapshots) snapshots = snapshotSpace();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const sessionDir = snapshots ? path.join(snapshots.stateDir, intake.recipientSessionId) : null;
        // Snapshot mode: each model run leaves its line in the conversation's files, as a real run changes them.
        const model = scriptedModelSession(script, sessionDir === null ? null
            : (call, prompt) => fs.appendFileSync(path.join(sessionDir, "events.jsonl"), `${JSON.stringify({ modelRun: call, prompt })}\n`));
        // Only this fixture's session runs on this worker's scripted model; an instance an earlier test left in the schema
        // never reaches it.
        const ownSession = sessionId => {
            if (sessionId !== intake.recipientSessionId) throw new Error(`session ${sessionId} is not this test's`);
        };
        // The config each turn gives the session manager, as given (a shallow copy): the session manager declares the model's
        // tools from it (a 1.0.83 turn's workflowMilestoneTurn and an agent state's own child's workflowAgentChild), and this
        // double does not declare anything, so a case reads it here.
        const sessionConfigs = [];
        const sessionManager = {
            withRunTurnLock: async (sessionId, _operation, fn) => { ownSession(sessionId); return await fn(); },
            getOrCreate: async (sessionId, config) => { ownSession(sessionId); sessionConfigs.push({ ...config }); return model.session; },
            getModelSummary: () => undefined,
            getWorkspaceProvider: () => options.workspaceProvider ?? null,
            getFeatureFlagCache: () => null,
            invalidateWarmSession: async () => {},
            resetSessionState: async () => {},
            abortWarmSessionTurn: async () => false,
            dehydrate: async () => {},
            hydrate: async () => {},
            needsHydration: async () => false,
            // What a Workflow the session starts inherits (SessionManager.captureWorkflowToolBinding). This double's session
            // has no live tools, so it answers the binding of a session with none, for the session's owner.
            captureWorkflowToolBinding: async sessionId => {
                ownSession(sessionId);
                const owner = (await intake.catalog.getSession(sessionId))?.owner ?? null;
                return { policy: "node-parent-tools-v1", parentSessionId: sessionId, owner, config: {}, capabilities: { revision: 0, selections: [] },
                    tools: [], sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "intake-native-fixture" };
            },
            ...(snapshots ? {
                getSessionStateDir: () => snapshots.stateDir,
                dropWarmSession: async sessionId => { ownSession(sessionId); snapshots.dropped.push(sessionId); },
                // As the SDK writes its layout when it creates a session: only when the directory has none (the preamble
                // removed it, or nothing was there yet); a warm or hydrated one is resumed as it is.
                getOrCreate: async (sessionId, config) => {
                    ownSession(sessionId);
                    sessionConfigs.push({ ...config });
                    if (!fs.existsSync(path.join(sessionDir, "workspace.yaml"))) makeSessionLayout(snapshots.stateDir, sessionId, "created");
                    return model.session;
                },
            } : {}),
            ...(options.managerExtras ?? {}),
        };
        const calls = [];
        const overrides = {
            // The history size check reads this test's own provider.
            getOrchestrationStats: async (_ctx, input) => client.getOrchestrationStats(`session-${input.sessionId}`),
        };
        let generation = 0;
        /** A native runtime on the provider with every registration of a worker that runs 1.0.83; started. */
        const startRuntime = async () => {
            generation += 1;
            const workerNodeId = `${env.runId}-intake-native-${generation}`;
            const runtime = new Runtime(provider, {
                workerNodeId, workerConcurrency: 2, orchestrationConcurrency: 1,
                dispatcherPollIntervalMs: 20, workerLockTimeoutMs: 10_000, maxSessionsPerRuntime: 10, sessionIdleTimeoutMs: 3_600_000,
                workerTagFilter: { defaultAnd: TAGS }, logLevel: "error", ...(options.runtimeOptions ?? {}),
            });
            const runtimeGeneration = generation;
            const adapter = {
                registerActivity(name, handler) {
                    runtime.registerActivity(name, async (ctx, input) => {
                        const call = { name, tag: ctx.tag?.() ?? null, input, runtime: runtimeGeneration };
                        calls.push(call);
                        try {
                            const held = options.beforeActivity?.(name, input);
                            if (held) await held;
                            const result = await (overrides[name] ?? handler)(ctx, input);
                            call.result = result;
                            // A completion lost on the way back (the case's transport double): the real handler ran to
                            // its end, and its result stays recorded here, but the orchestration gets the error.
                            const lost = options.afterActivity?.(name, input, result);
                            if (lost) {
                                call.lostCompletion = true;
                                throw lost;
                            }
                            return result;
                        } catch (error) {
                            call.error = errorDetails(error);
                            throw error;
                        }
                    });
                },
            };
            const inline = options.inlineClient === true;
            registerActivities(adapter, sessionManager, snapshots?.store ?? null, undefined, withoutBudgetGate(intake.catalog), provider,
                inline ? env.store : undefined, inline ? env.cmsSchema : undefined,
                inline ? { duroxideSchema: env.duroxideSchema, factsSchema: env.factsSchema } : undefined,
                options.systemAgents, null, [], options.userAgents, null, workerNodeId, null,
                { ...(options.testOptions ?? {}) });
            // No fact store here: the knowledge index is empty.
            adapter.registerActivity("loadKnowledgeIndex", async () => ({ skills: [], asks: [] }));
            registerWorkflowIntakeActivities(adapter, intake.deps);
            runtime.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, VERSION, intakeOrchestration83);
            await runtime.start();
            return runtime;
        };
        worker = await startRuntime();
        /** Crash the running runtime, its in-flight work never completed by it, and start another (see the fixture's comment). */
        const restart = async () => {
            const crashed = worker;
            worker = null;
            await crashed.shutdown(500);
            worker = await startRuntime();
        };

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
        /** Every execution's history, oldest first, as the provider lists the executions. */
        const histories = async () => {
            const executions = await client.listExecutions(instanceId);
            const all = [];
            for (const executionId of executions) all.push(await client.readExecutionHistory(instanceId, executionId));
            return all;
        };
        /** The recipient's intake rows, invocation rows, exposure records and canonical transcript records (bounded), for evidence. */
        const persisted = async () => {
            const reads = await Promise.allSettled([
                intake.q(`SELECT row_to_json(i)::text AS row FROM SCHEMA.workflow_intake i WHERE recipient_session_id = $1 ORDER BY exchange_id`,
                    [sessionId]),
                intake.q(`SELECT row_to_json(v)::text AS row FROM SCHEMA.workflow_intake_invocations v WHERE recipient_session_id = $1
                    ORDER BY invocation_id`, [sessionId]),
                intake.catalog.getSessionEvents(sessionId, 0, 1000),
                intake.q(`SELECT row_to_json(x)::text AS row FROM SCHEMA.workflow_intake_exposures x WHERE recipient_session_id = $1
                    ORDER BY invocation_id`, [sessionId]),
            ]);
            const records = reads[2].status === "fulfilled"
                ? { ok: true, value: reads[2].value
                    .filter(event => Array.isArray(event.data?.clientMessageIds) || String(event.eventType).startsWith("session.workflow_intake"))
                    .map(event => ({ seq: event.seq, eventType: event.eventType, data: bounded(event.data, 2_000) })) }
                : readOutcome(reads[2]);
            const rowsOf = read => (read.status === "fulfilled" ? { ok: true, value: read.value.map(row => JSON.parse(row.row)) } : readOutcome(read));
            return {
                intakeRows: rowsOf(reads[0]),
                invocationRows: rowsOf(reads[1]),
                exposureRows: rowsOf(reads[3]),
                transcriptRecords: records,
            };
        };
        /** Snapshot mode: the store's tip, the local marker, the model runs the local conversation holds and the warm drops. */
        const snapshotState = async () => {
            if (snapshots === null) return null;
            const [probe] = await Promise.allSettled([snapshots.store.probeSnapshot(sessionId)]);
            let marker;
            try { marker = { ok: true, value: readSnapshotMarker(sessionDir) }; } catch (error) { marker = { ok: false, error: errorDetails(error) }; }
            let modelRuns;
            try { modelRuns = { ok: true, value: modelRunsIn(sessionDir).map(run => ({ modelRun: run.modelRun, prompt: bounded(run.prompt, 500) })) }; }
            catch (error) { modelRuns = { ok: false, error: errorDetails(error) }; }
            return { probe: readOutcome(probe), marker, modelRuns, warmDrops: snapshots.dropped.length };
        };
        /**
         * Record the evidence of a failure while the runtime and the schemas still exist, and return the error to throw:
         * the original failure as its cause, with the evidence (or the error that kept it from being read) attached.
         */
        const failure = async (phase, label, cause, last = null) => {
            const failed = new Error(`Native intake ${phase} "${label}" failed: ${String(cause?.message ?? cause)}`, { cause });
            failed.name = "NativeIntakeError";
            try {
                const reads = await Promise.allSettled([client.getInstanceInfo(instanceId), client.getStatus(instanceId), histories()]);
                const evidence = {
                    phase, boundary: label, cause: errorDetails(cause), lastObservation: bounded(last), testDoubles: doubles,
                    finalReads: {
                        info: readOutcome(reads[0]), status: readOutcome(reads[1]),
                        histories: reads[2].status === "fulfilled"
                            ? { ok: true, value: reads[2].value.map(history => history.map(event => ({ ...event, data: bounded(event.data, 2_000) }))) }
                            : readOutcome(reads[2]),
                    },
                    calls: calls.map(call => bounded(call)),
                    prompts: model.prompts.map(prompt => bounded(prompt, 2_000)),
                    ...(await persisted()),
                    ...(snapshots ? { snapshots: await snapshotState() } : {}),
                };
                console.info("workflow intake native evidence", JSON.stringify(evidence));
                // Kept on the error for a caller, but not enumerable: the line above is the record, printed once.
                Object.defineProperty(failed, "intakeEvidence", { value: evidence, enumerable: false, configurable: true, writable: true });
            } catch (evidenceError) {
                failed.evidenceError = errorDetails(evidenceError);
                console.info("workflow intake native evidence unreadable", JSON.stringify({ phase, boundary: label, cause: errorDetails(cause),
                    evidenceError: failed.evidenceError }));
            }
            return failed;
        };
        /** Wait for `check` on persisted native state (instance info, current execution's history, status, store rows). */
        const until = async (check, label, timeout = 120_000) => {
            let observed;
            const last = { attempts: 0, readPhase: "not started", info: null, status: null, historyLength: null, checked: null, readError: null };
            try {
                await vi.waitFor(async () => {
                    last.attempts += 1;
                    last.readError = null;
                    try {
                        last.readPhase = "getInstanceInfo";
                        const info = await client.getInstanceInfo(instanceId);
                        last.info = info;
                        last.readPhase = "readExecutionHistory";
                        const history = await client.readExecutionHistory(instanceId, info.currentExecutionId);
                        last.historyLength = history.length;
                        last.readPhase = "getStatus";
                        const status = await client.getStatus(instanceId);
                        last.status = status;
                        expect(status.status, `${label}: ${JSON.stringify(status)}`).not.toBe("Failed");
                        last.readPhase = "check";
                        const done = await check({ info, history, status });
                        last.checked = done;
                        expect(done, label).toBe(true);
                        observed = { info, history, status };
                    } catch (error) {
                        last.readError = errorDetails(error);
                        throw error;
                    }
                }, { timeout, interval: 50 });
            } catch (cause) {
                throw await failure("boundary", label, cause, last);
            }
            return observed;
        };
        /** A compact receipt of what a passing case persisted. Never throws: a receipt that cannot be read is recorded as such. */
        const receipt = async label => {
            try {
                const [info, status, all, rows] = await Promise.all([client.getInstanceInfo(instanceId), client.getStatus(instanceId), histories(), persisted()]);
                const scheduledNames = {};
                for (const history of all) {
                    for (const event of history) {
                        if (event.kind !== "ActivityScheduled") continue;
                        const name = /"name":"([^"]+)"/.exec(String(event.data))?.[1] ?? "?";
                        scheduledNames[name] = (scheduledNames[name] ?? 0) + 1;
                    }
                }
                console.info("workflow intake native receipt", JSON.stringify({
                    case: label, testDoubles: doubles, orchestrationVersion: info.orchestrationVersion, currentExecutionId: info.currentExecutionId,
                    executions: all.length, status: status.status, scheduledNames, modelRuns: model.prompts.length,
                    intakeRows: rows.intakeRows.ok ? rows.intakeRows.value.map(row => ({ exchange_id: row.exchange_id, state: row.state,
                        processing: row.processing, invocation_id: row.invocation_id, cancel_requested: row.cancel_requested })) : rows.intakeRows,
                    invocations: rows.invocationRows.ok ? rows.invocationRows.value.length : rows.invocationRows,
                    exposures: rows.exposureRows.ok
                        ? rows.exposureRows.value.map(row => ({ invocation_id: row.invocation_id, attempt_id: row.attempt_id })) : rows.exposureRows,
                    transcriptRecords: rows.transcriptRecords.ok ? rows.transcriptRecords.value.length : rows.transcriptRecords,
                    ...(snapshots ? { snapshots: await snapshotState() } : {}),
                }));
            } catch (error) {
                console.info("workflow intake native receipt unreadable", JSON.stringify({ case: label, error: errorDetails(error) }));
            }
        };
        return {
            ...intake, client, provider, calls, prompts: model.prompts, sessionId, instanceId, start, deliver, say, customStatus, until,
            histories, failure, receipt, restart,
            /** The config each turn gave the session manager (a shallow copy each), oldest first; not with managerExtras.getOrCreate. */
            sessionConfigs,
            /**
             * Snapshot mode only (else null): the real store, the session's state directory, the store's tip (its probe),
             * the local marker, and the model runs the local conversation holds (events.jsonl lines, oldest first).
             */
            snapshots: snapshots === null ? null : {
                store: snapshots.store, stateDir: snapshots.stateDir, sessionDir,
                probe: () => snapshots.store.probeSnapshot(sessionId),
                marker: () => readSnapshotMarker(sessionDir),
                modelRuns: () => modelRunsIn(sessionDir),
                warmDrops: () => snapshots.dropped.length,
            },
            /** The runtime running now (after a restart, the new one). */
            get worker() { return worker; },
            async close() {
                try {
                    if (worker) await worker.shutdown(3_000);
                } finally {
                    try { await intake.close(); } finally { if (snapshots) fs.rmSync(snapshots.root, { recursive: true, force: true }); }
                }
            },
        };
    } catch (error) {
        // A setup failure once the stores exist: recorded before they are closed; the original error is rethrown.
        console.info("workflow intake native evidence", JSON.stringify({ phase: "setup", cause: errorDetails(error), testDoubles: doubles }));
        const attach = (key, value) => { if (error !== null && typeof error === "object" && Object.isExtensible(error)) error[key] = value; };
        if (worker) await worker.shutdown(3_000).catch(shutdownError => attach("shutdownError", errorDetails(shutdownError)));
        try { await intake.close(); } catch (closeError) { attach("closeError", errorDetails(closeError)); }
        if (snapshots) fs.rmSync(snapshots.root, { recursive: true, force: true });
        throw error;
    }
}

/**
 * One native case: the fixture, the case's body, its receipt when it passes,
 * and, when it fails anywhere after setup, its evidence recorded before the
 * fixture closes. A boundary that is not reached throws the error that names
 * it (its cause the original failure, its evidence attached); any other
 * failure is rethrown as itself, its assertion intact, with the evidence
 * attached. A shutdown error is attached to the failure, or thrown when the
 * case passed.
 */
export async function intakeNativeCase(env, label, script, options, body) {
    const h = await intakeNativeFixture(env, script, options);
    let primary = null;
    try {
        await body(h);
        await h.receipt(label);
    } catch (error) {
        if (error?.name === "NativeIntakeError") {
            primary = error;
        } else if (error !== null && typeof error === "object" && Object.isExtensible(error)) {
            const recorded = await h.failure("case", label, error);
            primary = error;
            primary.intakeCase = label;
            if (recorded.intakeEvidence !== undefined) {
                Object.defineProperty(primary, "intakeEvidence", { value: recorded.intakeEvidence, enumerable: false, configurable: true, writable: true });
            }
            if (recorded.evidenceError !== undefined) primary.evidenceError = recorded.evidenceError;
        } else {
            primary = await h.failure("case", label, error);
        }
        throw primary;
    } finally {
        try {
            await h.close();
        } catch (closeError) {
            if (primary === null) throw closeError;
            primary.closeError = errorDetails(closeError);
        }
    }
}
