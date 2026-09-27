/**
 * The reference deployment's worker side (examples/repo-workspaces/) on a
 * real worker with the real Copilot CLI and the scripted model, against a
 * real git fixture and an in-process repo service
 * (docs/proposals/session-workspaces.md, sections 5 and 6).
 *
 *   6.1  the agent makes its own clone with create_session_clone, moves in
 *        with set_session_workspace, and its next turn runs there under
 *        its tree's lease
 *   R1   a spawned child shares the tree's lease; another tree is held
 *        with WORKSPACE_IN_USE
 *   G7   from the agent's shell: deleting the mirror and fetching inside it
 *        fail, a commit in the clone works
 *   4.10 a git clone and a log share in one session: the clone is the
 *        working folder, the log share an extra folder (a plain root)
 *
 * Run: npx vitest run test/local/repo-workspaces.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createGitFixture, git } from "../helpers/git-fixture.mjs";
import { createRepoService } from "../../examples/repo-workspaces/repo-service.mjs";
import { createRepoWorkspaceProvider } from "../../examples/repo-workspaces/provider.mjs";
import { createRepoTools } from "../../examples/repo-workspaces/tools.mjs";
import { createWorkspaceProvider } from "../../examples/repo-workspaces/index.mjs";
import { systemText } from "../helpers/scripted-model.mjs";
import { createManagementClient } from "../helpers/local-workers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

/** A fixture, a repo service on it, and the provider and tools a worker loads. */
async function deployment(extra = {}) {
    const fixture = await createGitFixture();
    const service = createRepoService({
        root: fixture.root,
        rootName: "fx",
        repos: { app: { remote: fixture.remote } },
        runGit: (args) => git(args),
        ...extra,
    });
    const url = await service.listen();
    let workerRef = null;
    return {
        fixture, service, url,
        provider: createRepoWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }], serviceUrls: { fx: url } }),
        tools: createRepoTools({ serviceUrl: url, getCatalog: () => workerRef?.catalog ?? null }),
        bind: (worker) => { workerRef = worker; },
        async close() {
            await service.close();
            await fixture.cleanup();
        },
    };
}

const leaseOf = (service, checkout) => (service.state().leases[checkout] ?? []).map((e) => [e.sessionId, e.rootSessionId]);

