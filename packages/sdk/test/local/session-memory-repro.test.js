/**
 * Per-session memory repro (opt-in: PS_SESSION_LEAK_REPRO=1; not run in CI). On TEST the worker grew about 2.2 MiB per
 * finished agent-step session (about 1 MiB in the node worker, about 1.2 MiB in the Copilot CLI child) while the live
 * session count stayed flat, until it was OOMKilled. This test measures it on one real worker with the real Copilot CLI
 * and a scripted model (no tokens):
 *
 *   for each N in PS_SESSION_LEAK_STEPS (default 0,50,100,200, cumulative): N sessions with one turn each, then N Workflows
 *   whose one agent step (session: new) completes at once; then wait until the worker holds no warm session (eviction
 *   with PILOTSWARM_SESSION_EVICT_MS, default 1000, and the end of the agent steps), gc() and record:
 *   - node: RSS and heap used;
 *   - the Copilot CLI children: VmRSS (each direct child process of this one whose command line names copilot);
 *   - the session manager: sessionConfigs.size, and the sum of every CopilotClient's sessions.size;
 *   - the CLI's logs: how many "Cleaning up session" lines;
 *   - PostgreSQL: pg_stat_activity rows of the test database.
 *
 * It prints one table row per step and the MiB per session between the first and the last step. It asserts nothing about
 * the numbers: the executor compares them at main, at the side branch before the leak fixes and after them. A build
 * without Workflow (main) runs the sessions only, and says so (agentSteps: false).
 *
 * The second case: one long session (PS_SESSION_LEAK_LONG_TURNS turns, default 300) is summarized once (the session
 * orchestration's summarizeSession activity, called as the worker registers it), while the RSS of this process and of
 * every process below it is sampled every 50 ms. It prints the baseline, the peak and the peak minus the baseline of
 * both, and the processes the summarization started. Over 300 MiB above the baseline it says so.
 *
 * Run: PS_SESSION_LEAK_REPRO=1 npx vitest run test/local/session-memory-repro.test.js
 */
import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerActivities } from "../../src/session-proxy.ts";

const RUN = process.env.PS_SESSION_LEAK_REPRO === "1";
const STEPS = (process.env.PS_SESSION_LEAK_STEPS || "0,50,100,200").split(",").map(value => Number(value.trim())).filter(Number.isFinite);
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "session-memory-repro", email: null, displayName: null };
const ACTOR = { kind: "system", name: "session-memory-repro" };
const MIB = 1024 * 1024;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One agent step (session: new) that its agent completes at once. As a document (JSON is YAML). */
const STEP_WORKFLOW = JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "leak-step", version: "1.0.0" },
    initial: "step",
    states: {
        step: { type: "agent", invoke: { prompt: "Say done." }, session: "new", timeoutSeconds: 600, transition: { next: { done: "finished", failure: "failed" } } },
        finished: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
}, null, 2);

/** The scripted model: an agent step completes its state at once; every other request is answered "ok". */
function respond(body, position) {
    const tools = (body.tools ?? []).map(tool => tool.function?.name);
    if (!tools.includes("complete_workflow_node")) return { content: "ok" };
    if (position.step === 0) return { tools: [{ name: "complete_workflow_node", args: { outcome: "done", output: null, operation_id: "leak-step" } }] };
    return { content: "STATE_COMPLETED" };
}

/** gc(), from inside a test without --expose-gc. */
function collect() {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    gc();
    gc();
}

/** Every process whose parent is `pid`, with its command line. */
function childrenOf(pid) {
    const children = [];
    for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            if (ppid !== pid) continue;
            children.push({ pid: Number(entry), cmd: fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ") });
        } catch {
            // Gone meanwhile.
        }
    }
    return children;
}

/** The VmRSS (MiB) of every process below this one, by pid. */
function descendantsRssMiB() {
    const out = new Map();
    const visit = (pid) => {
        for (const child of childrenOf(pid)) {
            try {
                const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"));
                if (match) out.set(child.pid, { mib: Number(match[1]) / 1024, cmd: child.cmd.slice(0, 120) });
            } catch {
                // Gone meanwhile.
            }
            visit(child.pid);
        }
    };
    if (fs.existsSync("/proc/self/stat")) visit(process.pid);
    return out;
}

