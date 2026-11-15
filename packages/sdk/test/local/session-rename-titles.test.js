// Renaming a session: the person's title is kept whole up to 100 characters,
// and a named agent's prefix is always kept, whole.
//
// WHY THIS EXISTS: the 60-character limit used to cover the agent-name prefix
// too, so the longer the agent's name, the more of a rename was silently cut
// ("Kingsley Shacklebolt — Azure Control Plane: Investigate the"). A review
// also showed that guessing which prefixes are "really" agent names deletes
// real ones for callers without catalog data, so the prefix is never dropped.
import { describe, it, expect } from "vitest";
import { PilotSwarmManagementClient, buildStoredSessionTitle, getNamedAgentTitlePrefix } from "../../src/management-client.js";
import { assertEqual } from "../helpers/assertions.js";

const LONG = "Investigate the nightly replication lag regression on the westus3 read replicas";

describe("session rename titles", () => {
    it("keeps the whole title up to 100 characters, prefix or not", () => {
        assertEqual(buildStoredSessionTitle({ title: "abc" }, LONG), LONG);
        assertEqual(
            buildStoredSessionTitle({ agentId: "control-plane", title: "Kingsley Shacklebolt — Azure Control Plane: 12b9af29" }, LONG),
            `Kingsley Shacklebolt — Azure Control Plane: ${LONG}`,
        );
        assertEqual(
            buildStoredSessionTitle({ agentId: "generic-crawler", title: "Generic-crawler: fcb6a5a5" }, LONG),
            `Generic-crawler: ${LONG}`,
        );
        const hundredAndTen = "x".repeat(110);
        assertEqual(buildStoredSessionTitle({ agentId: "deepwiki", title: "Deepwiki: 01babe9e" }, hundredAndTen), `Deepwiki: ${"x".repeat(100)}`);
    });

    it("keeps the agent-name prefix: the longest catalog title it starts with, else the text before the first ': '", () => {
        assertEqual(getNamedAgentTitlePrefix({ agentId: "deepwiki", title: "Deepwiki: 01babe9e" }), "Deepwiki");
        assertEqual(getNamedAgentTitlePrefix({ agentId: "agent-manager", title: "Agent Smith: TRON MOTD" }, ["Agent Smith"]), "Agent Smith");
        assertEqual(getNamedAgentTitlePrefix({ agentId: "r2d-watcher", title: "Mad-Eye Moody - R2D Train Watcher: M61" }), "Mad-Eye Moody - R2D Train Watcher");
        // A display title that itself contains ": " is kept whole when the catalog knows it.
        assertEqual(getNamedAgentTitlePrefix({ agentId: "ops", title: "Ops: Fleet Watcher: 12ab34cd" }, ["Ops: Fleet Watcher"]), "Ops: Fleet Watcher");
        // Not a named agent session: no prefix at all.
        assertEqual(getNamedAgentTitlePrefix({ title: "Release: M70 checklist" }), null);
    });

    it("never drops a prefix: SDK and MCP callers without catalog data keep what main kept", () => {
        // Two-argument callers (local MCP, direct SDK) and agents nobody can create.
        assertEqual(buildStoredSessionTitle({ agentId: "agent-manager", title: "Agent Smith: old" }, "new"), "Agent Smith: new");
        assertEqual(buildStoredSessionTitle({ agentId: "child-only", title: "Night Auditor: 9f8e7d6c" }, "Ledger pass"), "Night Auditor: Ledger pass");
        // A title the session was created with is recorded as the agent's name: kept.
        assertEqual(buildStoredSessionTitle({ agentId: "harbor-clerk", title: "UX card wall: Harbor arrivals" }, "Plain new name", ["Harbor Clerk"]), "UX card wall: Plain new name");
    });

    it("sending the whole stored title back does not repeat the agent's name", () => {
        assertEqual(buildStoredSessionTitle({ agentId: "agent-manager", title: "Agent Smith: old" }, "Agent Smith: old"), "Agent Smith: old");
        assertEqual(buildStoredSessionTitle({ agentId: "agent-manager", title: "Agent Smith: old" }, "Agent Smith: new name"), "Agent Smith: new name");
    });

    it("cuts at 100 without splitting an emoji", () => {
        const title = `${"a".repeat(99)}😀tail`;
        const stored = buildStoredSessionTitle({ title: "x" }, title);
        assertEqual(stored, "a".repeat(99));
        assertEqual(/[\uD800-\uDBFF]$/u.test(stored), false);
    });

    it("keeps the person's ' - ' and ': ' inside the title", () => {
        assertEqual(buildStoredSessionTitle({ agentId: "deepwiki", title: "Deepwiki: 19dd6dd8" }, "Fix login redirect - follow up"), "Deepwiki: Fix login redirect - follow up");
        assertEqual(
            buildStoredSessionTitle({ agentId: "generic-crawler", title: "Generic-crawler: Phase 2: old" }, "Phase 3: backfill"),
            "Generic-crawler: Phase 3: backfill",
        );
    });

    it("refuses an empty title", () => {
        assertEqual(buildStoredSessionTitle({ agentId: "deepwiki", title: "Deepwiki: x" }, "   "), "");
    });

    it("renameSession persists the longest catalog prefix and locks the title", async () => {
        const client = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
        client._started = true;
        let session = { sessionId: "rename-test", agentId: "ops", title: "Ops: Fleet Watcher: old" };
        const writes = [];
        client._catalog = {
            getSession: async (id) => { expect(id).toBe(session.sessionId); return session; },
            updateSession: async (id, update) => { writes.push({ id, update }); session = { ...session, ...update }; },
        };
        await client.renameSession(session.sessionId, "nightly", { agentTitles: ["Ops", "Ops: Fleet Watcher"] });
        expect(session.title).toBe("Ops: Fleet Watcher: nightly");
        expect(writes).toEqual([{ id: "rename-test", update: { title: "Ops: Fleet Watcher: nightly", titleLocked: true } }]);
        await expect(client.renameSession(session.sessionId, "   ", { agentTitles: ["Ops", "Ops: Fleet Watcher"] }))
            .rejects.toThrow("Title cannot be empty");
        expect(writes).toHaveLength(1);
    });
});