describe("reference repo workspaces", () => {
    it("the agent makes its own clone, moves in, and its next turn runs there under its tree's lease (6.1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment();
        try {
            const respond = scriptTurns([
                [
                    { tools: [{ name: "create_session_clone", args: { repo: "app" } }] },
                    (_body, position) => {
                        const made = JSON.parse(position.toolResults.join(""));
                        return { tools: [{ name: "set_session_workspace", args: made.workspace }] };
                    },
                    { content: "moving" },
                ],
                [
                    { tools: [{ name: "bash", args: { command: "pwd && git status --short --branch | head -1", description: "where" } }] },
                    (_body, position) => ({ content: `out:${position.toolResults.join("").trim().split("\n").slice(0, 2).join("|")}` }),
                ],
            ]);
            await withScriptedModel(env, { respond, tools: d.tools, worker: { workspaceProvider: d.provider } }, async ({ client, worker, model, qualifiedModel }) => {
                d.bind(worker);
                const sessionId = randomUUID();
                const session = await client.createSession({
                    sessionId, model: qualifiedModel,
                    toolNames: ["create_session_clone", "list_session_clones", "remove_session_clone", "set_session_workspace"],
                });
                const answer = await session.sendAndWait("make a clone of app and work in it", TIMEOUT);
                const checkout = `sessions/${sessionId}/app`;
                assertEqual(answer, `out:${path.join(d.fixture.root, checkout)}|## main...origin/main`,
                    "the continuation turn runs in the new clone, on main");
                assertEqual(JSON.stringify(leaseOf(d.service, checkout)), JSON.stringify([[sessionId, sessionId]]), "the root session holds the lease");
                const turnTwo = model.sessionRequests("make a clone of app").find((r) => r.position.turn === 2);
                assert(turnTwo.position.lastUserText.includes(`folder "${checkout}"`), "the continuation got the changed-cwd note");
            });
        } finally {
            await d.close();
        }
    });

    it("a spawned child shares the tree's lease; another tree is held with WORKSPACE_IN_USE (R1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment();
        try {
            const parent = scriptTurns([[
                { tools: [{ name: "spawn_agent", args: { task: "R1-CHILD: report pwd" } }] },
                { content: "spawned" },
            ]]);
            const pwd = (_body, position) => (position.step === 0
                ? { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] }
                : { content: `out:${firstLine(position.toolResults)}` });
            const respond = (body, position) => (position.firstUserText.includes("R1-CHILD") || position.firstUserText.includes("tree b")
                ? pwd : parent)(body, position);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: d.provider } }, async ({ client, worker, model, qualifiedModel }) => {
                d.bind(worker);
                const treeA = randomUUID();
                const made = await fetch(new URL("/v1/clones", d.url), {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ rootSessionId: treeA, repo: "app" }),
                }).then((r) => r.json());
                const a = await client.createSession({ sessionId: treeA, model: qualifiedModel, workspace: made.workspace });
                assertEqual(await a.sendAndWait("tree a spawns a child", TIMEOUT), "spawned");
                const deadline = Date.now() + 90_000;
                let childDone;
                while (!childDone && Date.now() < deadline) {
                    childDone = model.sessionRequests("R1-CHILD").find((r) => r.position.step === 1);
                    if (!childDone) await new Promise((r) => setTimeout(r, 250));
                }
                assert(childDone, "the child ran its turn");
                assertEqual(firstLine(childDone.position.toolResults), made.path, "the child works in the tree's clone");
                const entries = leaseOf(d.service, made.workspace.folder);
                assertEqual(entries.length, 2, `the parent and the child hold entries: ${JSON.stringify(entries)}`);
                assert(entries.every(([, root]) => root === treeA), "both entries are under tree A");

                const treeB = randomUUID();
                const b = await client.createSession({ sessionId: treeB, model: qualifiedModel, workspace: made.workspace });
                await b.send("tree b wants the same checkout");
                const catalog = await createCatalog(env);
                try {
                    const [held] = await waitForEventCount(catalog, treeB, "session.workspace_unavailable", 1, 60_000);
                    assertEqual(held.data.code, "WORKSPACE_IN_USE");
                } finally {
                    await catalog.close?.();
                }
                assertEqual(model.sessionRequests("tree b").length, 0, "the other tree made no model call");
            });
        } finally {
            await d.close();
        }
    });

    // As root, the file permissions this test relies on do not hold (T9).
    it.skipIf(process.getuid?.() === 0)("from the agent's shell the mirror cannot be deleted or fetched into, and the clone still commits (G7)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment();
        try {
            const mirror = d.fixture.mirror;
            // The bash tool runs bash; each step prints its exit status and first message line.
            const script = [
                "out=$(rm -rf '" + mirror + "' 2>&1); echo \"rm_status=$? ${out%%$'\\n'*}\"",
                "out=$(git -C '" + mirror + "' fetch -q origin 2>&1); echo \"fetch_status=$? ${out%%$'\\n'*}\"",
                "git -c user.name=agent -c user.email=agent@example.invalid commit -q --allow-empty -m 'agent commit'; echo \"commit_status=$?\"",
            ].join("; ");
            const respond = scriptTurns([[
                { tools: [{ name: "bash", args: { command: script, description: "try the mirror" } }] },
                (_body, position) => ({ content: `out:${position.toolResults.join("")}` }),
            ]]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: d.provider } }, async ({ client, worker, qualifiedModel }) => {
                d.bind(worker);
                const tree = randomUUID();
                const made = await fetch(new URL("/v1/clones", d.url), {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ rootSessionId: tree, repo: "app" }),
                }).then((r) => r.json());
                // Section 5.1: the mirror belongs to another uid; locally, read-only modes stand in.
                await d.fixture.setMirrorReadOnly(true);
                const session = await client.createSession({ sessionId: tree, model: qualifiedModel, workspace: made.workspace });
                const answer = await session.sendAndWait("try to break the mirror", TIMEOUT);
                assert(/Permission denied/i.test(answer), `rm reports a permission error: ${answer}`);
                assert(/rm_status=[1-9]/.test(answer), `rm fails: ${answer}`);
                assert(/fetch_status=[1-9]/.test(answer), `a fetch inside the mirror fails: ${answer}`);
                assert(/commit_status=0/.test(answer), `the clone still commits: ${answer}`);
                assert(await git(["-C", mirror, "rev-parse", "--verify", "-q", "HEAD"]), "the mirror is intact");
                assertEqual(await git(["-C", made.path, "log", "-1", "--format=%s"]), "agent commit");
            });
        } finally {
            await d.fixture.setMirrorReadOnly(false).catch(() => {});
            await d.close();
        }
    });
});

