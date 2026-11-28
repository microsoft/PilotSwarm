/**
 * Shared happy-path scenario for PilotSwarm Workflows across every public API surface:
 *   - SDK direct (`PilotSwarmManagementClient`)
 *   - Web API (`WebPilotSwarmManagementClient` against a real local portal server)
 *   - MCP (`pilotswarm-mcp` binary over `StdioClientTransport`)
 *
 * All Workflow states are model-free (`script`, `wait`, `terminal`), and starts
 * pass `notifyParent: false` so completed/cancelled runs never trigger agent
 * turns. Note: S5 `createSessionForWorkflow` always sends one coordinating
 * kickoff message; SDK/Web runners back it with a local scripted model stub.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);

function computeYaml(name, { version, rev, expr }) {
    return `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ${name}
  version: "${version}"
inputs:
  schema:
    type: object
    required: [a, b]
    properties:
      a: { type: number }
      b: { type: number }
    additionalProperties: false
initial: compute
states:
  compute:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { rev: ${rev}, total: ${expr} });
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
}

function holdYaml(name) {
    return `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ${name}
  version: "1.0.0"
initial: hold
states:
  hold:
    type: wait
    seconds: 300
    transition:
      next:
        elapsed: done
  done:
    type: terminal
    outcome: succeeded
    output: { ok: true }
`;
}

function receiveYaml(name) {
    return `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ${name}
  version: "1.0.0"
inputs:
  schema:
    type: object
    required: [ticketId]
    properties:
      ticketId: { type: string }
    additionalProperties: false
schemas:
  DeploySignal:
    type: object
    required: [approvedBy, slot]
    properties:
      approvedBy: { type: string, minLength: 1 }
      slot: { type: string, minLength: 1 }
    additionalProperties: false
contracts:
  DeploySignal@1:
    schema: { $ref: "#/schemas/DeploySignal" }
initial: await_signal
states:
  await_signal:
    type: messaging
    mode: receive
    contract: DeploySignal@1
    correlate:
      ticketId: "\${inputs.ticketId}"
    transition:
      next:
        received: done
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
`;
}

function makeTestPackageFiles(pkgName, workflowName) {
    const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
    const yaml = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ${workflowName}
  version: "1.0.0"
inputs:
  schema:
    type: object
    required: [text]
    properties:
      text: { type: string }
    additionalProperties: false
initial: emit
states:
  emit:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { echoed: String(context.inputs.text ?? "") });
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
    const card = `---
name: ${workflowName}
description: Echoes input text through a deterministic script workflow.
whenToUse: Verifying packaged Workflow discovery, cards, and copy on a public surface.
inputs:
  example: { text: hello }
outcomes:
  done: Echoed the text.
  failed: Failed to run.
output: Object containing echoed text.
effects: Pure script step with no external calls.
---
Ask the caller for text, then start the workflow.
`;
    return [
        { path: "plugin.json", contentBase64: b64(JSON.stringify({ name: pkgName, version: "1.0.0", description: `Surface scenario package (${pkgName})` })) },
        { path: `workflows/${workflowName}/workflow.yaml`, contentBase64: b64(yaml) },
        { path: `workflows/${workflowName}/card.md`, contentBase64: b64(card) },
    ];
}

function parseJsonField(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

async function waitUntil(check, label, { timeoutMs = 60_000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

/**
 * Shared adapter factory for `PilotSwarmManagementClient` (direct) and
 * `WebPilotSwarmManagementClient` (HTTP), leaving only mode-specific hooks
 * (`createOwnerSession`, `publishPackage`, `deletePackage`,
 * `listCreatableWorkflows`, `createSessionForWorkflow`) to each runner.
 */
