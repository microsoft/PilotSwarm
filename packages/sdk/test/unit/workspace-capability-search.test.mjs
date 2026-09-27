/**
 * search_capabilities and a session workspace's adopted repo agents and
 * skills (docs/proposals/session-workspaces.md, section 4.6). The base
 * instructions send the model to search_capabilities for any named
 * capability; repo agents are not in the catalog, so the model reported a repo
 * agent as not found before using it. workspaceCapabilityHits lists them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workspaceCapabilityHits } from "../../dist/capability-catalog.js";

const TFENV = {
    repo: "tfenv",
    agents: [
        { name: "architect", description: "Designing big changes, cross-cutting architectural decisions, impact analysis." },
        { name: "bug-finder", description: "Finding bugs, triaging defects, security audit, code review." },
        { name: "reviewer", description: "Reviewing pull requests, first-pass code review." },
    ],
    skills: ["duroxide-code-coverage"],
};

describe("workspace capability hits", () => {
    it("finds a named repo agent and says how to call it", () => {
        const [hit, ...rest] = workspaceCapabilityHits(TFENV, { query: "architect agent repository overview for tfenv" }, 8);
        assert.equal(hit.name, "architect");
        assert.equal(hit.kind, "agent");
        assert.equal(hit.source, "workspace");
        assert.equal(hit.ownership, "repo");
        assert.equal(hit.repo, "tfenv");
        assert.match(hit.how_to_use, /task tool with agent_type "architect"/);
        assert.equal(hit.ref, undefined, "nothing to load or activate");
        // The named agent ranks first; the others match on the repo name only.
        assert.ok(rest.every((other) => other.score < hit.score));
    });

    it("lists the repo's agents for a query that names the repo, within the limit", () => {
        const hits = workspaceCapabilityHits(TFENV, { query: "tfenv agents" }, 2);
        assert.equal(hits.length, 2);
        assert.ok(hits.every((h) => h.kind === "agent" && h.repo === "tfenv"));
    });

    it("finds a repo skill by name and says to use the skill tool", () => {
        const [hit] = workspaceCapabilityHits(TFENV, { query: "duroxide code coverage" }, 8);
        assert.equal(hit.kind, "skill");
        assert.equal(hit.name, "duroxide-code-coverage");
        assert.match(hit.how_to_use, /skill tool: skill "duroxide-code-coverage"/);
    });

    it("keeps to the requested kinds, and gives nothing without a workspace or a match", () => {
        assert.deepEqual(workspaceCapabilityHits(TFENV, { query: "architect", kinds: ["skill"] }, 8), []);
        assert.deepEqual(workspaceCapabilityHits(undefined, { query: "architect" }, 8), []);
        assert.deepEqual(workspaceCapabilityHits(TFENV, { query: "kubernetes" }, 8), []);
    });
});
