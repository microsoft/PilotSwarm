/**
 * The provider's notice and the attach purpose
 * (docs/proposals/session-workspaces.md, sections 4.2 and 5.3).
 *
 *   N1  prepareWorkspace passes a provider's notice through, trimmed and
 *       capped; anything but a non-empty string is dropped
 *   N2  an extra folder's notice comes back with its name
 *   N3  the checks behind spawn_agent attach with purpose "check"
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MAX_WORKSPACE_NOTICE_CHARS,
    checkWorkspaceForSpawn,
    createBuiltInWorkspaceProvider,
    prepareWorkspace,
    prepareWorkspaceExtras,
} from "../../dist/workspace.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const REQ = { sessionId: "s1", rootSessionId: "s1", revision: 1, workerNodeId: "w1", turnIndex: 3 };

describe("provider notices and the attach purpose", () => {
    let base;
    let roots;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-notice-")));
        for (const dir of ["a/w", "logs/svc"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
        roots = [{ name: "a", path: path.join(base, "a") }, { name: "logs", path: path.join(base, "logs") }];
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    /** The built-in provider, with the notice a test picks for each folder. */
    const noticing = (noticeFor) => {
        const inner = createBuiltInWorkspaceProvider(roots);
        const seen = [];
        return {
            seen,
            listRoots: () => inner.listRoots(),
            async ensureAttached(req) {
                seen.push(req);
                const result = await inner.ensureAttached(req);
                const notice = noticeFor(req);
                return notice === undefined ? result : { ...result, notice };
            },
        };
    };
    const workspace = { schema: 1, root: "a", folder: "w", extra: { logs: { root: "logs", folder: "svc" } } };

    it("N1: passes the notice through, trimmed and capped; drops anything but a non-empty string", async () => {
        const run = async (notice) => prepareWorkspace(noticing(() => notice), { ...REQ, workspace: { schema: 1, root: "a", folder: "w" } });
        const given = await run("  The clone was made again.\n");
        assert.equal(given.ok, true, JSON.stringify(given));
        assert.equal(given.notice, "The clone was made again.");
        for (const dropped of ["", "   ", 42, null, { text: "x" }]) {
            const result = await run(dropped);
            assert.equal(result.ok, true);
            assert.equal("notice" in result, false, `dropped: ${JSON.stringify(dropped)}`);
        }
        const long = await run("x".repeat(MAX_WORKSPACE_NOTICE_CHARS + 50));
        assert.equal(long.notice.length, MAX_WORKSPACE_NOTICE_CHARS + 1, "cut, with an ellipsis");
        assert.ok(long.notice.endsWith("…"));
        assert.equal("notice" in await prepareWorkspace(createBuiltInWorkspaceProvider(roots), { ...REQ, workspace: { schema: 1, root: "a", folder: "w" } }), false,
            "a provider that gives none adds none");
    });

    it("N2: an extra folder's notice comes back with its name", async () => {
        const provider = noticing((req) => (req.attachment === "logs" ? "The log share moved." : undefined));
        const extras = await prepareWorkspaceExtras(provider, { ...REQ, workspace });
        assert.deepEqual(extras.map((extra) => [extra.name, extra.ok, extra.notice]), [["logs", true, "The log share moved."]]);
        assert.equal("notice" in extras[0].attach, false, "the notice is not part of the folder the turn keeps");
    });

    it("N3: the checks behind spawn_agent attach with purpose check, every folder", async () => {
        const provider = createFakeWorkspaceProvider({ roots });
        const checked = await checkWorkspaceForSpawn(provider, { ...REQ, sessionId: "child", workspace });
        assert.equal(checked.ok, true, JSON.stringify(checked));
        const attaches = provider.callsFor("ensureAttached").map((call) => [call.req.attachment ?? null, call.req.purpose]);
        assert.deepEqual(attaches, [[null, "check"], ["logs", "check"]]);
    });
});
