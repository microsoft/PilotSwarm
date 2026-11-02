/**
 * The read-only copies of a session's folders on its compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * What these hold it to: a folder is carried whole and recognised again
 * when nothing in it has changed; a folder of links to folders — how
 * skills from several sources reach a runtime as one folder — is carried;
 * a link that points out of a folder is left behind with the reason; the
 * limits a deployment sets are kept; and a manifest arriving from the
 * other end can never make the host write outside its own store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    COMPUTE_COPY_MAX_BYTES,
    COMPUTE_COPY_MAX_FILES,
    ComputeAssetStore,
    computeCopyLimits,
    computeCopyManifest,
    planComputeCopy,
    safeCopyPath,
} from "../../dist/compute-assets.js";

function tmp(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function write(dir, relative, text) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    return full;
}

/** Send a plan into a store the way the channel does, and lay it out. */
function deliver(plan, store) {
    const sources = new Map();
    for (const item of plan.items) {
        for (const file of item.files) {
            if (!sources.has(file.digest)) sources.set(file.digest, path.join(item.source, ...file.path.split("/")));
        }
    }
    const missing = store.missing([...sources.keys()]);
    for (const digest of missing) store.put(digest, fs.readFileSync(sources.get(digest)));
    const placements = {};
    for (const item of computeCopyManifest(plan.items)) placements[item.name] = store.place(item);
    return { placements, sent: missing.length };
}

