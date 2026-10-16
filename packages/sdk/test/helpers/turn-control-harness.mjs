/**
 * Session turn control, phase A5: shared harness for the worker-loss tests
 * (turn-control-workspaces, turn-control-crash).
 *
 * Workers are separate processes (the kill harness): each has its own disk
 * and they share the snapshot store, so a worker loss is a real process
 * death and the recovery is duroxide's. The model is the scripted endpoint
 * in the test process; optionally the reference repo workspaces (a git
 * fixture and the repo service, whose worker liveness the test controls).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PilotSwarmClient } from "./local-workers.js";
import { forkKillWorker } from "./kill-harness.js";
import { createCatalog } from "./cms-helpers.js";
import { startScriptedModel } from "./scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "./scripted-workers.js";
import { createGitFixture, git } from "./git-fixture.mjs";
import { createRepoService } from "../../examples/repo-workspaces/repo-service.mjs";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";

/** First orchestration version whose turns accept Stop and Steer through the CMS. */
const TURN_CONTROL_ORCHESTRATION_MIN_VERSION = "1.0.81";
import { TURN_CONTROL_EVENT_TYPES } from "../../src/turn-control-contract.ts";

const versionAtLeast = (v, min) => {
    const a = v.split(".").map(Number);
    const b = min.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
};

/** The orchestration that dispatches runTurnV4 (workstream B2) is registered. */
export const TURN_CONTROL_ORCHESTRATION = versionAtLeast(DURABLE_SESSION_LATEST_VERSION, TURN_CONTROL_ORCHESTRATION_MIN_VERSION);

export function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

export const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

/** Wait until `probe()` returns a truthy value (bounded); returns that value. */
export async function until(probe, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`${label}: not reached within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** Events of one type whose data mentions `text`. */
export async function eventsWith(catalog, sessionId, eventType, text) {
    const events = await catalog.getSessionEvents(sessionId);
    return events.filter((e) => e.eventType === eventType && JSON.stringify(e.data ?? {}).includes(text));
}

/** The outcome events of one control (there must be exactly one). */
export async function outcomesOf(catalog, sessionId, seq) {
    const events = await catalog.getSessionEvents(sessionId);
    return events.filter((e) => e.eventType === TURN_CONTROL_EVENT_TYPES.outcome && e.data?.seq === seq);
}

/** Wait for a control's outcome event; returns its outcome. */
export async function awaitOutcome(catalog, sessionId, seq, label, timeoutMs = 240_000) {
    const [first] = await until(async () => {
        const found = await outcomesOf(catalog, sessionId, seq);
        return found.length > 0 ? found : null;
    }, `${label}: control ${seq} has an outcome`, timeoutMs);
    return first.data.outcome;
}

/** How many times `text` appears in the messages of one model request. */
export function copiesIn(request, text) {
    return (request.body.messages ?? []).filter((m) => JSON.stringify(m.content ?? "").includes(text)).length;
}

/**
 * Start a deployment. `cleanups` is the caller's list, drained (in reverse)
 * after each test.
 *
 * @param {object} env  the suite env
 * @param {Array<() => Promise<void>>} cleanups
 * @param {object} [opts]
 * @param {boolean} [opts.workspaces]  reference repo workspaces (git fixture and repo service)
 * @param {object}  [opts.client]      extra client options (for example `dehydrateOnIdle`)
 */
export async function forkedDeployment(env, cleanups, opts = {}) {
    let fixture = null;
    let service = null;
    let url = null;
    const alive = new Set();
    if (opts.workspaces) {
        fixture = await createGitFixture();
        cleanups.push(() => fixture.cleanup());
        service = createRepoService({
            root: fixture.root,
            rootName: "fx",
            repos: { app: { remote: fixture.remote } },
            runGit: (args) => git(args),
            isWorkerAlive: (worker) => alive.has(worker),
            log: () => {},
        });
        url = await service.listen();
        cleanups.push(() => service.close());
    }
    const releaseDir = fs.mkdtempSync(path.join(path.dirname(env.sessionStateDir), "tc-release-"));
    const model = await startScriptedModel();
    cleanups.push(() => model.close());
    const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        modelProvidersPath,
        ...(opts.client || {}),
    });
    await client.start();
    cleanups.push(() => client.stop());
    const catalog = await createCatalog(env);
    cleanups.push(() => catalog.close?.());

    return {
        fixture, service, url, model, client, catalog, alive, releaseDir,
        /** Fork a worker process; `faultInject` arms PILOTSWARM_FAULT_INJECT in it. */
        async fork(id, { faultInject } = {}) {
            const worker = forkKillWorker(env, id, {
                modelProvidersPath,
                ...(faultInject ? { faultInject } : {}),
                env: { PILOTSWARM_FAULT_RELEASE_DIR: releaseDir },
                ...(opts.workspaces ? { repoWorkspaces: { rootName: "fx", rootPath: fixture.root, serviceUrl: url } } : {}),
            });
            cleanups.push(() => worker.stop());
            alive.add(`kill-${id}`);
            await worker.ready;
            return worker;
        },
        /** Kill a worker process and take it out of the liveness registry. */
        async kill(worker) {
            await worker.killHard();
            alive.delete(`kill-${worker.id}`);
        },
        /** Freeze a worker process (it stops renewing its locks) and let it go on. */
        pause(worker) { process.kill(worker.child.pid, "SIGSTOP"); },
        resume(worker) { process.kill(worker.child.pid, "SIGCONT"); },
        /** Release a session-scoped hold (plan P23). */
        release(point, sessionId) {
            fs.writeFileSync(path.join(releaseDir, `${point}.${sessionId}`), "");
        },
        async session(sessionOpts = {}, sessionId = randomUUID()) {
            const session = await client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, ...sessionOpts });
            return { sessionId, session };
        },
        /** A clone for a new session tree, and the session working in it. */
        async sessionInClone(sessionId = randomUUID()) {
            const made = await fetch(new URL("/v1/clones", url), {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ rootSessionId: sessionId, repo: "app" }),
            }).then((r) => r.json());
            const session = await client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: made.workspace });
            return { sessionId, session, checkout: made.workspace.folder, clonePath: made.path };
        },
        entry(checkout, sessionId) {
            return (service.state().leases[checkout] ?? []).find((e) => e.sessionId === sessionId) ?? null;
        },
        stop(sessionId, reason = "Stopped by user") {
            return catalog.turnControlAdd(sessionId, "stop", reason, randomUUID(), null);
        },
        steer(sessionId, text) {
            return catalog.turnControlAdd(sessionId, "steer", text, randomUUID(), { kind: "user", provider: "dev", subject: "alice" });
        },
    };
}
