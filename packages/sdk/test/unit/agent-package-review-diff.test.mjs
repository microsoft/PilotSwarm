/**
 * Package review diff: risk classification, baseline selection, and the
 * guarantee that truncation never hides executable changes.
 *
 * Run: node --test test/unit/agent-package-review-diff.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    classifyReviewChange, selectReviewBaseline, buildAgentPackageReviewDiff,
    reviewBaselineAuditNote, REVIEW_CHANGE_GROUPS, REVIEW_DIFF_ADVISORY,
} from "../../dist/agent-package-review-diff.js";
import { DIFF_MAX_FILES, DIFF_MAX_FILE_BYTES } from "../../dist/agent-package-diff.js";

const b = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const e = (path, content) => ({ path, content: b(content) });
const sha = (c) => c.repeat(64);

test("risk order is executable, dependency, capability, precheck-policy, declarative", () => {
    assert.deepEqual([...REVIEW_CHANGE_GROUPS], ["executable", "dependency", "capability", "precheck-policy", "declarative"]);
});

test("code files and tool/mcp-server directories are executable", () => {
    for (const path of ["tools/check.js", "src/x.mjs", "lib/a.ts", "run.sh", "tools/bin/helper", "mcp-servers/s/server"]) {
        assert.equal(classifyReviewChange(path, undefined, b("x")).group, "executable", path);
    }
    assert.equal(classifyReviewChange("tools/readme.md", undefined, b("x")).group, "declarative");
});

test("unrecognized file types are executable and flagged", () => {
    const result = classifyReviewChange("bin/blob.dat", undefined, b("x"));
    assert.equal(result.group, "executable");
    assert.match(result.flagged, /unrecognized/);
    assert.equal(classifyReviewChange("LICENSE", undefined, b("x")).group, "declarative");
});

test("package manifests, lockfiles and node_modules are dependency changes", () => {
    for (const path of ["package.json", "package-lock.json", "sub/yarn.lock", "node_modules/x/index.json"]) {
        assert.equal(classifyReviewChange(path, b("{}"), b("{\"a\":1}")).group, "dependency", path);
    }
});

test(".mcp.json: changed existing server is dependency, added/removed server is capability, unparseable is flagged", () => {
    const one = { mcpServers: { a: { command: "node", args: ["a.js"] } } };
    assert.deepEqual(classifyReviewChange(".mcp.json", b(one), b({ mcpServers: { a: { command: "node", args: ["b.js"] } } })),
        { group: "dependency", changedKeys: ["a"] });
    assert.deepEqual(classifyReviewChange(".mcp.json", b(one), b({ mcpServers: { ...one.mcpServers, b: { command: "x" } } })),
        { group: "capability", changedKeys: ["b"] });
    const bad = classifyReviewChange(".mcp.json", b(one), b("{not json"));
    assert.ok(bad.flagged);
});

test("plugin.json keys: capability beats precheck-policy beats declarative", () => {
    const base = { name: "kit", description: "d" };
    assert.deepEqual(classifyReviewChange("plugin.json", b(base), b({ ...base, description: "e" })),
        { group: "declarative", changedKeys: ["description"] });
    assert.equal(classifyReviewChange("plugin.json", b(base), b({ ...base, cronPrechecks: { q: "tools/q.js" } })).group, "precheck-policy");
    assert.equal(classifyReviewChange("plugin.json", b(base), b({ ...base, cronPrechecks: {}, tools: ["x"] })).group, "capability");
    assert.ok(classifyReviewChange("plugin.json", b(base), b("{")).flagged);
});

test("agent frontmatter: tools is capability, cronPrechecks is precheck-policy, body text is declarative", () => {
    const doc = (fm, body = "hello") => `---\nname: a\n${fm}---\n${body}\n`;
    assert.equal(classifyReviewChange("agents/a.agent.md", b(doc("")), b(doc("", "changed"))).group, "declarative");
    assert.deepEqual(classifyReviewChange("agents/a.agent.md", b(doc("tools:\n  - x\n")), b(doc("tools:\n  - x\n  - y\n"))),
        { group: "capability", changedKeys: ["tools"] });
    assert.equal(classifyReviewChange("agents/a.agent.md", b(doc("")), b(doc("cronPrechecks:\n  - q\n"))).group, "precheck-policy");
});

const versions = [
    { packageId: "p", versionId: "v4", sha256: sha("4"), semver: "4.0.0", decision: "pending" },
    { packageId: "p", versionId: "v3", sha256: sha("3"), semver: "3.0.0", decision: "rejected", active: true },
    { packageId: "p", versionId: "v2", sha256: sha("2"), semver: "2.0.0", decision: "approved" },
    { packageId: "p", versionId: "v1", sha256: sha("1"), semver: "1.0.0", decision: "approved" },
];

test("baseline: explicit, else newest approved, else active, else none", () => {
    assert.equal(selectReviewBaseline(versions, "v4", "v1").baseline.versionId, "v1");
    assert.equal(selectReviewBaseline(versions, "v4", "v1").source, "explicit");
    assert.deepEqual(selectReviewBaseline(versions, "v4").baseline.versionId, "v2");
    assert.equal(selectReviewBaseline(versions, "v4").source, "approved");
    const noApproved = versions.map((v) => ({ ...v, decision: v.decision === "approved" ? "revoked" : v.decision }));
    assert.equal(selectReviewBaseline(noApproved, "v4").baseline.versionId, "v3");
    assert.equal(selectReviewBaseline(noApproved, "v4").source, "active");
    assert.deepEqual(selectReviewBaseline([versions[0]], "v4"), { baseline: null, source: "none" });
});

test("baseline: the candidate itself or a foreign version is rejected", () => {
    for (const explicit of ["v4", "other"]) {
        assert.throws(() => selectReviewBaseline(versions, "v4", explicit), (err) => err.code === "INVALID_REQUEST");
    }
});

const candidate = { packageId: "p", versionId: "v4", sha256: sha("4"), semver: "4.0.0", revision: 3, name: "kit", scope: "user", publisher: "u" };

test("diff groups changes by risk, carries hashes, and reports identical trees", () => {
    const baseline = versions[2];
    const before = [e("plugin.json", { name: "kit" }), e("tools/q.js", "return 1"), e("README.md", "a")];
    const after = [e("plugin.json", { name: "kit", cronPrechecks: { q: "tools/q.js" } }), e("tools/q.js", "return 2"), e("README.md", "b")];
    const diff = buildAgentPackageReviewDiff({ candidate, baseline, baselineSource: "approved", candidateEntries: after, baselineEntries: before });
    assert.deepEqual(diff.changes.map((c) => [c.group, c.path]), [
        ["executable", "tools/q.js"], ["precheck-policy", "plugin.json"], ["declarative", "README.md"],
    ]);
    assert.equal(diff.summary.total, 3);
    assert.equal(diff.summary.executable, 1);
    assert.equal(diff.identical, false);
    assert.match(diff.changes[0].oldSha256, /^[a-f0-9]{64}$/);
    assert.match(diff.changes[0].diff, /return 2/);
    assert.equal(diff.advisory, REVIEW_DIFF_ADVISORY);
    const same = buildAgentPackageReviewDiff({ candidate, baseline, baselineSource: "approved", candidateEntries: before, baselineEntries: before });
    assert.equal(same.identical, true);
    assert.equal(same.changes.length, 0);
});

test("new package lists everything as added against no baseline", () => {
    const diff = buildAgentPackageReviewDiff({ candidate, baseline: null, baselineSource: "none",
        candidateEntries: [e("tools/q.js", "x"), e("plugin.json", { name: "kit" })], baselineEntries: [] });
    assert.ok(diff.changes.every((c) => c.status === "added" && !c.oldSha256 && c.newSha256));
    assert.equal(diff.baseline, null);
});

test("oversized content is flagged and shown only as hashes", () => {
    const diff = buildAgentPackageReviewDiff({ candidate, baseline: null, baselineSource: "none",
        candidateEntries: [e("docs/big.md", "x".repeat(DIFF_MAX_FILE_BYTES + 1))], baselineEntries: [] });
    assert.equal(diff.changes[0].diff, null);
    assert.ok(diff.changes[0].flagged);
    assert.equal(diff.summary.flagged, 1);
});

test("truncation keeps executable changes; omitted files still count in the summary", () => {
    const docs = Array.from({ length: DIFF_MAX_FILES + 5 }, (_, i) => e(`docs/a${String(i).padStart(4, "0")}.md`, `d${i}`));
    const diff = buildAgentPackageReviewDiff({ candidate, baseline: null, baselineSource: "none",
        candidateEntries: [...docs, e("zz/tools/late.js", "x")], baselineEntries: [] });
    assert.equal(diff.changes[0].path, "zz/tools/late.js");
    assert.equal(diff.changes.length, DIFF_MAX_FILES);
    assert.deepEqual(diff.truncated, { omitted: 6 });
    assert.equal(diff.summary.total, DIFF_MAX_FILES + 6);
    assert.equal(diff.summary.executable, 1);
});

test("audit note names the baseline digest or states there was none", () => {
    assert.equal(reviewBaselineAuditNote({ versionId: "v2", sha256: sha("2") }), ` [reviewed against baseline v2 sha256:${sha("2")}]`);
    assert.equal(reviewBaselineAuditNote(null), " [reviewed as new package: no baseline]");
});