/** VmRSS (MiB) of the Copilot CLI children of this process (and of their children). */
function cliRssMiB() {
    let kib = 0;
    const visit = (pid, depth) => {
        for (const child of childrenOf(pid)) {
            if (depth > 0 || /copilot/i.test(child.cmd)) {
                try {
                    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"));
                    if (match) kib += Number(match[1]);
                } catch {
                    // Gone meanwhile.
                }
                visit(child.pid, depth + 1);
            }
        }
    };
    if (fs.existsSync("/proc/self/stat")) visit(process.pid, 0);
    return kib / 1024;
}

/**
 * "Cleaning up session" lines in the CLI logs under COPILOT_HOME (the parent of the session state folder); null when the
 * CLI wrote no log folder (the worker starts it at log level "error", where it may write none).
 */
function cleanupLines(sessionStateDir) {
    const logs = path.join(path.dirname(sessionStateDir), "logs");
    let count = 0;
    if (!fs.existsSync(logs)) return null;
    for (const name of fs.readdirSync(logs)) {
        try {
            count += (fs.readFileSync(path.join(logs, name), "utf8").match(/Cleaning up session/g) ?? []).length;
        } catch {
            // Rotated meanwhile.
        }
    }
    return count;
}

describe.skipIf(!RUN)("per-session memory on one worker (opt-in repro)", () => {
    it("measures node, CLI, session-manager maps and database connections per finished session and agent step", { timeout: 6 * 60 * 60_000 }, async () => {
        process.env.PILOTSWARM_SESSION_EVICT_MS ||= "1000";
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 1 });
        const rows = [];
        try {
            await withScriptedModel(env, { respond, worker: { logLevel: "warning" } }, async ({ client, worker, qualifiedModel }) => {
                const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
                await catalog.initialize();
                // Workflow is in this build (not on main): the agent steps run too.
                const service = await import("../../src/workflow/service.ts").catch(() => null);
                const store = service && typeof catalog.workflowStore === "function" ? catalog.workflowStore() : null;
                const duroxide = client._getDuroxideClient();
                const manager = worker.sessionManager;
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                let done = 0;
                const settle = async () => {
                    for (let waited = 0; waited < 120_000 && manager.sessions.size > 0; waited += 500) await pause(500);
                    await pause(2_000);
                    collect();
                };
                const measure = async (n) => {
                    await settle();
                    const memory = process.memoryUsage();
                    const sdkSessions = [...manager.clients.values()].reduce((sum, c) => sum + (c.sessions?.size ?? 0), 0);
                    const { rows: [activity] } = await direct.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()");
                    const row = { n, agentSteps: store !== null, rssMiB: memory.rss / MIB, heapMiB: memory.heapUsed / MIB, cliMiB: cliRssMiB(), warm: manager.sessions.size,
                        sessionConfigs: manager.sessionConfigs.size, sdkSessions, cleanups: cleanupLines(env.sessionStateDir), pgConnections: activity.n };
                    rows.push(row);
                    console.log(`[session-memory-repro] ${JSON.stringify(row)}`);
                };
                for (const target of STEPS) {
                    for (; done < target; done += 1) {
                        const ownerSession = await client.createSession({ model: qualifiedModel, owner: OWNER });
                        await ownerSession.sendAndWait("Say ok.", 120_000);
                        if (!store) continue;
                        const created = await service.createWorkflow({ catalog, store, duroxideClient: duroxide }, {
                            workflowSessionId: randomUUID(), parentSessionId: parent, yaml: STEP_WORKFLOW, actor: ACTOR, operationId: `leak-${done}`,
                            publish: true, start: { inputs: {} }, notifyParent: false,
                        });
                        const runId = created.receipt.run.runId;
                        for (let waited = 0; waited < 120_000; waited += 250) {
                            const run = await store.readRun(runId);
                            if (run && !["admitted", "running", "paused"].includes(run.status)) break;
                            await pause(250);
                        }
                    }
                    await measure(target);
                }
                await catalog.close();
            });
        } finally {
            await direct.end();
        }
        const first = rows[0];
        const last = rows.at(-1);
        if (first && last && last.n > first.n) {
            const sessions = (last.agentSteps ? 2 : 1) * (last.n - first.n);
            console.log(`[session-memory-repro] per finished session (a session or an agent step): node ${((last.rssMiB - first.rssMiB) / sessions).toFixed(3)} MiB, `
                + `heap ${((last.heapMiB - first.heapMiB) / sessions).toFixed(3)} MiB, CLI ${((last.cliMiB - first.cliMiB) / sessions).toFixed(3)} MiB`);
        }
        console.table(rows);
    });

    it("measures the peak RSS of a long session's summarization (node and the processes below it)", { timeout: 2 * 60 * 60_000 }, async () => {
        const turns = Number(process.env.PS_SESSION_LEAK_LONG_TURNS || 300);
        const env = getEnv();
        await withScriptedModel(env, { respond, worker: { logLevel: "warning" } }, async ({ client, worker, qualifiedModel }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            try {
                const ownerSession = await client.createSession({ model: qualifiedModel, owner: OWNER });
                for (let turn = 0; turn < turns; turn += 1) await ownerSession.sendAndWait(`Turn ${turn}: say ok about item ${turn}.`, 120_000);
                const events = (await catalog.getSessionEvents(ownerSession.sessionId, undefined, 100_000)).length;
                // The worker's own summarizeSession activity, registered on a capture runtime with the worker's session manager.
                const handlers = {};
                registerActivities({ registerActivity: (name, fn) => { handlers[name] = fn; } }, worker.sessionManager, null, undefined, catalog);
                if (typeof handlers.summarizeSession !== "function") throw new Error("this build registers no summarizeSession activity");
                await catalog.updateSession(ownerSession.sessionId, { titleLocked: false }).catch(() => {});
                collect();
                await pause(1_000);
                const before = descendantsRssMiB();
                const baseline = { nodeMiB: process.memoryUsage().rss / MIB, childrenMiB: [...before.values()].reduce((sum, item) => sum + item.mib, 0) };
                const peak = { ...baseline, newProcesses: 0 };
                const started = new Map();
                let sampling = true;
                const sampler = (async () => {
                    while (sampling) {
                        const now = descendantsRssMiB();
                        peak.nodeMiB = Math.max(peak.nodeMiB, process.memoryUsage().rss / MIB);
                        peak.childrenMiB = Math.max(peak.childrenMiB, [...now.values()].reduce((sum, item) => sum + item.mib, 0));
                        for (const [pid, item] of now) {
                            if (before.has(pid)) continue;
                            started.set(pid, { cmd: item.cmd, peakMiB: Math.max(started.get(pid)?.peakMiB ?? 0, item.mib) });
                        }
                        peak.newProcesses = Math.max(peak.newProcesses, [...now.keys()].filter(pid => !before.has(pid)).length);
                        await pause(50);
                    }
                })();
                const startedAt = Date.now();
                let title = null;
                let error = null;
                try {
                    title = await handlers.summarizeSession({ traceInfo: () => {}, traceWarn: () => {} }, { sessionId: ownerSession.sessionId });
                } catch (caught) {
                    error = String(caught?.message ?? caught);
                } finally {
                    sampling = false;
                    await sampler;
                }
                const result = {
                    turns, events, ms: Date.now() - startedAt, title, error,
                    baseline, peak, nodePeakAboveBaselineMiB: peak.nodeMiB - baseline.nodeMiB, childrenPeakAboveBaselineMiB: peak.childrenMiB - baseline.childrenMiB,
                    startedProcesses: [...started.values()],
                };
                console.log(`[session-memory-repro] summarization ${JSON.stringify(result)}`);
                const above = result.nodePeakAboveBaselineMiB + result.childrenPeakAboveBaselineMiB;
                if (above > 300) console.log(`[session-memory-repro] summarization peak is ${above.toFixed(1)} MiB above the baseline (over 300 MiB)`);
            } finally {
                await catalog.close();
            }
        });
    });
});
