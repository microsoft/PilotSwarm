/**
 * D9 against a real Postgres: an agent session inside a Workflow agent
 * step's subtree reads, through canvas_kv get and list, only the parent's KV
 * rows an agent wrote.
 *
 * P (agent, owned by Alice) started Workflow W; S is W's agent step child.
 * Slot 1 of P holds one row each by Alice, by P itself (an agent) and by a
 * share link. The lineage comes from a Proxy over the real catalog whose
 * workflowStore() answers as the test says: an agent step, outside every
 * agent step, or a read that throws (an explicit lineage error, not an
 * empty result).
 *
 * The second test uses the real lineage: W has an agent state admitted with
 * child S, as the Workflow controller admits one, and C is S's own child
 * (agentRoot distance 1). From S and from C, a list paged one row at a time
 * never names a hidden row's key and still reaches every agent row, and
 * read_canvas with includeData returns only what an agent drew and ticked.
 * Then Alice replaces P's canvas.html through the person upload path
 * (NodeSdkTransport.uploadArtifactContent, which the portal's uploadArtifact
 * operation calls) and through copyArtifact: read_canvas from S and C, with
 * includeData and manifestOnly, for P and "parent", is refused with an
 * explicit error and carries none of her bytes, until P draws again.
 *
 * The third test draws for real and reads back from S and C (content,
 * manifestOnly, includeData): non-ASCII HTML inline, a fromArtifact draw,
 * a fromArtifact source that is not valid UTF-8 (stored as the UTF-8 text
 * it decodes to; with the source's own hash as expectedSha256 it is not
 * drawn), and S drawing and ticking slot 3 of "parent". Each time the
 * stored bytes' SHA-256 equals the slot's recorded doc_sha.
 *
 * Run: npx vitest run test/local/canvas-kv-agent-step-filter.test.js
 */

import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore } from "../../src/index.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { canvasArtifactFilename } from "../../api/src/canvas-slots.js";
import { writeCanvasKv } from "../../dist/canvas-kv.js";
import { createCanvasOperations } from "../../dist/canvas-operations.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "kvf-alice", email: "alice@test", displayName: "Alice" };
const alice = { kind: "user", provider: ALICE.provider, subject: ALICE.subject, isAdmin: false, label: ALICE.displayName };

const keys = (result) => result.entries.map((e) => e.key).join(",");

