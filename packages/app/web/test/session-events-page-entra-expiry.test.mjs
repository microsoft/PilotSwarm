/**
 * REAL credential expiry through the shipped Entra provider (issue 148).
 *
 * This closes the gap that `session-events-page-auth-controls.test.mjs`
 * records but cannot cover: the dev credential has no `exp`, so expiry is
 * unreachable through it. Real enforcement lives in `jose.jwtVerify`, which
 * the Entra provider calls.
 *
 * ── WHAT IS REAL ────────────────────────────────────────────────────────
 *   - the shipped export `createEntraAuthProvider`
 *   - its real `authenticateRequest(token)` -> `validateToken` -> `jwtVerify`
 *   - `jose` itself, enforcing exp, issuer, audience and the signature
 *
 * ── WHAT IS SUBSTITUTED ─────────────────────────────────────────────────
 *   - the NETWORK TRANSPORT only. `globalThis.fetch` is mocked so the key set
 *     is served locally instead of from login.microsoftonline.com.
 *
 * The verification is NOT mocked. That distinction is the whole point: a test
 * that called `jose.jwtVerify` directly would prove the LIBRARY rejects an
 * expired token and say nothing about our provider. This drives our provider.
 *
 * NO PRODUCTION CHANGE. No export, argument, env flag or code path exists for
 * this test. Delete the file and production is byte-identical.
 *
 * "No production surface change" is NOT "no security risk" — a test that
 * mocks transport could, if written carelessly, bypass the very checks it
 * claims to prove. Three defences are therefore load-bearing here:
 *   1. the fetch mock THROWS on any unexpected URL, so a stray real network
 *      call fails loudly instead of silently passing
 *   2. a POSITIVE control proves the provider still ACCEPTS a valid token, so
 *      the negatives cannot be satisfied by a provider that refuses everything
 *   3. each negative asserts the REASON jose rejected, not merely that it did
 *
 * (3) matters more than it looks. `authenticateRequest` swallows the error and
 * returns `null` (entra.js:45-50), so expired, wrong-issuer, wrong-audience
 * and tampered-signature are INDISTINGUISHABLE at the provider boundary. The
 * logged reason is the only evidence of which check fired. Without it, a
 * provider that rejected everything for one wrong reason would pass all four.
 *
 * STATUS: authored, NOT EXECUTED. No credential, tenant, network, database or
 * model authority has been used.
 *
 * UNVERIFIED ASSUMPTION, stated rather than assumed: that the installed `jose`
 * fetches its remote key set through `globalThis.fetch`. That must be checked
 * against the INSTALLED SOURCE before this file is trusted. If it does not,
 * the mock never fires and the `fetchCalls` assertion below FAILS LOUDLY
 * rather than passing hollowly — which is why that assertion exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";
import { createEntraAuthProvider } from "../auth/providers/entra.js";

const ALG = "RS256";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

/**
 * A unique, deliberately INVALID synthetic tenant per case.
 *
 * Two reasons, both load-bearing:
 *   - the provider's JWKS cache is keyed by tenant id and checked first
 *     (entra.js:18-19). A repeated id would silently reuse a previous key set
 *     and the case would not test what it claims.
 *   - the value is not a real tenant, so a leaked request cannot reach a live
 *     directory.
 */
let tenantSeq = 0;
const freshTenant = () => `00000000-0000-4000-8000-${String(++tenantSeq).padStart(12, "0")}`;

