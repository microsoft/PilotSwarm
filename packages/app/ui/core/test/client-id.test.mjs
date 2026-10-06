import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { newClientId } from "../src/client-id.js";

test("client IDs use randomUUID when the context supports it", () => {
    const crypto = {
        marker: "native-uuid",
        randomUUID() { return this.marker; },
        getRandomValues() { throw new Error("The fallback must not run"); },
    };
    assert.equal(newClientId(crypto), "native-uuid");
});

test("HTTP fallback sets UUID v4 version and variant with cryptographic bytes", () => {
    let calls = 0;
    const crypto = {
        getRandomValues(bytes) {
            calls++;
            assert.ok(bytes instanceof Uint8Array);
            assert.equal(bytes.length, 16);
            bytes.set(Array.from({ length: 16 }, (_, index) => index));
            return bytes;
        },
    };
    assert.equal(newClientId(crypto), "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.equal(calls, 1);
});

test("fallback clears old version and variant bits and keeps leading zeros", () => {
    assert.equal(newClientId({ getRandomValues: bytes => bytes.fill(255) }),
        "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.equal(newClientId({ getRandomValues: bytes => bytes.fill(0) }),
        "00000000-0000-4000-8000-000000000000");
});

test("getRandomValues-only contexts produce distinct valid UUID v4 IDs", () => {
    const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
    const ids = Array.from({ length: 128 }, () => newClientId(crypto));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("missing randomness fails explicitly rather than generating weak identities", () => {
    assert.throws(() => newClientId({}), /Cryptographic randomness is unavailable/);
    assert.throws(() => newClientId(null), /Cryptographic randomness is unavailable/);
});