describe("canvas KV: agent steps do not read rows a person typed", () => {
    it("an agent step sees only agent rows; outside it every row; a failed lineage read an error", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const P = randomUUID();
            const W = randomUUID();
            const S = randomUUID();
            await catalog.createSession(P, { model: "m", owner: ALICE });
            assertEqual((await catalog.createWorkflowSession(W, {
                parentSessionId: P, owner: null, creationConfig: { workflow: { requestSha256: "kv-agent-step-filter" } },
            })).created, true);
            await catalog.createSession(S, { model: "m", parentSessionId: W });
            assertEqual((await catalog.getSession(W)).sessionKind, "workflow");
            assertEqual((await catalog.getSession(S)).parentSessionId, W);

            // Three writers on P slot 1. The link writes under policy "link"
            // with an app that admits viewers; the policy goes back to owner after.
            let out = await writeCanvasKv(catalog, P, 1, alice, [{ op: "put", key: "ui/a", value: { typed: "by a person" } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            out = await writeCanvasKv(catalog, P, 1, { kind: "agent", sessionId: P }, [{ op: "put", key: "app/b", value: { n: 1 } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "link");
            await catalog.setCanvasKvManifest(P, 1, { write: "viewers", shared: [] });
            out = await writeCanvasKv(catalog, P, 1, { kind: "link", writerId: "link-w1", label: "a link", writeEnabled: true },
                [{ op: "put", key: "app/c", value: { typed: "by a link" } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "owner");
            const kinds = (await catalog.canvasKvList(P, 1, null, 10, null)).map((r) => `${r.key}:${r.value.by.kind}`).join(",");
            assertEqual(kinds, "app/b:agent,app/c:link,ui/a:user");

            let lineage = "agent-step";
            const fakeStore = {
                readWorkflowLineage: async (sessionId) => {
                    assertEqual(sessionId, S, "the reader's own lineage is read");
                    if (lineage === "throws") throw new Error("lineage read failed");
                    return {
                        sessionId: S, level: 2,
                        agentRoot: lineage === "agent-step"
                            ? { childSessionId: S, nodeExecutionId: "n", workflowSessionId: W, controllingSessionId: P, distance: 0 }
                            : null,
                    };
                },
            };
            const proxied = new Proxy(catalog, {
                get(target, prop) {
                    if (prop === "workflowStore") return () => fakeStore;
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const deps = (c) => ({
                catalog: c, artifactStore: null, factStore: null, writerSessionId: S, workerNodeId: undefined, agentIdentity: null, mode: "agent",
            });
            const kv = createCanvasOperations(deps(proxied)).canvasKv;

            // In an agent step: only the agent's row.
            assertEqual(keys(await kv({ op: "list", session_id: P })), "app/b");
            assertEqual(JSON.stringify(await kv({ op: "get", key: "ui/a", session_id: P })), JSON.stringify({ found: false, key: "ui/a" }));
            assertEqual(JSON.stringify(await kv({ op: "get", key: "app/c", session_id: P })), JSON.stringify({ found: false, key: "app/c" }));
            assertEqual((await kv({ op: "get", key: "app/b", session_id: P })).found, true);
            // "parent" from the step reaches P, with the same filter.
            assertEqual(keys(await kv({ op: "list", session_id: "parent" })), "app/b");

            // Outside every agent step (agentRoot null): all three.
            lineage = "outside";
            assertEqual(keys(await kv({ op: "list", session_id: P })), "app/b,app/c,ui/a");
            assertEqual((await kv({ op: "get", key: "ui/a", session_id: P })).v.typed, "by a person");

            // A lineage read that throws: an explicit error, no row, and never an empty result.
            lineage = "throws";
            const failed = JSON.stringify({ error: "could not verify the session lineage: lineage read failed" });
            assertEqual(JSON.stringify(await kv({ op: "list", session_id: P })), failed);
            assertEqual(JSON.stringify(await kv({ op: "get", key: "app/b", session_id: P })), failed);

            // The real workflow store: S has no agent invocation recorded, so it is outside every agent step.
            const real = createCanvasOperations(deps(catalog)).canvasKv;
            assertEqual(keys(await real({ op: "list", session_id: P })), "app/b,app/c,ui/a");
        } finally {
            await catalog.close?.();
        }
    });

    it("real agent-step lineage, distance 0 and 1: list cursors never name a hidden row; read_canvas returns only what an agent drew and ticked", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvf-artifacts-"));
        try {
            const artifactStore = new FilesystemArtifactStore(artifactDir);
            const P = randomUUID();
            const S = randomUUID();
            const C = randomUUID();
            await catalog.createSession(P, { model: "m", owner: ALICE });
            const { workflowSessionId: W, nodeExecutionId } = await agentStateOf(catalog, P, S);
            await catalog.createSession(S, { model: "m", parentSessionId: W });
            await catalog.createSession(C, { model: "m", parentSessionId: S });
            const root = { childSessionId: S, nodeExecutionId, workflowSessionId: W, controllingSessionId: P };
            expect((await catalog.workflowStore().readWorkflowLineage(S)).agentRoot).toEqual({ ...root, distance: 0 });
            expect((await catalog.workflowStore().readWorkflowLineage(C)).agentRoot).toEqual({ ...root, distance: 1 });

            const opsFor = (writerSessionId) => createCanvasOperations({
                catalog, artifactStore, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode: "agent",
            });
            // P draws slot 1 and ticks it: the only data the plane holds.
            const drawn = await opsFor(P).drawCanvas({ html: "<html><body>the agent's page</body></html>" });
            expect(drawn.error).toBeUndefined();
            const ticked = await opsFor(P).updateCanvas({ data: { status: "ticked by P" } });
            expect(ticked.error).toBeUndefined();

            // KV rows on P slot 1, in key order: app/b (agent), app/c (link),
            // old/e (legacy, no writer), ui/a (Alice), zz/d (agent).
            const SECRETS = ["typed by a person", "typed by a link", "typed before writers"];
            let out = await writeCanvasKv(catalog, P, 1, alice, [{ op: "put", key: "ui/a", value: { typed: SECRETS[0] } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            out = await writeCanvasKv(catalog, P, 1, { kind: "agent", sessionId: P }, [
                { op: "put", key: "app/b", value: { n: 1 } }, { op: "put", key: "zz/d", value: { n: 2 } }]);
            assertEqual(out.results.every((r) => r.ok), true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "link");
            await catalog.setCanvasKvManifest(P, 1, { write: "viewers", shared: [] });
            out = await writeCanvasKv(catalog, P, 1, { kind: "link", writerId: "link-w2", label: "a link", writeEnabled: true },
                [{ op: "put", key: "app/c", value: { typed: SECRETS[1] } }]);
            assertEqual(out.results[0].ok, true, JSON.stringify(out.results));
            await catalog.setCanvasKvAccess(P, 1, "owner");
            const legacy = await catalog.canvasKvWrite(P, 1, "old/e", { v: { typed: SECRETS[2] } }, null,
                { maxKeys: 1000, maxBytes: 2 * 1024 * 1024, maxValueBytes: 16 * 1024 });
            assertEqual(legacy.status, "written");
            const kinds = (await catalog.canvasKvList(P, 1, null, 10, null)).map((r) => `${r.key}:${r.value.by?.kind ?? "none"}`).join(",");
            assertEqual(kinds, "app/b:agent,app/c:link,old/e:none,ui/a:user,zz/d:agent");

            const HIDDEN = ["ui/a", "app/c", "old/e"];
            const assertNoPersonInput = (result, what) => {
                const text = JSON.stringify(result);
                for (const secret of SECRETS) expect(text, `${what} carries "${secret}"`).not.toContain(secret);
                for (const key of HIDDEN) expect(text, `${what} names the hidden key ${key}`).not.toContain(JSON.stringify(key));
            };

            for (const reader of [S, C]) {
                const ops = opsFor(reader);
                for (const target of [P, "parent"]) {
                    const what = `reader ${reader === S ? "S" : "C"}, target ${target === P ? "P" : "parent"}`;
                    // read_canvas with includeData: the agent's page and the agent's tick, nothing a person typed.
                    const doc = await ops.readCanvas({ session_id: target, includeData: true });
                    expect(doc.exists, what).toBe(true);
                    expect(doc.content).toContain("the agent's page");
                    expect(doc.live.data).toEqual({ status: "ticked by P" });
                    expect(doc.live.updatedBy).toBe(P);
                    assertNoPersonInput(doc, `${what}: read_canvas`);
                    const card = await ops.readCanvas({ session_id: target, includeData: true, manifestOnly: true });
                    expect(card.exists, what).toBe(true);
                    expect(card.live.updatedBy).toBe(P);
                    assertNoPersonInput(card, `${what}: read_canvas manifestOnly`);

                    // canvas_kv list, one row per page: every agent row, and no cursor that names a hidden row.
                    const pages = [];
                    let after;
                    do {
                        const page = await ops.canvasKv({ op: "list", limit: 1, session_id: target, ...(after ? { after } : {}) });
                        expect(page.error, what).toBeUndefined();
                        pages.push(page);
                        after = page.nextAfter;
                        expect(pages.length, `${what}: the cursor ends`).toBeLessThan(10);
                    } while (after);
                    expect(pages.map((p) => p.entries.map((e) => e.key)), what).toEqual([["app/b"], ["zz/d"]]);
                    expect(pages.map((p) => p.nextAfter), what).toEqual(["app/b", undefined]);
                    for (const page of pages) assertNoPersonInput(page, `${what}: list page`);
                    for (const key of HIDDEN) {
                        expect(await ops.canvasKv({ op: "get", key, session_id: target }), what).toEqual({ found: false, key });
                    }
                }
            }
            // Alice replaces P's drawn canvas.html through the person upload
            // path: the transport method the portal's uploadArtifact operation calls.
            const transport = Object.create(NodeSdkTransport.prototype);
            transport.artifactStore = artifactStore;
            const UPLOADED = "<html><body>typed by a person into canvas.html</body></html>";
            await transport.uploadArtifactContent(P, "canvas.html", Buffer.from(UPLOADED).toString("base64"), "text/html", "base64");
            expect(await artifactStore.downloadArtifactText(P, "canvas.html")).toBe(UPLOADED);
            const REFUSED = { error: "the document in canvas slot 1 does not match the last draw_canvas there, so a session in a Workflow agent step cannot read it (canvas.html may have been replaced after the draw); draw the canvas again" };
            const assertRefused = async (secret, how) => {
                for (const reader of [S, C]) {
                    for (const target of [P, "parent"]) {
                        for (const args of [{ includeData: true }, { includeData: true, manifestOnly: true }]) {
                            const what = `${how}: reader ${reader === S ? "S" : "C"}, target ${target === P ? "P" : "parent"}, ${JSON.stringify(args)}`;
                            const result = await opsFor(reader).readCanvas({ session_id: target, ...args });
                            expect(result, what).toEqual(REFUSED);
                            expect(JSON.stringify(result), what).not.toContain(secret);
                        }
                    }
                }
            };
            await assertRefused("typed by a person into canvas.html", "uploaded");
            // Outside every agent step, read_canvas still returns what is stored.
            expect((await opsFor(P).readCanvas({})).content).toBe(UPLOADED);

            // P draws again: the agent steps read the new page.
            expect((await opsFor(P).drawCanvas({ html: "<html><body>the agent's second page</body></html>" })).error).toBeUndefined();
            for (const reader of [S, C]) {
                for (const target of [P, "parent"]) {
                    const doc = await opsFor(reader).readCanvas({ session_id: target, includeData: true });
                    expect(doc.content).toBe("<html><body>the agent's second page</body></html>");
                    expect((await opsFor(reader).readCanvas({ session_id: target, manifestOnly: true })).exists).toBe(true);
                }
            }
            // Alice copies a file of hers over canvas.html: refused the same way.
            await transport.uploadArtifactContent(P, "notes.html", "<html><body>copied by a person</body></html>", "text/html");
            await transport.copyArtifact(P, "notes.html", P, "canvas.html");
            expect(await artifactStore.downloadArtifactText(P, "canvas.html")).toContain("copied by a person");
            await assertRefused("copied by a person", "copied");

            // Outside the agent step (P itself) every row shows, with its value.
            expect(keys(await opsFor(P).canvasKv({ op: "list" }))).toBe("app/b,app/c,old/e,ui/a,zz/d");
        } finally {
            await catalog.close?.();
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("real draws read back from an agent step: non-ASCII HTML, fromArtifact, a source that is not UTF-8, and the step drawing on its parent's slot 3", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvf-artifacts-"));
        try {
            const artifactStore = new FilesystemArtifactStore(artifactDir);
            const P = randomUUID();
            const S = randomUUID();
            const C = randomUUID();
            await catalog.createSession(P, { model: "m", owner: ALICE });
            const { workflowSessionId: W } = await agentStateOf(catalog, P, S);
            await catalog.createSession(S, { model: "m", parentSessionId: W });
            await catalog.createSession(C, { model: "m", parentSessionId: S });
            expect((await catalog.workflowStore().readWorkflowLineage(S)).agentRoot?.distance).toBe(0);
            expect((await catalog.workflowStore().readWorkflowLineage(C)).agentRoot?.distance).toBe(1);
            const opsFor = (writerSessionId) => createCanvasOperations({
                catalog, artifactStore, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode: "agent",
            });
            const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
            /** The stored canvas document's bytes, their SHA-256, and the slot's recorded doc_sha. */
            const stored = async (slot) => {
                const filename = canvasArtifactFilename(slot);
                const { body } = await artifactStore.downloadArtifact(P, filename);
                const row = (await catalog.getCanvasLive(P)).find((r) => r.slot === slot);
                return { body, sha: sha256(body), metaSha: (await artifactStore.statArtifact(P, filename))?.sha256, docSha: row?.docSha };
            };
            /** The same document from S and C, for P and "parent": content, manifestOnly and includeData. */
            const readsBack = async (slot, text, how) => {
                for (const reader of [S, C]) {
                    for (const target of [P, "parent"]) {
                        const what = `${how}: reader ${reader === S ? "S" : "C"}, target ${target === P ? "P" : "parent"}`;
                        const doc = await opsFor(reader).readCanvas({ session_id: target, slot, includeData: true });
                        expect(doc.error, what).toBeUndefined();
                        expect(doc.content, what).toBe(text);
                        expect(doc.sizeBytes, what).toBe(Buffer.byteLength(text, "utf8"));
                        expect(doc.sizeChars, what).toBe(text.length);
                        expect(doc.truncated, what).toBe(false);
                        const card = await opsFor(reader).readCanvas({ session_id: target, slot, manifestOnly: true, includeData: true });
                        expect(card.error, what).toBeUndefined();
                        expect(card.exists, what).toBe(true);
                        expect(card.sizeBytes, what).toBe(Buffer.byteLength(text, "utf8"));
                        expect(card.live, what).toEqual(doc.live);
                        results.push({ doc, card });
                    }
                }
            };
            let results = [];
            const manifest = (description) => `<!-- CANVAS-APP-MANIFEST ${JSON.stringify({ name: "greetings", description })} -->`;

            // 1. Non-ASCII HTML drawn inline by P on slot 1.
            const GREETING = "Grüße — 你好 ✓";
            const NON_ASCII = `<!doctype html>\n${manifest(GREETING)}\n<html><body><p>${GREETING}</p></body></html>`;
            expect(Buffer.byteLength(NON_ASCII, "utf8")).toBeGreaterThan(NON_ASCII.length);
            const drawn1 = await opsFor(P).drawCanvas({ html: NON_ASCII });
            expect(drawn1.error).toBeUndefined();
            let s = await stored(1);
            expect(s.body.equals(Buffer.from(NON_ASCII, "utf8"))).toBe(true);
            expect(s.docSha).toBe(s.sha);
            expect(s.metaSha).toBe(s.sha);
            results = [];
            await readsBack(1, NON_ASCII, "non-ASCII inline");
            for (const { card } of results) expect(card.app).toEqual({ name: "greetings", description: GREETING });

            // 2. fromArtifact: P draws slot 2 from its own UTF-8 artifact, with the expected hash.
            const FROM = `<!doctype html>\n${manifest("from an artifact ✓")}\n<html><body><p>${GREETING} (artifact)</p></body></html>`;
            const uploaded = await artifactStore.uploadArtifact(P, "page.html", FROM, "text/html");
            const drawn2 = await opsFor(P).drawCanvas({ fromArtifact: { filename: "page.html", expectedSha256: uploaded.sha256 }, slot: 2 });
            expect(drawn2.error).toBeUndefined();
            expect(drawn2.source).toEqual({ kind: "artifact", sessionId: P, filename: "page.html", sha256: uploaded.sha256 });
            s = await stored(2);
            expect(s.sha).toBe(uploaded.sha256);
            expect(s.docSha).toBe(s.sha);
            expect(s.metaSha).toBe(s.sha);
            results = [];
            await readsBack(2, FROM, "fromArtifact");
            for (const { card } of results) expect(card.app.description).toBe("from an artifact ✓");

            // 3. A source that is not valid UTF-8 (Latin-1 é and a lone 0xFF).
            //    With the source's own hash as expectedSha256, nothing is drawn.
            //    Without it, the draw stores the UTF-8 text the bytes decode to,
            //    each bad byte as U+FFFD, and records the hash of those stored bytes.
            const RAW = Buffer.from("<html><body><p>caf\xE9 \xFF</p></body></html>", "latin1");
            const rawUpload = await artifactStore.uploadArtifact(P, "latin1.html", RAW, "text/html");
            expect(rawUpload.sha256).toBe(sha256(RAW));
            const pinned = await opsFor(P).drawCanvas({ fromArtifact: { filename: "latin1.html", expectedSha256: rawUpload.sha256 }, slot: 4 });
            expect(pinned.error).toMatch(/^SHA_MISMATCH: artifact latin1\.html hashes [0-9a-f]{64}, expected [0-9a-f]{64}; nothing was drawn$/);
            expect(await opsFor(S).readCanvas({ session_id: "parent", slot: 4 })).toEqual({ exists: false });
            const NORMALIZED = RAW.toString("utf8");
            expect(NORMALIZED).toBe("<html><body><p>caf\uFFFD \uFFFD</p></body></html>");
            const drawn4 = await opsFor(P).drawCanvas({ fromArtifact: { filename: "latin1.html" }, slot: 4 });
            expect(drawn4.error).toBeUndefined();
            s = await stored(4);
            expect(s.body.equals(Buffer.from(NORMALIZED, "utf8"))).toBe(true);
            expect(s.sha).not.toBe(rawUpload.sha256);
            expect(drawn4.source.sha256).toBe(s.sha);
            expect(s.docSha).toBe(s.sha);
            expect(s.metaSha).toBe(s.sha);
            results = [];
            await readsBack(4, NORMALIZED, "a source that is not UTF-8");

            // 4. The agent step S draws on "parent" (P), slot 3, ticks it, and
            //    reads it back; C reads it too. P, outside, reads the same bytes.
            const STEP = `<!doctype html>\n${manifest("drawn by the agent step ✓")}\n<html><body><p>${GREETING} (step)</p></body></html>`;
            const drawn3 = await opsFor(S).drawCanvas({ html: STEP, session_id: "parent", slot: 3 });
            expect(drawn3.error).toBeUndefined();
            expect(drawn3.slot).toBe(3);
            const ticked = await opsFor(S).updateCanvas({ data: { status: "ticked by S ✓" }, session_id: "parent", slot: 3 });
            expect(ticked.error).toBeUndefined();
            s = await stored(3);
            expect(s.body.equals(Buffer.from(STEP, "utf8"))).toBe(true);
            expect(s.docSha).toBe(s.sha);
            expect(s.metaSha).toBe(s.sha);
            results = [];
            await readsBack(3, STEP, "the step's own draw");
            for (const { doc, card } of results) {
                expect(doc.live.data).toEqual({ status: "ticked by S ✓" });
                expect(doc.live.updatedBy).toBe(S);
                expect(card.app.description).toBe("drawn by the agent step ✓");
            }
            expect((await opsFor(P).readCanvas({ slot: 3 })).content).toBe(STEP);
            // The other slots are untouched by the step's draw.
            expect((await opsFor(S).readCanvas({ session_id: "parent", slot: 1 })).content).toBe(NON_ASCII);
        } finally {
            await catalog.close?.();
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});

const ACTOR = { kind: "system", name: "canvas-kv-agent-step-filter-test" };
const AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: kv-reader, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/**
 * A live Workflow of `parent` whose agent state is admitted pending with
 * child `childSessionId`: its invocation record, as the Workflow controller
 * admits one (the fixture of workflow-input-policy.test.js).
 */
async function agentStateOf(catalog, parent, childSessionId) {
    const store = catalog.workflowStore();
    const compiled = compileWorkflow(AGENT_YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "kv-agent-step-filter" } } })).toEqual({ created: true });
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "kv-agent-step-filter", publish: true, title: "Workflow: kv-reader",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, nodeExecutionId };
}
