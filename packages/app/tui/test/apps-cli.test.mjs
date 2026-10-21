/**
 * `pilotswarm apps` against a stub management client: each command calls the
 * management-client operation the Web API, MCP and portal share, with the
 * arguments that operation expects. No deployment, database or network.
 *
 * Run: node --test tui/test/apps-cli.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runAppsCommand, parseAppsArgs, APPS_USAGE } from "../src/apps-cli.js";

function stubClient(answers = {}) {
    const calls = [];
    const client = new Proxy({}, {
        get(_target, op) {
            if (op === "then") return undefined;
            return async (args) => {
                calls.push({ op: String(op), args });
                const answer = answers[op];
                return typeof answer === "function" ? answer(args) : answer ?? { ok: true };
            };
        },
    });
    return { client, calls };
}

async function run(argv, answers) {
    const { client, calls } = stubClient(answers);
    const out = [];
    const err = [];
    const code = await runAppsCommand(argv, { client, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, calls, out: out.join("\n"), err: err.join("\n") };
}

test("no command prints usage and fails; --help succeeds", async () => {
    const none = await run([]);
    assert.equal(none.code, 1);
    assert.equal(none.out, APPS_USAGE);
    assert.equal(none.calls.length, 0);
    const help = await run(["list", "--help"]);
    assert.equal(help.code, 0);
});

test("parseAppsArgs reads scope, tags and values", () => {
    const { flags, positional } = parseAppsArgs(["push", "a.html", "--name", "board", "--shared", "--tags", "a, b,,c", "--version", "1.2.0"]);
    assert.deepEqual(positional, ["push", "a.html"]);
    assert.equal(flags.scope, "shared");
    assert.equal(flags.name, "board");
    assert.equal(flags.version, "1.2.0");
    assert.deepEqual(flags.tags, ["a", "b", "c"]);
});

test("push publishes private unless --shared", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-cli-"));
    try {
        const file = path.join(dir, "board.html");
        fs.writeFileSync(file, "<html>board</html>");
        const answer = (args) => ({ status: "published", version: "1.0.0", scope: args.scope ?? "user" });
        const priv = await run(["push", file, "--name", "board"], { uploadCanvasApp: answer });
        assert.equal(priv.code, 0);
        assert.deepEqual(priv.calls, [{ op: "uploadCanvasApp", args: { html: "<html>board</html>", name: "board" } }]);
        assert.match(priv.out, /published board@1\.0\.0 \(private\)/);
        const shared = await run(["push", file, "--name", "board", "--shared"], { uploadCanvasApp: answer });
        assert.equal(shared.calls[0].args.scope, "shared");
        assert.match(shared.out, /\(shared\)/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("publish --check calls publishCanvasApp with checkOnly and nothing else", async () => {
    const answer = { checkOnly: true, ok: true, code: null, error: null, sizeBytes: 120, manifest: { name: "board", version: "1.2.0", description: "Use when a team signs off a train.", tags: ["review"] }, workspace: true };
    const check = await run(["publish", "s-1", "--slot", "2", "--check"], { publishCanvasApp: answer });
    assert.equal(check.code, 0);
    // One call, and it is the check: no publish, upload or other write op.
    assert.deepEqual(check.calls, [{ op: "publishCanvasApp", args: { sessionId: "s-1", slot: 2, checkOnly: true } }]);
    assert.match(check.out, /check passed/);
    assert.match(check.out, /name: board/);
    assert.match(check.out, /workspace/);
    const failed = await run(["publish", "s-1", "--check"], { publishCanvasApp: { checkOnly: true, ok: false, code: "BAD_REQUEST", error: "the manifest has no `interface` block." } });
    assert.equal(failed.code, 2);
    assert.match(failed.out, /check failed: the manifest has no `interface` block/);
});

test("publish needs --name unless --check, and publishes private unless --shared", async () => {
    await assert.rejects(() => run(["publish", "s-1"]), /usage: pilotswarm apps publish/);
    const answer = (args) => ({ status: "published", version: "1.0.0", scope: args.scope ?? "user" });
    const priv = await run(["publish", "s-1", "--name", "board"], { publishCanvasApp: answer });
    assert.deepEqual(priv.calls, [{ op: "publishCanvasApp", args: { sessionId: "s-1", name: "board" } }]);
    assert.match(priv.out, /published board@1\.0\.0 \(private\)/);
    const shared = await run(["publish", "s-1", "--slot", "3", "--name", "board", "--shared"], { publishCanvasApp: answer });
    assert.deepEqual(shared.calls[0].args, { sessionId: "s-1", slot: 3, name: "board", scope: "shared" });
});

test("publish rejects a supplied --slot outside 1-5 before any request (review r1 P7)", async () => {
    for (const bad of ["0", "-1", "1.5", "6", "abc", ""]) {
        for (const extra of [["--check"], ["--name", "board"]]) {
            const { client, calls } = stubClient();
            await assert.rejects(
                () => runAppsCommand(["publish", "s-1", "--slot", bad, ...extra], { client, out: () => {}, err: () => {} }),
                /--slot must be a canvas slot from 1 to 5/,
                `--slot ${JSON.stringify(bad)} ${extra.join(" ")}`,
            );
            assert.deepEqual(calls, [], `no request for --slot ${JSON.stringify(bad)}`);
        }
    }
    // A trailing --slot with no value is invalid too, not slot 1.
    const { client, calls } = stubClient();
    await assert.rejects(() => runAppsCommand(["publish", "s-1", "--check", "--slot"], { client, out: () => {}, err: () => {} }), /--slot must be/);
    assert.deepEqual(calls, []);
    // Absent: the default slot (nothing sent); 5 is the last slot.
    const absent = await run(["publish", "s-1", "--check"], { publishCanvasApp: { checkOnly: true, ok: true, sizeBytes: 1, manifest: {} } });
    assert.deepEqual(absent.calls[0].args, { sessionId: "s-1", checkOnly: true });
    const five = await run(["publish", "s-1", "--slot", "5", "--check"], { publishCanvasApp: { checkOnly: true, ok: true, sizeBytes: 1, manifest: {} } });
    assert.deepEqual(five.calls[0].args, { sessionId: "s-1", slot: 5, checkOnly: true });
});

test("label takes the same --slot as publish: a number 1-5, checked before any request", async () => {
    const answer = { sessionId: "s-1", slot: 2, rev: 4, trust: "cross-owner", legacy: false };
    const two = await run(["label", "s-1", "--slot", "2", "--json"], { getCanvasRevisionLabel: answer });
    assert.deepEqual(two.calls[0], { op: "getCanvasRevisionLabel", args: { sessionId: "s-1", slot: 2 } });
    const absent = await run(["label", "s-1", "--json"], { getCanvasRevisionLabel: answer });
    assert.deepEqual(absent.calls[0].args, { sessionId: "s-1" });
    for (const bad of ["0", "6", "abc", ""]) {
        const { client, calls } = stubClient();
        await assert.rejects(() => runAppsCommand(["label", "s-1", "--slot", bad], { client, out: () => {}, err: () => {} }), /--slot must be a canvas slot from 1 to 5/);
        assert.deepEqual(calls, [], `no request for --slot ${JSON.stringify(bad)}`);
    }
});

test("share and unshare move between scopes", async () => {
    const share = await run(["share", "board"]);
    assert.deepEqual(share.calls[0], { op: "setCanvasAppScope", args: { name: "board", scope: "user", targetScope: "shared" } });
    const unshare = await run(["unshare", "board"]);
    assert.deepEqual(unshare.calls[0], { op: "setCanvasAppScope", args: { name: "board", scope: "shared", targetScope: "user" } });
});

test("describe changes only the description and tags of the selected copy (review S07)", async () => {
    await assert.rejects(run(["describe", "board"]), /describe <name>/);
    const both = await run(["describe", "board", "--description", "Use when the team plans the week together.", "--tags", "Plan, Week", "--shared"]);
    assert.deepEqual(both.calls, [{ op: "setCanvasAppMetadata", args: { name: "board", scope: "shared", description: "Use when the team plans the week together.", tags: ["Plan", "Week"] } }]);
    const tagsOnly = await run(["describe", "board", "--tags", "a"]);
    assert.deepEqual(tagsOnly.calls, [{ op: "setCanvasAppMetadata", args: { name: "board", tags: ["a"] } }], "no page, no version, no description");
});

test("pin needs name@version", async () => {
    await assert.rejects(run(["pin", "board"]), /name>@<version/);
    const good = await run(["pin", "board@1.2.0", "--shared"]);
    assert.deepEqual(good.calls[0], { op: "pinCanvasAppVersion", args: { name: "board", version: "1.2.0", scope: "shared" } });
});

test("rm refuses without --yes and calls nothing", async () => {
    const refused = await run(["rm", "board"]);
    assert.equal(refused.code, 1);
    assert.equal(refused.calls.length, 0);
    assert.match(refused.err, /--yes/);
    const done = await run(["rm", "board", "--yes"]);
    assert.deepEqual(done.calls[0], { op: "deleteCanvasApp", args: { name: "board" } });
});

test("editors add/remove parse provider:subject", async () => {
    const add = await run(["editors", "add", "board", "entra:bob"]);
    assert.deepEqual(add.calls[0], { op: "grantCanvasAppEditor", args: { name: "board", user: { provider: "entra", subject: "bob" } } });
    await assert.rejects(run(["editors", "remove", "board", "bob"]), /provider>:<subject/);
});

test("migrate-legacy is a dry run unless --apply", async () => {
    const answer = (args) => ({ dryRun: args.dryRun, migrated: 0, skipped: 0, lines: [] });
    const dry = await run(["migrate-legacy"], { migrateLegacyCanvasApps: answer });
    assert.equal(dry.calls[0].args.dryRun, true);
    const apply = await run(["migrate-legacy", "--apply"], { migrateLegacyCanvasApps: answer });
    assert.equal(apply.calls[0].args.dryRun, false);
});

test("migrate-legacy while the transition is on: the dry run says --apply is blocked; --apply fails with the server's refusal", async () => {
    const message = "the canvas app transition (PILOTSWARM_CANVAS_LEGACY_MODE) is on: switch it off before applying the migration; a dry run still works";
    const dry = await run(["migrate-legacy"], {
        migrateLegacyCanvasApps: { dryRun: true, migrated: 1, skipped: 0, lines: [{ name: "board", outcome: "migrate", version: "1.0.0", owner: null }], applyBlocked: { code: "CANVAS_LEGACY_MODE_ON", message } },
    });
    assert.equal(dry.code, 0);
    assert.match(dry.out, /dry run: 1 to migrate/);
    assert.match(dry.out, /--apply is blocked: .*switch it off before applying/);
    const refused = Object.assign(new Error(message), { code: "CANVAS_LEGACY_MODE_ON", status: 409 });
    await assert.rejects(run(["migrate-legacy", "--apply"], { migrateLegacyCanvasApps: () => { throw refused; } }), (err) => err.code === "CANVAS_LEGACY_MODE_ON");
    // Switched off: no blocked line.
    const off = await run(["migrate-legacy"], { migrateLegacyCanvasApps: { dryRun: true, migrated: 0, skipped: 0, lines: [] } });
    assert.doesNotMatch(off.out, /blocked/);
});

test("import exits 2 when any version failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-cli-"));
    try {
        const file = path.join(dir, "board.tar.gz");
        fs.writeFileSync(file, Buffer.from([1, 2, 3]));
        const result = await run(["import", file], {
            importCanvasApp: () => ({ name: "board", scope: "user", versions: [{ version: "1.0.0", status: "imported" }, { version: "1.1.0", status: "failed", code: "VERSION_EXISTS" }] }),
        });
        assert.equal(result.code, 2);
        assert.equal(result.calls[0].args.contentBase64, Buffer.from([1, 2, 3]).toString("base64"));
        assert.match(result.out, /1\.1\.0: failed \(VERSION_EXISTS\)/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("there is no workspace-approval command", async () => {
    const result = await run(["consent", "board"]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.doesNotMatch(APPS_USAGE, /consent|approve/i);
});

test("loads forwards bounds and the cursor unchanged; prune reaches the management client", async () => {
    const page = { total30d: 3, rows: [], nextCursor: { loadedAt: "2026-10-17T10:00:00.000Z", loadId: "42" } };
    const loads = await run(["loads", "board", "--limit", "2", "--since", "2026-10-01T00:00:00Z", "--until", "2026-10-17T00:00:00Z", "--cursor", "2026-10-16T10:00:00.000Z/41"], { getCanvasAppLoads: () => page });
    assert.equal(loads.code, 0);
    assert.deepEqual(loads.calls[0], { op: "getCanvasAppLoads", args: {
        name: "board", limit: 2, since: "2026-10-01T00:00:00Z", until: "2026-10-17T00:00:00Z",
        cursorAt: "2026-10-16T10:00:00.000Z", cursorId: "41",
    } });
    assert.match(loads.out, /next: --cursor 2026-10-17T10:00:00.000Z\/42/);
    await assert.rejects(run(["loads", "board", "--cursor", "nocursor"]), /cursorAt>\/<cursorId/);
    const prune = await run(["prune"], { pruneCanvasApps: () => ({ loadsRemoved: 1, pendingRemoved: 0, spacesPurged: 0, failures: 0 }) });
    assert.equal(prune.code, 0);
    assert.deepEqual(prune.calls[0], { op: "pruneCanvasApps", args: {} });
    const failing = await run(["prune"], { pruneCanvasApps: () => ({ loadsRemoved: 0, pendingRemoved: 0, spacesPurged: 0, failures: 2 }) });
    assert.equal(failing.code, 2, "storage failures are not reported as success");
});
