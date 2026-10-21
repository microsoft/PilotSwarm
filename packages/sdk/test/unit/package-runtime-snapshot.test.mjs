import test from "node:test";
import assert from "node:assert/strict";
import modules, { syncBuiltinESMExports } from "node:module";
import { installPackageSourceSnapshot } from "../../dist/package-runtime-snapshot.js";

test("verified executable snapshot fails closed when synchronous module hooks are unavailable", () => {
    const registerHooks = modules.registerHooks;
    try {
        modules.registerHooks = undefined;
        syncBuiltinESMExports();
        assert.throws(() => installPackageSourceSnapshot({ sources: {}, builtins: [] }),
            /requires synchronous Node module\.registerHooks/);
    } finally {
        modules.registerHooks = registerHooks;
        syncBuiltinESMExports();
    }
});
