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
 *
 * Run: npx vitest run test/local/repo-workspaces.test.js
 */
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

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

/** A fixture, a repo service on it, and the provider and tools a worker loads. */
async function deployment(t) {
    const fixture = await createGitFixture();
    const service = createRepoService({
        root: fixture.root,
        rootName: "fx",
        repos: { app: { remote: fixture.remote } },
        runGit: (args) => git(args),
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

    it("from the agent's shell the mirror cannot be deleted or fetched into, and the clone still commits (G7)", { timeout: TIMEOUT }, async () => {
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
