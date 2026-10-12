import test from "node:test";
import assert from "node:assert/strict";
import { createSweeperTools } from "../../dist/sweeper-tools.js";
import { agentPackagesArtifactSessionId } from "../../dist/agent-package-format.js";
import {
    workflowPackagesArtifactSessionId,
} from "../../dist/workflow-orchestration/package-artifact.js";

function metadata(filename, uploadedAt, pinned = false) {
    return {
        filename,
        uploadedAt,
        pinned,
        sizeBytes: 1,
        contentType: "application/gzip",
        isBinary: true,
        source: "system",
    };
}

function fixture({
    workflowArtifacts = [],
    agentArtifacts = [],
    workflowReferences = [],
    agentReferences = [],
    workflowCounts = {},
    agentCounts = {},
    deleteFailure,
} = {}) {
    const deleted = [];
    const locked = [];
    const byNamespace = new Map([
        [workflowPackagesArtifactSessionId(), workflowArtifacts],
        [agentPackagesArtifactSessionId(), agentArtifacts],
    ]);
    const catalog = {
        listPackageArtifactReferences: async () => ({
            workflowArtifactFilenames: workflowReferences,
            agentArtifactFilenames: agentReferences,
        }),
        countWorkflowPackageArtifactRefs: async filename =>
            workflowCounts[filename] ?? (workflowReferences.includes(filename) ? 1 : 0),
        countAgentPackageArtifactRefs: async filename =>
            agentCounts[filename] ?? (agentReferences.includes(filename) ? 1 : 0),
    };
    catalog.withPackageArtifactLocks = async (targets, fn) => {
        locked.push(structuredClone(targets));
        return fn(catalog);
    };
    const artifactStore = {
        listArtifacts: async sessionId => structuredClone(byNamespace.get(sessionId) ?? []),
        statArtifact: async (sessionId, filename) =>
            structuredClone(
                (byNamespace.get(sessionId) ?? []).find(
                    artifact => artifact.filename === filename,
                ) ?? null,
            ),
        deleteArtifact: async (sessionId, filename) => {
            if (filename === deleteFailure) throw new Error("simulated delete failure");
            deleted.push({ sessionId, filename });
            return true;
        },
    };
    const tools = createSweeperTools({
        catalog,
        artifactStore,
        duroxideClient: {},
    });
    return {
        deleted,
        locked,
        sweep: tools.find(tool => tool.name === "sweep_package_artifacts"),
    };
}

test("package artifact sweep deletes only old unreferenced artifacts", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { deleted, locked, sweep } = fixture({
        workflowArtifacts: [
            metadata("workflow-referenced.tar.gz", old, true),
            metadata("workflow-orphan.tar.gz", old, true),
            metadata("workflow-recent.tar.gz", recent, true),
        ],
        agentArtifacts: [
            metadata("agent-referenced.tar.gz", old),
            metadata("agent-orphan.tar.gz", old),
            metadata("agent-recent.tar.gz", recent),
        ],
        workflowReferences: ["workflow-referenced.tar.gz"],
        agentReferences: ["agent-referenced.tar.gz"],
    });

    assert.ok(sweep);
    const result = await sweep.handler({ graceHours: 24 });

    assert.equal(result.ok, true);
    assert.equal(result.scanned, 6);
    assert.equal(result.referenced, 2);
    assert.equal(result.recent, 2);
    assert.equal(result.eligible, 2);
    assert.equal(result.deleted, 2);
    assert.deepEqual(
        deleted.map(entry => entry.filename).sort(),
        ["agent-orphan.tar.gz", "workflow-orphan.tar.gz"],
    );
    assert.deepEqual(
        locked.flat().map(entry => entry.filename).sort(),
        ["agent-orphan.tar.gz", "workflow-orphan.tar.gz"],
    );
});

test("package artifact sweep rechecks references before deletion", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { deleted, sweep } = fixture({
        workflowArtifacts: [metadata("concurrently-published.tar.gz", old, true)],
        workflowCounts: { "concurrently-published.tar.gz": 1 },
    });

    const result = await sweep.handler({ graceHours: 24 });

    assert.equal(result.ok, true);
    assert.equal(result.deleted, 0);
    assert.equal(result.referenced, 1);
    assert.equal(result.eligible, 0);
    assert.deepEqual(deleted, []);
});

test("package artifact sweep supports dry runs and reports isolated failures", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const dry = fixture({
        agentArtifacts: [metadata("dry-run.tar.gz", old)],
    });
    const dryResult = await dry.sweep.handler({ graceHours: 24, dryRun: true });
    assert.equal(dryResult.deleted, 0);
    assert.equal(dryResult.artifacts[0].action, "would-delete");
    assert.deepEqual(dry.deleted, []);

    const failing = fixture({
        agentArtifacts: [
            metadata("fails.tar.gz", old),
            metadata("succeeds.tar.gz", old),
        ],
        deleteFailure: "fails.tar.gz",
    });
    const result = await failing.sweep.handler({ graceHours: 24 });

    assert.equal(result.ok, true);
    assert.equal(result.deleted, 1);
    assert.deepEqual(
        failing.deleted.map(entry => entry.filename),
        ["succeeds.tar.gz"],
    );
    assert.deepEqual(result.failures, [{
        kind: "agent",
        filename: "fails.tar.gz",
        error: "simulated delete failure",
    }]);
});
