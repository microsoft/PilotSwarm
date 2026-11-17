import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

test("canvas KV slot params: missing is slot 1, 1-10 accepted, 11 refused with the shared words", () => {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    assert.equal(runtime._canvasKvSlot(undefined), 1);
    assert.equal(runtime._canvasKvSlot(""), 1);
    assert.equal(runtime._canvasKvSlot({ slot: 10 }), 10);
    assert.equal(runtime._canvasKvSlot("10"), 10);
    for (const bad of [11, 0, "x", 1.5]) {
        assert.throws(() => runtime._canvasKvSlot(bad), (error) => error.code === "INVALID_REQUEST"
            && error.message === "slot must be an integer 1-10", String(bad));
    }
});
