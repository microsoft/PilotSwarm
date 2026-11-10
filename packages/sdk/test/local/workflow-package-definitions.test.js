/**
 * Workflow Simplified stage 2.3, on PostgreSQL: a package's Workflow Definitions (spec "Packages and Agent Smith": P1–P7,
 * E2-7, D7; A2; migration 0108; chat-packages.ts, chat-definitions.ts, definition-tool.ts, the management client).
 * Packages are published to the real agent registry with their bytes in a filesystem artifact store:
 * - P1: the registry's packages export their definitions with their cards; a viewer sees the shared ones and their own;
 * - P2, P5, E2-7: attaching one makes the chat's locked definition `<package>/<name>` at revision 1 with the package
 *   version and the card's digest; attaching it again changes nothing; a save to it is refused (DEFINITION_LOCKED); Start
 *   pins its revision; Make a copy saves the package's YAML as the chat's own, editable definition, with a note;
 * - P6: a newer package version is offered (packageUpdate) and attached as the next revision; a running Workflow keeps its own;
 * - P4: a chat starts what its agent names (a bare name in the agent's own package, another package's by package and name),
 *   reads a card first, and is refused one its agent does not name; a coordinating chat starts its own;
 * - A2: a definition whose agent state uses an agent that names definitions is refused at save and at Start;
 * - the management client: the picker's catalog, a coordinating chat's preparation and attach (its row's workflowRef and
 *   title), a person's newer version and Make a copy.
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { createPackageWorkflowSource } from "../../src/workflow/chat-packages.ts";
import { createRegistryWorkflowAgentResolver } from "../../src/workflow/agent-resolver.ts";
import {
    attachChatPackageWorkflow, copyChatPackageWorkflow, listChatWorkflowDefinitions, saveChatWorkflowDefinition, startChatWorkflowDefinition,
    withPackageUpdates,
} from "../../src/workflow/chat-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "package-definitions" };
const VIEWER = { provider: OWNER.provider, subject: OWNER.subject };
const ENGINE = { kind: "system", name: "package-definitions-test" };

const WATCH_YAML = (seconds, version) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: release-watch, version: "${version}" }
inputs:
  schema: { type: object, required: [train], properties: { train: { type: string } }, additionalProperties: false }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: clear } } }
  clear: { type: terminal, outcome: succeeded }
`;
const WATCH_CARD = `---
name: release-watch
description: Watches a release train and reports when it is clear.
whenToUse: A release train is rolling out. Not for a single pull request.
inputs:
  example: { train: M70 }
outcomes:
  clear: The train finished without a blocker.
effects: No scripts; one wait.
---
Start it with the train's name.
`;
const DIGEST_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: incident-digest, version: "0.4.1" }
initial: hold
states:
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const DIGEST_CARD = `---
name: incident-digest
description: Collects the day's incidents into one digest.
whenToUse: Once a day, or when someone asks for the digest.
outcomes:
  done: The digest was written.
effects: No scripts; one wait.
---
`;
const AGENT = (name, workflows = "") => `---
name: ${name}
description: ${name}.
schemaVersion: 1
version: 1.0.0
${workflows}---
You are ${name}.
`;
/** A definition with one agent state that uses `agent` of `pkg`. */
const DELEGATE = (agent, pkg) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: delegate, version: "1.0.0" }
initial: ask
states:
  ask:
    type: agent
    invoke: { agent: { name: ${agent}, package: ${pkg} } }
    timeoutSeconds: 600
    transition: { next: { checked: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

function packageDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfs-pkgdef-"));
    for (const [relative, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        fs.writeFileSync(path.join(dir, relative), text);
    }
    return dir;
}

/** The real store and registry, two published packages, and a chat. */
async function harness() {
    const h = await openWorkflowStore(getEnv());
    const tag = randomUUID().slice(0, 8);
    const artifactStore = new FilesystemArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), "wfs-pkgdef-artifacts-")));
    const registry = { catalog: h.catalog, artifactStore };
    const release = `release-tools-${tag}`;
    const ops = `ops-kit-${tag}`;
    const publish = async (name, version, files, extra = {}) => publishAgentPackageDir(registry, {
        dir: packageDir({ "plugin.json": JSON.stringify({ name, version, description: `${name}.` }), "CHANGELOG.md": `## ${version}\n`, ...files }),
        scope: extra.scope ?? "shared", owner: extra.owner ?? OWNER, createdBy: "package-definitions-test", isAdmin: false,
    });
    const releaseFiles = (seconds, version) => ({
        "agents/release-watcher.agent.md": AGENT("release-watcher", `workflows:\n  - release-watch\n  - ${ops}/incident-digest\n`),
        "agents/release-helper.agent.md": AGENT("release-helper"),
        "workflows/release-watch/workflow.yaml": WATCH_YAML(seconds, version),
        "workflows/release-watch/card.md": WATCH_CARD,
    });
    await publish(ops, "0.4.1", { "workflows/incident-digest/workflow.yaml": DIGEST_YAML, "workflows/incident-digest/card.md": DIGEST_CARD });
    await publish(release, "1.0.0", releaseFiles(30, "1.0.0"));
    const dispatched = [];
    const duroxideClient = {
        startOrchestrationVersioned: async (instanceId) => { dispatched.push(instanceId); },
        getStatus: async () => ({ status: "Running" }),
        enqueueEvent: async () => {},
    };
    const host = { catalog: h.catalog, store: h.store, duroxideClient, packageWorkflows: createPackageWorkflowSource({ catalog: h.catalog, artifactStore }) };
    const chat = randomUUID();
    await h.catalog.createSession(chat, { owner: OWNER });
    return { h, host, chat, release, ops, tag, publish, releaseFiles, artifactStore, dispatched };
}

