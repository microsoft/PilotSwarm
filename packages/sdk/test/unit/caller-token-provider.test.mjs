import assert from "node:assert/strict";
import test from "node:test";

import {
    appIdUriFromScope,
    multiTokenProvider,
    normalizeAudience,
} from "../../dist/caller-token-provider.js";

test("caller token helpers normalize scopes and route explicit audience tokens", async () => {
    assert.equal(
        appIdUriFromScope("api://example-app/.default"),
        "api://example-app",
    );
    assert.equal(normalizeAudience("api://EXAMPLE-APP/"), "example-app");

    const provider = multiTokenProvider({
        "api://example-app": "caller-token",
    });
    assert.equal(
        await provider({
            appIdUri: "example-app",
            scope: "api://example-app/.default",
        }),
        "caller-token",
    );
    assert.equal(
        await provider({
            appIdUri: "different-app",
            scope: "api://different-app/.default",
        }),
        null,
    );
});
