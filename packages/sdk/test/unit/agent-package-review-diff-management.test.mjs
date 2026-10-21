/**
 * Management review-diff and baseline-bound decision: admin-only, exact
 * candidate digest, verified artifacts, and the baseline audit note.
 *
 * Run: node --test test/unit/agent-package-review-diff-management.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { packAgentPackage } from "../../dist/agent-package-format.js";

const admin = { provider: "entra", subject: "admin" };

function pack(root, version, files) {
    const dir = path.join(root, version);
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return packAgentPackage(dir);
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-diff-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = "---\nname: helper\ntools: [ping]\n---\nHelp.";
    const v1 = pack(root, "v1", { "plugin.json": JSON.stringify({ name: "kit" }), "agents/helper.agent.md": agent, "tools/q.mjs": "export const a = 1;" });
    const v2 = pack(root, "v2", {
        "plugin.json": JSON.stringify({ name: "kit", cronPrechecks: { queue: { callback: "check" } } }),
        "agents/helper.agent.md": agent, "tools/q.mjs": "export const a = 2;",
    });
    const blobs = new Map([["v1.tar.gz", v1.targz], ["v2.tar.gz", v2.targz]]);
    const decided = [];
    const versions = [
        { packageId: "pkg", versionId: "v2", sha256: v2.sha256, semver: "2.0.0", decision: "pending", active: false },
        { packageId: "pkg", versionId: "v1", sha256: v1.sha256, semver: "1.0.0", decision: "approved", active: true },
    ];
    const catalog = {
        packageReviews: {
            list: async () => versions.map((v) => ({ ...v, name: "kit", scope: "shared", publisher: "pub", owner: null,
                revision: v.versionId === "v2" ? 1 : 2, inspection: { reasons: ["executable tools"] } })),
            publisherStatus: async (_actor, packageId) => ({ packageId, versions }),
            decide: async (actor, input) => { decided.push({ actor, input }); },
        },
        getAgentPackage: async () => ({
            versions: versions.map((v) => ({ versionId: v.versionId, sha256: v.sha256, artifactFilename: `${v.versionId}.tar.gz` })),
        }),
    };
    const client = Object.create(PilotSwarmManagementClient.prototype);
    Object.assign(client, {
        _started: true, _catalog: catalog,
        _artifactStore: { downloadArtifact: async (_sid, name) => ({ body: blobs.get(name) }) },
    });
    return { client, v1, v2, versions, blobs, decided };
}

test("review diff is admin-only and requires an exact digest", async (t) => {
    const { client, v2 } = fixture(t);
    const input = { packageId: "pkg", versionId: "v2", sha256: v2.sha256 };
    await assert.rejects(client.getAgentPackageReviewDiff(input, admin, false), (e) => e.code === "FORBIDDEN");
    await assert.rejects(client.getAgentPackageReviewDiff(input, null, true), (e) => e.code === "FORBIDDEN");
    await assert.rejects(client.getAgentPackageReviewDiff({ ...input, sha256: "nope" }, admin, true), (e) => e.code === "INVALID_REQUEST");
    await assert.rejects(client.getAgentPackageReviewDiff({ ...input, sha256: "f".repeat(64) }, admin, true), (e) => e.code === "CONFLICT");
});

test("review diff compares against the newest approved version and classifies by risk", async (t) => {
    const { client, v1, v2 } = fixture(t);
    const diff = await client.getAgentPackageReviewDiff({ packageId: "pkg", versionId: "v2", sha256: v2.sha256 }, admin, true);
    assert.equal(diff.baselineSource, "approved");
    assert.equal(diff.baseline.sha256, v1.sha256);
    assert.equal(diff.candidate.sha256, v2.sha256);
    assert.equal(diff.candidate.revision, 1);
    assert.deepEqual(diff.changes.map((c) => [c.group, c.path]), [["executable", "tools/q.mjs"], ["precheck-policy", "plugin.json"]]);
    assert.deepEqual(diff.inspectionReasons, ["executable tools"]);
});

test("review diff refuses an artifact whose bytes do not match the recorded digest", async (t) => {
    const { client, v2, blobs } = fixture(t);
    blobs.set("v1.tar.gz", v2.targz);
    await assert.rejects(client.getAgentPackageReviewDiff({ packageId: "pkg", versionId: "v2", sha256: v2.sha256 }, admin, true));
});

test("decision from the diff records the baseline digest; stale or self baseline is refused", async (t) => {
    const { client, v1, v2, decided } = fixture(t);
    const base = { packageId: "pkg", versionId: "v2", sha256: v2.sha256, expectedRevision: 1, decision: "approved", reason: "looks fine" };
    await client.decideAgentPackageReview({ ...base, baseline: { versionId: "v1", sha256: v1.sha256 } }, admin, true);
    assert.equal(decided[0].input.reason, `looks fine [reviewed against baseline v1 sha256:${v1.sha256}]`);
    assert.equal(Object.hasOwn(decided[0].input, "baseline"), false);
    await client.decideAgentPackageReview({ ...base, baseline: null }, admin, true);
    assert.equal(decided[1].input.reason, "looks fine [reviewed as new package: no baseline]");
    await client.decideAgentPackageReview(base, admin, true);
    assert.equal(decided[2].input.reason, "looks fine");
    await assert.rejects(client.decideAgentPackageReview({ ...base, baseline: { versionId: "v1", sha256: "f".repeat(64) } }, admin, true),
        (e) => e.code === "CONFLICT");
    await assert.rejects(client.decideAgentPackageReview({ ...base, baseline: { versionId: "v2", sha256: v2.sha256 } }, admin, true),
        (e) => e.code === "INVALID_REQUEST");
    assert.equal(decided.length, 3);
});

test("summary mode lists every change with line counts and no patch bodies", async (t) => {
    const { client, v2 } = fixture(t);
    const input = { packageId: "pkg", versionId: "v2", sha256: v2.sha256 };
    const full = await client.getAgentPackageReviewDiff(input, admin, true);
    const summary = await client.getAgentPackageReviewDiff({ ...input, patches: false }, admin, true);
    assert.deepEqual(summary.changes.map((c) => c.path), full.changes.map((c) => c.path));
    assert.deepEqual(summary.summary, full.summary);
    for (const change of summary.changes) {
        assert.equal(change.diff, null, change.path);
        assert.equal(change.patchOmitted, true, change.path);
    }
    const q = summary.changes.find((c) => c.path === "tools/q.mjs");
    assert.deepEqual([q.additions, q.deletions], [1, 1]);
    assert.deepEqual(full.changes.find((c) => c.path === "tools/q.mjs").additions, 1, "full mode carries the same counts");
});

test("one file's patch loads on its own, with the same admin and exact-digest checks", async (t) => {
    const { client, v1, v2 } = fixture(t);
    const input = { packageId: "pkg", versionId: "v2", sha256: v2.sha256 };
    const file = await client.getAgentPackageReviewFileDiff({ ...input, path: "tools/q.mjs" }, admin, true);
    assert.equal(file.candidate.sha256, v2.sha256);
    assert.equal(file.baseline.sha256, v1.sha256);
    assert.equal(file.change.path, "tools/q.mjs");
    assert.equal(file.change.group, "executable");
    assert.match(file.change.diff, /^-export const a = 1;$/m);
    assert.match(file.change.diff, /^\+export const a = 2;$/m);
    assert.deepEqual([file.change.additions, file.change.deletions], [1, 1]);
    await assert.rejects(client.getAgentPackageReviewFileDiff({ ...input, path: "tools/q.mjs" }, admin, false), (e) => e.code === "FORBIDDEN");
    await assert.rejects(client.getAgentPackageReviewFileDiff({ ...input, sha256: "f".repeat(64), path: "tools/q.mjs" }, admin, true), (e) => e.code === "CONFLICT");
    await assert.rejects(client.getAgentPackageReviewFileDiff({ ...input, path: "agents/helper.agent.md" }, admin, true),
        (e) => e.code === "NOT_FOUND", "an unchanged file has no patch");
    await assert.rejects(client.getAgentPackageReviewFileDiff({ ...input, path: "" }, admin, true), (e) => e.code === "INVALID_REQUEST");
});
