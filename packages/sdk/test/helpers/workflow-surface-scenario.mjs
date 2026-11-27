/**
 * Shared happy-path scenario for PilotSwarm Workflows across every public API surface:
 *   - SDK direct (`PilotSwarmManagementClient`)
 *   - Web API (`WebPilotSwarmManagementClient` against a real local portal server)
 *   - MCP (`pilotswarm-mcp` binary over `StdioClientTransport`)
 *
 * Uses only model-free states (`script`, `wait`, `terminal`) so every run is
 * deterministic and requires no LLM credentials. Every definition name is
 * prefixed per surface so names stay distinct across surfaces.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);

function computeYaml(name, { version, rev, expr }) {
    return [
        "apiVersion: pilotswarm.dev/v1",
        "kind: Workflow",
        "metadata:",
        `  name: ${name}`,
        `  version: "${version}"`,
        "inputs:",
        "  schema:",
        "    type: object",
        "    required: [a, b]",
        "    properties:",
        "      a: { type: number }",
        "      b: { type: number }",
        "    additionalProperties: false",
        "initial: compute",
        "states:",
        "  compute:",
        "    type: script",
        "    outcomes: [ok]",
        "    source: |",
        `      await setResult("ok", { rev: ${rev}, total: ${expr} });`,
        "    transition:",
        "      next:",
        "        ok: done",
        "        failure: failed",
        "  done:",
        "    type: terminal",
        "    outcome: succeeded",
        '    output: "${input}"',
        "  failed:",
        "    type: terminal",
        "    outcome: failed",
        '    output: "${runtime.error}"',
        "",
    ].join("\n");
}

export const computeYamlV1 = (name) =>
    computeYaml(name, { version: "1.0.0", rev: 1, expr: "Number(context.inputs.a) + Number(context.inputs.b)" });

export const computeYamlV2 = (name) =>
    computeYaml(name, { version: "1.0.1", rev: 2, expr: "Number(context.inputs.a) * Number(context.inputs.b) + 1" });

export function holdYaml(name) {
    return [
        "apiVersion: pilotswarm.dev/v1",
        "kind: Workflow",
        "metadata:",
        `  name: ${name}`,
        '  version: "1.0.0"',
        "initial: hold",
        "states:",
        "  hold:",
        "    type: wait",
        "    seconds: 300",
        "    transition:",
        "      next:",
        "        elapsed: done",
        "  done:",
        "    type: terminal",
        "    outcome: succeeded",
        "    output: { ok: true }",
        "",
    ].join("\n");
}

export function makeTestPackageFiles(pkgName, workflowName) {
    const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
    const yaml = [
        "apiVersion: pilotswarm.dev/v1",
        "kind: Workflow",
        "metadata:",
        `  name: ${workflowName}`,
        '  version: "1.0.0"',
        "inputs:",
        "  schema:",
        "    type: object",
        "    required: [text]",
        "    properties:",
        "      text: { type: string }",
        "    additionalProperties: false",
        "initial: emit",
        "states:",
        "  emit:",
        "    type: script",
        "    outcomes: [ok]",
        "    source: |",
        '      await setResult("ok", { echoed: String(context.inputs.text ?? "") });',
        "    transition:",
        "      next:",
        "        ok: done",
        "        failure: failed",
        "  done:",
        "    type: terminal",
        "    outcome: succeeded",
        '    output: "${input}"',
        "  failed:",
        "    type: terminal",
        "    outcome: failed",
        '    output: "${runtime.error}"',
        "",
    ].join("\n");
    const card = [
        "---",
        `name: ${workflowName}`,
        "description: Echoes input text through a deterministic script workflow.",
        "whenToUse: Verifying packaged Workflow discovery, cards, and copy on a public surface.",
        "inputs:",
        "  example: { text: hello }",
        "outcomes:",
        "  done: Echoed the text.",
        "  failed: Failed to run.",
        "output: Object containing echoed text.",
        "effects: Pure script step with no external calls.",
        "---",
        "Ask the caller for text, then start the workflow.",
        "",
    ].join("\n");
    return [
        { path: "plugin.json", contentBase64: b64(JSON.stringify({ name: pkgName, version: "1.0.0", description: `Surface scenario package (${pkgName})` })) },
        { path: `workflows/${workflowName}/workflow.yaml`, contentBase64: b64(yaml) },
        { path: `workflows/${workflowName}/card.md`, contentBase64: b64(card) },
    ];
}

function parseJsonField(value) {
    if (typeof value === "string") return JSON.parse(value);
    return value;
}

export async function waitUntil(check, label, { timeoutMs = 60_000, intervalMs = 200 } = {}) {
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
 * Execute the S1–S6 Workflow happy-path scenario against one surface adapter.
 *
 * Adapter methods:
 *   getWorkflowCapabilities()
 *   listWorkflowSkills()
 *   readWorkflowSkill(name)
 *   createOwnerSession(title)                                  -> { sessionId }
 *   validateDefinition(yaml)
 *   saveDefinition({ ownerSessionId, name, yaml, definitionId?, expectedRevision?, operationId })
 *   listDefinitions(ownerSessionId)                            -> array of definitions
 *   readDefinition({ ownerSessionId, definitionId?, name?, revision? })
 *   startDefinition({ ownerSessionId, definitionId?, name?, revision?, inputs?, vars?, workspace, operationId })
 *   readWorkflow(workflowId, options?)
 *   updateWorkflow(workflowId, command)
 *   deleteDefinition({ ownerSessionId, definitionId?, name?, operationId })
 *   publishPackage(pkgName, files)
 *   deletePackage(pkgName)
 *   listCreatableWorkflows()                                   -> array of creatable workflows
 *   readPackageCard({ ownerSessionId, name })
 *   createSessionForWorkflow(ref)                              -> { sessionId, workflowRef, title }
 *   copyDefinition({ ownerSessionId, name, definitionId?, operationId })
 *   deleteSession(sessionId)
 *   verifySessionKind?(sessionId, expectedKind)                // optional surface check
 */
