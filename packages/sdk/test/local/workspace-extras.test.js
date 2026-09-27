/**
 * Session workspaces: extra folders (docs/proposals/session-workspaces.md,
 * section 4.10) on a real worker with the real Copilot CLI and the scripted
 * model. A session keeps one working folder and may use up to four more
 * folders next to it; each is attached before every turn and passed to the
 * CLI as an additional directory.
 *
 * Run: npx vitest run test/local/workspace-extras.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { deepStrictEqual } from "node:assert";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns, systemText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { createManagementClient } from "../helpers/local-workers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const LOG_LINE = "2026-09-27T14:02:11Z ERROR NullReference in PaymentMapper.cs:88";
const ENV_LINE = "Additional directories available for file access";

/** The first line of a tool result; the bash tool appends a "<shellId: ...>" status line. */
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

async function eventually(probe, what, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await probe();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/**
 * Three roots on disk: `a` with the working folders, `logs` with a log file,
 * `shared` for a folder every session can write. The logs folder also holds
 * repo content (agents, skills, AGENTS.md, a .git folder) that must never be
 * adopted from an extra folder.
 */
function makeRoots() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-extras-")));
    const dir = (...parts) => {
        const full = path.join(base, ...parts);
        fs.mkdirSync(full, { recursive: true });
        return full;
    };
    dir("a", "repo-x");
    dir("a", "repo-y");
    const svc = dir("logs", "svc");
    fs.writeFileSync(path.join(svc, "app.log"), `${LOG_LINE}\n`);
    dir("logs", "svc", ".git");
    dir("logs", "svc", ".github", "agents");
    dir("logs", "svc", ".github", "skills", "probe-skill");
    fs.writeFileSync(path.join(svc, ".github", "agents", "probe-agent.agent.md"), "---\nname: probe-agent\ndescription: PROBE-AGENT\ntools: [\"view\"]\n---\nProbe.\n");
    fs.writeFileSync(path.join(svc, ".github", "skills", "probe-skill", "SKILL.md"), "---\nname: probe-skill\ndescription: PROBE-SKILL\n---\nProbe.\n");
    fs.writeFileSync(path.join(svc, "AGENTS.md"), "PROBE-AGENTS-MD\n");
    dir("shared", "notes");
    return {
        base,
        svc,
        notes: path.join(base, "shared", "notes"),
        roots: ["a", "logs", "shared"].map((name) => ({ name, path: path.join(base, name) })),
        cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
}

describe("extra folders", () => {
    it("a session created with an extra folder: the CLI lists it, the model reads a file there, nothing is adopted from it, and get_session_workspace shows it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const r = makeRoots();
        // The provider adopts everything it can: the working folder has
        // nothing to adopt, the extra folder must adopt nothing.
        const provider = createFakeWorkspaceProvider({ roots: r.roots, adopt: { agents: true, skills: true, instructions: true } });
        try {
            const respond = scriptTurns([
                [
                    { tools: [{ name: "bash", args: { command: `cat '${r.svc}/app.log'`, description: "read the log" } }] },
                    (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
                ],
                [
                    { tools: [{ name: "get_session_workspace", args: {} }] },
                    (_body, position) => ({ content: `ws:${position.toolResults.join("")}` }),
                ],
            ]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({
                    sessionId, model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc" } } },
                });
                assertEqual(await session.sendAndWait("read the log", TIMEOUT), `out:${LOG_LINE}`);
                const first = model.sessionRequests("read the log")[0];
                const system = systemText(first.body);
                assert(system.includes(ENV_LINE) && system.includes(r.svc), "the CLI lists the extra folder to the model");
                assert(system.includes(`Current working directory: ${path.join(r.base, "a", "repo-x")}`), "the working folder is unchanged");
                for (const probe of ["PROBE-AGENTS-MD", "PROBE-SKILL", "probe-skill", "PROBE-AGENT", "probe-agent"]) {
                    assert(!JSON.stringify(first.body).includes(probe), `nothing from the extra folder is adopted: ${probe}`);
                }
                const extraAttach = provider.callsFor("ensureAttached", { sessionId }).find((call) => call.req.attachment === "logs");
                assertEqual(JSON.stringify(extraAttach?.req.workspace), JSON.stringify({ schema: 1, root: "logs", folder: "svc" }), "the provider got the one folder, by name");
                const cwdAttach = provider.callsFor("ensureAttached", { sessionId }).find((call) => !call.req.attachment);
                assertEqual(JSON.stringify(cwdAttach?.req.workspace), JSON.stringify({ schema: 1, root: "a", folder: "repo-x" }), "the working folder goes without its extras");

                const view = JSON.parse((await session.sendAndWait("show the workspace", TIMEOUT)).slice("ws:".length));
                assertEqual(JSON.stringify(view.extra), JSON.stringify([
                    { name: "logs", root: "logs", folder: "svc", required: true, path: r.svc, status: "attached" },
                ]));
            });
        } finally {
            r.cleanup();
        }
    });

    it("the agent adds an extra folder and uses it in the same turn; the working folder stays; the next turn is told", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const r = makeRoots();
        try {
            const respond = scriptTurns([
                [
                    { tools: [{ name: "set_session_workspace", args: { extra: { logs: { root: "logs", folder: "svc", required: false } } } }] },
                    (_body, position) => ({ tools: [{ name: "bash", args: { command: `cat '${r.svc}/app.log' && pwd`, description: "use it now" } }] }),
                    (_body, position) => ({ content: `out:${position.toolResults.join("").trim().split("\n").slice(0, 2).join("|")}` }),
                ],
                [{ content: "second" }],
            ]);
            await withScriptedModel(env, { respond, worker: { workspaceRoots: r.roots } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                const answer = await session.sendAndWait("add the logs and read them", TIMEOUT);
                assertEqual(answer, `out:${LOG_LINE}|${path.join(r.base, "a", "repo-x")}`, "the same turn read the log, still in the working folder");
                const requests = model.sessionRequests("add the logs");
                const setAnswer = requests.find((req) => req.position.turn === 1 && req.position.step === 1).position.toolResults.join("");
                assert(setAnswer.includes(`Added: logs at ${r.svc}`), `the tool gave the path: ${setAnswer}`);
                assert(setAnswer.includes("Continue your task"), "the answer lets the turn go on");

                const catalog = await createCatalog(env);
                try {
                    const changed = await waitForEventCount(catalog, sessionId, "session.workspace_changed", 2, 60_000);
                    // Key order is not kept by the database.
                    deepStrictEqual(changed.at(-1).data.workspace, {
                        schema: 1, root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc", required: false } },
                    });
                    assertEqual(changed.at(-1).data.revision, 2);
                    assertEqual(changed.at(-1).data.extraPaths?.logs, r.svc);
                } finally {
                    await catalog.close?.();
                }

                assertEqual(await session.sendAndWait("second message", TIMEOUT), "second");
                const second = model.sessionRequests("add the logs").find((req) => req.position.turn === 2);
                assert(second.position.lastUserText.includes(`Your extra folders changed: added "logs" (root "logs", folder "svc", at ${r.svc}).`),
                    "the next turn got the note");
                assertEqual(requests.filter((req) => req.position.turn === 1).length, 3, "no continuation turn was added");
            });
        } finally {
            r.cleanup();
        }
    });

    it("an optional extra folder that cannot attach is left out and the model is told; a required one holds the prompt and names the folder", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const r = makeRoots();
        const provider = createFakeWorkspaceProvider({ roots: r.roots });
        provider.script({ type: "fail", code: "WORKSPACE_NOT_MOUNTED", message: "the log share has no marker", retryAfterMs: 30_000 }, { attachment: "logs" });
        try {
            await withScriptedModel(env, { respond: scriptTurns([[{ content: "ran" }]]), worker: { workspaceProvider: provider } }, async ({ client, model, qualifiedModel }) => {
                const optionalId = randomUUID();
                const optional = await client.createSession({
                    sessionId: optionalId, model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc", required: false } } },
                });
                assertEqual(await optional.sendAndWait("optional logs", TIMEOUT), "ran", "the turn ran without the folder");
                const request = model.sessionRequests("optional logs")[0];
                assert(request.position.lastUserText.includes('Extra folder "logs" (root logs, folder svc) is not available this turn: WORKSPACE_NOT_MOUNTED: the log share has no marker.'),
                    `the model was told: ${request.position.lastUserText}`);
                assert(!systemText(request.body).includes(ENV_LINE), "the missing folder is not passed to the CLI");

                const requiredId = randomUUID();
                const required = await client.createSession({
                    sessionId: requiredId, model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc" } } },
                });
                await required.send("required logs");
                const catalog = await createCatalog(env);
                try {
                    const [held] = await waitForEventCount(catalog, requiredId, "session.workspace_unavailable", 1, 60_000);
                    assertEqual(held.data.code, "WORKSPACE_NOT_MOUNTED");
                    assertEqual(held.data.attachment, "logs");
                    assert(held.data.message.startsWith('extra folder "logs": '), held.data.message);
                } finally {
                    await catalog.close?.();
                }
                assertEqual(model.sessionRequests("required logs").length, 0, "a held prompt calls no model");
            });
        } finally {
            r.cleanup();
        }
    });

    it("adding an extra folder works while a background shell runs; removing one is refused until it stops", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const r = makeRoots();
        try {
            const respond = scriptTurns([[
                { tools: [{ name: "bash", args: { command: "sleep 30", description: "long job", mode: "async", detach: true } }] },
                { tools: [{ name: "set_session_workspace", args: { extra: { shared: { root: "shared", folder: "notes" } } } }] },
                { tools: [{ name: "set_session_workspace", args: { extra: { logs: null } } }] },
                (_body, position) => ({ content: `remove:${position.toolResults.join("").includes("WORKSPACE_BUSY")}` }),
            ]]);
            await withScriptedModel(env, { respond, worker: { workspaceRoots: r.roots } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({
                    sessionId: randomUUID(), model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc" } } },
                });
                assertEqual(await session.sendAndWait("busy session", TIMEOUT), "remove:true");
                const addAnswer = model.sessionRequests("busy session").find((req) => req.position.step === 2).position.toolResults.join("");
                assert(addAnswer.includes(`Added: shared at ${r.notes}`), `adding was not refused: ${addAnswer}`);
            });
        } finally {
            r.cleanup();
        }
    });

    it("the session's end releases the working folder and every extra folder, each by name, with reason ended; a child inherits them", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const r = makeRoots();
        const provider = createFakeWorkspaceProvider({ roots: r.roots });
        try {
            const parent = scriptTurns([[
                { tools: [{ name: "spawn_agent", args: { task: "EXTRAS-CHILD: say hi" } }] },
                { content: "spawned" },
            ]]);
            const child = scriptTurns([[{ content: "hi" }]]);
            const respond = (body, position) => (position.firstUserText.includes("EXTRAS-CHILD") ? child : parent)(body, position);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({
                    sessionId, model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x", extra: { logs: { root: "logs", folder: "svc" }, shared: { root: "shared", folder: "notes" } } },
                });
                assertEqual(await session.sendAndWait("spawn a child", TIMEOUT), "spawned");
                await eventually(() => model.sessionRequests("EXTRAS-CHILD").length > 0, "the child's turn");
                const childAttaches = await eventually(() => {
                    const calls = provider.callsFor("ensureAttached").filter((call) => call.req.sessionId !== sessionId && call.req.rootSessionId === sessionId && call.req.turnIndex >= 0);
                    return calls.some((call) => call.req.attachment === "shared") ? calls : null;
                }, "the child's attach of its inherited extra folders");
                assert(childAttaches.some((call) => call.req.attachment === "logs"), "the child attached both extra folders");

                const mgmt = await createManagementClient(env);
                try {
                    await mgmt.completeSession(sessionId, "done");
                } finally {
                    await mgmt.stop();
                }
                const released = await eventually(() => {
                    const calls = provider.callsFor("release", { sessionId }).filter((call) => call.req.reason === "ended");
                    return calls.length >= 3 ? calls : null;
                }, "three releases");
                assertEqual(JSON.stringify(released.map((call) => call.req.attachment ?? "(working folder)").sort()), JSON.stringify(["(working folder)", "logs", "shared"]));
                const byName = Object.fromEntries(released.map((call) => [call.req.attachment ?? "(working folder)", call.req.workspace]));
                assertEqual(JSON.stringify(byName.logs), JSON.stringify({ schema: 1, root: "logs", folder: "svc" }));
                assertEqual(JSON.stringify(byName["(working folder)"]), JSON.stringify({ schema: 1, root: "a", folder: "repo-x" }));
            });
        } finally {
            r.cleanup();
        }
    });
});
