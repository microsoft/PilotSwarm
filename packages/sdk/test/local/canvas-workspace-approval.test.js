/**
 * Canvas workspace approval (issue 181, R20 as amended by the adopted
 * registry-authority decision).
 *
 * No canvas page uses the session's folders or commands until the session
 * owner approved that exact program: page bytes, checked workspace
 * declaration and the folders its names resolve to, in that slot. Whoever
 * wrote the page — the owner, an agent, another user — makes no difference,
 * so an agent that rewrites a foreign page (or a page a foreign app sent it
 * through a canvas action) cannot obtain workspace access by itself.
 *
 * Real PG catalog + the direct management client. Alice owns the session,
 * Bob is another user, Ada an admin.
 *
 * Run: npx vitest run test/local/canvas-workspace-approval.test.js
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { canvasArtifactFilename } from "../../src/canvas-support.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

const schema = `ps_test_canvas_ws_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/pilotswarm";
const ALICE = { provider: "test", subject: "ws-alice" };
const BOB = { provider: "test", subject: "ws-bob" };
const sha = (text) => createHash("sha256").update(text).digest("hex");

const READ_WORK = { read: ["work/**"] };
function page(title, workspace = READ_WORK) {
    const manifest = { name: title, description: "Use when testing workspace approval.", interface: { keys: [], requests: [], events: [] }, workspace };
    return `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body>${title}</body></html>\n`;
}

let catalog, mgmt, artifactDir, workspaceView;

/** What the session proxy records for a draw: the page, then its event. */
async function draw(sessionId, html, { slot = 1, trust = "agent", app = null, workspace = READ_WORK } = {}) {
    const latest = await catalog.getSessionEventsBefore(sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_updated"]);
    const rev = Math.max(0, ...latest.filter((e) => (Number(e.data?.slot) || 1) === slot).map((e) => Number(e.data?.rev) || 0)) + 1;
    await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(slot), html, "text/html");
    await catalog.recordEvents(sessionId, [{
        eventType: "session.canvas_updated",
        data: { rev, slot, sizeBytes: html.length, workspace, trust, pageSha256: sha(html), ...(app ? { app } : {}) },
    }], "test");
    return rev;
}

async function expectWsCode(promise, code) {
    try {
        await promise;
    } catch (error) {
        assertEqual(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
        return error;
    }
    throw new Error(`expected ${code}, but the call succeeded`);
}

async function grant(sessionId, slot, owner = ALICE, decision = "granted") {
    const approval = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot }, owner, false);
    return mgmt.setCanvasWorkspaceConsent({
        sessionId, slot, rev: approval.rev, pageSha256: approval.pageSha256,
        declarationSha256: approval.declarationSha256, bindingsSha256: approval.bindingsSha256, decision,
    }, owner, false);
}

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-ws-approval-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-ws-root-"));
    mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:", workspaceFiles: { roots: [{ name: "a", path: root }], requireMarker: false } });
    mgmt._catalog = catalog;
    mgmt._artifactStore = new FilesystemArtifactStore(artifactDir);
    mgmt._started = true;
    mgmt.config.workspaceFiles = { roots: [{ name: "a", path: root }], requireMarker: false };
    workspaceView = (folder) => ({
        workspace: { root: "a", folder }, revision: 1, path: `/ws/a/${folder}`, status: "ready", lastError: null, heldPrompts: 0,
    });
    let folder = "proj";
    mgmt.getSessionWorkspace = async () => workspaceView(folder);
    mgmt._setTestFolder = (next) => { folder = next; };
});

afterAll(async () => {
    await catalog?.close();
    if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
});

