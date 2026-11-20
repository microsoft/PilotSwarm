import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

test("Decision operator and release docs cover migrations, catalog activation, upgrade and rollback", () => {
    const changelog = read("CHANGELOG.md");
    for (const required of ["0097", "0098", "0099", "0100", "decisionModels", "Cluster Decision Default", "Upgrade:", "Rollback:"]) {
        assert.ok(changelog.includes(required), `CHANGELOG is missing ${required}`);
    }
    const config = read("docs/developer/reference/configuration.md");
    for (const required of ["decisionModels", "Cluster Decision Default", "upgrade", "rollback"]) {
        assert.ok(new RegExp(required, "i").test(config), `configuration guide is missing ${required}`);
    }
    const proposal = read("docs/proposals/workflow-decision-node.md");
    for (const required of ["0097", "0098", "0099", "0100", "Operator rollout", "Rollback"]) {
        assert.ok(proposal.includes(required), `proposal is missing ${required}`);
    }
});

test("Decision model maps are documented on every public Start surface", () => {
    const api = read("docs/api/reference.md");
    const guide = read("docs/user-guide/workflows.md");
    const system = read("docs/architecture/system-reference.md");
    assert.match(api, /startSessionWorkflowDefinition[\s\S]*decisionModels/);
    assert.match(guide, /startSessionWorkflowDefinition[\s\S]*decisionModels/);
    assert.match(guide, /`start`[\s\S]*`decision_models`/);
    assert.match(system, /`workflow_definition`[\s\S]*decision_models/);
    assert.match(guide, /`decision_models`[\s\S]*`decisionModels`/);
});

test("qualification stays NOT_RUN and fixtures are called synthetic, never real or live PASS", () => {
    const proposal = read("docs/proposals/workflow-decision-node.md");
    const review = read("docs/proposals/workflow-decision-node/formal/decision-node-completion-model-v10-review.md");
    const providerTest = read("packages/sdk/test/unit/workflow-decision-provider.test.mjs");
    const runtimeTest = read("packages/sdk/test/unit/workflow-decision-runtime.test.mjs");
    assert.match(proposal, /Status:\s*\*\*IMPLEMENTED\*\*/);
    assert.match(proposal, /TLC: `NOT_RUN`/);
    assert.match(proposal, /Live Microsoft qualification:\s*`NOT_RUN`/);
    assert.match(review, /Live Microsoft qualification:\s*\*\*NOT_RUN\*\*/);
    assert.doesNotMatch(proposal, /pinned real Microsoft response fixture/i);
    assert.match(proposal, /synthetic Microsoft-shaped response fixture/i);
    assert.match(providerTest, /synthetic|injected fetch fixture/i);
    assert.match(runtimeTest, /synthetic/i);
    assert.doesNotMatch(`${proposal}\n${review}`, /live Microsoft[^\n]*PASS/i);
});
