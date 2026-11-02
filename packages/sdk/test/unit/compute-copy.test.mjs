/**
 * Sending a session's folders to its compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * What these hold it to: the bytes that go are the bytes that were
 * planned, checked here and not on the host, so a file swapped while the
 * host was thinking is never sent under the benign file's name; a copy
 * larger than one notice carries still crosses; and a host that takes a
 * file and then says nothing does not hold a turn open for ever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ComputeChannel } from "../../dist/compute-channel.js";
import { ComputeControlLink } from "../../dist/compute-control.js";
import { planComputeCopy } from "../../dist/compute-assets.js";

function tmp(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function write(dir, relative, text) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    return full;
}

function pair(t) {
    return new Promise((resolve) => {
        const server = net.createServer((incoming) => {
            incoming.on("error", () => { /* the test closes these */ });
            resolve({ host: incoming, worker, server });
        });
        let worker;
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            worker = net.connect({ host: "127.0.0.1", port: server.address().port });
            worker.on("error", () => { /* the test closes these */ });
        });
        t.after(() => {
            try { worker?.destroy(); } catch { /* already gone */ }
            server.close();
        });
    });
}

/**
 * A stand-in host that answers the copy questions.
 *
 * `onHave` lets a test do something between the worker asking which
 * digests are missing and the worker reading the files — which is the
 * window the host decides the length of.
 */
async function hostSide(t, options = {}) {
    const { worker, host } = await pair(t);
    const link = new ComputeControlLink(worker, { heartbeatMs: 0 });
    const channel = new ComputeChannel(host, { side: "host" });
    const kept = new Map();
    const placed = {};
    channel.on("notice", async (message) => {
        try {
            if (message.t === "alive") return;
            if (message.t === "have") {
                const digests = message.digests.filter((digest) => !kept.has(digest));
                if (options.onHave) await options.onHave();
                if (options.silentAfterHave) return;
                await channel.notice({ t: "have:ok", id: message.id, missing: digests });
                return;
            }
            if (message.t === "manifest") {
                const held = placed[message.name] ?? (placed[message.name] = { digest: message.digest, files: [] });
                held.files.push(...message.files);
                await channel.notice({ t: "manifest:ok", id: message.id });
                return;
            }
            if (message.t === "place") {
                await channel.notice({ t: "place:ok", id: message.id, where: `/host/${message.name}` });
                return;
            }
        } catch { /* the channel is going */ }
    });
    channel.on("stream", (stream) => {
        const parts = [];
        stream.on("data", (chunk) => parts.push(chunk));
        stream.on("end", () => {
            kept.set(String(stream.meta.digest), Buffer.concat(parts));
            if (options.neverAcknowledge) return;
            void stream.write(Buffer.from(JSON.stringify({ ok: true }), "utf8")).then(() => stream.end()).catch(() => {});
        });
    });
    channel.start();
    await channel.notice({ t: "ready", separator: "/", httpBase: null, relay: null });
    t.after(() => { link.close(); channel.close(); });
    return { link, kept, placed };
}

test("a file swapped for a link while the host was thinking is never sent", async (t) => {
    const outside = tmp("ps-copy-secret-");
    const secret = write(outside, "worker-only.txt", "something only the worker may read\n");
    const source = tmp("ps-copy-swap-");
    const benign = write(source, "SKILL.md", "# a skill\n");

    const plan = planComputeCopy([{ name: "skills-swap", source }]);
    assert.equal(plan.items[0].files.length, 1);
    const planned = plan.items[0].files[0].digest;

    // The host controls how long this takes, and uses it.
    const { link, kept } = await hostSide(t, {
        onHave: () => {
            fs.rmSync(benign);
            fs.symlinkSync(secret, benign);
        },
    });

    await assert.rejects(() => link.copy(plan), /was not sent to the compute host/,
        "the bytes are checked here, before any of them cross");
    assert.equal(kept.has(planned), false, "so nothing was sent under the planned file's name");
    for (const body of kept.values()) {
        assert.equal(body.toString().includes("only the worker"), false);
    }
});

test("a file edited while the host was thinking is refused rather than sent under the old digest", async (t) => {
    const source = tmp("ps-copy-edit-");
    const file = write(source, "SKILL.md", "# a skill\n");
    const plan = planComputeCopy([{ name: "skills-edit", source }]);

    const { link, kept } = await hostSide(t, {
        // Same length, so a check on size alone would not notice.
        onHave: () => fs.writeFileSync(file, "# a SKILL\n"),
    });
    await assert.rejects(() => link.copy(plan), /was not sent to the compute host/);
    assert.equal(kept.size, 0);

    // And the next turn reads it again rather than refusing for ever on
    // what it remembered.
    const again = planComputeCopy([{ name: "skills-edit", source }]);
    assert.notEqual(again.items[0].digest, plan.items[0].digest);
    const second = await hostSide(t);
    await second.link.copy(again);
    assert.equal(second.kept.get(again.items[0].files[0].digest)?.toString(), "# a SKILL\n");
});

test("a copy with more files than one notice carries still crosses", async (t) => {
    const source = tmp("ps-copy-many-");
    // Each manifest entry is about a hundred bytes, so this is several
    // times what a single notice carries. The limits a deployment sets
    // are the only thing that should decide how large a copy may be.
    for (let i = 0; i < 1200; i++) write(source, `skills/file-${i}.md`, `# file ${i}\n`);
    const plan = planComputeCopy([{ name: "skills-many", source }]);
    assert.equal(plan.items[0].files.length, 1200);

    const { link, kept, placed } = await hostSide(t);
    const placements = await link.copy(plan);
    assert.equal(placements["skills-many"], "/host/skills-many");
    assert.equal(kept.size, 1200, "every file crossed");
    assert.equal(placed["skills-many"].files.length, 1200, "and the whole manifest arrived");
});

test("a host that takes a file and then says nothing does not hold the turn open", async (t) => {
    const source = tmp("ps-copy-silent-");
    write(source, "SKILL.md", "# a skill\n");
    const plan = planComputeCopy([{ name: "skills-silent", source }]);

    const { link } = await hostSide(t, { neverAcknowledge: true });
    const started = Date.now();
    await assert.rejects(() => link.copy(plan, { timeoutMs: 300 }),
        /did not acknowledge a copied file in time|did not finish taking/);
    assert.ok(Date.now() - started < 10_000, "it gives up on its own deadline, not the channel's");
});

test("a host that never answers a question does not hold the turn open either", async (t) => {
    const source = tmp("ps-copy-mute-");
    write(source, "SKILL.md", "# a skill\n");
    const plan = planComputeCopy([{ name: "skills-mute", source }]);

    const { link } = await hostSide(t, { silentAfterHave: true });
    await assert.rejects(() => link.copy(plan, { timeoutMs: 300 }), /given up on|did not finish taking/);
});
