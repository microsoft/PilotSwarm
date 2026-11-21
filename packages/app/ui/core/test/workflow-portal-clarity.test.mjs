import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appReducer, createInitialState } from "../src/index.js";
import { selectWorkflowTabContext } from "../src/workflow-owner.js";
import { sessionDefinitionChoice, sessionDefinitionReadKey, sessionDefinitionsModel } from "../src/workflow-session-definitions.js";
import { workflowRunControls } from "../src/workflow-commands.js";
import { SessionWorkflowTab } from "../../react/src/workflow-session-tab.js";
import { readModel, row, states } from "./workflow-fixtures.mjs";

const OWNER = "chat";
const WORKFLOW = "wf-1";
const DEFINITION = "def-watch";
const AT = "2026-11-12T03:00:00.000Z";
const DEFINITIONS = sessionDefinitionsModel([{
    definitionId: DEFINITION, ownerSessionId: OWNER, name: "watch-flow", source: "session", currentRevision: 1, newestValidRevision: 1,
    createdAt: AT, updatedAt: AT, deletedAt: null,
    revisions: [{ definitionId: DEFINITION, revision: 1, valid: true, semver: "1.0.0", createdAt: AT, errorCount: 0 }],
    workflows: [{ workflowSessionId: WORKFLOW, definitionId: DEFINITION, revision: 1, runStatus: "paused", createdAt: AT }],
}]);
const revisionValue = yaml => ({
    definition: { definitionId: DEFINITION, name: "watch-flow" },
    revision: { revision: 1, valid: true, yaml, diagnostics: [] },
    graph: { revision: 1, initial: "poll", states },
    viewer: { allowed: yaml !== null, reason: yaml === null ? "Read-only access." : null },
    personCommands: true,
});
const ready = yaml => ({ phase: "ready", value: revisionValue(yaml) });

function harness({ direct = false, tab = {}, read = ready(null), model = null } = {}) {
    let state = createInitialState({ mode: "api" });
    const dispatch = action => { state = appReducer(state, action); };
    dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: OWNER, title: "Owner session", status: "idle", createdAt: AT, updatedAt: AT },
        { sessionId: WORKFLOW, title: "Workflow: watch-flow", sessionKind: "workflow", parentSessionId: OWNER, status: "waiting", createdAt: AT, updatedAt: AT },
    ] });
    dispatch({ type: "sessions/selected", sessionId: direct ? WORKFLOW : OWNER });
    dispatch({ type: "ui/workflowTab", ownerId: OWNER, patch: { sessionDefinitionId: DEFINITION, view: direct ? "workflows" : "definition", ...tab } });
    if (read) dispatch({ type: "ui/sessionDefinitionRead", ownerId: OWNER, key: sessionDefinitionReadKey(DEFINITION, 1), entry: read });
    if (model) dispatch({ type: "ui/workflowView", sessionId: WORKFLOW, view: { readModel: model } });
    return { getState: () => state, subscribe: () => () => {}, dispatch };
}

function render(controller, phone) {
    const previous = globalThis.window;
    if (phone) globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    try {
        return renderToStaticMarkup(React.createElement(SessionWorkflowTab, { controller, mobile: phone,
            context: selectWorkflowTabContext(controller.getState()), definitions: DEFINITIONS }));
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
}
const yamlButton = html => html.match(/<button[^>]*aria-label="YAML"[^>]*>/)?.[0] ?? "";

for (const phone of [false, true]) {
    const device = phone ? "phone" : "desktop";
    test(`${device}: a reader's saved YAML preference cannot hide the graph behind a redacted YAML view`, () => {
        const html = render(harness({ tab: { sessionYaml: true } }), phone);
        assert.match(yamlButton(html), /aria-disabled="true"/);
        assert.match(yamlButton(html), /aria-pressed="false"/);
        assert.match(html, /Only this session&#x27;s owner or an admin can read the YAML/);
        assert.match(html, /aria-label="Workflow graph"/);
        assert.doesNotMatch(html, /class="ps-wf-main ps-wf-yaml"/);
    });

    test(`${device}: current YAML access preserves the owner's YAML preference`, () => {
        const html = render(harness({ tab: { sessionYaml: true }, read: ready("apiVersion: pilotswarm.dev/v1\n") }), phone);
        assert.doesNotMatch(yamlButton(html), /aria-disabled="true"/);
        assert.match(yamlButton(html), /aria-pressed="true"/);
        assert.match(html, /class="ps-wf-main ps-wf-yaml"/);
    });

    test(`${device}: missing, loading and failed reads never enable YAML, even if a stale value exists`, () => {
        for (const read of [null, { phase: "loading", value: revisionValue("private") }, { phase: "failed", error: "unavailable", value: revisionValue("private") }]) {
            const html = render(harness({ tab: { sessionYaml: true }, read }), phone);
            assert.match(yamlButton(html), /aria-disabled="true"/);
            assert.doesNotMatch(html, /class="ps-wf-main ps-wf-yaml"/);
        }
    });

    test(`${device}: a direct run has a return path to this definition's runs in its owning session`, () => {
        const controller = harness({ direct: true, tab: { workflowId: WORKFLOW } });
        assert.match(render(controller, phone), /data-action="back-to-workflows"[^>]*>Back to Workflows<\/button>/);
        const choice = sessionDefinitionChoice(DEFINITION, { workflowShown: true, view: "workflows" });
        controller.dispatch({ type: "ui/workflowTab", ownerId: OWNER, patch: choice.patch });
        assert.equal(choice.selectOwner, true);
        controller.dispatch({ type: "sessions/selected", sessionId: OWNER });
        assert.equal(selectWorkflowTabContext(controller.getState()).workflowId, null);
        const list = render(controller, phone);
        assert.match(list, /data-definition-id="def-watch"/);
        assert.doesNotMatch(list, /data-action="back-to-workflows"/);
        assert.match(list, /Workflows/);
    });

    test(`${device}: a paused run keeps pending wait/receive facts and allows Resume without waiting for them`, () => {
        const model = readModel({
            run: { status: "paused", pausedFrom: "running", pauseSettled: false },
            nodeExecutions: [row("pause", 1, "pending", { deadline: "2026-12-01T12:00:00.000Z" }), row("await_ack", 1, "pending")],
        });
        model.personCommands = { operations: ["pause", "resume", "stop", "cancel"], viewer: { allowed: true } };
        const html = render(harness({ direct: true, model }), phone);
        assert.match(html, />Paused<\/span>/);
        assert.match(html, /Started work and timers continue/);
        assert.match(html, /aria-label="Resume"/);
        assert.doesNotMatch(html, />Pausing<\/span>/);
        assert.equal(model.run.pauseSettled, false);
        assert.equal(model.run.nodeExecutions[0].deadline, "2026-12-01T12:00:00.000Z");
        assert.equal(workflowRunControls(model).controls.find(item => item.operation === "resume").enabled, true);
    });
}