const chatActor = chat => ({ kind: "chat", sessionId: chat });
const tool = (host, chat, args, extra = {}) => workflowDefinitionFromTool(args, {
    callerSessionId: chat, host, toolCallId: extra.toolCallId ?? `call-${randomUUID()}`, owner: OWNER, binding: async () => null,
    ...(extra.agentWorkflows ? { agentWorkflows: extra.agentWorkflows } : {}),
}).then(text => JSON.parse(text));

describe("a package's Workflow Definitions (stage 2.3)", () => {
    it("P1: the registry exports each definition with its card; a viewer sees the shared packages and their own only", { timeout: TIMEOUT }, async () => {
        const { h, host, release, ops, tag, publish } = await harness();
        try {
            await publish(`private-kit-${tag}`, "1.0.0", { "workflows/incident-digest/workflow.yaml": DIGEST_YAML, "workflows/incident-digest/card.md": DIGEST_CARD },
                { scope: "user", owner: { provider: "test", subject: "eve" } });
            // This run's packages: a ref is <package>/<name>, so the run's tag ends the package's name, not the ref.
            const mine = (await host.packageWorkflows.list(VIEWER)).filter(entry => entry.packageName.endsWith(tag));
            expect(mine.map(entry => entry.ref).sort()).toEqual([`${ops}/incident-digest`, `${release}/release-watch`]);
            const watch = mine.find(entry => entry.ref === `${release}/release-watch`);
            expect(watch).toMatchObject({ packageName: release, semver: "1.0.0", scope: "shared", mine: false,
                workflow: { name: "release-watch", version: "1.0.0", description: "Watches a release train and reports when it is clear." } });
            expect(watch.workflow.card.inputs.example).toEqual({ train: "M70" });
            expect(watch.workflow.interface.outcomes).toEqual({ clear: "succeeded" });
            expect(await host.packageWorkflows.readYaml(watch)).toBe(WATCH_YAML(30, "1.0.0"));
            // Eve's own package is hers.
            expect((await host.packageWorkflows.list({ provider: "test", subject: "eve" })).some(entry => entry.ref === `private-kit-${tag}/incident-digest`)).toBe(true);
        } finally {
            await h.stop();
        }
    });

    it("P2, P5, E2-7: attached locked at the package version; once; a save refused; Start pins it; Make a copy is the chat's own", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release } = await harness();
        try {
            const ref = `${release}/release-watch`;
            const attach = (operationId) => attachChatPackageWorkflow(host, { ownerSessionId: chat, ref, viewer: VIEWER, actor: chatActor(chat), operationId, by: "chat" });
            const first = await attach("attach-1");
            expect(first.receipt).toMatchObject({ operation: "attach", name: ref, revision: 1, created: true, changed: true,
                package: { packageName: release, semver: "1.0.0" } });
            expect(first.receipt.package.cardDigest).toMatch(/^[0-9a-f]{64}$/);
            expect((await attach("attach-2")).receipt).toMatchObject({ revision: 1, created: false, changed: false });
            const [view] = await listChatWorkflowDefinitions(host, chat);
            expect(view).toMatchObject({ name: ref, locked: true, packageName: release, currentRevision: 1,
                current: { package: { packageName: release, semver: "1.0.0", cardDigest: first.receipt.package.cardDigest } } });
            // Locked: the chat's save of it is refused in words, by name and by its id.
            const byName = await tool(host, chat, { operation: "save", name: ref, yaml: WATCH_YAML(5, "9.9.9") });
            expect(byName).toMatchObject({ ok: false, error: { code: "DEFINITION_LOCKED" } });
            expect(byName.error.message).toMatch(/locked: it cannot be changed here\. Make a copy of it .* Nothing was saved\.$/);
            await refused(host.store.chat.save({ ownerSessionId: chat, name: ref, yaml: WATCH_YAML(5, "9.9.9"), compiled: { valid: true, diagnostics: [],
                yamlSha256: "x", irSha256: null, ir: null, version: "9.9.9" }, expected: { definitionId: view.definitionId, revision: 1 },
            actor: chatActor(chat), operationId: "save-locked", requestSha256: "x", seenByChat: true }), "DEFINITION_LOCKED");
            // Start pins revision 1; the Workflow's own definition is the package's YAML.
            const started = await startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { name: ref }, inputs: { train: "M70" },
                actor: ENGINE, operationId: "start-1" });
            expect(started).toMatchObject({ name: ref, revision: 1 });
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(WATCH_YAML(30, "1.0.0"));
            // Make a copy: the chat's own definition release-watch, revision 1, unlocked, with a note for the chat.
            const copy = await copyChatPackageWorkflow(host, { ownerSessionId: chat, definitionId: view.definitionId, actor: { kind: "user", provider: "test",
                subject: "ada", display: "Ada Lovelace" }, operationId: "copy-1", personWords: "Ada Lovelace" });
            expect(copy.receipt).toMatchObject({ name: "release-watch", revision: 1, created: true, valid: true });
            // Formal L1: the copy is source 'copy' and names the definition, revision and package version it came from.
            expect((await h.store.chat.readDefinition(copy.receipt.definitionId))).toMatchObject({ locked: false, packageName: null, source: "copy",
                copiedFrom: { definitionId: view.definitionId, name: ref, revision: 1, package: { packageName: release, semver: "1.0.0",
                    packageId: first.receipt.package.packageId, sha256: first.receipt.package.sha256 } } });
            const [copyView] = (await listChatWorkflowDefinitions(host, chat)).filter(item => item.definitionId === copy.receipt.definitionId);
            expect(copyView.copiedFrom).toMatchObject({ name: ref, revision: 1 });
            expect((await tool(host, chat, { operation: "read", definition_id: copy.receipt.definitionId })).copiedFrom ?? null)
                .toEqual({ name: ref, revision: 1, packageVersion: "1.0.0" });
            // Any other definition names no source.
            expect((await h.store.chat.readDefinition(view.definitionId)).copiedFrom).toBe(null);
            expect((await h.store.chat.pendingNotes(chat)).map(note => note.text)).toEqual(["Ada Lovelace saved release-watch revision 1."]);
            await refused(copyChatPackageWorkflow(host, { ownerSessionId: chat, definitionId: view.definitionId, actor: ENGINE, operationId: "copy-2" }),
                "DEFINITION_EXISTS");
            // A copy of the chat's own definition is not a copy: it is changed by saving it.
            await refused(copyChatPackageWorkflow(host, { ownerSessionId: chat, definitionId: copy.receipt.definitionId, actor: ENGINE, operationId: "copy-3" }),
                "WORKFLOW_COMMAND_INVALID");
        } finally {
            await h.stop();
        }
    });

    it("P6: a newer package version is offered and attached for the next Workflow; the running one keeps its own", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release, publish, releaseFiles } = await harness();
        try {
            const ref = `${release}/release-watch`;
            const first = await attachChatPackageWorkflow(host, { ownerSessionId: chat, ref, viewer: VIEWER, actor: chatActor(chat), operationId: "a-1", by: "chat" });
            const running = await startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { name: ref }, inputs: { train: "M70" }, actor: ENGINE,
                operationId: "s-1" });
            await publish(release, "1.1.0", releaseFiles(45, "1.1.0"));
            const [offered] = await withPackageUpdates(host, await listChatWorkflowDefinitions(host, chat), VIEWER);
            expect(offered.packageUpdate).toMatchObject({ semver: "1.1.0" });
            const second = await attachChatPackageWorkflow(host, { ownerSessionId: chat, ref, viewer: VIEWER, actor: chatActor(chat), operationId: "a-2", by: "chat" });
            expect(second.receipt).toMatchObject({ definitionId: first.receipt.definitionId, revision: 2, created: false, changed: true, package: { semver: "1.1.0" } });
            const [after] = await withPackageUpdates(host, await listChatWorkflowDefinitions(host, chat), VIEWER);
            expect(after.packageUpdate).toBeNull();
            expect(after.workflows).toEqual([expect.objectContaining({ workflowSessionId: running.workflowId, revision: 1 })]);
            expect((await h.store.readRevision(running.workflowId, 1)).yaml).toBe(WATCH_YAML(30, "1.0.0"));
            const next = await startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { name: ref }, inputs: { train: "M71" }, actor: ENGINE,
                operationId: "s-2" });
            expect(next.revision).toBe(2);
            expect((await h.store.readRevision(next.workflowId, 1)).yaml).toBe(WATCH_YAML(45, "1.1.0"));
        } finally {
            await h.stop();
        }
    });

    // Stage 2 review S2SF-F6 / formal L4: "newer" is the same package's strictly greater semver. A rollback (an older active
    // version) and another package of the same name (the owner's own copy, which shadows the shared one) are never offered,
    // and a person's or the chat's "newer version" attaches neither.
    it("S2SF-F6 / L4: 1.1.0 attached and 1.0.0 active: no offer and no update; an owner's own copy neither; the same package's 1.2.0 is", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release, publish, releaseFiles, artifactStore } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {}, artifactStore });
        await mgmt.start();
        const ref = `${release}/release-watch`;
        const offered = async () => (await mgmt.listChatWorkflowDefinitions(chat))[0].packageUpdate ?? null;
        try {
            await publish(release, "1.1.0", releaseFiles(45, "1.1.0"));
            const attached = await attachChatPackageWorkflow(host, { ownerSessionId: chat, ref, viewer: VIEWER, actor: chatActor(chat), operationId: "a-1", by: "chat" });
            expect(attached.receipt).toMatchObject({ revision: 1, package: { semver: "1.1.0" } });
            const definitionId = attached.receipt.definitionId;
            // A rollback: 1.0.0 is the active version again.
            await h.catalog.pinAgentPackageVersion(release, "1.0.0", OWNER, false, { scope: "shared" });
            expect(await offered()).toBe(null);
            expect((await mgmt.readChatWorkflowDefinition(chat, { definitionId })).packageUpdate ?? null).toBe(null);
            const rollback = await refused(mgmt.updateChatWorkflowPackage(chat, { definitionId, operationId: "u-1" }, { principal: VIEWER }), "PACKAGE_NOT_NEWER");
            expect(rollback.message).toBe("The package's active version is 1.0.0, not newer than the 1.1.0 this chat has. "
                + "Nothing was attached; its Workflows start 1.1.0.");
            expect(rollback.status).toBe(409);
            const card = await tool(host, chat, { operation: "card", name: ref });
            expect(card).toMatchObject({ ok: true, version: "1.1.0", attached: true });
            expect("newerVersion" in card).toBe(false);
            const update = await tool(host, chat, { operation: "start", name: ref, update: true, inputs: { train: "M70" } });
            expect(update).toMatchObject({ ok: false, error: { code: "PACKAGE_NOT_NEWER" } });
            expect(await h.store.chat.listWorkflows({ definitionId })).toEqual([]);
            expect((await h.store.chat.readDefinition(definitionId)).currentRevision).toBe(1);
            // The same package's 1.2.0 is newer: offered, and taken for the next Workflow.
            await publish(release, "1.2.0", releaseFiles(50, "1.2.0"));
            expect(await offered()).toMatchObject({ semver: "1.2.0" });
            expect(await mgmt.updateChatWorkflowPackage(chat, { definitionId, operationId: "u-2" }, { principal: VIEWER }))
                .toMatchObject({ revision: 2, changed: true, package: { semver: "1.2.0" } });
            // The owner's own copy of the package (user scope, same name, 2.0.0) shadows the shared one: another package, not newer.
            await publish(release, "2.0.0", releaseFiles(60, "2.0.0"), { scope: "user", owner: OWNER });
            expect(await offered()).toBe(null);
            const other = await refused(mgmt.updateChatWorkflowPackage(chat, { definitionId, operationId: "u-3" }, { principal: VIEWER }), "PACKAGE_NOT_NEWER");
            expect(other.message).toMatch(/is another package of that name, not the one this chat has \(1\.2\.0\)\. Nothing was attached/);
            expect((await h.store.chat.readDefinition(definitionId)).currentRevision).toBe(2);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    // Stage 2 review S2RT-F10 (and formal L2): an attach and a Make a copy that ran are answered from their receipts when
    // repeated, whatever the registry's active version is now.
    it("S2RT-F10: a start with update interrupted after its attach, replayed after a republish, starts the attached revision; a repeated copy answers its receipt", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release, publish, releaseFiles } = await harness();
        try {
            const ref = `${release}/release-watch`;
            const agentWorkflows = async () => ({ packageName: release, refs: ["release-watch"] });
            // 1.0.0 attached and started once; then 1.1.0 is published.
            expect(await tool(host, chat, { operation: "start", name: ref, inputs: { train: "M70" } }, { agentWorkflows })).toMatchObject({ ok: true, revision: 1 });
            await publish(release, "1.1.0", releaseFiles(45, "1.1.0"));
            // The chat's start with update attaches 1.1.0 (revision 2), then stops before its Start is stored.
            let fail = true;
            const stopping = { ...host, store: new Proxy(h.store, { get: (target, name) => (name === "createDefinition" && fail
                ? async () => { fail = false; throw new Error("worker stopped"); } : typeof target[name] === "function" ? target[name].bind(target) : target[name]) }) };
            const args = { operation: "start", name: ref, update: true, inputs: { train: "M71" } };
            const first = await tool(stopping, chat, args, { agentWorkflows, toolCallId: "call-update" });
            expect(first.ok).toBe(false);
            const [definition] = await h.store.chat.listDefinitions(chat);
            expect(definition.currentRevision).toBe(2);
            // 1.2.0 is published; the same call again starts revision 2 (1.1.0) and attaches nothing more.
            await publish(release, "1.2.0", releaseFiles(50, "1.2.0"));
            const again = await tool(host, chat, args, { agentWorkflows, toolCallId: "call-update" });
            expect(again, JSON.stringify(again)).toMatchObject({ ok: true, revision: 2 });
            expect((await h.store.chat.readDefinition(definition.definitionId)).currentRevision).toBe(2);
            expect((await h.store.readRevision(again.workflowId, 1)).yaml).toBe(WATCH_YAML(45, "1.1.0"));
            // Make a copy (of the newest, revision 2) whose answer was lost; the package moves to 1.2.0 (revision 3); the same copy
            // again answers its receipt: the copy of revision 2.
            const copy = await copyChatPackageWorkflow(host, { ownerSessionId: chat, definitionId: definition.definitionId, actor: ENGINE, operationId: "copy-lost" });
            await attachChatPackageWorkflow(host, { ownerSessionId: chat, ref, viewer: VIEWER, actor: chatActor(chat), operationId: "a-3", by: "chat", newerOnly: true });
            expect((await h.store.chat.readDefinition(definition.definitionId)).currentRevision).toBe(3);
            const repeated = await copyChatPackageWorkflow(host, { ownerSessionId: chat, definitionId: definition.definitionId, actor: ENGINE, operationId: "copy-lost" });
            expect(repeated).toEqual({ receipt: copy.receipt, replayed: true });
            expect((await h.store.chat.readDefinition(copy.receipt.definitionId)).copiedFrom).toMatchObject({ revision: 2 });
        } finally {
            await h.stop();
        }
    });

    // Formal L3: two attaches under one operation id at the same time. Both read no receipt, then wait for the chat (held
    // here); the first stores its attach, and the second, once it has the chat, answers that receipt (not a key error).
    it("L3: a concurrent attach under the same operation id answers the first one's receipt", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release } = await harness();
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 1 });
        const holder = await direct.connect();
        try {
            await holder.query("BEGIN");
            await holder.query(`SELECT 1 FROM "${env.cmsSchema}".sessions WHERE session_id = $1 FOR UPDATE`, [chat]);
            const request = { ownerSessionId: chat, ref: `${release}/release-watch`, viewer: VIEWER, actor: chatActor(chat), operationId: "same", by: "chat" };
            const both = Promise.allSettled([attachChatPackageWorkflow(host, request), attachChatPackageWorkflow(host, request)]);
            await new Promise(resolve => setTimeout(resolve, 2_000));
            await holder.query("COMMIT");
            const results = await both;
            expect(results.map(result => result.status), JSON.stringify(results.map(result => result.reason?.message ?? null))).toEqual(["fulfilled", "fulfilled"]);
            const [a, b] = results.map(result => result.value);
            expect(a.receipt).toEqual(b.receipt);
            expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
            const definitions = await h.store.chat.listDefinitions(chat);
            expect(definitions.map(item => item.currentRevision)).toEqual([1]);
        } finally {
            holder.release();
            await direct.end();
            await h.stop();
        }
    });

    it("P4: the chat starts what its agent names, reads the card first, and is refused another; a coordinating chat starts its own", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release, ops, tag } = await harness();
        try {
            const agentWorkflows = async () => ({ packageName: release, refs: ["release-watch", `${ops}/incident-digest`] });
            const listed = await tool(host, chat, { operation: "list" }, { agentWorkflows });
            expect(listed.canStart).toEqual([
                { name: `${release}/release-watch`, version: "1.0.0", description: "Watches a release train and reports when it is clear.", attached: false },
                { name: `${ops}/incident-digest`, version: "0.4.1", description: "Collects the day's incidents into one digest.", attached: false },
            ]);
            const card = await tool(host, chat, { operation: "card", name: `${release}/release-watch` }, { agentWorkflows });
            expect(card).toMatchObject({ ok: true, operation: "card", name: `${release}/release-watch`, version: "1.0.0", attached: false,
                exampleInputs: { train: "M70" }, outcomes: { clear: "The train finished without a blocker." } });
            expect(card.inputsSchema).toMatchObject({ type: "object", required: ["train"] });
            expect(card.card).toContain("When to use it: A release train is rolling out.");
            // Another package's definition, by package and name: attached and started in one call, pinned to the attached revision.
            const started = await tool(host, chat, { operation: "start", name: `${ops}/incident-digest` }, { agentWorkflows });
            expect(started).toMatchObject({ ok: true, operation: "start", name: `${ops}/incident-digest`, revision: 1 });
            const [view] = (await listChatWorkflowDefinitions(host, chat)).filter(item => item.name === `${ops}/incident-digest`);
            expect(view).toMatchObject({ locked: true, packageName: ops, workflows: [expect.objectContaining({ workflowSessionId: started.workflowId })] });
            // The list now says it is attached, and the read says it is locked.
            const again = await tool(host, chat, { operation: "list" }, { agentWorkflows });
            expect(again.definitions.find(item => item.name === `${ops}/incident-digest`)).toMatchObject({ locked: true, package: { name: ops, version: "0.4.1" } });
            expect(again.canStart.find(item => item.name === `${ops}/incident-digest`).attached).toBe(true);
            // A definition the agent does not name is refused, and nothing is attached.
            const other = await tool(host, chat, { operation: "start", name: `${release}/release-watch`, inputs: { train: "M70" } });
            expect(other).toMatchObject({ ok: false, error: { code: "PACKAGE_WORKFLOW_NOT_ALLOWED" } });
            expect((await listChatWorkflowDefinitions(host, chat)).some(item => item.name === `${release}/release-watch`)).toBe(false);
            const missing = await tool(host, chat, { operation: "start", name: `nothing-${tag}/x` }, { agentWorkflows: async () => ({ packageName: null,
                refs: [`nothing-${tag}/x`] }) });
            expect(missing).toMatchObject({ ok: false, error: { code: "PACKAGE_WORKFLOW_NOT_FOUND" } });
            // A coordinating chat (made for release-watch) starts its own without any agent list.
            const coordinating = randomUUID();
            await h.catalog.createSession(coordinating, { owner: OWNER });
            await attachChatPackageWorkflow(host, { ownerSessionId: coordinating, ref: `${release}/release-watch`, viewer: VIEWER, actor: ENGINE,
                operationId: "coordinate", by: "system", workflowRef: `${release}/release-watch` });
            expect((await h.catalog.getSession(coordinating)).workflowRef).toBe(`${release}/release-watch`);
            const own = await tool(host, coordinating, { operation: "start", name: `${release}/release-watch`, inputs: { train: "M70" } });
            expect(own).toMatchObject({ ok: true, revision: 1 });
            expect((await tool(host, coordinating, { operation: "list" })).canStart).toEqual([expect.objectContaining({ name: `${release}/release-watch`, attached: true })]);
        } finally {
            await h.stop();
        }
    });

    it("A2: an agent state may not use an agent that names definitions: refused at save and at Start", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, release } = await harness();
        try {
            const resolving = { ...host, resolveAgent: createRegistryWorkflowAgentResolver(h.catalog) };
            const save = (yaml, onHost, name = "delegate") => saveChatWorkflowDefinition(onHost, { ownerSessionId: chat, name, yaml, expected: null,
                actor: chatActor(chat), operationId: `save-${randomUUID()}`, by: "chat" });
            const atSave = await refused(save(DELEGATE("release-watcher", release), resolving), "AGENT_HAS_WORKFLOWS");
            expect(atSave.message).toMatch(/^State 'ask' uses agent "release-watcher", which names Workflow Definitions it can start\. .* Nothing was saved\.$/);
            // A host that resolves no agents saves it (Start pins every named agent)...
            const saved = (await save(DELEGATE("release-watcher", release), { ...host })).receipt;
            expect(saved).toMatchObject({ revision: 1, valid: true });
            // ...and Start refuses it, writing nothing.
            const atStart = await refused(startChatWorkflowDefinition(resolving, { ownerSessionId: chat, definition: { definitionId: saved.definitionId },
                inputs: {}, actor: ENGINE, operationId: "start-a2" }), "AGENT_HAS_WORKFLOWS");
            expect(atStart.message).toMatch(/Nothing was changed\.$/);
            expect((await h.store.chat.listWorkflows({ definitionId: saved.definitionId }))).toEqual([]);
            // The package's other agent names none: saved and started.
            const helper = (await save(DELEGATE("release-helper", release).replace("name: delegate", "name: helper"), resolving, "helper")).receipt;
            expect(helper.valid).toBe(true);
            const ok = await startChatWorkflowDefinition(resolving, { ownerSessionId: chat, definition: { definitionId: helper.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-helper" });
            expect(ok.revision).toBe(1);
        } finally {
            await h.stop();
        }
    });

    it("the management client: the picker's catalog, a coordinating chat, a person's newer version and Make a copy", { timeout: TIMEOUT }, async () => {
        const { h, release, tag, publish, releaseFiles, artifactStore } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {}, artifactStore });
        await mgmt.start();
        try {
            const catalog = (await mgmt.listCreatableWorkflows(VIEWER)).filter(item => item.ref.endsWith(tag) || item.package.endsWith(tag));
            const watch = catalog.find(item => item.ref === `${release}/release-watch`);
            expect(watch).toMatchObject({ name: "release-watch", package: release, semver: "1.0.0", mine: false, model: null,
                description: "Watches a release train and reports when it is clear.", inputs: [{ name: "train", required: true }],
                outcomes: { clear: "The train finished without a blocker." } });
            // S2SF-F4: what the definition shows of its effects, read from its checked bytes, whatever its card says.
            expect(watch.checked).toEqual({ scripts: [], agents: [], words: "Checked from the definition: it runs no scripts and has no agent steps." });
            const prepared = await mgmt.prepareWorkflowChat(`${release}/release-watch`, VIEWER);
            expect(prepared.systemMessage).toContain("Checked from the definition: it runs no scripts and has no agent steps.");
            expect(prepared.systemMessage).toContain("Effects (the author's words): No scripts; one wait.");
            expect(prepared).toMatchObject({ ref: `${release}/release-watch`, semver: "1.0.0", title: `release-watch · ${release}`, model: null });
            expect(prepared.systemMessage).toContain(`This chat coordinates one Workflow Definition: ${release}/release-watch (package version 1.0.0).`);
            expect(prepared.kickoff).toMatch(/ask for each input it needs/);
            await refused(mgmt.prepareWorkflowChat(`nothing-${tag}/x`, VIEWER), "PACKAGE_WORKFLOW_NOT_FOUND");
            // The coordinating chat: attached, its row's workflowRef and title.
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const attached = await mgmt.attachChatWorkflowPackage(chat, { ref: prepared.ref, operationId: "coordinate", coordinating: true, title: prepared.title },
                { principal: VIEWER });
            expect(attached).toMatchObject({ revision: 1, created: true });
            expect(await h.catalog.getSession(chat)).toMatchObject({ workflowRef: prepared.ref, title: prepared.title });
            // DS-1: a person's save of the locked definition is DEFINITION_LOCKED, with its own name, a bare name or none.
            const lockedId = attached.definitionId;
            for (const [name, guard] of [[prepared.ref, { definitionId: lockedId, expectedRevision: 1 }], ["release-watch", { definitionId: lockedId, expectedRevision: 1 }],
                [prepared.ref, {}]]) {
                const refusal = await refused(mgmt.saveChatWorkflowDefinition(chat, { name, yaml: WATCH_YAML(5, "9.9.9"), operationId: `ds1-${randomUUID()}`, ...guard },
                    { principal: VIEWER }), "DEFINITION_LOCKED");
                expect(refusal.message).toMatch(/Make a copy of it \(in the Workflow tab\) and change the copy\. Nothing was saved\.$/);
            }
            expect((await h.store.chat.readDefinition(lockedId)).currentRevision).toBe(1);
            // A person takes the newer version for the next Workflow.
            await publish(release, "1.1.0", releaseFiles(45, "1.1.0"));
            const [listed] = await mgmt.listChatWorkflowDefinitions(chat);
            expect(listed).toMatchObject({ locked: true, packageUpdate: { semver: "1.1.0" } });
            expect(await mgmt.updateChatWorkflowPackage(chat, { definitionId: listed.definitionId, operationId: "update" }, { principal: VIEWER }))
                .toMatchObject({ revision: 2, changed: true, package: { semver: "1.1.0" } });
            // Make a copy.
            expect(await mgmt.copyChatWorkflowDefinition(chat, { definitionId: listed.definitionId, operationId: "copy" }, { principal: { ...VIEWER,
                displayName: "Ada Lovelace" } })).toMatchObject({ name: "release-watch", revision: 1, created: true });
            const read = await mgmt.readChatWorkflowDefinition(chat, { definitionId: listed.definitionId });
            expect(read).toMatchObject({ locked: true, packageUpdate: null, revision: { revision: 2, package: { semver: "1.1.0" } } });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    // Stage 2 review S2SF-F3: the picker's chat is made with instructions written from one package version; the attach takes
    // exactly that version (its package id and content hash), or nothing.
    it("S2SF-F3: the attach takes the prepared package version or nothing: another active version, or a removed package, attaches nothing", { timeout: TIMEOUT }, async () => {
        const { h, release, publish, releaseFiles, artifactStore } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {}, artifactStore });
        await mgmt.start();
        const ref = `${release}/release-watch`;
        const coordinate = (chat, prepared) => mgmt.attachChatWorkflowPackage(chat, { ref, operationId: `coordinate-${chat}`, coordinating: true,
            title: prepared.title, packageId: prepared.packageId, sha256: prepared.sha256 }, { principal: VIEWER });
        const nothingAttached = async (chat) => {
            expect(await mgmt.listChatWorkflowDefinitions(chat)).toEqual([]);
            expect((await h.catalog.getSession(chat)).workflowRef ?? null).toBe(null);
        };
        try {
            const prepared = await mgmt.prepareWorkflowChat(ref, VIEWER);
            expect(prepared).toMatchObject({ semver: "1.0.0", packageId: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
            // The prepared version, unchanged: attached at that version.
            const same = randomUUID();
            await h.catalog.createSession(same, { owner: OWNER });
            expect(await coordinate(same, prepared)).toMatchObject({ revision: 1, created: true, package: { semver: "1.0.0" } });
            // A version and its package id must come together.
            await refused(mgmt.attachChatWorkflowPackage(same, { ref, operationId: "half", packageId: prepared.packageId }, { principal: VIEWER }),
                "WORKFLOW_COMMAND_INVALID");
            // 1.1.0 becomes active between prepare and attach: nothing is attached.
            await publish(release, "1.1.0", releaseFiles(45, "1.1.0"));
            const changed = randomUUID();
            await h.catalog.createSession(changed, { owner: OWNER });
            const refusal = await refused(coordinate(changed, prepared), "PACKAGE_VERSION_CHANGED");
            expect(refusal.message).toMatch(/now 1\.1\.0, not the one its instructions describe\. Nothing was attached/);
            expect(refusal.status).toBe(409);
            await nothingAttached(changed);
            // The package is removed between prepare and attach: nothing is attached.
            const again = await mgmt.prepareWorkflowChat(ref, VIEWER);
            expect(again.semver).toBe("1.1.0");
            await h.catalog.setAgentPackageEnabled(release, false, OWNER, false, { scope: "shared" });
            const gone = randomUUID();
            await h.catalog.createSession(gone, { owner: OWNER });
            await refused(coordinate(gone, again), "PACKAGE_WORKFLOW_NOT_FOUND");
            await nothingAttached(gone);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
});
