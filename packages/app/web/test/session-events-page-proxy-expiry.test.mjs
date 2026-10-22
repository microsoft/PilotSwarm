/**
 * REAL EXPIRY, PROXY PROVIDER (issue 148).
 *
 * Issue 148 requires credential expiry and re-authentication. Expiry is
 * enforced by `jose.jwtVerify`, and there are TWO production paths that call
 * it: `auth/providers/entra.js` and `auth/providers/proxy.js`. The entra path
 * is covered by session-events-page-entra-expiry.test.mjs. This file covers
 * the other one, which had no expiry coverage at all - a deployment behind a
 * proxy had no evidence that an expired assertion is refused.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * It verifies the provider's own verification contract: a valid assertion
 * authenticates, and an expired, wrong-issuer, wrong-audience, tampered or
 * foreign-signed one does not. Each negative is paired with the positive
 * control above it, so a case cannot pass by the provider rejecting
 * everything - that is the failure mode a lone negative test cannot see.
 *
 * It does NOT exercise the HTTP pipeline or the session-events routes; those
 * have their own files. It does not reach a database, a model or a network:
 * `globalThis.fetch` is replaced so the only reachable URL is this test's own
 * JWKS, and any other call is an explicit failure rather than a silent escape.
 *
 * `proxy.js` returns `null` for every rejection and logs the reason, so these
 * cases assert `principal === null`. A test that only asserted "not the happy
 * principal" would pass even if the provider threw, so the comparison is
 * exact.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";

import { createProxyAuthProvider } from "../auth/providers/proxy.js";

const ALG = "RS256";
const JWT_HEADER = "cf-access-jwt-assertion";

// Placeholders, in the style the privacy guard accepts: every dash-group is a
// single repeated character. The audience and the wrong audience must differ,
// or the wrong-audience case would prove nothing.
const AUDIENCE = "11111111-2222-3333-4444-555555555555";
const OTHER_AUDIENCE = "99999999-8888-7777-6666-555555555555";

let jwksSerial = 0;
/** A fresh URL per case: jose caches a key set per URL, inside the module. */
const freshJwksUrl = () => `https://proxy.test.invalid/${++jwksSerial}/cdn-cgi/access/certs`;
const ISSUER = "https://proxy.test.invalid";

async function makeKeys() {
    const { publicKey, privateKey } = await jose.generateKeyPair(ALG, { extractable: true });
    const jwk = await jose.exportJWK(publicKey);
    return { privateKey, jwks: { keys: [{ ...jwk, alg: ALG, use: "sig", kid: "test-key" }] } };
}

function sign(privateKey, { issuer = ISSUER, audience = AUDIENCE, expiresIn = "5m", notBefore = "0s", subject = "user-1" } = {}) {
    return new jose.SignJWT({ email: "user@test.invalid", name: "Test User" })
        .setProtectedHeader({ alg: ALG, kid: "test-key" })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setNotBefore(notBefore)
        .setExpirationTime(expiresIn)
        .sign(privateKey);
}

/**
 * `globalThis.fetch` is process-wide, so it is restored in a finally block: a
 * case that fails must not leave the next one talking to the real network.
 */
async function withProvider(t, { jwksUrl, jwks }, fn) {
    const prevFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url;
        const method = (init?.method || "GET").toUpperCase();
        fetchCalls.push(url);
        if (url === jwksUrl) {
            if (method !== "GET") throw new Error(`[test] JWKS must be fetched with GET, saw ${method}`);
            return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error(`[test] unexpected network call to ${url} - only this test's JWKS may be fetched`);
    };

    try {
        const provider = createProxyAuthProvider({
            env: {
                PORTAL_AUTH_PROXY_JWKS_URL: jwksUrl,
                PORTAL_AUTH_PROXY_ISSUER: ISSUER,
                PORTAL_AUTH_PROXY_AUDIENCE: AUDIENCE,
            },
        });
        assert.equal(provider.enabled, true, "the proxy provider must be configured for this case to mean anything");
        await fn({ provider, fetchCalls });
    } finally {
        globalThis.fetch = prevFetch;
    }
}

/** The provider reads the assertion from a header, not a bearer token. */
const requestWith = assertion => ({ headers: { [JWT_HEADER]: assertion } });

const authenticate = (provider, assertion) => provider.authenticateRequest(undefined, requestWith(assertion));

test("REAL EXPIRY control: a valid assertion is ACCEPTED and yields a principal", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider, fetchCalls }) => {
        const principal = await authenticate(provider, await sign(privateKey));
        assert.notEqual(principal, null, "a valid assertion must authenticate, or every negative below is vacuous");
        assert.equal(principal.provider, "proxy");
        assert.deepEqual(fetchCalls, [jwksUrl], "only this test's JWKS may be fetched");
    });
});

test("REAL EXPIRY: an EXPIRED assertion is rejected, proving the expiry check is live", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider }) => {
        // Paired control first: the same key and issuer authenticate when fresh,
        // so the rejection below is attributable to expiry and nothing else.
        assert.notEqual(await authenticate(provider, await sign(privateKey)), null, "control: a fresh assertion authenticates");

        const expired = await sign(privateKey, { expiresIn: "-1m" });
        assert.equal(await authenticate(provider, expired), null, "an expired assertion must not authenticate");
    });
});

test("REAL EXPIRY: a wrong-ISSUER assertion is rejected, proving that check is live", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider }) => {
        assert.notEqual(await authenticate(provider, await sign(privateKey)), null, "control: the correct issuer authenticates");

        const foreign = await sign(privateKey, { issuer: "https://attacker.test.invalid" });
        assert.equal(await authenticate(provider, foreign), null, "an assertion from another issuer must not authenticate");
    });
});

test("REAL EXPIRY: a wrong-AUDIENCE assertion is rejected, proving that check is live", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider }) => {
        assert.notEqual(await authenticate(provider, await sign(privateKey)), null, "control: the correct audience authenticates");

        const other = await sign(privateKey, { audience: OTHER_AUDIENCE });
        assert.equal(await authenticate(provider, other), null, "an assertion for another audience must not authenticate");
    });
});

test("REAL EXPIRY: a TAMPERED assertion is rejected, so the key set is genuinely verified", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider }) => {
        const good = await sign(privateKey);
        assert.notEqual(await authenticate(provider, good), null, "control: the untampered assertion authenticates");

        // Flip one character of the signature segment. The header and payload
        // stay valid, so only signature verification can reject this.
        const [header, payload, signature] = good.split(".");
        const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
        assert.equal(await authenticate(provider, `${header}.${payload}.${flipped}`), null,
            "a tampered signature must not authenticate");
    });
});

test("REAL EXPIRY: an assertion signed by an UNRELATED key is rejected", async () => {
    const jwksUrl = freshJwksUrl();
    const { privateKey, jwks } = await makeKeys();
    const foreign = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider }) => {
        assert.notEqual(await authenticate(provider, await sign(privateKey)), null, "control: the published key authenticates");

        assert.equal(await authenticate(provider, await sign(foreign.privateKey)), null,
            "an assertion signed by a key outside the published set must not authenticate");
    });
});

test("a missing assertion header is refused, not treated as anonymous success", async () => {
    const jwksUrl = freshJwksUrl();
    const { jwks } = await makeKeys();
    await withProvider(null, { jwksUrl, jwks }, async ({ provider, fetchCalls }) => {
        assert.equal(await provider.authenticateRequest(undefined, { headers: {} }), null,
            "no assertion must not authenticate");
        assert.deepEqual(fetchCalls, [], "a request with no assertion must not even fetch the key set");
    });
});