test("the defaults are the ones a deployment is told about", () => {
    assert.equal(COMPUTE_COPY_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(COMPUTE_COPY_MAX_FILES, 4096);
    assert.deepEqual(computeCopyLimits(), { maxBytes: COMPUTE_COPY_MAX_BYTES, maxFiles: COMPUTE_COPY_MAX_FILES });
    assert.deepEqual(computeCopyLimits({ maxBytes: 10, maxFiles: 2 }), { maxBytes: 10, maxFiles: 2 });
    // Nonsense falls back rather than turning a limit off.
    assert.deepEqual(computeCopyLimits({ maxBytes: 0, maxFiles: -1 }), { maxBytes: COMPUTE_COPY_MAX_BYTES, maxFiles: COMPUTE_COPY_MAX_FILES });
});

test("a folder is carried whole, and sending it again sends nothing", () => {
    const source = tmp("ps-copy-src-");
    write(source, "SKILL.md", "# a skill\n");
    write(source, "reference/notes.md", "detail\n");
    const hostDir = tmp("ps-copy-host-");
    const store = new ComputeAssetStore(hostDir);

    const first = planComputeCopy([{ name: "skills-a", source }]);
    assert.equal(first.refusals.length, 0);
    assert.deepEqual(first.items[0].files.map((file) => file.path), ["SKILL.md", "reference/notes.md"]);
    const laid = deliver(first, store);
    assert.equal(laid.sent, 2);
    assert.equal(fs.readFileSync(path.join(laid.placements["skills-a"], "SKILL.md"), "utf8"), "# a skill\n");
    assert.equal(fs.readFileSync(path.join(laid.placements["skills-a"], "reference", "notes.md"), "utf8"), "detail\n");

    // Nothing changed: the same digest, and the store has every byte.
    const second = planComputeCopy([{ name: "skills-a", source }]);
    assert.equal(second.items[0].digest, first.items[0].digest);
    assert.equal(deliver(second, store).sent, 0);
    assert.equal(store.placed("skills-a", second.items[0].digest), laid.placements["skills-a"]);

    // Changed: a different digest, the new bytes go, and the folder is laid out again.
    write(source, "SKILL.md", "# a skill, rewritten\n");
    const third = planComputeCopy([{ name: "skills-a", source }]);
    assert.notEqual(third.items[0].digest, first.items[0].digest);
    assert.equal(deliver(third, store).sent, 1);
    assert.equal(fs.readFileSync(path.join(laid.placements["skills-a"], "SKILL.md"), "utf8"), "# a skill, rewritten\n");
});

test("what is laid out is read-only", { skip: process.platform === "win32" ? "file modes" : false }, () => {
    const source = tmp("ps-copy-ro-");
    write(source, "SKILL.md", "text\n");
    const store = new ComputeAssetStore(tmp("ps-copy-ro-host-"));
    const plan = planComputeCopy([{ name: "skills-ro", source }]);
    const { placements } = deliver(plan, store);
    const mode = fs.statSync(path.join(placements["skills-ro"], "SKILL.md")).mode & 0o777;
    assert.equal(mode & 0o222, 0, "nothing in a copy is writable");
});

test("a folder of links to folders is carried; a link out of a folder is not", () => {
    if (process.platform === "win32") return; // making links needs a privilege there
    const one = tmp("ps-copy-one-");
    const two = tmp("ps-copy-two-");
    const elsewhere = tmp("ps-copy-else-");
    write(one, "SKILL.md", "first\n");
    write(two, "SKILL.md", "second\n");
    write(elsewhere, "secret.txt", "not for the host\n");

    const farm = tmp("ps-copy-farm-");
    fs.symlinkSync(one, path.join(farm, "one"));
    fs.symlinkSync(two, path.join(farm, "two"));
    // A link that points out of the folder, deeper than the first level.
    fs.symlinkSync(path.join(elsewhere, "secret.txt"), path.join(one, "pointer.txt"));

    const plan = planComputeCopy([{ name: "skills-farm", source: farm }]);
    const paths = plan.items[0].files.map((file) => file.path);
    assert.deepEqual(paths, ["one/SKILL.md", "two/SKILL.md"]);
    assert.ok(plan.refusals.some((refusal) => refusal.path === "one/pointer.txt" && /points out of the folder/.test(refusal.reason)),
        `expected a refusal for the link out, got ${JSON.stringify(plan.refusals)}`);
});

test("the limits a deployment sets are kept, and what does not fit says why", () => {
    const source = tmp("ps-copy-limit-");
    write(source, "a.md", "aaaa");
    write(source, "b.md", "bbbb");
    write(source, "c.md", "cccc");

    const byFiles = planComputeCopy([{ name: "skills-x", source }], { maxBytes: 1_000_000, maxFiles: 2 });
    assert.equal(byFiles.items.length, 0, "a folder that does not fit is left out whole");
    assert.match(byFiles.refusals[0].reason, /limit of 2 files/);

    const byBytes = planComputeCopy([{ name: "skills-x", source }], { maxBytes: 6, maxFiles: 100 });
    assert.equal(byBytes.items.length, 0);
    assert.match(byBytes.refusals[0].reason, /limit of 6 bytes/);

    const big = tmp("ps-copy-big-");
    write(big, "huge.bin", "x".repeat(64));
    const oversize = planComputeCopy([{ name: "skills-big", source: big }], { maxBytes: 16, maxFiles: 10 });
    assert.match(oversize.refusals[0].reason, /larger than the 16 bytes/);
});

test("a folder that is not there is left behind with the reason, not thrown", () => {
    const plan = planComputeCopy([{ name: "skills-gone", source: path.join(tmp("ps-copy-none-"), "missing") }]);
    assert.equal(plan.items.length, 0);
    assert.match(plan.refusals[0].reason, /could not be read/);
});

test("a path out of a manifest is checked before anything is written", () => {
    assert.equal(safeCopyPath("a/b.md"), path.join("a", "b.md"));
    for (const hostile of ["../escape", "a/../../escape", "/etc/passwd", "Z:\\elsewhere", "a\\b", "a//b", "a/./b", "", null, 42, "a\u0000b"]) {
        assert.equal(safeCopyPath(hostile), null, `${JSON.stringify(hostile)} must be refused`);
    }
});

test("the host refuses a manifest it was never sent the bytes for, and one that names a path outside the folder", () => {
    const store = new ComputeAssetStore(tmp("ps-copy-hostile-"));
    const digest = "a".repeat(64);
    assert.throws(() => store.place({ name: "skills-a", digest, files: [{ path: "x.md", digest }] }),
        /never sent/);
    assert.throws(() => store.place({ name: "skills-a", digest, files: [{ path: "../x.md", digest }] }),
        /will not write/);
    assert.throws(() => store.place({ name: "../escape", digest, files: [] }),
        /not a folder name/);
});

test("the host keeps a file only under the digest its own bytes have", () => {
    const store = new ComputeAssetStore(tmp("ps-copy-digest-"));
    assert.throws(() => store.put("b".repeat(64), Buffer.from("not those bytes")),
        /not the bytes the digest names/);
    assert.throws(() => store.put("not-a-digest", Buffer.from("x")), /not a digest/);
});

test("what crosses to the host carries no worker path", () => {
    const source = tmp("ps-copy-manifest-");
    write(source, "SKILL.md", "text\n");
    const plan = planComputeCopy([{ name: "skills-m", source }]);
    const manifest = computeCopyManifest(plan.items);
    assert.equal(JSON.stringify(manifest).includes(source), false, "the worker's own path never crosses");
    assert.deepEqual(Object.keys(manifest[0]).sort(), ["digest", "files", "name"]);
});
