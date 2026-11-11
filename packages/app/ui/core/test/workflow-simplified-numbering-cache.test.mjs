/**
 * Workflow Simplified, review UI-12: an owner's definitions and its Workflows' numbers are computed once per session map
 * and views, and every row reuses them; a new session map or views (a change) computes them again, so the numbers stay
 * coherent with what changed.
 *
 * Run: node --test ui/core/test/workflow-simplified-numbering-cache.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinitionsOf, workflowNumberOf, workflowRowTitle } from "../src/workflow-owner.js";

const OWNER = "owner-1";
const workflow = (sessionId, name, n) => ({ sessionId, sessionKind: "workflow", title: `Workflow: ${name}`, status: "running", parentSessionId: OWNER,
    createdAt: n, updatedAt: n });
const mapOf = list => Object.fromEntries(list.map(session => [session.sessionId, session]));

test("one grouping per session map and views, reused by every row; a change computes it again", () => {
    const sessions = [{ sessionId: OWNER, title: "Owner", createdAt: 0 }];
    for (let i = 1; i <= 300; i += 1) sessions.push(workflow(`wf-${i}`, i % 2 ? "check-items" : "price-lookup", i));
    const byId = mapOf(sessions);
    const views = {};
    const first = workflowDefinitionsOf(byId, OWNER, views);
    assert.equal(workflowDefinitionsOf(byId, OWNER, views), first, "the same grouping, not a new one");
    assert.equal(workflowNumberOf(byId, "wf-299", views), 150);
    assert.equal(workflowNumberOf(byId, "wf-300", views), 150);
    assert.equal(workflowRowTitle(byId, byId["wf-1"], views), "check-items #1");
    // A new session map (a Workflow added): computed again, with the new one numbered.
    const grown = mapOf([...sessions, workflow("wf-301", "check-items", 301)]);
    assert.notEqual(workflowDefinitionsOf(grown, OWNER, views), first);
    assert.equal(workflowNumberOf(grown, "wf-301", views), 151);
    // New views (a read model that renames a child's definition): computed again for them.
    const renamed = { "wf-301": { readModel: { revision: { name: "renamed" } } } };
    const again = workflowDefinitionsOf(grown, OWNER, renamed);
    assert.notEqual(again, workflowDefinitionsOf(grown, OWNER, views));
});
