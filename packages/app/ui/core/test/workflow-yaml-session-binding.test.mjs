/**
 * Adversarial review UI-1: switching from workflow A to workflow B must never start B's YAML editor with A's text, or
 * save A's text into B. The workflow screen reads the active session's id, row, history, view and step places
 * in one selector from one state, and the YAML editor's buffer is bound to its session: a model or a kept edit of
 * another session is not taken, and nothing of another session is saved.
 *
 * Run: node --test test/workflow-yaml-session-binding.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EMPTY_WORKFLOW_VIEW, selectWorkflowViewSnapshot, workflowViewSnapshotEqual } from "../src/workflow-v2-view.js";
import { WorkflowV2DraftEditor } from "../../react/src/workflow-v2-panels.js";

const A = "wf-a";
const B = "wf-b";
const YAML_A = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: a, version: 1.0.0 }\n# A\n";
const YAML_B = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: b, version: 1.0.0 }\n# B\n";

function stateWith(active) {
    const sessions = { [A]: { sessionId: A, title: "Workflow: a" }, [B]: { sessionId: B, title: "Workflow: b" } };
    return {
        sessions: { activeSessionId: active, byId: sessions },
        history: { bySessionId: new Map([[A, { events: ["a"] }], [B, { events: ["b"] }]]) },
        ui: {
            workflowViews: { [A]: { mainTab: "yaml", readModel: { yaml: YAML_A } }, [B]: { mainTab: "yaml", readModel: { yaml: YAML_B } } },
            workflowLayouts: { [`session:${A}`]: { at: 1, steps: { s: [1, 1] } }, [`session:${B}`]: { at: 2, steps: { s: [2, 2] } } },
        },
    };
}

test("one snapshot: every part is the active session's, from the same state", () => {
    for (const [active, other] of [[A, B], [B, A]]) {
        const state = stateWith(active);
        const snapshot = selectWorkflowViewSnapshot(state);
        assert.equal(snapshot.sessionId, active);
        assert.equal(snapshot.session, state.sessions.byId[active]);
        assert.equal(snapshot.history, state.history.bySessionId.get(active));
        assert.equal(snapshot.view, state.ui.workflowViews[active]);
        assert.equal(snapshot.places, state.ui.workflowLayouts[`session:${active}`].steps);
        assert.notEqual(snapshot.view, state.ui.workflowViews[other]);
    }
});

test("a session with nothing read yet has the one empty view and no places; no session selects nothing", () => {
    const state = stateWith("wf-new");
    const snapshot = selectWorkflowViewSnapshot(state);
    assert.equal(snapshot.view, EMPTY_WORKFLOW_VIEW);
    assert.equal(snapshot.places, null);
    assert.equal(snapshot.session, undefined);
    assert.equal(selectWorkflowViewSnapshot({ sessions: { activeSessionId: null, byId: {} } }).sessionId, null);
});

test("snapshots compare equal only when every part is the same object", () => {
    const state = stateWith(A);
    const one = selectWorkflowViewSnapshot(state);
    assert.ok(workflowViewSnapshotEqual(one, selectWorkflowViewSnapshot(state)), "the same state selects equal snapshots");
    assert.ok(!workflowViewSnapshotEqual(one, selectWorkflowViewSnapshot(stateWith(B))));
    const moved = { ...state, ui: { ...state.ui, workflowViews: { ...state.ui.workflowViews, [A]: { ...state.ui.workflowViews[A] } } } };
    assert.ok(!workflowViewSnapshotEqual(one, selectWorkflowViewSnapshot(moved)));
});

const editorModel = (sessionId, yaml, revision = 1) => ({ sessionId, revision, definitionHash: `hash-${sessionId}`, yaml, semver: "1.0.0", current: true,
    busy: false, pending: false, diagnostics: [] });
const render = props => renderToStaticMarkup(React.createElement(WorkflowV2DraftEditor, { controller: { dispatch() {}, sendWorkflowRunCommand() { throw new Error("no save"); } }, ...props }));

test("the editor takes only its own session's model: another session's (same revision) renders nothing", () => {
    const own = render({ sessionId: B, model: editorModel(B, YAML_B) });
    assert.match(own, /# B/);
    assert.doesNotMatch(own, /# A/);
    // B's editor handed A's model, at the same revision number, as one render with a stale view would: nothing is shown.
    assert.equal(render({ sessionId: B, model: editorModel(A, YAML_A) }), "");
    // A model that names no session is not taken either.
    const { sessionId: _, ...unnamed } = editorModel(B, YAML_B);
    assert.equal(render({ sessionId: B, model: unnamed }), "");
});

test("a kept edit is restored only into its own session's editor", () => {
    const keptA = { sessionId: A, base: { sessionId: A, revision: 1, yaml: YAML_A }, text: `${YAML_A}# edited in A\n` };
    const intoB = render({ sessionId: B, model: editorModel(B, YAML_B), savedEdit: keptA });
    assert.match(intoB, /# B/);
    assert.doesNotMatch(intoB, /edited in A/);
    const intoA = render({ sessionId: A, model: editorModel(A, YAML_A), savedEdit: keptA });
    assert.match(intoA, /edited in A/);
    // A kept edit that does not say whose it is (an older build's) is not restored.
    const unnamed = { base: { revision: 1, yaml: YAML_A }, text: `${YAML_A}# unnamed\n` };
    assert.doesNotMatch(render({ sessionId: A, model: editorModel(A, YAML_A), savedEdit: unnamed }), /# unnamed/);
});
