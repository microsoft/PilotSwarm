/**
 * Review PRS-001 (security review of a00f9c32): a Workflow agent's base instructions (base-instructions-<hash>.md, an
 * owner-only artifact) are read by no model-facing tool. Bob's ordinary session, through the real canvas bridge of a turn
 * (session-proxy's controlToolBridge.drawCanvas), the artifact tools, bulk_store_facts and the message-of-the-day picture
 * reader: every read or copy of Alice's Workflow's file is refused in read_artifact's words, and nothing is written (no
 * canvas bytes, no canvas revision, no fact). The name is matched as the stores take it: any letter case, the last path
 * part, trimmed; an explicit responseContract and an ancestor as the source change nothing. An ordinary HTML app still
 * draws.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { createArtifactTools } from "../../src/artifact-tools.ts";
import { createFactTools } from "../../src/facts-tools.ts";
import { readMotdArtifactPicture } from "../../src/session-manager.ts";
import { workflowBaseInstructionsArtifact } from "../../src/workflow/v2/base-instructions.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const SECRET_TEXT = "Alice's confidential role text: the Q3 acquisition plan.";
const NAME = workflowBaseInstructionsArtifact("0123456789abcdef".repeat(4));
const APP = `<!doctype html><html><body><h1>An ordinary app</h1></body></html>`;

function storeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-owner-only-readers-"));
    return { dir, store: new FilesystemArtifactStore(path.join(dir, "store")), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Bob's session `bob-child` (its parent `bob-root`) runs one turn that makes each draw; the canvas writes are recorded. */
async function drawsInATurn(store, draws) {
    const minted = [];
    const results = [];
    const h = makeRunTurnHarness({
        artifactStore: store,
        catalogExtras: {
            getSession: vi.fn(async sessionId => ({ sessionId, owner: { provider: "test", subject: "bob" },
                parentSessionId: sessionId === "bob-child" ? "bob-root" : null })),
            getSessionCanvases: vi.fn(async () => []),
            getSessionEventsBefore: vi.fn(async () => []),
            mintCanvasRev: vi.fn(async (sessionId, slot, seed) => { minted.push({ sessionId, slot }); return seed + 1; }),
        },
        turn: async opts => {
            for (const args of draws) results.push(await opts.controlToolBridge.drawCanvas(args));
            return { type: "completed", content: "drawn", events: [] };
        },
    });
    await h.runTurn("bob-child");
    const canvasEvents = h.recordedEvents.filter(event => event.eventType === "session.canvas_updated");
    return { results, minted, canvasEvents };
}