const issuerFor = (tenantId) => `https://login.microsoftonline.com/${tenantId}/v2.0`;
const jwksUrlFor = (tenantId) => `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;

/**
 * Install the environment and the transport mock, run `fn`, and ALWAYS
 * restore both.
 *
 * Env and `globalThis.fetch` are process-wide, so a case that failed to
 * restore them would corrupt every later test in this process. Restoration is
 * in `finally` for that reason, and the previous values are captured rather
 * than assumed absent.
 *
 * Node's test runner isolates by FILE, so this does not serialize anything or
 * reduce throughput: other files still run in parallel, and nothing here takes
 * a global lock.
 */
async function withProvider(t, { tenantId, keys }, fn) {
    const prevTenant = process.env.PORTAL_AUTH_ENTRA_TENANT_ID;
    const prevClient = process.env.PORTAL_AUTH_ENTRA_CLIENT_ID;
    const prevFetch = globalThis.fetch;

    const fetchCalls = [];
    const errors = [];

    process.env.PORTAL_AUTH_ENTRA_TENANT_ID = tenantId;
    process.env.PORTAL_AUTH_ENTRA_CLIENT_ID = CLIENT_ID;

    // Any URL other than this tenant's key set is a genuine escape and must
    // fail the test, not be quietly tolerated.
    globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input?.url ?? String(input);
        fetchCalls.push(url);
        if (url !== jwksUrlFor(tenantId)) {
            throw new Error(`[test] unexpected network call to ${url} — only this tenant's JWKS may be fetched`);
        }
        return new Response(JSON.stringify({ keys }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    // The provider logs the rejection reason and returns null. Capturing it is
    // the ONLY way to tell the negative cases apart.
    t.mock.method(console, "error", (...args) => { errors.push(args.map(String).join(" ")); });

    try {
        return await fn({
            provider: createEntraAuthProvider({}),
            fetchCalls,
            errors,
        });
    } finally {
        globalThis.fetch = prevFetch;
        if (prevTenant === undefined) delete process.env.PORTAL_AUTH_ENTRA_TENANT_ID;
        else process.env.PORTAL_AUTH_ENTRA_TENANT_ID = prevTenant;
        if (prevClient === undefined) delete process.env.PORTAL_AUTH_ENTRA_CLIENT_ID;
        else process.env.PORTAL_AUTH_ENTRA_CLIENT_ID = prevClient;
    }
}

async function makeKeys() {
    const { publicKey, privateKey } = await jose.generateKeyPair(ALG, { extractable: true });
    const jwk = await jose.exportJWK(publicKey);
    return { privateKey, jwk: { ...jwk, alg: ALG, use: "sig", kid: "test-key-1" } };
}

function sign(privateKey, { issuer, audience, expiresIn = "5m", notBefore = "0s", subject = "user-1" }) {
    return new jose.SignJWT({ oid: subject, name: "Test User", preferred_username: "user@test.invalid" })
        .setProtectedHeader({ alg: ALG, kid: "test-key-1" })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(subject)
        .setNotBefore(notBefore)
        .setExpirationTime(expiresIn)
        .sign(privateKey);
}

/**
 * EVERY negative case must prove its rejection came from the CHECK UNDER TEST
 * and not from the harness.
 *
 * The review that caught this gave the exact counterexample: the mock's own
 * failure message is "[test] unexpected network call to …", and `unexpected`
 * CONTAINS the substring `exp`. A regex of /exp|expire/i therefore matched the
 * harness's own error, so a transport mistake would have PASSED as proof of
 * expiry enforcement. The same flaw let /iss|issuer/i match the word
 * `missing`.
 *
 * Two defences, both required:
 *   - `assertCleanTransport` proves the only URL fetched was this tenant's
 *     key set, so no harness error is in play at all
 *   - the callers below match jose's ACTUAL diagnostic text, anchored on the
 *     quoted claim name, instead of loose substrings
 */
function assertCleanTransport(fetchCalls, tenantId, label) {
    const expected = jwksUrlFor(tenantId);
    // Assert WHERE we fetched, not HOW MANY TIMES.
    //
    // An earlier version demanded exactly one call. That over-constrained
    // jose's internals rather than our contract: a RemoteJWKSet may RELOAD its
    // key set (30s cooldown, 10min cache age, remote.js:70-74), for instance
    // when a kid is not found in the cached set. A legitimate reload would
    // then have failed the test for a reason that has nothing to do with the
    // check under test — the precise class of wrong-reason failure this file
    // exists to avoid.
    //
    // The security property is that NO OTHER URL was contacted, and that the
    // key set really was served by the mock rather than the network.
    assert.ok(fetchCalls.length > 0,
        `${label}: the key set must have been fetched through the mock — zero fetches means jose did not use globalThis.fetch`);
    const foreign = fetchCalls.filter((u) => u !== expected);
    assert.deepEqual(foreign, [],
        `${label}: every fetch must be this tenant's key set — any other URL means the harness failed, `
        + `not the check under test; saw ${JSON.stringify(fetchCalls)}`);
}

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────
// Must come first in intent: every negative below is meaningless unless the
// provider demonstrably ACCEPTS a good token through the same path.

test("REAL EXPIRY control: a valid token is ACCEPTED and yields a principal", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, fetchCalls }) => {
        const token = await sign(privateKey, { issuer: issuerFor(tenantId), audience: CLIENT_ID });
        const principal = await provider.authenticateRequest(token);

        assert.ok(principal, "a valid token must authenticate — if this fails, every negative below proves nothing");
        assert.equal(principal.provider, "entra");
        assert.equal(principal.subject, "user-1");

        // Proves the mocked transport was actually used. If `jose` does not
        // fetch through globalThis.fetch, this fails loudly instead of the
        // file passing hollowly.
        assertCleanTransport(fetchCalls, tenantId, "valid token control");
    });
});

