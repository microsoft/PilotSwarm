import assert from "node:assert/strict";
import test from "node:test";
import { PilotSwarmWorker } from "../../../sdk/dist/worker.js";
import { runTurnRoutingTag } from "../../../sdk/dist/activity-routing.js";
import { PortalRuntime } from "../runtime.js";

const owner = {
    provider: "entra",
    subject: "alice-object-id",
    email: "alice@example.test",
    displayName: "Alice",
};

test("portal discovers models from an owner-scoped worker heartbeat", async () => {
    const worker = new PilotSwarmWorker({
        store: "sqlite::memory:",
        blobUseManagedIdentity: false,
        workerOwner: owner,
    });
    worker._workerTagFilter = {
        defaultAnd: [
            runTurnRoutingTag({
                repo: "sample-repo",
                ownerAffinity: owner,
            }),
        ],
    };
    worker._workerPhase = "ready";
    worker.sessionManager.currentWorkerModels = () => ({
        defaultModel: "github-copilot:claude-sonnet-5",
        available: [
            "github-copilot:claude-sonnet-5",
            "github-copilot:gpt-5.4",
        ],
    });

    let heartbeat;
    worker._catalog = {
        async workerHeartbeat(input) {
            heartbeat = input;
            return [];
        },
    };
    await worker._reportAgentWorkerState();

    const runtime = Object.create(PortalRuntime.prototype);
    runtime.transport = {
        async listWorkers() {
            return [{
                phase: heartbeat.phase,
                updatedAt: new Date(),
                owner: heartbeat.owner,
                info: heartbeat.info,
            }];
        },
        async listModels() {
            return [
                {
                    qualifiedName: "github-copilot:claude-sonnet-5",
                    credentialAvailable: false,
                },
                {
                    qualifiedName: "github-copilot:gpt-5.4",
                    credentialAvailable: false,
                },
                {
                    qualifiedName: "azure-foundry:gpt-5.4",
                    credentialAvailable: true,
                },
            ];
        },
    };

    const models = await runtime._modelsForDevbox(owner, "sample-repo", false);

    assert.deepEqual(heartbeat.info.ownerScopedRepos, ["sample-repo"]);
    assert.equal(heartbeat.info.repos, undefined);
    assert.deepEqual(
        models.map((model) => model.qualifiedName),
        [
            "github-copilot:claude-sonnet-5",
            "github-copilot:gpt-5.4",
        ],
    );
    assert.ok(models.every((model) => (
        model.credentialAvailable === true
        && model.availabilitySource === "worker"
    )));
});
