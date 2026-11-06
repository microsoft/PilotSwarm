// Renaming a session: the person's title is kept whole up to 100 characters,
// and a named agent's prefix is kept only when it really is the agent's name.
//
// WHY THIS EXISTS: the 60-character limit used to cover the agent-name prefix
// too, so the longer the agent's name, the more of a rename was silently cut
// ("Kingsley Shacklebolt — Azure Control Plane: Investigate the"). And any
// words before the first ": " were treated as the agent's name, so a title a
// session started with ("UX card wall: …") became a prefix the person could
// never remove.
import { describe, it } from "vitest";
import { buildStoredSessionTitle, getNamedAgentTitlePrefix } from "../../src/management-client.js";
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

    it("keeps an agent-name prefix: the agent's id, its catalog title, or a Persona - Type name", () => {
        assertEqual(getNamedAgentTitlePrefix({ agentId: "deepwiki", title: "Deepwiki: 01babe9e" }), "Deepwiki");
        assertEqual(getNamedAgentTitlePrefix({ agentId: "agent-manager", title: "Agent Smith: TRON MOTD" }, ["Agent Smith"]), "Agent Smith");
        assertEqual(getNamedAgentTitlePrefix({ agentId: "r2d-watcher", title: "Mad-Eye Moody - R2D Train Watcher: M61" }), "Mad-Eye Moody - R2D Train Watcher");
    });

    it("never treats the person's own words as the agent's name", () => {
        // A title the session started with is not an agent name: the next rename replaces it.
        assertEqual(getNamedAgentTitlePrefix({ agentId: "harbor-clerk", title: "UX card wall: Harbor arrivals" }, ["Harbor Clerk"]), null);
        assertEqual(buildStoredSessionTitle({ agentId: "harbor-clerk", title: "UX card wall: Harbor arrivals" }, "Plain new name", ["Harbor Clerk"]), "Plain new name");
        // With the catalog known, a dash in someone's own title is not a persona.
        assertEqual(getNamedAgentTitlePrefix({ agentId: "deepwiki", title: "Fix login - follow up: notes" }, ["DeepWiki Code Explorer"]), null);
        // Not a named agent session: no prefix at all.
        assertEqual(getNamedAgentTitlePrefix({ title: "Release: M70 checklist" }), null);
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
});