export async function runWorkflowSurfaceScenario(adapter, { prefix, timeoutMs = 60_000 }) {
    const tag = randomBytes(4).toString("hex");
    const computeName = `${prefix}-compute`;
    const holdName = `${prefix}-hold`;
    const pkgWfName = `${prefix}-pkg-echo`;
    const pkgName = `${prefix}-pkg-${tag}`;
    const pkgRef = `${pkgName}/${pkgWfName}`;
    const op = (step) => `${prefix}-${tag}-${step}`;

    const sessionsToClean = [];
    let pkgPublished = false;

    try {
        // ── S1 Discover ────────────────────────────────────────────────
        const caps = await adapter.getWorkflowCapabilities();
        assert.equal(caps?.enabled, true, `${prefix} S1: workflows.enabled`);
        assert.equal(caps?.read, true, `${prefix} S1: workflows.read`);
        assert.equal(caps?.validate, true, `${prefix} S1: workflows.validate`);
        assert.equal(caps?.skills, true, `${prefix} S1: workflows.skills`);
        assert.equal(caps?.card, true, `${prefix} S1: workflows.card`);
        assert.equal(caps?.commands?.available, true, `${prefix} S1: workflows.commands.available`);

        const skillList = await adapter.listWorkflowSkills();
        const skills = Array.isArray(skillList?.skills) ? skillList.skills : [];
        assert.ok(skills.length > 0, `${prefix} S1: workflow skills list non-empty`);
        const authoringEntry = skills.find((s) => s.name === "workflow-authoring");
        assert.ok(authoringEntry, `${prefix} S1: workflow-authoring listed`);
        assert.ok(typeof authoringEntry.description === "string" && authoringEntry.description.length > 0,
            `${prefix} S1: workflow-authoring has description`);

        const authoringSkill = await adapter.readWorkflowSkill("workflow-authoring");
        assert.equal(authoringSkill?.name, "workflow-authoring", `${prefix} S1: skill name`);
        assert.ok(typeof authoringSkill?.content === "string" && authoringSkill.content.length > 200,
            `${prefix} S1: skill content populated`);

        // ── S2 Author ──────────────────────────────────────────────────
        const owner = await adapter.createOwnerSession(`${prefix}-wf-owner-${tag}`);
        assert.ok(typeof owner?.sessionId === "string" && owner.sessionId.length > 0, `${prefix} S2: owner session created`);
        sessionsToClean.push(owner.sessionId);

        const v1Yaml = computeYamlV1(computeName);
        const v2Yaml = computeYamlV2(computeName);

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
            workspace: "none",
            operationId: op("start-compute"),
        });
        assert.ok(typeof startedCompute?.workflowId === "string" && startedCompute.workflowId.length > 0,
            `${prefix} S3: workflowId returned`);
        assert.equal(startedCompute.revision, 2, `${prefix} S3: started revision 2`);
        sessionsToClean.push(startedCompute.workflowId);

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
            workspace: "none",
            operationId: op("start-hold"),
        });
        assert.ok(startedHold?.workflowId, `${prefix} S4: hold workflowId`);
        sessionsToClean.push(startedHold.workflowId);

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
        const pausedView = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "paused" ? view : null;
        }, `${prefix} S4 hold paused`, { timeoutMs });
        assert.equal(pausedView.run.status, "paused", `${prefix} S4: read shows paused`);

        const resumedReceipt = await adapter.updateWorkflow(startedHold.workflowId, {
            operation: "resume",
            operation_id: op("resume-hold"),
        });
        assert.equal(resumedReceipt?.status, "running", `${prefix} S4: resume receipt status`);
        const resumedView = await waitUntil(async () => {
            const view = await adapter.readWorkflow(startedHold.workflowId);
            return view?.run?.status === "running" ? view : null;
        }, `${prefix} S4 hold resumed`, { timeoutMs });
        assert.equal(resumedView.run.status, "running", `${prefix} S4: read shows running after resume`);

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
        assert.equal(cancelledView.run.status, "cancelled", `${prefix} S4: read shows cancelled`);
        assert.equal(cancelledView.run.lastControl?.operation, "cancel", `${prefix} S4: lastControl operation`);
        assert.equal(cancelledView.run.lastControl?.reason, cancelReason, `${prefix} S4: lastControl reason`);

        // ── S5 Packages ────────────────────────────────────────────────
        await adapter.publishPackage(pkgName, makeTestPackageFiles(pkgName, pkgWfName));
        pkgPublished = true;

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
        assert.ok(typeof cardBeforeAttach?.card === "string" && cardBeforeAttach.card.includes(pkgWfName),
            `${prefix} S5: card text populated`);

        const coord = await adapter.createSessionForWorkflow(pkgRef);
        assert.ok(typeof coord?.sessionId === "string" && coord.sessionId.length > 0,
            `${prefix} S5: coordinating session created`);
        assert.equal(coord.workflowRef, pkgRef, `${prefix} S5: coordinating session workflowRef`);
        assert.ok(typeof coord.title === "string" && coord.title.includes(pkgWfName),
            `${prefix} S5: coordinating session title`);
        sessionsToClean.push(coord.sessionId);

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

        const remaining = await adapter.listDefinitions(owner.sessionId);
        assert.equal(remaining.some((d) => d.definitionId === saved1.definitionId || d.name === computeName), false,
            `${prefix} S6: compute definition gone from list`);
        assert.equal(remaining.some((d) => d.definitionId === savedHold.definitionId || d.name === holdName), false,
            `${prefix} S6: hold definition gone from list`);

        return {
            steps: ["S1", "S2", "S3", "S4", "S5", "S6"],
            computeWorkflowId: startedCompute.workflowId,
            holdWorkflowId: startedHold.workflowId,
            coordSessionId: coord.sessionId,
        };
    } finally {
        for (const sid of [...sessionsToClean].reverse()) {
            await adapter.deleteSession(sid).catch(() => {});
        }
        if (pkgPublished) {
            await adapter.deletePackage(pkgName).catch(() => {});
        }
    }
}
