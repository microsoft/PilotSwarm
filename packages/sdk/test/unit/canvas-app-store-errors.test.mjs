/**
 * Canvas app registry (issue 181): procedure errors map to the public codes,
 * and a unique-index conflict on an app name (two concurrent scope changes
 * that both passed the procedure's own check) is NAME_TAKEN, not a server
 * error. Anything else is rethrown unchanged.
 *
 * Run: node --test test/unit/canvas-app-store-errors.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CanvasAppError, mapCanvasAppError } from "../../dist/canvas-app-store.js";

const mapped = (err) => {
    try { mapCanvasAppError(err); } catch (e) { return e; }
    assert.fail("mapCanvasAppError always throws");
};

test("procedure errors map to their public code and status", () => {
    const e = mapped(new Error('CANVAS_APP_NAME_TAKEN: a shared canvas app named "x" already exists'));
    assert.ok(e instanceof CanvasAppError);
    assert.equal(e.code, "NAME_TAKEN");
    assert.equal(e.status, 409);
    assert.equal(mapped(new Error('CANVAS_APP_DISABLED: canvas app "x" is disabled')).code, "APP_DISABLED");
});

test("a unique violation on either name index is NAME_TAKEN (409), not a server error", () => {
    for (const [constraint, text] of [["canvas_apps_shared_name_uniq", /shared canvas app/], ["canvas_apps_user_name_uniq", /private canvas app/]]) {
        const err = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: "23505", constraint });
        const e = mapped(err);
        assert.ok(e instanceof CanvasAppError, constraint);
        assert.equal(e.code, "NAME_TAKEN");
        assert.equal(e.status, 409);
        assert.match(e.message, text);
    }
});

test("other database errors are rethrown unchanged", () => {
    const other = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "canvas_app_versions_pkey" });
    assert.equal(mapped(other), other);
    const plain = new Error("connection reset");
    assert.equal(mapped(plain), plain);
});
