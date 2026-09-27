// Parsing and matching for `pilotswarm-relay --allow`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ANY_OWNER, OwnerAllowList } from "../dist/index.js";

const OID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const entra = (subject, email) => ({ provider: "entra", subject, email });

test("accepts emails and object ids, split by commas or repeated", () => {
    const list = OwnerAllowList.parse(["a@x.com, B@Y.com", OID]);
    assert.ok(list.allows(entra("any", "a@x.com")));
    assert.ok(list.allows(entra("any", "b@y.com")));
    assert.ok(list.allows(entra(OID.toUpperCase(), undefined)));
});

test("rejects a bare alias, junk, and an empty list", () => {
    assert.throws(() => OwnerAllowList.parse(["alice"]), /not an email or an Entra object id/);
    assert.throws(() => OwnerAllowList.parse(["a@x.com", "not an id"]), /not an email/);
    assert.throws(() => OwnerAllowList.parse([" , "]), /empty/);
});

test("only Entra owners match, and a missing owner never matches", () => {
    const list = OwnerAllowList.parse(["a@x.com", OID]);
    assert.equal(list.allows({ provider: "dev", subject: OID, email: "a@x.com" }), false);
    assert.equal(list.allows(undefined), false);
    assert.equal(list.allows(entra("other-oid", "someone@x.com")), false);
    assert.equal(list.allows(entra("other-oid", undefined)), false);
});

test("the hello form round-trips, and 'any' comes back as no list", () => {
    const list = OwnerAllowList.parse(["A@X.com", OID]);
    const again = OwnerAllowList.fromServed(list.toServed());
    assert.ok(again.allows(entra("any", "a@x.com")));
    assert.ok(again.allows(entra(OID, undefined)));
    assert.equal(again.allows(entra("other", "b@x.com")), false);
    assert.equal(OwnerAllowList.fromServed(ANY_OWNER), undefined);
    assert.throws(() => OwnerAllowList.fromServed({ anyOwner: false, emails: "a@x.com", objectIds: [] }), /string arrays/);
});