// ── NEGATIVES, each asserting WHICH check fired ──────────────────────────

test("REAL EXPIRY: an EXPIRED token is rejected, and rejected for being expired", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors, fetchCalls }) => {
        // Signed in the past and already expired.
        const token = await sign(privateKey, {
            issuer: issuerFor(tenantId), audience: CLIENT_ID, expiresIn: "-1m",
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "an expired token must not authenticate");
        assertCleanTransport(fetchCalls, tenantId, "expired");
        // jose throws JWTExpired with '"exp" claim timestamp check failed'
        // (lib/jwt_claims_set.js). Anchoring on the QUOTED claim name cannot
        // be satisfied by the harness's own "unexpected network call" text.
        assert.match(errors.join(" "), /"exp" claim/,
            `the rejection must name the "exp" CLAIM; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a wrong-ISSUER token is rejected for the issuer, proving that check is live", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors, fetchCalls }) => {
        const token = await sign(privateKey, {
            issuer: issuerFor(freshTenant()), audience: CLIENT_ID,
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token from another issuer must not authenticate");
        assertCleanTransport(fetchCalls, tenantId, "wrong issuer");
        // Anchored on the quoted claim: /iss|issuer/i also matched "missing".
        assert.match(errors.join(" "), /"iss" claim/,
            `the rejection must name the "iss" CLAIM; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a wrong-AUDIENCE token is rejected for the audience, proving that check is live", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors, fetchCalls }) => {
        const token = await sign(privateKey, {
            issuer: issuerFor(tenantId), audience: "99999999-9999-4999-8999-999999999999",
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token for another audience must not authenticate");
        assertCleanTransport(fetchCalls, tenantId, "wrong audience");
        assert.match(errors.join(" "), /"aud" claim/,
            `the rejection must name the "aud" CLAIM; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a TAMPERED signature is rejected, so the key set is genuinely verified", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors, fetchCalls }) => {
        const good = await sign(privateKey, { issuer: issuerFor(tenantId), audience: CLIENT_ID });
        // Keep header and payload, corrupt only the signature segment.
        const [h, p, s] = good.split(".");
        const flipped = s.startsWith("A") ? `B${s.slice(1)}` : `A${s.slice(1)}`;
        const principal = await provider.authenticateRequest(`${h}.${p}.${flipped}`);

        assert.equal(principal, null, "a tampered token must not authenticate");
        assertCleanTransport(fetchCalls, tenantId, "tampered signature");
        // jose: 'signature verification failed'. The full phrase, not a loose
        // /verif/ which any verification-adjacent message would satisfy.
        assert.match(errors.join(" "), /signature verification failed/i,
            `the rejection must be a SIGNATURE verification failure; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a token signed by an UNRELATED key is rejected", async (t) => {
    const tenantId = freshTenant();
    const { jwk } = await makeKeys();              // published
    const { privateKey: foreign } = await makeKeys(); // never published

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors, fetchCalls }) => {
        const token = await sign(foreign, { issuer: issuerFor(tenantId), audience: CLIENT_ID });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token signed by a key outside the published set must not authenticate");
        assertCleanTransport(fetchCalls, tenantId, "unrelated key");
        // "the rejection must be logged" was too weak: a TRANSPORT failure
        // also logs. The rejection must specifically be signature verification
        // against the published key.
        assert.match(errors.join(" "), /signature verification failed/i,
            `the rejection must be a SIGNATURE verification failure, not a transport error; logged: ${errors.join(" ")}`);
    });
});
