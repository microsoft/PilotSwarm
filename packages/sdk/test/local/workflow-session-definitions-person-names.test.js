/**
 * Phase 4 (Unit G) local PG/HorizonDB integration tests for person-facing session Workflow
 * Definition operations by `name` (with receipt-first replay safety) and SF-2 `originatingSessionId`
 * refusal against real PostgreSQL / HorizonDB storage.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { createWorkflow } from "../../src/workflow/service.ts";
import { attachSessionPackageWorkflow } from "../../src/workflow/session-definitions.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "person-names" };
const PERSON_PRINCIPAL = { provider: "test", subject: "ada", displayName: "Ada Lovelace" };

const WAIT_YAML = (seconds, name = "person-watch", version = "1.0.0") => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ${name}
  version: "${version}"
initial: hold
states:
  hold:
    type: wait
    seconds: ${seconds}
    transition:
      next:
        elapsed: done
  done:
    type: terminal
    outcome: succeeded
    output: {}
`;

const AGENT_WF_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: outer-agent-wf
  version: "1.0.0"
initial: step
states:
  step:
    type: agent
    timeoutSeconds: 60
    invoke:
      prompt: "Do work."
    outcomes: [done]
    transition:
      next:
        done: finished
        failure: failed
  finished:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("Workflow session definitions: person name lookup, replay safety & SF-2 (PG16 + HorizonDB)", () => {
    it("deletes and replays by name, copies by name, starts by name with key, updates package by name, and enforces SF-2", async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            cmsSchema: env.cmsSchema,
            duroxideSchema: env.duroxideSchema,
            factsSchema: env.factsSchema,
            workflowCommands: {},
        });
        await mgmt.start();

        try {
            const ownerSession = randomUUID();
            await h.catalog.createSession(ownerSession, { owner: OWNER });

            // 1. Save a custom definition, start by name with key (no explicit operation_id -> key:<k>), replay by name
            const saved = await mgmt.saveSessionWorkflowDefinition(ownerSession, {
                name: "person-watch",
                yaml: WAIT_YAML(30, "person-watch"),
                operationId: "save-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(saved.revision).toBe(1);

            const started = await mgmt.startSessionWorkflowDefinition(ownerSession, {
                name: "person-watch",
                workspace: "none",
                operationId: "key:k-name-1",
                key: "k-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(started.name).toBe("person-watch");
            expect(started.replayed).toBe(false);

            const startedReplay = await mgmt.startSessionWorkflowDefinition(ownerSession, {
                name: "person-watch",
                workspace: "none",
                operationId: "key:k-name-1",
                key: "k-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(startedReplay.workflowId).toBe(started.workflowId);
            expect(startedReplay.replayed).toBe(true);

            // Cancel the started workflow so we can delete the definition
            await mgmt.updateWorkflow(started.workflowId, { operation: "cancel", operation_id: "cancel-1" }, { principal: PERSON_PRINCIPAL });

            // 2. Delete by name, then replay by name after soft-delete -> { replayed: true }; new operationId -> DEFINITION_DELETED
            const del1 = await mgmt.deleteSessionWorkflowDefinition(ownerSession, {
                name: "person-watch",
                operationId: "del-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(del1.name).toBe("person-watch");
            expect(del1.replayed).toBe(false);

            const delReplay = await mgmt.deleteSessionWorkflowDefinition(ownerSession, {
                name: "person-watch",
                operationId: "del-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(delReplay.definitionId).toBe(del1.definitionId);
            expect(delReplay.replayed).toBe(true);

            await refused(
                mgmt.deleteSessionWorkflowDefinition(ownerSession, {
                    name: "person-watch",
                    operationId: "del-by-name-2",
                }, { principal: PERSON_PRINCIPAL }),
                "DEFINITION_DELETED",
            );

            // 3. Attached package definition: copy by name + replay, and updateSessionWorkflowPackage by name
            let pkgSemver = "1.0.0";
            let pkgSha = "sha-v1";
            const pkgYaml = () => WAIT_YAML(pkgSemver === "1.0.0" ? 15 : 25, "pkg-flow", pkgSemver);
            const fakePackageSource = {
                find: async (parsed) => parsed.packageName === "demo" && parsed.name === "pkg-flow" ? {
                    ref: "demo/pkg-flow",
                    packageId: "pkg-id-1",
                    packageName: "demo",
                    packageTitle: "Demo",
                    semver: pkgSemver,
                    sha256: pkgSha,
                    scope: "shared",
                    mine: false,
                    workflow: {
                        name: "pkg-flow",
                        description: "Demo",
                        cardDigest: `digest-${pkgSemver}`,
                        interface: { inputSchema: null, outputSchema: null, outcomes: { done: "succeeded" }, asks: [], sends: [] },
                        card: {
                            name: "pkg-flow",
                            description: "Demo",
                            whenToUse: "Test",
                            inputs: { example: null, schema: null },
                            outcomes: { done: "Finished" },
                            output: { about: null, schema: null },
                            asks: {},
                            sends: {},
                            effects: "None.",
                            model: null,
                            modelHints: {},
                            notes: "",
                        },
                    },
                } : null,
                list: async () => [],
                readYaml: async () => pkgYaml(),
                readFacts: async () => ({ scripts: [], agents: [] }),
            };
            mgmt._packageWorkflows = () => fakePackageSource;

            const host = {
                catalog: h.catalog,
                store: h.store,
                packageWorkflows: fakePackageSource,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const attached = await attachSessionPackageWorkflow(host, {
                ownerSessionId: ownerSession,
                ref: "demo/pkg-flow",
                viewer: null,
                actor: { kind: "system", name: "test" },
                operationId: "attach-1",
                by: "system",
            });
            expect(attached.receipt.revision).toBe(1);

            const copy1 = await mgmt.copySessionWorkflowDefinition(ownerSession, {
                name: "demo/pkg-flow",
                operationId: "copy-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(copy1.name).toBe("pkg-flow");
            expect(copy1.revision).toBe(1);
            expect(copy1.replayed).toBe(false);

            const copyReplay = await mgmt.copySessionWorkflowDefinition(ownerSession, {
                name: "demo/pkg-flow",
                operationId: "copy-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(copyReplay.definitionId).toBe(copy1.definitionId);
            expect(copyReplay.replayed).toBe(true);

            // Bump package to 1.1.0 and update by name + replay
            pkgSemver = "1.1.0";
            pkgSha = "sha-v2";
            const upd1 = await mgmt.updateSessionWorkflowPackage(ownerSession, {
                name: "demo/pkg-flow",
                operationId: "upd-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(upd1.revision).toBe(2);
            expect(upd1.replayed).toBe(false);

            const updReplay = await mgmt.updateSessionWorkflowPackage(ownerSession, {
                name: "demo/pkg-flow",
                operationId: "upd-by-name-1",
            }, { principal: PERSON_PRINCIPAL });
            expect(updReplay.revision).toBe(2);
            expect(updReplay.replayed).toBe(true);

            // 4. SF-2 with real agent-step child session row in readWorkflowLineage
            const wfSession = randomUUID();
            const createdWf = await createWorkflow(host, {
                workflowSessionId: wfSession,
                parentSessionId: ownerSession,
                owner: OWNER,
                yaml: AGENT_WF_YAML,
                actor: { kind: "system", name: "test" },
                operationId: "sf2-wf-create",
                publish: true,
                start: { inputs: {} },
            });
            const runId = createdWf.receipt.run.runId;
            const agentChildId = randomUUID();
            await h.catalog.createSession(agentChildId, { parentSessionId: wfSession, owner: OWNER });
            const nodeExecutionId = nodeExecutionIdFor(runId, "root", "step", 1);
            const entered = await h.store.enterNode({
                runId,
                nodeExecutionId,
                scopeId: "root",
                nodeId: "step",
                ordinal: 1,
                nodeType: "agent",
                predecessorId: null,
                arrivalRoute: null,
                inputText: "null",
                kvRevision: 1,
                waitSeconds: null,
                immediate: null,
                agent: {
                    childSessionId: agentChildId,
                    controllingSessionId: ownerSession,
                    task: { source: "prompt", prompt: "Do work." },
                    outcomes: ["done"],
                    outputSchema: null,
                    timeoutSeconds: 60,
                },
            });
            expect(entered.admitted).toBe(true);

            const sf2Opts = { principal: PERSON_PRINCIPAL, originatingSessionId: agentChildId };
            await refused(
                mgmt.saveSessionWorkflowDefinition(ownerSession, { name: "sf2-blocked", yaml: WAIT_YAML(10, "sf2-blocked"), operationId: "sf2-save" }, sf2Opts),
                "WORKFLOW_DEFINITION_TOOLS_REFUSED",
            );
            await refused(
                mgmt.startSessionWorkflowDefinition(ownerSession, { name: "pkg-flow", workspace: "none", operationId: "sf2-start" }, sf2Opts),
                "WORKFLOW_DEFINITION_TOOLS_REFUSED",
            );
            await refused(
                mgmt.deleteSessionWorkflowDefinition(ownerSession, { name: "pkg-flow", operationId: "sf2-del" }, sf2Opts),
                "WORKFLOW_DEFINITION_TOOLS_REFUSED",
            );
            await refused(
                mgmt.copySessionWorkflowDefinition(ownerSession, { name: "demo/pkg-flow", operationId: "sf2-copy" }, sf2Opts),
                "WORKFLOW_DEFINITION_TOOLS_REFUSED",
            );
            await refused(
                mgmt.updateSessionWorkflowPackage(ownerSession, { name: "demo/pkg-flow", operationId: "sf2-upd" }, sf2Opts),
                "WORKFLOW_DEFINITION_TOOLS_REFUSED",
            );
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    }, TIMEOUT);
});