export function managementClientAdapter(mgmt, overrides) {
    return {
        getWorkflowCapabilities: () => mgmt.getWorkflowCapabilities(),
        listWorkflowSkills: () => mgmt.readWorkflowSkills(),
        readWorkflowSkill: (name) => mgmt.readWorkflowSkills({ name }),
        validateDefinition: (yaml) => mgmt.validateWorkflowDefinition(yaml),
        saveDefinition: ({ ownerSessionId, name, yaml, definitionId, expectedRevision, operationId }) =>
            mgmt.saveSessionWorkflowDefinition(ownerSessionId, {
                name,
                yaml,
                ...(definitionId ? { definitionId } : {}),
                ...(expectedRevision != null ? { expectedRevision } : {}),
                operationId,
            }),
        listDefinitions: (ownerSessionId) => mgmt.listSessionWorkflowDefinitions(ownerSessionId),
        readDefinition: ({ ownerSessionId, definitionId, name, revision }) =>
            mgmt.readSessionWorkflowDefinition(ownerSessionId, { definitionId, name, revision }),
        startDefinition: ({ ownerSessionId, definitionId, name, revision, inputs, vars, workspace, notifyParent, operationId }) =>
            mgmt.startSessionWorkflowDefinition(ownerSessionId, {
                definitionId,
                name,
                ...(revision != null ? { revision } : {}),
                ...(inputs !== undefined ? { inputs } : {}),
                ...(vars !== undefined ? { vars } : {}),
                ...(notifyParent !== undefined ? { notifyParent } : {}),
                workspace,
                operationId,
            }),
        readWorkflow: (workflowId, options) => mgmt.readWorkflow(workflowId, options),
        updateWorkflow: (workflowId, command) => mgmt.updateWorkflow(workflowId, command),
        sendWorkflowInput: (workflowId, input) => mgmt.sendWorkflowInput(workflowId, input),
        deleteDefinition: ({ ownerSessionId, definitionId, name, operationId }) =>
            mgmt.deleteSessionWorkflowDefinition(ownerSessionId, { definitionId, name, operationId }),
        readPackageCard: ({ ownerSessionId, name }) => mgmt.readSessionWorkflowCard(ownerSessionId, { name }),
        copyDefinition: ({ ownerSessionId, name, definitionId, operationId }) =>
            mgmt.copySessionWorkflowDefinition(ownerSessionId, { name, definitionId, operationId }),
        deleteSession: (sessionId) => mgmt.deleteSession(sessionId),
        ...overrides,
    };
}

/**
 * Execute the S1–S6 Workflow happy-path scenario against one surface adapter.
 */
