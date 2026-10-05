/**
 * The portal's Workspace pane, on a real worker with the real Copilot CLI and
 * the scripted model (packages/sdk/src/workspace-files.ts):
 *
 *   F1  the owner's changes through the management client land in the
 *       session's folders, and the next turn's prompt names them once;
 *       the turn after does not repeat them
 *   F2  the folders list gives each folder's path on this machine, and a
 *       folder of the record keeps its name
 *   F3  a folder the session was created with is open while its first turn
 *       runs: the folders list, read when that turn calls the model, serves
 *       it (session.workspace_opened), next to the default folders
 *
 * Run: npx vitest run test/local/workspace-files.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createBuiltInWorkspaceProvider, PilotSwarmManagementClient } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const NOTE_START = "Since your last turn, the session's owner changed files in the portal (the Workspace tab or a canvas app)";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function fixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-files-")));
    const repo = path.join(base, "repo", "app");
    fs.mkdirSync(path.join(base, "shared"), { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "app\n");
    execFileSync("git", ["init", "-q", repo]);
    const roots = ["repo", "shared"].map((name) => ({ name, path: path.join(base, name) }));
    // Mounted roots carry the export marker; the portal refuses a root without one.
    for (const root of roots) fs.writeFileSync(path.join(root.path, ".pilotswarm-export"), "");
    const inner = createBuiltInWorkspaceProvider(roots);
    const provider = {
        listRoots: () => inner.listRoots(),
        ensureAttached: (req) => inner.ensureAttached(req),
        defaultFolders: () => ({ extra: { shared: { root: "shared" } } }),
    };
    return { base, repo, roots, provider, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("workspace files", () => {
    it("F1 + F2 + F3 the owner's changes land, and the next turn is told once", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            workspaceFiles: { roots: fx.roots },
        });
        await mgmt.start();
        try {
            const sessionId = randomUUID();
            // F3: the folders as the portal sees them when the first turn calls the model.
            let atFirstCall = null;
            const respond = async (_body, position) => {
                if (position.turn === 1 && position.step === 0 && !atFirstCall) {
                    atFirstCall = await mgmt.listSessionWorkspaceFolders(sessionId);
                }
                return { content: "ok" };
            };
            await withScriptedModel(env, { worker: { workspaceProvider: fx.provider }, respond }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "repo", folder: "app" } });
                await session.sendAndWait("files one", TIMEOUT);
                assert(atFirstCall, "the first turn called the model");
                assertEqual(JSON.stringify(atFirstCall.folders.map((f) => [f.id, f.opened, f.available])), JSON.stringify([
                    ["working", true, true],
                    ["extra:shared", true, true],
                ]), "during the first turn, the folder the session was created with is open, next to the default folder");

                // F2: the folders, with their paths here.
                const listed = await mgmt.listSessionWorkspaceFolders(sessionId);
                assertEqual(listed.enabled, true);
                assertEqual(JSON.stringify(listed.roots), JSON.stringify(["repo", "shared"]), "the roots this process serves, for the Set dialog");
                assertEqual(JSON.stringify(listed.folders.map((f) => [f.id, f.name, f.base])), JSON.stringify([
                    ["working", "app", fx.repo],
                    ["extra:shared", "shared", path.join(fx.base, "shared")],
                ]));

                // F1: changes through the management client.
                const created = await mgmt.sessionWorkspaceFiles(sessionId, { op: "write", folder: "working", path: "notes.md", contentBase64: b64("one\n"), ifMatch: null });
                assertEqual(created.created, true);
                await mgmt.sessionWorkspaceFiles(sessionId, { op: "write", folder: "working", path: "notes.md", contentBase64: b64("two\n"), ifMatch: created.etag });
                await mgmt.sessionWorkspaceFiles(sessionId, { op: "mkdir", folder: "extra:shared", path: "drop" });
                await mgmt.sessionWorkspaceFiles(sessionId, { op: "move", folder: "working", path: "notes.md", toFolder: "extra:shared", toPath: "drop/notes.md" });
                assertEqual(fs.readFileSync(path.join(fx.base, "shared", "drop", "notes.md"), "utf8"), "two\n");
                assert(!fs.existsSync(path.join(fx.repo, "notes.md")), "moved out of the repo");

                await session.sendAndWait("files two", TIMEOUT);
                await session.sendAndWait("files three", TIMEOUT);
                const turns = model.sessionRequests("files one");
                const promptOf = (text) => turns.filter((r) => r.position.lastUserText.includes(text)).map((r) => r.position.lastUserText).join("\n");
                const second = promptOf("files two");
                assert(second.includes(NOTE_START), `turn two is told: ${second.slice(-600)}`);
                assert(second.includes("added app/notes.md; edited app/notes.md; made folder shared/drop; moved app/notes.md to shared/drop/notes.md"),
                    `the changes, in order: ${second.slice(-600)}`);
                assert(!promptOf("files one").includes(NOTE_START), "turn one had nothing to tell");
                assert(!promptOf("files three").includes(NOTE_START), "turn three is not told again");

                const catalog = await createCatalog(env);
                try {
                    const events = await catalog.getSessionEvents(sessionId);
                    const count = (type) => events.filter((e) => e.eventType === type).length;
                    assertEqual(count("session.workspace_files_changed"), 4, "one event per change");
                    assertEqual(count("session.workspace_files_noted"), 1, "noted once");
                    assertEqual(events.filter((e) => e.eventType === "system.message" && String(e.data?.content || "").startsWith(NOTE_START)).length, 1,
                        "the transcript shows what the agent was told");
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            await mgmt.stop?.();
            fx.cleanup();
        }
    });
});
