import test from "node:test";
import assert from "node:assert/strict";

import { PgSessionCatalog } from "../../dist/cms.js";
import { isSystemSessionSharingRefusal } from "../../dist/types.js";

function fakeCatalog(errorFactory) {
    const audits = [];
    const pool = {
        async query(sql, values) {
            if (String(sql).includes("cms_record_authz_audit")) {
                audits.push(values);
                return { rows: [] };
            }
            throw errorFactory();
        },
    };
    return { catalog: new PgSessionCatalog(pool, "test_schema"), audits };
}

const rawRefusal = (message) => Object.assign(new Error(message), { code: "P0001" });

test("catalog maps a system sharing refusal and records the denial", async () => {
    const { catalog, audits } = fakeCatalog(() => rawRefusal("Cannot change visibility of a system session"));
    await assert.rejects(catalog.setSessionVisibility("system", "shared_read", {
        provider: "dev",
        subject: "admin",
        displayName: "Admin",
    }), (error) => {
        assert.equal(error.code, "SYSTEM_SESSION_PROTECTED");
        assert.equal(error.status, 409);
        return true;
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].slice(0, 8), [
        "dev",
        "admin",
        "Admin",
        "setSessionVisibility",
        "system",
        null,
        "deny",
        "system_session_sharing_policy",
    ]);
});

test("grant refusal carries a stable target audit outside the failed statement", async () => {
    const { catalog, audits } = fakeCatalog(() => rawRefusal("Cannot share a system session"));
    await assert.rejects(catalog.grantSessionShare(
        "system",
        { provider: "dev", subject: "bob", email: null, displayName: "Bob" },
        "read",
        null,
        { provider: "dev", subject: "admin", display: "Admin" },
    ), { code: "SYSTEM_SESSION_PROTECTED", status: 409 });
    assert.equal(audits.length, 1);
    assert.equal(audits[0][3], "grantSessionShare");
    assert.equal(audits[0][5], "dev/bob");
});

test("ordinary PostgreSQL validation is not reclassified from quoted refusal text", () => {
    const validation = rawRefusal('Invalid visibility "Cannot share a system session"');
    assert.equal(isSystemSessionSharingRefusal(validation), false);
    assert.equal(isSystemSessionSharingRefusal(rawRefusal("Cannot share a system session")), true);
    assert.equal(isSystemSessionSharingRefusal(Object.assign(new Error("Cannot share a system session"), { code: "XX000" })), false);
});
