/**
 * Stage 2.3's real-model scenario (spec "Order of work": "start from the new-session picker; an agent starts another
 * package's definition"), on a REAL model with Workflows on and packages published to the local agent registry:
 * 1. the picker's path: a chat made for release-tools/release-watch (prepareWorkflowChat, a session with its coordinating
 *    instructions, the definition attached and locked, its kickoff): the chat asks for the train and starts nothing; told
 *    the train, it starts the Workflow, which ends completed;
 * 2. a package agent (release-watcher, whose front matter names ops-kit/incident-digest) is asked for the day's incident
 *    digest: its chat starts ops-kit's definition by package and name, and that Workflow ends completed.
 *
 * PASS: after the kickoff no Workflow; then one Workflow of the locked release-watch definition, pinned to the package
 * version 1.0.0, completed; and one Workflow of the agent chat's attached ops-kit/incident-digest, completed. The model's
 * answers and tool calls are recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. Three asked turns.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-package-definitions-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { dirname, join } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { FilesystemArtifactStore, loadModelProviders, PgSessionCatalog, publishAgentPackageDir } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-package-definitions-real-model" };
const TURN_MS = 300_000;
const RUN_MS = 180_000;
const TEST_TIMEOUT = 20 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);

const WATCH_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: release-watch, version: "1.0.0" }
inputs:
  schema: { type: object, required: [train], properties: { train: { type: string } }, additionalProperties: false }
initial: hold
states:
  hold: { type: wait, seconds: 5, transition: { next: { elapsed: clear } } }
  clear: { type: terminal, outcome: succeeded }
`;
const WATCH_CARD = `---
name: release-watch
description: Watches one release train for five seconds and reports that it is clear.
whenToUse: Someone wants a release train checked. It needs the train's name, such as M70.
inputs:
  example: { train: M70 }
outcomes:
  clear: The train is clear.
effects: No scripts; one five-second wait.
---
Start it with the train's name. It ends clear.
`;
const DIGEST_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: incident-digest, version: "0.4.1" }
initial: hold
states:
  hold: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const DIGEST_CARD = `---
name: incident-digest
description: Collects the day's incidents into one digest.
whenToUse: Someone asks for the day's incident digest. It needs no inputs.
outcomes:
  done: The digest was written.
effects: No scripts; one five-second wait.
---
Start it with no inputs.
`;
const watcherAgent = ops => `---
name: release-watcher
description: Watches release trains and writes incident digests.
schemaVersion: 1
version: 1.0.0
workflows:
  - release-watch
  - ${ops}/incident-digest
---
You help with release trains. When someone asks for the day's incident digest, start the Workflow Definition
${ops}/incident-digest with workflow_definition (operation start, name "${ops}/incident-digest", no inputs), then tell them it started.
`;

function packageDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfs-pkg-real-"));
    for (const [relative, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        fs.writeFileSync(path.join(dir, relative), text);
    }
    return dir;
}

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function until(read, label, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "a chat made from the picker asks for its input and starts its Workflow; a package agent starts another package's definition";

describe("A package's Workflow Definitions (stage 2.3), on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-package-definitions-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, steps: {}, verdict: null };
        const env = createTestEnv("workflow-package-definitions-real-model");
        let mgmt = null;
        try {
            const tag = randomUUID().slice(0, 8);
            const release = `release-tools-${tag}`;
            const ops = `ops-kit-${tag}`;
            const artifactStore = new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts"));
            const registryCatalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await registryCatalog.initialize();
            try {
                const registry = { catalog: registryCatalog, artifactStore };
                const publish = (name, version, files) => publishAgentPackageDir(registry, { dir: packageDir({
                    "plugin.json": JSON.stringify({ name, version, description: `${name}.` }), "CHANGELOG.md": `## ${version}\n`, ...files }),
                scope: "shared", owner: OWNER, createdBy: "workflow-package-definitions-real-model", isAdmin: false });
                await publish(ops, "0.4.1", { "workflows/incident-digest/workflow.yaml": DIGEST_YAML, "workflows/incident-digest/card.md": DIGEST_CARD });
                await publish(release, "1.0.0", { "agents/release-watcher.agent.md": watcherAgent(ops),
                    "workflows/release-watch/workflow.yaml": WATCH_YAML, "workflows/release-watch/card.md": WATCH_CARD });
            } finally {
                await registryCatalog.close();
            }
            const worker = { testOptions: { workflowRequests: true }, workflowScripts: { enabled: true }, logLevel: "warning",
                agentPackages: { cacheDir: join(env.baseDir, `package-definitions-${tag}`), refreshIntervalMs: 0 } };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, artifactStore });
                await mgmt.start();
                const catalog = client._catalog;
                const chatStore = catalog.workflowStore().chat;
                const model = { model: plan.model.ref, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) };
                const eventsOf = (sessionId, types) => catalog.getSessionEvents(sessionId, 0, 5_000, types);
                const toolCalls = async sessionId => (await eventsOf(sessionId, ["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                const answers = async sessionId => (await eventsOf(sessionId, ["assistant.message"])).map(event => event.data?.content)
                    .filter(value => typeof value === "string" && value).map(value => value.slice(0, 300));
                const ended = (definitionId, workflowSessionId) => until(async () => {
                    const row = (await chatStore.listWorkflows({ definitionId })).find(item => item.workflowSessionId === workflowSessionId);
                    return row && row.runStatus && !ACTIVE.has(row.runStatus) ? row : null;
                }, "the Workflow ends", RUN_MS);

                // 1. The picker's path: the catalog lists release-watch; its chat is made as the portal makes it.
                const ref = `${release}/release-watch`;
                const listed = await mgmt.listCreatableWorkflows(OWNER);
                expect(listed.map(item => item.ref)).toEqual(expect.arrayContaining([ref, `${ops}/incident-digest`]));
                const prepared = await mgmt.prepareWorkflowChat(ref, OWNER);
                const chat = await client.createSession({ ...model, owner: OWNER, systemMessage: prepared.systemMessage });
                const attached = await mgmt.attachChatWorkflowPackage(chat.sessionId, { ref, operationId: `workflow-chat:${chat.sessionId}`, coordinating: true,
                    title: prepared.title, packageId: prepared.packageId, sha256: prepared.sha256 }, { principal: OWNER });
                await chat.sendAndWait(prepared.kickoff, TURN_MS);
                const afterKickoff = await chatStore.listWorkflows({ definitionId: attached.definitionId });
                receipt.steps.kickoff = { toolCalls: await toolCalls(chat.sessionId), answers: await answers(chat.sessionId), workflows: afterKickoff.length };
                expect(afterKickoff, JSON.stringify(receipt)).toEqual([]);
                await chat.sendAndWait("The train is M70. Start it now.", TURN_MS);
                const started = await chatStore.listWorkflows({ definitionId: attached.definitionId });
                receipt.steps.start = { toolCalls: await toolCalls(chat.sessionId), workflows: started.map(item => ({ revision: item.revision, status: item.runStatus })) };
                expect(started.length, JSON.stringify(receipt)).toBe(1);
                expect(started[0].revision).toBe(1);
                const revision = await chatStore.readRevision(attached.definitionId, 1);
                expect(revision.package).toMatchObject({ packageName: release, semver: "1.0.0" });
                expect((await ended(attached.definitionId, started[0].workflowSessionId)).runStatus).toBe("completed");
                expect((await catalog.getSession(chat.sessionId)).workflowRef).toBe(ref);

                // 2. A package agent starts another package's definition, by package and name.
                const agentChat = await client.createSessionForAgent("release-watcher", { ...model, owner: OWNER });
                await agentChat.sendAndWait("Please start today's incident digest.", TURN_MS);
                const digest = await chatStore.readDefinitionByName(agentChat.sessionId, `${ops}/incident-digest`);
                receipt.steps.agent = { toolCalls: await toolCalls(agentChat.sessionId), answers: await answers(agentChat.sessionId),
                    attached: digest ? { locked: digest.locked, packageName: digest.packageName } : null };
                expect(digest, JSON.stringify(receipt)).toBeTruthy();
                expect(digest).toMatchObject({ locked: true, packageName: ops });
                const digestRuns = await chatStore.listWorkflows({ definitionId: digest.definitionId });
                receipt.steps.agent.workflows = digestRuns.map(item => ({ revision: item.revision, status: item.runStatus }));
                expect(digestRuns.length, JSON.stringify(receipt)).toBe(1);
                expect((await ended(digest.definitionId, digestRuns[0].workflowSessionId)).runStatus).toBe("completed");
                receipt.verdict = "PASS";
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-package-definitions-real-model] ${JSON.stringify(receipt)}`);
            const receiptPath = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (receiptPath) {
                mkdirSync(dirname(receiptPath), { recursive: true });
                writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await mgmt?.stop().catch(() => {});
            await env.cleanup();
        }
    });
});