export async function runWorkflowSurfaceScenario(adapter, { prefix, timeoutMs = 60_000 }) {
    const tag = randomBytes(4).toString("hex");
    const computeName = `${prefix}-compute`;
    const holdName = `${prefix}-hold`;
    const receiveName = `${prefix}-receive`;
    const pkgWfName = `${prefix}-pkg-echo`;
    const pkgName = `${prefix}-pkg-${tag}`;
    const pkgRef = `${pkgName}/${pkgWfName}`;
    const op = (step) => `${prefix}-${tag}-${step}`;

    const sessionsToClean = new Set();
    let pkgActive = false;

    try {
        // ── S1 Discover ────────────────────────────────────────────────
        const caps = await adapter.getWorkflowCapabilities();
        assert.equal(caps?.read, true, `${prefix} S1: workflows.read`);
        assert.equal(caps?.card, true, `${prefix} S1: workflows.card`);
        assert.equal(caps?.input, true, `${prefix} S1: workflows.input`);
        assert.equal(caps?.commands?.available, true, `${prefix} S1: workflows.commands.available`);
        for (const needed of ["pause", "resume", "set_vars", "cancel"]) {
            assert.ok(caps?.commands?.operations?.includes(needed),
                `${prefix} S1: commands.operations includes ${needed}`);
        }

        const skillList = await adapter.listWorkflowSkills();
        const skills = Array.isArray(skillList?.skills) ? skillList.skills : [];
        assert.ok(skills.length > 0, `${prefix} S1: workflow skills list non-empty`);
        const authoringEntry = skills.find((s) => s.name === "workflow-authoring");
        assert.ok(authoringEntry?.description?.length > 0, `${prefix} S1: workflow-authoring listed with description`);

        const authoringSkill = await adapter.readWorkflowSkill("workflow-authoring");
        assert.equal(authoringSkill?.name, "workflow-authoring", `${prefix} S1: skill name`);
        assert.ok(typeof authoringSkill?.content === "string" && authoringSkill.content.length > 200,
            `${prefix} S1: skill content populated`);

        // ── S2 Author ──────────────────────────────────────────────────
        const owner = await adapter.createOwnerSession(`${prefix}-wf-owner-${tag}`);
        assert.ok(typeof owner?.sessionId === "string" && owner.sessionId.length > 0, `${prefix} S2: owner session created`);
        sessionsToClean.add(owner.sessionId);

        const v1Yaml = computeYaml(computeName, { version: "1.0.0", rev: 1, expr: "Number(context.inputs.a) + Number(context.inputs.b)" });
        const v2Yaml = computeYaml(computeName, { version: "1.0.1", rev: 2, expr: "Number(context.inputs.a) * Number(context.inputs.b) + 1" });

        const validated = await adapter.validateDefinition(v1Yaml);
        assert.equal(validated?.valid, true, `${prefix} S2: valid YAML passes validate`);
        assert.equal(validated?.name, computeName, `${prefix} S2: validated name`);
        assert.deepEqual(validated?.errors ?? [], [], `${prefix} S2: no validation errors`);
        assert.ok(validated?.graph && typeof validated.graph === "object", `${prefix} S2: validate returns graph`);
        assert.equal(validated?.inputsSchema?.type, "object", `${prefix} S2: validate returns inputsSchema`);

        const saved1 = await adapter.saveDefinition({
            ownerSessionId: owner.sessionId,
            name: computeName,
            yaml: v1Yaml,
            operationId: op("save-compute-1"),
        });
        assert.ok(typeof saved1?.definitionId === "string" && saved1.definitionId.length > 0, `${prefix} S2: definitionId`);
        assert.equal(saved1.name, computeName, `${prefix} S2: rev 1 name`);
        assert.equal(saved1.revision, 1, `${prefix} S2: rev 1 number`);
        assert.equal(saved1.valid, true, `${prefix} S2: rev 1 valid`);

        const listedAfterRev1 = await adapter.listDefinitions(owner.sessionId);
        const listedCompute = listedAfterRev1.find((d) => d.definitionId === saved1.definitionId);
        assert.ok(listedCompute, `${prefix} S2: list shows saved definition`);
        assert.equal(listedCompute.name, computeName, `${prefix} S2: listed name`);
        assert.equal(listedCompute.currentRevision, 1, `${prefix} S2: listed currentRevision`);

        const read1 = await adapter.readDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: saved1.definitionId,
            name: computeName,
        });
        assert.equal(read1?.definitionId, saved1.definitionId, `${prefix} S2: read definitionId`);
        assert.equal(read1?.name, computeName, `${prefix} S2: read name`);
        assert.equal(read1?.revision?.revision, 1, `${prefix} S2: read revision 1`);
        assert.ok(typeof read1?.revision?.yaml === "string" && read1.revision.yaml.includes("rev: 1"),
            `${prefix} S2: read revision 1 yaml`);
        assert.equal(read1?.graph?.initial, "compute", `${prefix} S2: read graph initial`);

        const saved2 = await adapter.saveDefinition({
            ownerSessionId: owner.sessionId,
            name: computeName,
            definitionId: saved1.definitionId,
            expectedRevision: 1,
            yaml: v2Yaml,
            operationId: op("save-compute-2"),
        });
        assert.equal(saved2?.definitionId, saved1.definitionId, `${prefix} S2: rev 2 same definitionId`);
        assert.equal(saved2?.revision, 2, `${prefix} S2: rev 2 number`);
        assert.equal(saved2?.basedOn, 1, `${prefix} S2: rev 2 basedOn 1`);
        assert.equal(saved2?.valid, true, `${prefix} S2: rev 2 valid`);

        // ── S3 Run ─────────────────────────────────────────────────────
        const startedCompute = await adapter.startDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: saved1.definitionId,
            name: computeName,
            revision: 2,
            inputs: { a: 6, b: 7 },
            notifyParent: false,
            workspace: "none",
            operationId: op("start-compute"),
        });
        assert.ok(typeof startedCompute?.workflowId === "string" && startedCompute.workflowId.length > 0,
            `${prefix} S3: workflowId returned`);
        assert.equal(startedCompute.revision, 2, `${prefix} S3: started revision 2`);
        sessionsToClean.add(startedCompute.workflowId);

        if (adapter.verifySessionKind) {
            await adapter.verifySessionKind(startedCompute.workflowId, "workflow");
        }

        const finishedCompute = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedCompute.workflowId);
            return TERMINAL_STATUSES.has(view?.run?.status) ? view : null;
        }, `${prefix} S3 compute run completion`, { timeoutMs });

        assert.equal(finishedCompute.workflowId, startedCompute.workflowId, `${prefix} S3: workflowId`);
        assert.equal(finishedCompute.definition?.source?.revision, 2, `${prefix} S3: source revision 2`);
        assert.equal(finishedCompute.run.status, "completed", `${prefix} S3: run status completed`);
        assert.equal(finishedCompute.run.outcome, "succeeded", `${prefix} S3: run outcome succeeded`);
        assert.deepEqual(parseJsonField(finishedCompute.run.output), { rev: 2, total: 43 },
            `${prefix} S3: exact rev-2 output { rev: 2, total: 43 }`);

        // ── S4 Control ─────────────────────────────────────────────────
        const savedHold = await adapter.saveDefinition({
            ownerSessionId: owner.sessionId,
            name: holdName,
            yaml: holdYaml(holdName),
            operationId: op("save-hold-1"),
        });
        assert.equal(savedHold?.revision, 1, `${prefix} S4: hold definition saved`);

        const startedHold = await adapter.startDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: savedHold.definitionId,
            name: holdName,
            vars: { stage: "initial" },
            notifyParent: false,
            workspace: "none",
            operationId: op("start-hold"),
        });
        assert.ok(startedHold?.workflowId, `${prefix} S4: hold workflowId`);
        sessionsToClean.add(startedHold.workflowId);

        const activeHold = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "running" ? view : null;
        }, `${prefix} S4 hold run active`, { timeoutMs });

        const initialKvRev = activeHold.run.kvRevision;
        assert.ok(Number.isInteger(initialKvRev) && initialKvRev >= 1, `${prefix} S4: initial kvRevision >= 1`);
        assert.deepEqual(parseJsonField(activeHold.run.kv), { stage: "initial" }, `${prefix} S4: initial kv`);

        const pausedReceipt = await adapter.updateWorkflow(startedHold.workflowId, {
            operation: "pause",
            operation_id: op("pause-hold"),
            reason: "scenario-pause",
        });
        assert.equal(pausedReceipt?.status, "paused", `${prefix} S4: pause receipt status`);
        await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "paused" ? view : null;
        }, `${prefix} S4 hold paused`, { timeoutMs });

        const resumedReceipt = await adapter.updateWorkflow(startedHold.workflowId, {
            operation: "resume",
            operation_id: op("resume-hold"),
        });
        assert.equal(resumedReceipt?.status, "running", `${prefix} S4: resume receipt status`);
        await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "running" ? view : null;
        }, `${prefix} S4 hold resumed`, { timeoutMs });

        const setVarsReceipt = await adapter.updateWorkflow(startedHold.workflowId, {
            operation: "set_vars",
            operation_id: op("set-vars-hold"),
            expected_kv_revision: initialKvRev,
            set: { stage: "updated", count: 42 },
        });
        const nextKvRev = initialKvRev + 1;
        assert.equal(setVarsReceipt?.kvRevision, nextKvRev, `${prefix} S4: set_vars bumped kvRevision`);

        const afterVarsView = await adapter.readWorkflow(startedHold.workflowId);
        assert.equal(afterVarsView?.run?.kvRevision, nextKvRev, `${prefix} S4: read reflects new kvRevision`);
        assert.deepEqual(parseJsonField(afterVarsView?.run?.kv), { stage: "updated", count: 42 },
            `${prefix} S4: set_vars values read back`);

        const kvKeyView = await adapter.readWorkflow(startedHold.workflowId, { kvRevision: nextKvRev, kvKey: "stage" });
        assert.equal(kvKeyView?.kv?.revision, nextKvRev, `${prefix} S4: kv_revision read`);
        assert.equal(kvKeyView?.kv?.present, true, `${prefix} S4: kv_key present`);
        assert.equal(kvKeyView?.kv?.value, "updated", `${prefix} S4: kv_key value`);

        const cancelReason = `scenario-cancel-${prefix}`;
        const cancelledReceipt = await adapter.updateWorkflow(startedHold.workflowId, {
            operation: "cancel",
            operation_id: op("cancel-hold"),
            reason: cancelReason,
        });
        assert.equal(cancelledReceipt?.status, "cancelled", `${prefix} S4: cancel receipt status`);

        const cancelledView = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "cancelled" ? view : null;
        }, `${prefix} S4 hold cancelled`, { timeoutMs });
        assert.equal(cancelledView.run.lastControl?.operation, "cancel", `${prefix} S4: lastControl operation`);
        assert.equal(cancelledView.run.lastControl?.reason, cancelReason, `${prefix} S4: lastControl reason`);

        // ── S4b Send typed input to waiting receive step ───────────────
        const savedReceive = await adapter.saveDefinition({
            ownerSessionId: owner.sessionId,
            name: receiveName,
            yaml: receiveYaml(receiveName),
            operationId: op("save-receive-1"),
        });
        assert.equal(savedReceive?.revision, 1, `${prefix} S4b: receive definition saved`);

        const startedReceive = await adapter.startDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: savedReceive.definitionId,
            name: receiveName,
            inputs: { ticketId: `CHG-${tag}` },
            notifyParent: false,
            workspace: "none",
            operationId: op("start-receive"),
        });
        assert.ok(startedReceive?.workflowId, `${prefix} S4b: receive workflowId`);
        sessionsToClean.add(startedReceive.workflowId);

        await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedReceive.workflowId);
            const execs = view?.run?.nodeExecutions ?? [];
            return execs.find((n) => n.stateId === "await_signal" && n.state === "pending") ?? null;
        }, `${prefix} S4b await_signal pending`, { timeoutMs });

        const sendPayload = { approvedBy: "surface-tester", slot: "westus2" };
        const sendReq = {
            contract: "DeploySignal@1",
            payload: sendPayload,
            correlation: { ticketId: `CHG-${tag}` },
            operationId: op("send-input-1"),
        };
        const sentReceipt = await adapter.sendWorkflowInput(startedReceive.workflowId, sendReq);
        assert.equal(sentReceipt?.replayed, false, `${prefix} S4b: initial send not replayed`);
        assert.equal(sentReceipt?.workflowId, startedReceive.workflowId, `${prefix} S4b: receipt workflowId`);
        assert.equal(sentReceipt?.claimedBy?.stateId, "await_signal", `${prefix} S4b: claimed await_signal`);
        assert.match(String(sentReceipt?.senderSessionId ?? ""), /^person:/, `${prefix} S4b: canonical person sender`);

        const replayedReceipt = await adapter.sendWorkflowInput(startedReceive.workflowId, sendReq);
        assert.equal(replayedReceipt?.replayed, true, `${prefix} S4b: idempotent replay`);
        assert.equal(replayedReceipt?.messageId, sentReceipt.messageId, `${prefix} S4b: replay preserves messageId`);

        const completedReceive = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedReceive.workflowId);
            return TERMINAL_STATUSES.has(view?.run?.status) ? view : null;
        }, `${prefix} S4b receive run completion`, { timeoutMs });
        assert.equal(completedReceive.run.status, "completed", `${prefix} S4b: receive run status completed`);
        assert.equal(completedReceive.run.outcome, "succeeded", `${prefix} S4b: receive run outcome succeeded`);
        assert.deepEqual(parseJsonField(completedReceive.run.output), sendPayload, `${prefix} S4b: receive output matches sent payload`);

        // ── S5 Packages ────────────────────────────────────────────────
        await adapter.publishPackage(pkgName, makeTestPackageFiles(pkgName, pkgWfName));
        pkgActive = true;

        const creatable = await adapter.listCreatableWorkflows();
        const pkgEntry = creatable.find((w) => w.ref === pkgRef);
        assert.ok(pkgEntry, `${prefix} S5: published package workflow listed in creatable workflows`);
        assert.equal(pkgEntry.package, pkgName, `${prefix} S5: creatable package name`);
        assert.equal(pkgEntry.name, pkgWfName, `${prefix} S5: creatable workflow name`);
        assert.equal(pkgEntry.semver, "1.0.0", `${prefix} S5: creatable semver`);

        const cardBeforeAttach = await adapter.readPackageCard({ ownerSessionId: owner.sessionId, name: pkgRef });
        assert.equal(cardBeforeAttach?.name, pkgRef, `${prefix} S5: card ref`);
        assert.equal(cardBeforeAttach?.package, pkgName, `${prefix} S5: card package`);
        assert.equal(cardBeforeAttach?.version, "1.0.0", `${prefix} S5: card version`);
        assert.equal(cardBeforeAttach?.attached, false, `${prefix} S5: card not attached on plain owner`);
        assert.ok(typeof cardBeforeAttach?.card === "string" && cardBeforeAttach.card.includes("Echoes input text"),
            `${prefix} S5: card body populated`);

        const coord = await adapter.createSessionForWorkflow(pkgRef);
        assert.ok(typeof coord?.sessionId === "string" && coord.sessionId.length > 0,
            `${prefix} S5: coordinating session created`);
        assert.equal(coord.workflowRef, pkgRef, `${prefix} S5: coordinating session workflowRef`);
        assert.ok(typeof coord.title === "string" && coord.title.includes(pkgWfName),
            `${prefix} S5: coordinating session title`);
        sessionsToClean.add(coord.sessionId);

        if (adapter.verifySessionKind) {
            await adapter.verifySessionKind(coord.sessionId, "agent");
        }

        const cardOnCoord = await adapter.readPackageCard({ ownerSessionId: coord.sessionId, name: pkgRef });
        assert.equal(cardOnCoord?.attached, true, `${prefix} S5: package attached on coordinating session`);

        const copied = await adapter.copyDefinition({
            ownerSessionId: coord.sessionId,
            name: pkgRef,
            operationId: op("copy-pkg"),
        });
        assert.equal(copied?.name, pkgWfName, `${prefix} S5: copied definition name`);
        assert.equal(copied?.revision, 1, `${prefix} S5: copied definition revision 1`);
        assert.equal(copied?.valid, true, `${prefix} S5: copied definition valid`);

        const coordDefs = await adapter.listDefinitions(coord.sessionId);
        const copiedRow = coordDefs.find((d) => d.name === pkgWfName && d.definitionId === copied.definitionId);
        assert.ok(copiedRow, `${prefix} S5: copied definition appears in owner session list`);
        assert.equal(copiedRow.locked, false, `${prefix} S5: copied definition is editable (unlocked)`);

        // ── S6 Clean up ────────────────────────────────────────────────
        const delCompute = await adapter.deleteDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: saved1.definitionId,
            name: computeName,
            operationId: op("del-compute"),
        });
        assert.equal(delCompute?.definitionId, saved1.definitionId, `${prefix} S6: deleted compute definitionId`);

        const delHold = await adapter.deleteDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: savedHold.definitionId,
            name: holdName,
            operationId: op("del-hold"),
        });
        assert.equal(delHold?.definitionId, savedHold.definitionId, `${prefix} S6: deleted hold definitionId`);

        const delReceive = await adapter.deleteDefinition({
            ownerSessionId: owner.sessionId,
            definitionId: savedReceive.definitionId,
            name: receiveName,
            operationId: op("del-receive"),
        });
        assert.equal(delReceive?.definitionId, savedReceive.definitionId, `${prefix} S6: deleted receive definitionId`);

        const remaining = await adapter.listDefinitions(owner.sessionId);
        assert.equal(remaining.some((d) => d.definitionId === saved1.definitionId || d.name === computeName), false,
            `${prefix} S6: compute definition gone from list`);
        assert.equal(remaining.some((d) => d.definitionId === savedHold.definitionId || d.name === holdName), false,
            `${prefix} S6: hold definition gone from list`);
        assert.equal(remaining.some((d) => d.definitionId === savedReceive.definitionId || d.name === receiveName), false,
            `${prefix} S6: receive definition gone from list`);

        await adapter.deletePackage(pkgName);
        pkgActive = false;
        const creatableAfterDelete = await adapter.listCreatableWorkflows();
        assert.equal(creatableAfterDelete.some((w) => w.ref === pkgRef), false,
            `${prefix} S6: deleted package gone from creatable workflows`);

        for (const sid of [...sessionsToClean].reverse()) {
            await adapter.deleteSession(sid);
            sessionsToClean.delete(sid);
        }

        return { steps: ["S1", "S2", "S3", "S4", "S4b", "S5", "S6"] };
    } finally {
        for (const sid of [...sessionsToClean].reverse()) {
            await adapter.deleteSession(sid).catch(() => {});
        }
        if (pkgActive) {
            await adapter.deletePackage(pkgName).catch(() => {});
        }
    }
}
