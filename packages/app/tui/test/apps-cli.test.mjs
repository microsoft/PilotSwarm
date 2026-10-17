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

test("share and unshare move between scopes", async () => {
    const share = await run(["share", "board"]);
    assert.deepEqual(share.calls[0], { op: "setCanvasAppScope", args: { name: "board", scope: "user", targetScope: "shared" } });
    const unshare = await run(["unshare", "board"]);
    assert.deepEqual(unshare.calls[0], { op: "setCanvasAppScope", args: { name: "board", scope: "shared", targetScope: "user" } });
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
