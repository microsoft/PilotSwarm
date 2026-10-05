import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    sameWorkspace,
    validateWorkspaceText,
} from "../../dist/workspace-check.js";
import { WORKSPACE_ERROR_CODES as CODES } from "../../dist/types.js";

describe("folder-text check", () => {
    const ok = (input, expected) => {
        const result = validateWorkspaceText(input);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(result.workspace, expected);
    };
    const bad = (input, pattern) => {
        const result = validateWorkspaceText(input);
        assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
        assert.equal(result.code, CODES.PATH_INVALID);
        if (pattern) assert.match(result.message, pattern);
    };

    it("accepts a root, a root with a folder, and schema 1", () => {
        ok({ root: "a" }, { schema: 1, root: "a" });
        ok({ root: "a", folder: "sessions/s-1/app" }, { schema: 1, root: "a", folder: "sessions/s-1/app" });
        ok({ schema: 1, root: "a", folder: "x" }, { schema: 1, root: "a", folder: "x" });
        ok({ root: "a", folder: null }, { schema: 1, root: "a" });
    });

    it("normalizes the folder: dots, doubled and trailing slashes; empty and '.' mean the root", () => {
        ok({ root: "a", folder: "x/./y//" }, { schema: 1, root: "a", folder: "x/y" });
        ok({ root: "a", folder: "x/../y" }, { schema: 1, root: "a", folder: "y" });
        ok({ root: "a", folder: "" }, { schema: 1, root: "a" });
        ok({ root: "a", folder: "." }, { schema: 1, root: "a" });
        ok({ root: "a", folder: "..b/c" }, { schema: 1, root: "a", folder: "..b/c" });
    });

    it("rejects absolute folders, '..' after normalizing, and NUL", () => {
        bad({ root: "a", folder: "/etc" }, /relative/);
        bad({ root: "a", folder: ".." }, /inside the root/);
        bad({ root: "a", folder: "../x" }, /inside the root/);
        bad({ root: "a", folder: "x/../../y" }, /inside the root/);
        bad({ root: "a", folder: "x\0y" }, /NUL/);
    });

    it("rejects bad shapes: non-objects, unknown fields, other schemas, bad roots, non-string folders", () => {
        for (const input of [null, undefined, "a", 1, [], ["a"]]) bad(input);
        bad({ root: "a", path: "x" }, /unknown workspace field "path"/);
        bad({ schema: 2, root: "a" }, /schema 2/);
        bad({ folder: "x" }, /root/);
        bad({ root: "" }, /root/);
        bad({ root: "a/b" }, /root name/);
        bad({ root: " a" }, /root name/);
        bad({ root: "a\0" }, /root name/);
        bad({ root: "a", folder: 5 }, /string/);
    });

    it("sameWorkspace compares root and folder, treating an absent folder as the root", () => {
        assert.equal(sameWorkspace({ schema: 1, root: "a" }, { schema: 1, root: "a", folder: undefined }), true);
        assert.equal(sameWorkspace({ schema: 1, root: "a", folder: "x" }, { schema: 1, root: "a", folder: "x" }), true);
        assert.equal(sameWorkspace({ schema: 1, root: "a", folder: "x" }, { schema: 1, root: "a" }), false);
        assert.equal(sameWorkspace({ schema: 1, root: "a" }, { schema: 1, root: "b" }), false);
        assert.equal(sameWorkspace(null, undefined), true);
        assert.equal(sameWorkspace(null, { schema: 1, root: "a" }), false);
    });
});