describe("reference repo workspaces: a git clone and a log share in one session (section 4.10)", () => {
    it("the clone is the working folder and the log share an extra folder: the agent reads the logs, commits in the clone, then drops the logs mid-turn", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment();
        const logsRoot = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ps-logs-")));
        const day = path.join(logsRoot, "checkout-svc", "2026-09-27");
        fs.mkdirSync(day, { recursive: true });
        const LOG_LINE = "2026-09-27T14:02:11Z ERROR NullReference in PaymentMapper.cs:88";
        fs.writeFileSync(path.join(day, "app-1.log"), `2026-09-27T14:02:10Z INFO started\n${LOG_LINE}\n`);
        // The worker's one provider: the repo root and the plain logs root.
        const provider = createWorkspaceProvider({
            roots: [{ name: "fx", path: d.fixture.root }],
            serviceUrls: { fx: d.url },
            plainRoots: [{ name: "logs", path: logsRoot }],
        });
        try {
            const respond = scriptTurns([
                [
                    { tools: [{ name: "create_session_clone", args: { repo: "app" } }] },
                    (_body, position) => {
                        const made = JSON.parse(position.toolResults.join(""));
                        return { tools: [{ name: "set_session_workspace", args: {
                            ...made.workspace,
                            extra: { logs: { root: "logs", folder: "checkout-svc/2026-09-27", required: false } },
                        } }] };
                    },
                    { content: "moving" },
                ],
                [
                    { tools: [{ name: "bash", args: {
                        command: `grep -h ERROR '${day}'/*.log | head -1 > incident.txt && git add incident.txt `
                            + "&& git -c user.name=agent -c user.email=agent@example.invalid commit -q -m 'note the incident' "
                            + "&& git log -1 --format=%s && pwd",
                        description: "read the logs, commit in the clone",
                    } }] },
                    (_body, position) => ({ content: `out:${position.toolResults.join("").trim().split("\n").slice(0, 2).join("|")}` }),
                ],
                [
                    { tools: [{ name: "set_session_workspace", args: { extra: { logs: null } } }] },
                    { tools: [{ name: "bash", args: { command: "pwd", description: "still here" } }] },
                    (_body, position) => ({ content: `after:${firstLine(position.toolResults)}` }),
                ],
            ]);
            await withScriptedModel(env, { respond, tools: d.tools, worker: { workspaceProvider: provider } }, async ({ client, worker, model, qualifiedModel }) => {
                d.bind(worker);
                const sessionId = randomUUID();
                const session = await client.createSession({
                    sessionId, model: qualifiedModel,
                    toolNames: ["create_session_clone", "list_session_clones", "remove_session_clone", "set_session_workspace"],
                });
                const checkout = `sessions/${sessionId}/app`;
                const clonePath = path.join(d.fixture.root, checkout);
                assertEqual(await session.sendAndWait("investigate the checkout errors", TIMEOUT), `out:note the incident|${clonePath}`,
                    "the continuation turn read the logs and committed in the clone");
                assertEqual(await git(["-C", clonePath, "log", "-1", "--format=%s"]), "note the incident");
                assertEqual(fs.readFileSync(path.join(clonePath, "incident.txt"), "utf8").trim(), LOG_LINE);
                assertEqual(JSON.stringify(leaseOf(d.service, checkout)), JSON.stringify([[sessionId, sessionId]]), "the clone is leased; the log share needs no lease");

                const continuation = model.sessionRequests("investigate the checkout errors").find((r) => r.position.turn === 2);
                const system = systemText(continuation.body);
                assert(system.includes(`Current working directory: ${clonePath}`), "the working folder is the clone");
                assert(system.includes("Additional directories available for file access") && system.includes(day), "the CLI lists the log share");
                assert(continuation.position.lastUserText.includes(`Your extra folders changed: added "logs" (root "logs", folder "checkout-svc/2026-09-27", at ${day}).`),
                    "the continuation got both notes");

                assertEqual(await session.sendAndWait("drop the logs", TIMEOUT), `after:${clonePath}`, "removing the extra folder did not end the turn");
                const catalog = await createCatalog(env);
                try {
                    const changed = await waitForEventCount(catalog, sessionId, "session.workspace_changed", 2, 30_000);
                    const last = changed.at(-1).data.workspace;
                    assertEqual(last.extra, undefined, "the record has no extra folders now");
                    assertEqual(last.folder, checkout);
                } finally {
                    await catalog.close?.();
                }

                const mgmt = await createManagementClient(env);
                try {
                    await mgmt.completeSession(sessionId, "done");
                } finally {
                    await mgmt.stop();
                }
                const deadline = Date.now() + 60_000;
                while (leaseOf(d.service, checkout).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
                assertEqual(leaseOf(d.service, checkout).length, 0, "the end released the clone's lease");
                assert(fs.existsSync(path.join(clonePath, "incident.txt")), "the files stay");
            });
        } finally {
            fs.rmSync(logsRoot, { recursive: true, force: true });
            await d.close();
        }
    });
});