describe("owner-only artifacts are read by no model-facing tool (PRS-001)", () => {
    it("the canvas bridge refuses the protected source in any case, path or padding, with a contract, from an ancestor; nothing is written; an ordinary app draws", async () => {
        const s = storeDir();
        try {
            await s.store.uploadArtifact("wf-alice", NAME, SECRET_TEXT, "text/markdown");
            await s.store.uploadArtifact("bob-root", NAME, SECRET_TEXT, "text/markdown");
            await s.store.uploadArtifact("wf-alice", "app.html", APP, "text/html");
            const refusedDraws = [
                { fromArtifact: { sessionId: "wf-alice", filename: NAME } },
                { fromArtifact: { sessionId: "wf-alice", filename: NAME.toUpperCase() } },
                { fromArtifact: { sessionId: "wf-alice", filename: `notes/../${NAME}` } },
                { fromArtifact: { sessionId: "wf-alice", filename: `  ${NAME}  ` } },
                { fromArtifact: { sessionId: "wf-alice", filename: NAME }, responseContract: { actions: { ok: { note: "string" } } } },
                { fromArtifact: { sessionId: "bob-root", filename: NAME }, session_id: "bob-root" },
                { fromArtifact: { sessionId: "bob-root", filename: NAME } },
            ];
            const refused = await drawsInATurn(s.store, refusedDraws);
            for (const [index, result] of refused.results.entries()) {
                expect(result, JSON.stringify(refusedDraws[index])).toEqual({ error: expect.stringMatching(/^ARTIFACT_OWNER_ONLY: 'base-instructions-[0-9a-f]+\.md' holds a Workflow agent's base instructions\. .* Nothing was drawn\.$/i) });
                expect(JSON.stringify(result)).not.toContain("acquisition");
            }
            expect(refused.minted).toEqual([]);
            expect(refused.canvasEvents).toEqual([]);
            for (const session of ["bob-child", "bob-root"]) {
                expect((await s.store.listArtifacts(session)).filter(name => String(name?.filename ?? name).startsWith("canvas"))).toEqual([]);
            }
            // Control: an ordinary HTML app from the same session draws, with its bytes and one revision.
            const drawn = await drawsInATurn(s.store, [{ fromArtifact: { sessionId: "wf-alice", filename: "app.html" } }]);
            expect(drawn.results[0]).not.toHaveProperty("error");
            expect(drawn.minted).toEqual([{ sessionId: "bob-child", slot: 1 }]);
            expect(drawn.canvasEvents).toHaveLength(1);
            expect(await s.store.downloadArtifactText("bob-child", "canvas.html")).toBe(APP);
        } finally {
            s.cleanup();
        }
    });

    it("read_artifact and write_artifact refuse to read or copy it, in the same words", async () => {
        const s = storeDir();
        try {
            await s.store.uploadArtifact("wf-alice", NAME, SECRET_TEXT, "text/markdown");
            const tools = Object.fromEntries(createArtifactTools({ blobStore: s.store }).map(tool => [tool.name, tool]));
            const call = async (name, params) => JSON.parse(String(await tools[name].handler(params, { durableSessionId: "bob-child" })));
            for (const out of [await call("read_artifact", { sessionId: "wf-alice", filename: NAME }),
                await call("write_artifact", { fromArtifact: { sessionId: "wf-alice", filename: NAME }, filename: "copy.md" })]) {
                expect(out).toMatchObject({ error: "ARTIFACT_OWNER_ONLY", message: expect.stringContaining("holds a Workflow agent's base instructions") });
            }
            expect(await s.store.statArtifact("bob-child", "copy.md")).toBeNull();
        } finally {
            s.cleanup();
        }
    });

    it("bulk_store_facts does not read it as records; the picture reader does not publish it", async () => {
        const s = storeDir();
        try {
            await s.store.uploadArtifact("wf-alice", NAME, SECRET_TEXT, "text/markdown");
            const factStore = { storeFact: vi.fn(async () => { throw new Error("nothing may be stored"); }) };
            const bulk = createFactTools({ factStore, artifactStore: s.store, agentIdentity: "bob" }).find(tool => tool.name === "bulk_store_facts");
            const refusal = await bulk.handler({ from: { session_id: "wf-alice", filename: NAME.toUpperCase() } }, { sessionId: "bob-child" });
            expect(refusal).toEqual({ error: expect.stringMatching(/^Error: ARTIFACT_OWNER_ONLY: .* Nothing was written\.$/) });
            expect(JSON.stringify(refusal)).not.toContain("acquisition");
            expect(factStore.storeFact).not.toHaveBeenCalled();

            const read = vi.spyOn(s.store, "downloadArtifact");
            const getSessionAccess = vi.fn(async () => ({ owner: { provider: "test", subject: "bob" } }));
            const viewer = { principal: { provider: "test", subject: "bob" }, isAdmin: true };
            await expect(readMotdArtifactPicture({ artifactStore: s.store, sessionCatalog: { getSessionAccess }, adminScope: "unrestricted" },
                "bob-child", { sessionId: "wf-alice", filename: NAME, alt: "a picture" }, viewer))
                .rejects.toMatchObject({ code: "MOTD_FORBIDDEN", message: expect.stringContaining("holds a Workflow agent's base instructions") });
            expect(getSessionAccess).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
        } finally {
            s.cleanup();
        }
    });

    // Review DSS-001: no artifact write path replaces it either. A script running as the Workflow's session (the file's own
    // session) has bulk_store_facts and write_artifact; each write is refused in the same words, the bytes stay, and no fact
    // is written. The name is checked as the store writes it: a trailing separator is dropped, a link's target names a file.
    it("DSS-001: bulk_store_facts to_file and write_artifact (a trailing separator, a link's target) cannot overwrite it", async () => {
        const s = storeDir();
        try {
            await s.store.uploadArtifact("wf-alice", NAME, SECRET_TEXT, "text/markdown");
            const unchanged = async () => expect((await s.store.downloadArtifact("wf-alice", NAME)).body.toString("utf8")).toBe(SECRET_TEXT);
            const factStore = { storeFact: vi.fn(async () => { throw new Error("nothing may be stored"); }) };
            const bulk = createFactTools({ factStore, artifactStore: s.store, agentIdentity: "wf" }).find(tool => tool.name === "bulk_store_facts");
            for (const toFile of [NAME, `${NAME}/`, `${NAME}//`, `  ${NAME.toUpperCase()} `, `dir/${NAME}`]) {
                expect(await bulk.handler({ facts: [], to_file: toFile }, { sessionId: "wf-alice" }), toFile)
                    .toEqual({ error: expect.stringMatching(/^Error: ARTIFACT_OWNER_ONLY: .* Nothing was written\.$/) });
            }
            expect(factStore.storeFact).not.toHaveBeenCalled();
            await unchanged();

            const tools = Object.fromEntries(createArtifactTools({ blobStore: s.store }).map(tool => [tool.name, tool]));
            const write = async params => JSON.parse(String(await tools.write_artifact.handler(params, { durableSessionId: "wf-alice" })));
            const ordinary = path.join(s.dir, "ordinary.txt");
            fs.writeFileSync(ordinary, "replacement text");
            const target = path.join(s.dir, "links", NAME);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, "replacement text");
            const link = path.join(s.dir, "innocent.txt");
            fs.symlinkSync(target, link);
            for (const params of [
                { filename: `${NAME}/`, fromFile: ordinary },
                { filename: `${NAME}\\`, fromFile: ordinary },
                { fromFile: link },
                { filename: `${NAME}/`, content: "replacement text" },
            ]) {
                expect(await write(params), JSON.stringify(params)).toMatchObject({ error: "ARTIFACT_OWNER_ONLY" });
            }
            await unchanged();

            // Ordinary writes go on as before.
            expect(await bulk.handler({ facts: [], to_file: "failures.json" }, { sessionId: "wf-alice" })).toMatchObject({ failed_artifact: "failures.json" });
            expect(await write({ fromFile: ordinary })).toMatchObject({ success: true, filename: "ordinary.txt" });
            expect(await write({ filename: "notes.md", content: "hello" })).toMatchObject({ success: true, filename: "notes.md" });
        } finally {
            s.cleanup();
        }
    });

    // Review DS2-001: a blank filename falls back to the source's name in the store; the check sees that same name. A source
    // file named for the artifact, directly or through a link with an innocent name, is refused whatever blank filename
    // (spaces, a tab and a newline) is given; the bytes stay. A blank filename with inline content is refused as missing.
    it("DS2-001: a blank filename with a source named for it, directly or through a link, cannot overwrite it", async () => {
        const s = storeDir();
        try {
            await s.store.uploadArtifact("wf-alice", NAME, SECRET_TEXT, "text/markdown");
            const before = await s.store.statArtifact("wf-alice", NAME);
            const unchanged = async () => {
                expect((await s.store.downloadArtifact("wf-alice", NAME)).body.toString("utf8")).toBe(SECRET_TEXT);
                expect(await s.store.statArtifact("wf-alice", NAME)).toEqual(before);
            };
            const tools = Object.fromEntries(createArtifactTools({ blobStore: s.store }).map(tool => [tool.name, tool]));
            const write = async params => JSON.parse(String(await tools.write_artifact.handler(params, { durableSessionId: "wf-alice" })));
            const named = path.join(s.dir, "named", NAME);
            fs.mkdirSync(path.dirname(named), { recursive: true });
            fs.writeFileSync(named, "replacement text");
            const link = path.join(s.dir, "innocent-blank.txt");
            fs.symlinkSync(named, link);
            for (const filename of [" ", "\t\n", "   \t "]) {
                for (const fromFile of [named, link]) {
                    expect(await write({ filename, fromFile }), JSON.stringify({ filename, fromFile })).toMatchObject({ error: "ARTIFACT_OWNER_ONLY" });
                }
                expect(await write({ filename, content: "replacement text" })).toMatchObject({ error: "FILENAME_REQUIRED" });
            }
            await unchanged();

            // Ordinary writes: an omitted or blank filename takes the source's name; an explicit one is trimmed.
            const ordinary = path.join(s.dir, "ordinary-2.txt");
            fs.writeFileSync(ordinary, "ordinary text");
            expect(await write({ fromFile: ordinary })).toMatchObject({ success: true, filename: "ordinary-2.txt" });
            expect(await write({ filename: "  ", fromFile: ordinary })).toMatchObject({ success: true, filename: "ordinary-2.txt" });
            expect(await write({ filename: "  kept.txt ", fromFile: ordinary })).toMatchObject({ success: true, filename: "kept.txt" });
            expect(await write({ filename: " notes.md ", content: "hello" })).toMatchObject({ success: true, filename: "notes.md" });
        } finally {
            s.cleanup();
        }
    });
});