describe("canvas workspace approval", () => {
    it("an agent's page asks first; the owner's approval lets the same call through", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("agent-page"));
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");
        const approval = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false);
        assertEqual(approval.rev, rev);
        assertEqual(approval.decision, null);
        assertEqual(approval.trust, "agent");
        assertEqual(approval.pageSha256, sha(page("agent-page")));
        assertEqual(approval.declaration.read[0], "work/**");
        assertEqual(approval.bindings[0].name, "work");
        assertEqual(approval.bindings[0].root, "a");
        await grant(sessionId, 1);
        const info = await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
        assert(Array.isArray(info.folders), "the approved call runs");
    });

    it("the owner's own app page asks too: approval is positive, not a classification", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("own-app"), { trust: "owner", app: { name: "own-app", version: "1.0.0", versionId: "v1" } });
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
    });

    it("a stale frame, and an approval quoting anything but the slot now, fail closed", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("stale"));
        const approval = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false);
        const quote = (patch) => mgmt.setCanvasWorkspaceConsent({
            sessionId, slot: 1, rev: approval.rev, pageSha256: approval.pageSha256,
            declarationSha256: approval.declarationSha256, bindingsSha256: approval.bindingsSha256, decision: "granted", ...patch,
        }, ALICE, false);
        await expectWsCode(quote({ rev: rev + 1 }), "CANVAS_WS_STALE");
        await expectWsCode(quote({ pageSha256: sha("other") }), "CANVAS_WS_STALE");
        await expectWsCode(quote({ declarationSha256: sha("other") }), "CANVAS_WS_STALE");
        await expectWsCode(quote({ bindingsSha256: sha("other") }), "CANVAS_WS_STALE");
        await quote({});
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev: rev - 1 }), "CANVAS_WS_STALE");
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info" }), "CANVAS_WS_STALE");
    });

    it("only the session owner decides: another user, and an admin on an owned session, are refused", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        await draw(sessionId, page("owner-only"));
        let error = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, BOB, false).catch((e) => e);
        assertEqual(error?.code, "FORBIDDEN");
        error = await grant(sessionId, 1, BOB).catch((e) => e);
        assertEqual(error?.code, "FORBIDDEN");
        error = await mgmt.setCanvasWorkspaceConsent({ sessionId, slot: 1, rev: 1, pageSha256: "", declarationSha256: "", bindingsSha256: "", decision: "granted" }, null, true).catch((e) => e);
        assertEqual(error?.code, "FORBIDDEN", "an admin flag without being the owner decides nothing");
    });

    it("a rewritten page, a changed declaration or moved folders ask again; the identical program keeps its approval", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        let rev = await draw(sessionId, page("program"));
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });

        // The identical document redrawn: same program, same decision.
        rev = await draw(sessionId, page("program"));
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });

        // One byte different (the laundering case): a new program.
        rev = await draw(sessionId, page("program!"));
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");

        // Same page text, wider declaration: a new program.
        rev = await draw(sessionId, page("program"), { workspace: { read: ["work/**"], write: ["work/**"] } });
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");

        // Back to the approved program, but "work" now points elsewhere.
        rev = await draw(sessionId, page("program"));
        mgmt._setTestFolder("other");
        try {
            await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");
        } finally {
            mgmt._setTestFolder("proj");
        }
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });

        // Another slot is another program.
        const rev2 = await draw(sessionId, page("program"), { slot: 2 });
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 2, { op: "info", rev: rev2 }), "CANVAS_WS_CONSENT_REQUIRED");
    });

    it("another user's app: the same contract, with its owner named in the request", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("bobs-app"), { trust: "cross-owner", app: { name: "bobs-app", version: "1.0.0", versionId: "vb" } });
        const error = await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");
        assert(/another user/.test(error.message), "the refusal says whose app it is");
        const approval = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false);
        assertEqual(approval.trust, "cross-owner");
        assertEqual(approval.app?.name, "bobs-app");
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
    });

    it("a denial sticks until the owner decides again", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("denied"));
        await grant(sessionId, 1, ALICE, "denied");
        const error = await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_CONSENT_REQUIRED");
        assert(/declined/.test(error.message));
        assertEqual((await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false)).decision, "denied");
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
    });

    it("a page swapped under an existing approval does not run (no redraw, no new event)", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("approved-page"));
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
        // The canvas file is overwritten without a draw: same event, other bytes.
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(1), page("swapped-page"), "text/html");
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_STALE");
        await expectWsCode(mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false), "CANVAS_WS_STALE");
        // Putting the approved bytes back restores exactly the approved program.
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(1), page("approved-page"), "text/html");
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev });
        // The same on another slot, and the approval quoting the old hash cannot be replayed.
        const rev2 = await draw(sessionId, page("slot-two"), { slot: 2 });
        await grant(sessionId, 2);
        await mgmt.canvasWorkspace(sessionId, 2, { op: "info", rev: rev2 });
        const approved = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 2 }, ALICE, false);
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(2), page("slot-two-swapped"), "text/html");
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 2, { op: "info", rev: rev2 }), "CANVAS_WS_STALE");
        await expectWsCode(mgmt.setCanvasWorkspaceConsent({
            sessionId, slot: 2, rev: approved.rev, pageSha256: approved.pageSha256,
            declarationSha256: approved.declarationSha256, bindingsSha256: approved.bindingsSha256, decision: "granted",
        }, ALICE, false), "CANVAS_WS_STALE");
    });

    it("a page drawn before draw events carried trust is read and still needs approval", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const html = page("legacy");
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(1), html, "text/html");
        await catalog.recordEvents(sessionId, [{ eventType: "session.canvas_updated", data: { rev: 1, slot: 1, sizeBytes: html.length, workspace: READ_WORK } }], "test");
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev: 1 }), "CANVAS_WS_CONSENT_REQUIRED");
        const approval = await mgmt.getCanvasWorkspaceApproval({ sessionId, slot: 1 }, ALICE, false);
        assertEqual(approval.pageSha256, sha(html), "the hash comes from the stored page");
        await grant(sessionId, 1);
        await mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev: 1 });
    });

    it("a page with no workspace block is not affected", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: ALICE });
        const rev = await draw(sessionId, page("visual", null), { workspace: null });
        await expectWsCode(mgmt.canvasWorkspace(sessionId, 1, { op: "info", rev }), "CANVAS_WS_UNDECLARED");
    });
});
