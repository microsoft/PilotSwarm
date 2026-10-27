/**
 * The canvas app transition (issue 181): the one-time legacy migration
 * removes the old apps/* facts, which ends the old apps' exemption. So while
 * this process's switch is on, the management client (and through it the Web
 * API, MCP and CLI) refuses to APPLY it (CANVAS_LEGACY_MODE_ON, 409) and
 * touches nothing; a dry run still works and says the apply is blocked. With
 * the switch off it runs as before.
 *
 * Run: node --test test/unit/canvas-legacy-migration-guard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { CanvasAppError, CANVAS_APP_ERROR_CODES } from "../../dist/canvas-app-store.js";

const ADMIN = { provider: "test", subject: "ada" };
const SHA = "a".repeat(64);
const HTML = "<!doctype html><html><body>old app</body></html>";

/** A management client over stubs that record every read and write. */
function client(canvasLegacyMode, facts = []) {
    const calls = [];
    const mgmt = new PilotSwarmManagementClient({ store: "postgres://unused", canvasLegacyMode });
    mgmt._started = true;
    mgmt._catalog = {
        canvasApps: new Proxy({}, {
            get(_t, op) {
                return async () => { calls.push(`registry.${String(op)}`); throw new CanvasAppError("NOT_FOUND", "no such app"); };
            },
        }),
        getSession: async () => null,
    };
    mgmt._artifactStore = {
        downloadArtifactText: async (...args) => { calls.push("artifact.download"); void args; return HTML; },
        uploadArtifact: async () => { calls.push("artifact.upload"); },
    };
    mgmt._factStore = {
        readFacts: async () => { calls.push("facts.read"); return { facts }; },
        deleteFactIfEtag: async () => { calls.push("facts.delete"); return true; },
    };
    return { mgmt, calls };
}

describe("migrateLegacyCanvasApps and the transition switch", () => {
    it("the error code is public and maps to 409", () => {
        assert.ok(CANVAS_APP_ERROR_CODES.includes("CANVAS_LEGACY_MODE_ON"));
        assert.equal(new CanvasAppError("CANVAS_LEGACY_MODE_ON", "x").status, 409);
    });

    it("switch on: apply is refused before anything is read or written", async () => {
        const { mgmt, calls } = client(true, [{ key: "apps/board", value: { name: "board", source: { sessionId: "s", filename: "canvas.html", sha256: SHA } }, etag: 1 }]);
        await assert.rejects(
            mgmt.migrateLegacyCanvasApps({ dryRun: false }, ADMIN, true),
            (err) => err instanceof CanvasAppError && err.code === "CANVAS_LEGACY_MODE_ON" && err.status === 409 && /switch it off/.test(err.message),
        );
        assert.deepEqual(calls, [], "no fact read, no registry write, no fact deleted");
    });

    it("switch on: a dry run still works and says the apply is blocked", async () => {
        const { mgmt, calls } = client(true);
        const plan = await mgmt.migrateLegacyCanvasApps({ dryRun: true }, ADMIN, true);
        assert.equal(plan.dryRun, true);
        assert.deepEqual(plan.lines, []);
        assert.equal(plan.applyBlocked?.code, "CANVAS_LEGACY_MODE_ON");
        assert.match(plan.applyBlocked.message, /switch it off before applying/);
        assert.deepEqual(calls, ["facts.read"]);
        // No dryRun at all is a dry run too.
        assert.equal((await mgmt.migrateLegacyCanvasApps({}, ADMIN, true)).applyBlocked?.code, "CANVAS_LEGACY_MODE_ON");
    });

    it("switch off: apply runs as before, with no blocked note", async () => {
        const { mgmt, calls } = client(false);
        const run = await mgmt.migrateLegacyCanvasApps({ dryRun: false }, ADMIN, true);
        assert.equal(run.dryRun, false);
        assert.equal(run.applyBlocked, undefined);
        assert.deepEqual(calls, ["facts.read"], "it read the old catalog");
        const plan = await mgmt.migrateLegacyCanvasApps({ dryRun: true }, ADMIN, true);
        assert.equal(plan.applyBlocked, undefined);
    });

    it("authorization comes first: a non-admin is FORBIDDEN whatever the switch says", async () => {
        for (const mode of [true, false]) {
            const { mgmt, calls } = client(mode);
            await assert.rejects(mgmt.migrateLegacyCanvasApps({ dryRun: false }, ADMIN, false), (err) => err.code === "FORBIDDEN");
            assert.deepEqual(calls, []);
        }
    });
});
