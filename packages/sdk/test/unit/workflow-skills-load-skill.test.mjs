/**
 * The Workflow authoring skills reach `load_skill` on every worker.
 *
 * A Base V2 session's `load_skill` catalog, its skills index and
 * `search_capabilities` read only capability sources. The worker loads the
 * Workflow skills (plugins/workflow-v2/skills, and workflow-testing with test
 * mode on) from an SDK directory rather than a plugin directory, so they must
 * also come as a static capability source; otherwise a V2 chat that follows
 * the guidance ("load the `workflow-authoring` skill") is told no such skill
 * exists. A V1 session reads the worker's shared skill list and must keep
 * them too.
 *
 * Run: node --test test/unit/workflow-skills-load-skill.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { CapabilityCatalog, ownedAndStaticCapabilityInventory } from "../../dist/capability-catalog.js";

const WORKFLOW_SKILLS = ["workflow-authoring", "workflow-patterns", "workflow-reference"];

function defaultWorker(t, testMode) {
    const previous = process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    if (testMode) process.env.PILOTSWARM_WORKFLOW_TEST_MODE = "on";
    else delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    t.after(() => {
        if (previous === undefined) delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
        else process.env.PILOTSWARM_WORKFLOW_TEST_MODE = previous;
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wf-skills-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    return new PilotSwarmWorker({ sessionStateDir: path.join(stateDir, "session-state"), workerNodeId: "test-wf-skills" });
}

async function catalogFor(worker, sessionId, version) {
    const manager = worker.sessionManager;
    manager.sessionConfigs.set(sessionId, { baseAgentPolicy: { version } });
    // null: an ownerless session, which sees deployment (static) skills only.
    return (await manager._skillCatalogForSession(sessionId, null)).map((skill) => skill.name);
}

test("a Base V2 session on a default worker can load every Workflow skill", async (t) => {
    const worker = defaultWorker(t, false);
    const names = await catalogFor(worker, "s-v2", "v2");
    for (const name of WORKFLOW_SKILLS) assert.ok(names.includes(name), `load_skill serves ${name} to a V2 chat`);
    assert.ok(!names.includes("workflow-testing"), "workflow-testing stays hidden with test mode off");
    assert.ok(names.includes("canvas-apps"), "the system plugin's skills are still there");
    // Each name once: the source is not duplicated.
    assert.equal(names.length, new Set(names).size);
    // The body served is the skill's own text.
    const authoring = (await worker.sessionManager._skillCatalogForSession("s-v2", null)).find((s) => s.name === "workflow-authoring");
    assert.match(authoring.prompt, /workflow/i);
});

test("the V2 skills index and search_capabilities list them as static deployment skills", async (t) => {
    const worker = defaultWorker(t, false);
    const sources = worker._getCapabilitySources();
    const inventory = ownedAndStaticCapabilityInventory(sources, null);
    for (const name of WORKFLOW_SKILLS) {
        const entry = inventory.find((item) => item.kind === "skill" && item.name === name);
        assert.ok(entry, `${name} is in the V2 index`);
        assert.equal(entry.ownership, "static");
    }
    const catalog = new CapabilityCatalog(() => worker._getCapabilitySources(), null);
    const found = await catalog.search(null, "s-v2", { query: "workflow authoring", kinds: ["skill"], sources: ["static"], limit: 10 });
    const hits = found.capabilities;
    assert.ok(hits.some((hit) => hit.name === "workflow-authoring"), "search finds workflow-authoring");
});

test("with test mode on, workflow-testing is loadable too; a reload does not duplicate the source", async (t) => {
    const worker = defaultWorker(t, true);
    let names = await catalogFor(worker, "s-v2", "v2");
    for (const name of [...WORKFLOW_SKILLS, "workflow-testing"]) assert.ok(names.includes(name), name);
    const count = () => worker._getCapabilitySources().filter((source) => source.artifacts.some((a) => a.name === "workflow-authoring")).length;
    assert.equal(count(), 1);
    worker._resetLoadedPluginState();
    worker._loadPlugins();
    assert.equal(count(), 1, "one Workflow skills source after a reload");
    names = await catalogFor(worker, "s-v2", "v2");
    assert.equal(names.filter((name) => name === "workflow-authoring").length, 1);
});

test("a V1 session keeps them through the worker's shared skill list", async (t) => {
    const worker = defaultWorker(t, false);
    const names = await catalogFor(worker, "s-v1", "v1");
    for (const name of WORKFLOW_SKILLS) assert.ok(names.includes(name), name);
});
