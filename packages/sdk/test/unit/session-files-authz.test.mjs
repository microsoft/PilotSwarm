/**
 * Workspace files (the portal's Workspace pane): the session:files access
 * class. The session's owner only; admins get no special access, because a
 * session's folders include its owner's own folder; people who cannot see
 * the session learn nothing about it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateSessionAccess } from "../../api/src/session-authz.js";

const snapshot = (over = {}) => ({
    rootSessionId: "s1",
    isSystem: false,
    visibility: "private",
    owner: { displayName: "Alice", subject: "alice" },
    viewerIsOwner: false,
    viewerShareAccess: null,
    ...over,
});

describe("session:files", () => {
    it("the owner may", () => {
        assert.deepEqual(evaluateSessionAccess("session:files", snapshot({ viewerIsOwner: true })), { allowed: true });
    });

    it("an admin who is not the owner may not, whatever the admin scope", () => {
        for (const adminScope of ["unrestricted", "cluster"]) {
            const decision = evaluateSessionAccess("session:files", snapshot(), { isAdmin: true, adminScope });
            assert.equal(decision.allowed, false, adminScope);
            assert.equal(decision.notFound, undefined, adminScope);
            assert.match(decision.reason, /owner/);
        }
    });

    it("people the session is shared with may not, even for writing", () => {
        for (const over of [{ visibility: "shared_read" }, { visibility: "shared_write" }, { viewerShareAccess: "write" }]) {
            const decision = evaluateSessionAccess("session:files", snapshot(over));
            assert.equal(decision.allowed, false, JSON.stringify(over));
            assert.match(decision.reason, /owner/);
        }
    });

    it("someone who cannot see the session gets not-found", () => {
        assert.deepEqual(evaluateSessionAccess("session:files", snapshot()), { allowed: false, notFound: true });
    });

    it("system sessions have no folders to show, even to their owner", () => {
        assert.equal(evaluateSessionAccess("session:files", snapshot({ isSystem: true, viewerIsOwner: true })).allowed, false);
    });
});
