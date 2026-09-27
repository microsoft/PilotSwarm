/**
 * Extra folders of a session workspace (docs/proposals/session-workspaces.md,
 * section 4.10): the record rules, the agent tool's merge rules, the attach
 * of each folder, the spawn check, the provider combiner, and the note the
 * next turn gets.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MAX_WORKSPACE_EXTRAS,
    callChangesWorkingFolder,
    mergeWorkspaceChange,
    sameWorkingFolder,
    sameWorkspace,
    validateWorkspaceText,
} from "../../dist/workspace-check.js";
import {
    checkWorkspaceForSpawn,
    combineWorkspaceProviders,
    createBuiltInWorkspaceProvider,
    prepareWorkspace,
    prepareWorkspaceExtras,
} from "../../dist/workspace.js";
import { extraFoldersChangedNote } from "../../dist/orchestration/state.js";
import { WORKSPACE_ERROR_CODES as CODES } from "../../dist/types.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { createWorkspaceProvider } from "../../examples/repo-workspaces/index.mjs";

const REQ = { sessionId: "s1", rootSessionId: "s1", revision: 1, workerNodeId: "worker-a", turnIndex: 1 };
const ok = (input) => {
    const result = validateWorkspaceText(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.workspace;
};
const bad = (input, pattern) => {
    const result = validateWorkspaceText(input);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
    assert.equal(result.code, CODES.PATH_INVALID);
    if (pattern) assert.match(result.message, pattern);
};

describe("extra folders: the record", () => {
    it("normalizes each folder, leaves required:true out, keeps required:false, sorts the names, and drops an empty map", () => {
        assert.deepEqual(ok({ root: "a", folder: "w", extra: { shared: { root: "s", folder: "x/./y//", required: true }, logs: { root: "l", required: false } } }), {
            schema: 1, root: "a", folder: "w",
            extra: { logs: { root: "l", required: false }, shared: { root: "s", folder: "x/y" } },
        });
        assert.deepEqual(Object.keys(ok({ root: "a", extra: { zeta: { root: "z" }, alpha: { root: "b" } } }).extra), ["alpha", "zeta"]);
        assert.deepEqual(ok({ root: "a", extra: {} }), { schema: 1, root: "a" });
        assert.deepEqual(ok({ root: "a", extra: null }), { schema: 1, root: "a" });
    });

    it(`allows ${MAX_WORKSPACE_EXTRAS} extra folders and refuses one more`, () => {
        const extra = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}`, { root: `r${i}` }]));
        assert.equal(Object.keys(ok({ root: "a", extra: extra(MAX_WORKSPACE_EXTRAS) }).extra).length, MAX_WORKSPACE_EXTRAS);
        bad({ root: "a", extra: extra(MAX_WORKSPACE_EXTRAS + 1) }, /at most/);
    });

    it("refuses bad names, bad shapes, unknown fields and a non-boolean required", () => {
        for (const name of ["Logs", "-x", "_x", "a b", "a/b", "x".repeat(33), ""]) bad({ root: "a", extra: { [name]: { root: "l" } } }, /name/);
        bad({ root: "a", extra: [] }, /object/);
        bad({ root: "a", extra: "logs" }, /object/);
        bad({ root: "a", extra: { logs: null } }, /must be an object/);
        bad({ root: "a", extra: { logs: { root: "l", mode: "ro" } } }, /unknown field "mode" in extra folder "logs"/);
        bad({ root: "a", extra: { logs: { root: "l", required: "no" } } }, /required must be true or false/);
        bad({ root: "a", extra: { logs: { root: "l", folder: "../x" } } }, /extra folder "logs" folder must stay inside the root/);
        bad({ root: "a", extra: { logs: { root: "l/x" } } }, /extra folder "logs" root must be a root name/);
        bad({ root: "a", extra: { logs: {} } }, /extra folder "logs" root must be a non-empty string/);
    });

    it("refuses folders that overlap the working folder or each other in one root; other roots and siblings are fine", () => {
        bad({ root: "a", folder: "w", extra: { x: { root: "a", folder: "w" } } }, /overlaps the working folder/);
        bad({ root: "a", folder: "w", extra: { x: { root: "a", folder: "w/sub" } } }, /overlaps the working folder/);
        bad({ root: "a", folder: "w/sub", extra: { x: { root: "a", folder: "w" } } }, /overlaps the working folder/);
        bad({ root: "a", folder: "w", extra: { x: { root: "a" } } }, /overlaps the working folder/);
        bad({ root: "a", folder: "w", extra: { x: { root: "b", folder: "p" }, y: { root: "b", folder: "p/q" } } }, /"x" and "y" overlap/);
        ok({ root: "a", folder: "w", extra: { x: { root: "a", folder: "w2" }, y: { root: "a", folder: "v" }, z: { root: "b" } } });
    });

    it("sameWorkspace compares the extra folders; sameWorkingFolder does not", () => {
        const base = ok({ root: "a", folder: "w", extra: { logs: { root: "l", folder: "x" } } });
        assert.equal(sameWorkspace(base, ok({ root: "a", folder: "w", extra: { logs: { root: "l", folder: "x/", required: true } } })), true);
        for (const other of [
            { root: "a", folder: "w" },
            { root: "a", folder: "w", extra: { logs: { root: "l", folder: "y" } } },
            { root: "a", folder: "w", extra: { logs: { root: "l", folder: "x", required: false } } },
            { root: "a", folder: "w", extra: { logs: { root: "l", folder: "x" }, more: { root: "m" } } },
        ]) {
            assert.equal(sameWorkspace(base, ok(other)), false, JSON.stringify(other));
            assert.equal(sameWorkingFolder(base, ok(other)), true, JSON.stringify(other));
        }
        assert.equal(sameWorkingFolder(base, ok({ root: "a", folder: "v", extra: base.extra })), false);
        assert.equal(sameWorkspace(null, null), true);
        assert.equal(sameWorkspace(base, null), false);
    });
});

describe("extra folders: which call ends the turn", () => {
    it("only a call with extra and nothing else keeps the turn going", () => {
        assert.equal(callChangesWorkingFolder({ extra: { logs: { root: "l" } } }), false);
        assert.equal(callChangesWorkingFolder({ extra: { logs: null } }), false);
        assert.equal(callChangesWorkingFolder(JSON.stringify({ extra: { logs: null } })), false);
        assert.equal(callChangesWorkingFolder({ extra: { logs: null }, clear: false }), false);
        for (const args of [
            { root: "a" }, { root: "a", folder: "w" }, { folder: "w" }, { clear: true },
            { extra: { logs: null }, root: "a" }, { extra: { logs: null }, folder: "w" }, { extra: { logs: null }, clear: true },
            {}, { extra: null }, null, undefined, "not json", 5,
        ]) {
            assert.equal(callChangesWorkingFolder(args), true, JSON.stringify(args));
        }
    });
});

describe("extra folders: the agent tool's merge", () => {
    const current = ok({ root: "a", folder: "w", extra: { logs: { root: "l", folder: "x" } } });

    it("adds, replaces and removes by name; names left out stay; the working folder stays", () => {
        const added = mergeWorkspaceChange(current, { extra: { shared: { root: "s" } } });
        assert.equal(added.ok, true, JSON.stringify(added));
        assert.deepEqual(added.next, { schema: 1, root: "a", folder: "w", extra: { logs: { root: "l", folder: "x" }, shared: { root: "s" } } });
        assert.deepEqual([added.changesWorkingFolder, added.added, added.replaced, added.removed], [false, ["shared"], [], []]);

        const replaced = mergeWorkspaceChange(current, { extra: { logs: { root: "l", folder: "y" } } });
        assert.deepEqual([replaced.next.extra, replaced.replaced], [{ logs: { root: "l", folder: "y" } }, ["logs"]]);

        const removed = mergeWorkspaceChange(current, { extra: { logs: null } });
        assert.deepEqual([removed.next, removed.removed, removed.extraPatch], [{ schema: 1, root: "a", folder: "w" }, ["logs"], { logs: null }]);

        const same = mergeWorkspaceChange(current, { extra: { logs: { root: "l", folder: "x" } } });
        assert.equal(sameWorkspace(current, same.next), true);
        assert.deepEqual([same.added, same.replaced], [[], []]);
    });

    it("a new working folder keeps the extra folders; the same working folder is not a change of it", () => {
        const moved = mergeWorkspaceChange(current, { root: "a", folder: "v" });
        assert.deepEqual(moved.next, { schema: 1, root: "a", folder: "v", extra: { logs: { root: "l", folder: "x" } } });
        assert.equal(moved.changesWorkingFolder, true);
        const stay = mergeWorkspaceChange(current, { root: "a", folder: "w", extra: { shared: { root: "s" } } });
        assert.equal(stay.changesWorkingFolder, false);
        const first = mergeWorkspaceChange(null, { root: "a", extra: { logs: { root: "l" } } });
        assert.deepEqual([first.next, first.changesWorkingFolder, first.added], [{ schema: 1, root: "a", extra: { logs: { root: "l" } } }, true, ["logs"]]);
    });

    it("clear drops everything and names what it removed", () => {
        const cleared = mergeWorkspaceChange(current, { clear: true });
        assert.deepEqual([cleared.next, cleared.changesWorkingFolder, cleared.removed], [null, true, ["logs"]]);
    });

    it("refuses what it cannot apply", () => {
        const refused = (change, pattern, from = current) => {
            const result = mergeWorkspaceChange(from, change);
            assert.equal(result.ok, false, `accepted ${JSON.stringify(change)}`);
            assert.equal(result.code, CODES.PATH_INVALID);
            assert.match(result.message, pattern);
        };
        refused({ clear: true, extra: { logs: null } }, /either clear=true or a change/);
        refused({ clear: true, root: "a" }, /either clear=true or a change/);
        refused({ clear: "yes" }, /clear must be true or false/);
        refused({ folder: "v" }, /pass root with folder/);
        refused({}, /pass root and folder/);
        refused({ extra: { nope: null } }, /no extra folder is named "nope"/);
        refused({ extra: { logs: { root: "l" } } }, /set a working folder first/, null);
        refused({ extra: { inside: { root: "a", folder: "w/sub" } } }, /overlaps the working folder/);
        refused({ root: "l", folder: "x/deeper" }, /overlaps the working folder/);
        refused({ extra: { Bad: { root: "l" } } }, /name/);
    });
});

describe("extra folders: attach", () => {
    let base;
    let roots;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-extras-")));
        for (const dir of ["a/w", "logs/svc", "shared/notes"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
        roots = [
            { name: "a", path: path.join(base, "a") },
            { name: "logs", path: path.join(base, "logs") },
            { name: "shared", path: path.join(base, "shared") },
        ];
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    const record = () => ok({ root: "a", folder: "w", extra: { logs: { root: "logs", folder: "svc", required: false }, shared: { root: "shared", folder: "notes" } } });

    it("the provider sees one folder per call: the working folder without extras, each extra folder with its name", async () => {
        const provider = createFakeWorkspaceProvider({ roots, adopt: { agents: true, skills: true, instructions: true } });
        const cwd = await prepareWorkspace(provider, { ...REQ, workspace: record() });
        assert.equal(cwd.ok, true, JSON.stringify(cwd));
        const extras = await prepareWorkspaceExtras(provider, { ...REQ, workspace: record() });
        const attaches = provider.callsFor("ensureAttached").map((call) => call.req);
        assert.deepEqual(attaches.map((req) => [req.attachment ?? null, req.workspace]), [
            [null, { schema: 1, root: "a", folder: "w" }],
            ["logs", { schema: 1, root: "logs", folder: "svc" }],
            ["shared", { schema: 1, root: "shared", folder: "notes" }],
        ]);
        assert.deepEqual(extras.map((extra) => [extra.name, extra.ok, extra.required, extra.ok && extra.attach.path]), [
            ["logs", true, false, path.join(base, "logs/svc")],
            ["shared", true, true, path.join(base, "shared/notes")],
        ]);
        // The working folder adopts; nothing is adopted from an extra folder.
        assert.ok(cwd.adopt);
        for (const extra of extras) assert.equal("adopt" in extra.attach, false);
    });

    it("passes readOnly through and reports each failure by name", async () => {
        const provider = createFakeWorkspaceProvider({ roots });
        provider.script({ type: "ok", path: path.join(base, "logs/svc") }, { attachment: "logs" });
        provider.script({ type: "fail", code: "WORKSPACE_NOT_MOUNTED", message: "no marker", retryAfterMs: 30_000 }, { attachment: "shared" });
        const readOnly = createBuiltInWorkspaceProvider(roots);
        const wrapped = { ...readOnly, ensureAttached: async (req) => ({ ...(await readOnly.ensureAttached(req)), ...(req.attachment === "logs" ? { readOnly: true } : {}) }) };
        const ro = await prepareWorkspaceExtras(wrapped, { ...REQ, workspace: record() }, { names: ["logs"] });
        assert.deepEqual(ro.map((extra) => [extra.name, extra.ok && extra.attach.readOnly]), [["logs", true]]);

        const results = await prepareWorkspaceExtras(provider, { ...REQ, workspace: record() });
        const shared = results.find((extra) => extra.name === "shared");
        assert.deepEqual(
            { ok: shared.ok, code: shared.code, retryAfterMs: shared.retryAfterMs, root: shared.root, folder: shared.folder, required: shared.required },
            { ok: false, code: "WORKSPACE_NOT_MOUNTED", retryAfterMs: 30_000, root: "shared", folder: "notes", required: true },
        );
        assert.equal(results.find((extra) => extra.name === "logs").ok, true);
    });

    it("the spawn check attaches and releases the working folder and every extra folder, and fails on any one", async () => {
        const provider = createFakeWorkspaceProvider({ roots });
        const good = await checkWorkspaceForSpawn(provider, { ...REQ, workspace: record() });
        assert.equal(good.ok, true, JSON.stringify(good));
        const released = provider.callsFor("release").map((call) => [call.req.attachment ?? null, call.req.reason]);
        assert.deepEqual(released.sort(), [[null, "spawn_check"], ["logs", "spawn_check"], ["shared", "spawn_check"]].sort());

        const failing = createFakeWorkspaceProvider({ roots });
        failing.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING", message: "gone" }, { attachment: "logs" });
        const refused = await checkWorkspaceForSpawn(failing, { ...REQ, workspace: record() });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "WORKSPACE_FOLDER_MISSING");
        assert.match(refused.message, /^extra folder "logs": gone/);
        // What was attached is released even when the check fails.
        assert.equal(failing.callsFor("release").length, failing.callsFor("ensureAttached").length);
    });
});

describe("combineWorkspaceProviders", () => {
    it("lists every provider's roots and routes each call by the request's root", async () => {
        const repos = createFakeWorkspaceProvider({ roots: [{ name: "repos", path: "/ws/repos" }] });
        const logs = createFakeWorkspaceProvider({ roots: [{ name: "logs", path: "/ws/logs" }] });
        const combined = combineWorkspaceProviders([repos, logs]);
        assert.deepEqual(await combined.listRoots(), [{ name: "repos", path: "/ws/repos" }, { name: "logs", path: "/ws/logs" }]);

        const toLogs = await combined.ensureAttached({ ...REQ, workspace: { schema: 1, root: "logs", folder: "svc" }, attachment: "logs" });
        assert.deepEqual(toLogs, { ok: true, path: "/ws/logs/svc" });
        assert.equal(logs.callsFor("ensureAttached").length, 1);
        assert.equal(logs.callsFor("ensureAttached")[0].req.attachment, "logs");
        assert.equal(repos.callsFor("ensureAttached").length, 0);

        await combined.release({ ...REQ, workspace: { schema: 1, root: "repos", folder: "x" }, reason: "ended" });
        assert.equal(repos.callsFor("release").length, 1);
        assert.equal(logs.callsFor("release").length, 0);

        const unknown = await combined.ensureAttached({ ...REQ, workspace: { schema: 1, root: "nope" } });
        assert.equal(unknown.code, CODES.ROOT_UNKNOWN);
    });

    it("a root two providers list fails the listing, so the attach fails instead of picking one", async () => {
        const combined = combineWorkspaceProviders([
            createBuiltInWorkspaceProvider([{ name: "x", path: "/ws/one" }]),
            createBuiltInWorkspaceProvider([{ name: "x", path: "/ws/two" }]),
        ]);
        await assert.rejects(() => combined.listRoots(), /listed by two providers/);
        const prepared = await prepareWorkspace(combined, { ...REQ, workspace: { schema: 1, root: "x" } });
        assert.equal(prepared.ok, false);
        assert.equal(prepared.code, CODES.ATTACH_FAILED);
    });

    it("the example combines its repo roots with plain roots, and refuses a name used by both", async () => {
        const provider = createWorkspaceProvider({
            roots: [{ name: "a", path: "/ws/a" }],
            serviceUrls: { a: "http://127.0.0.1:9" },
            plainRoots: [{ name: "shared", path: "/ws/shared" }],
        });
        assert.deepEqual((await provider.listRoots()).map((root) => root.name), ["a", "shared"]);
        const shared = await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "shared", folder: "notes" }, attachment: "shared" });
        assert.deepEqual(shared, { ok: true, path: "/ws/shared/notes" });
        assert.throws(() => createWorkspaceProvider({
            roots: [{ name: "a", path: "/ws/a" }], serviceUrls: {}, plainRoots: [{ name: "a", path: "/ws/other" }],
        }), /also a repo root/);
    });
});

describe("extraFoldersChangedNote", () => {
    it("names what was added, moved and removed, with paths when known", () => {
        const from = { extra: { logs: { root: "l", folder: "x" }, old: { root: "o" }, keep: { root: "k" } } };
        const to = { extra: { logs: { root: "l", folder: "y" }, shared: { root: "s" }, keep: { root: "k" } } };
        assert.equal(
            extraFoldersChangedNote(from, to, { shared: "/ws/s" }),
            'Your extra folders changed: moved "logs" (root "l", folder "y"); added "shared" (root "s", at /ws/s); removed "old".',
        );
        assert.equal(extraFoldersChangedNote(from, from), undefined);
        assert.equal(extraFoldersChangedNote({ extra: { a: { root: "r", required: false } } }, { extra: { a: { root: "r" } } }), undefined);
    });
});