describe("reference repo workspaces on two workers", () => {
    it("a parent and its child on two workers share a checkout; the child's attach keeps the parent's lock until both entries are dead (R5)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const alive = new Set(["local-a", "local-b"]);
        const d = await deployment({ isWorkerAlive: (worker) => alive.has(worker) });
        const saved = [process.env.PILOTSWARM_WORKER_CONCURRENCY, process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY];
        // One turn slot per worker: while the parent's turn holds one worker,
        // the child's turn has to run on the other.
        process.env.PILOTSWARM_WORKER_CONCURRENCY = "1";
        process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY = "4";
        try {
            const parent = scriptTurns([[
                { tools: [{ name: "bash", args: { command: "touch .git/index.lock && echo locked", description: "take the index lock" } }] },
                { tools: [{ name: "spawn_agent", args: { task: "R5-CHILD: check the lock" } }] },
                { tools: [{ name: "bash", args: { command: "sleep 20; echo parent-done", description: "keep the parent's turn running" } }] },
                { content: "parent finished" },
            ]]);
            const child = scriptTurns([[
                { tools: [{ name: "bash", args: { command: "test -f .git/index.lock && echo lock-present || echo lock-missing", description: "look" } }] },
                (_body, position) => ({ content: `child:${firstLine(position.toolResults)}` }),
            ]]);
            const respond = (body, position) => (position.firstUserText.includes("R5-CHILD") ? child : parent)(body, position);
            await withScriptedModel(env, { respond, workers: 2, worker: { workspaceProvider: d.provider } }, async ({ client, worker, model, qualifiedModel }) => {
                d.bind(worker);
                const tree = randomUUID();
                const made = await fetch(new URL("/v1/clones", d.url), {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ rootSessionId: tree, repo: "app" }),
                }).then((r) => r.json());
                const lock = path.join(made.path, ".git", "index.lock");
                const session = await client.createSession({ sessionId: tree, model: qualifiedModel, workspace: made.workspace });
                assertEqual(await session.sendAndWait("r5 parent locks, spawns, and keeps working", TIMEOUT), "parent finished");

                const childAnswer = model.sessionRequests("R5-CHILD").find((r) => r.position.step === 1);
                assert(childAnswer, "the child ran its turn");
                assertEqual(firstLine(childAnswer.position.toolResults), "lock-present", "the child's attach kept the parent's lock");
                const entries = d.service.state().leases[made.workspace.folder];
                const workersSeen = new Set(entries.map((e) => e.workerNodeId));
                assertEqual(workersSeen.size, 2, `the parent and the child ran on two workers: ${JSON.stringify(entries)}`);
                assert(fs.existsSync(lock), "the lock is still there while the entries are live");

                // Both workers leave the registry: the next attach in the tree clears the lock.
                alive.clear();
                const cleared = await fetch(new URL("/v1/leases", d.url), {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ checkout: made.workspace.folder, sessionId: "r5-late", rootSessionId: tree, workerNodeId: "local-c", turnIndex: 0 }),
                }).then((r) => r.json());
                assertEqual(JSON.stringify(cleared.removedLocks), JSON.stringify([".git/index.lock"]));
                assertEqual(fs.existsSync(lock), false);
            });
        } finally {
            const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
            restore("PILOTSWARM_WORKER_CONCURRENCY", saved[0]);
            restore("PILOTSWARM_ORCHESTRATION_CONCURRENCY", saved[1]);
            await d.close();
        }
    });
});
