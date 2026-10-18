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
        assert.ok(fetchCalls.includes(jwksUrlFor(tenantId)),
            `the key set must have been fetched through the mock; saw ${JSON.stringify(fetchCalls)}`);
    });
});

// ── NEGATIVES, each asserting WHICH check fired ──────────────────────────

test("REAL EXPIRY: an EXPIRED token is rejected, and rejected for being expired", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors }) => {
        // Signed in the past and already expired.
        const token = await sign(privateKey, {
            issuer: issuerFor(tenantId), audience: CLIENT_ID, expiresIn: "-1m",
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "an expired token must not authenticate");
        assert.match(errors.join(" "), /exp|expire/i,
            `the rejection must be for EXPIRY, not some other failure; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a wrong-ISSUER token is rejected for the issuer, proving that check is live", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors }) => {
        const token = await sign(privateKey, {
            issuer: issuerFor(freshTenant()), audience: CLIENT_ID,
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token from another issuer must not authenticate");
        assert.match(errors.join(" "), /iss|issuer/i,
            `the rejection must name the ISSUER; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a wrong-AUDIENCE token is rejected for the audience, proving that check is live", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors }) => {
        const token = await sign(privateKey, {
            issuer: issuerFor(tenantId), audience: "99999999-9999-4999-8999-999999999999",
        });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token for another audience must not authenticate");
        assert.match(errors.join(" "), /aud|audience/i,
            `the rejection must name the AUDIENCE; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a TAMPERED signature is rejected, so the key set is genuinely verified", async (t) => {
    const tenantId = freshTenant();
    const { privateKey, jwk } = await makeKeys();

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors }) => {
        const good = await sign(privateKey, { issuer: issuerFor(tenantId), audience: CLIENT_ID });
        // Keep header and payload, corrupt only the signature segment.
        const [h, p, s] = good.split(".");
        const flipped = s.startsWith("A") ? `B${s.slice(1)}` : `A${s.slice(1)}`;
        const principal = await provider.authenticateRequest(`${h}.${p}.${flipped}`);

        assert.equal(principal, null, "a tampered token must not authenticate");
        assert.match(errors.join(" "), /signature|verif/i,
            `the rejection must concern the SIGNATURE; logged: ${errors.join(" ")}`);
    });
});

test("REAL EXPIRY: a token signed by an UNRELATED key is rejected", async (t) => {
    const tenantId = freshTenant();
    const { jwk } = await makeKeys();              // published
    const { privateKey: foreign } = await makeKeys(); // never published

    await withProvider(t, { tenantId, keys: [jwk] }, async ({ provider, errors }) => {
        const token = await sign(foreign, { issuer: issuerFor(tenantId), audience: CLIENT_ID });
        const principal = await provider.authenticateRequest(token);

        assert.equal(principal, null, "a token signed by a key outside the published set must not authenticate");
        assert.ok(errors.length > 0, "the rejection must be logged");
    });
});
