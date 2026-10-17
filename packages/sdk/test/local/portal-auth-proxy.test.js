/**
 * Proxy auth provider — identity established by an identity-aware proxy in
 * front of the portal (Cloudflare Access, Google IAP, AWS ALB, Pomerium,
 * oauth2-proxy, Authelia, Authentik).
 *
 * Exercises the real provider's claim/header handling and refusal to trust
 * unsigned headers by default. No store or model is required.
 *
 * Signed assertions use locally generated keypairs with data-URL and loopback
 * HTTP JWKS fixtures. No external identity service is required.
 *
 * Run: npx vitest run test/local/portal-auth-proxy.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import * as jose from "jose";
import { createProxyAuthProvider } from "../../../app/web/auth/providers/proxy.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const ISSUER = "https://grimfanda.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

let privateKey;
let jwksJson;

function reqWith(headers) {
    return { headers };
}

/** Provider configured for the signed-assertion path, JWKS served from a data: URL. */
function jwtProvider(extra = {}) {
    return createProxyAuthProvider({
        env: {
            PORTAL_AUTH_PROXY_MODE: "jwt",
            PORTAL_AUTH_PROXY_JWT_HEADER: "cf-access-jwt-assertion",
            PORTAL_AUTH_PROXY_JWKS_URL: `data:application/json;base64,${Buffer.from(jwksJson).toString("base64")}`,
            PORTAL_AUTH_PROXY_ISSUER: ISSUER,
            PORTAL_AUTH_PROXY_AUDIENCE: AUDIENCE,
            ...extra,
        },
    });
}

describe.concurrent("portal proxy real JWKS rejection controls", () => {
    let server;
    let provider;
    let signingKey;
    let otherKey;
    let publicJwk;
    let validAssertion;
    const issuer = "https://identity.example.invalid";
    const audience = "portal-auth-characterization";
    const header = "x-example-assertion";

    const authenticate = (assertion) => provider.authenticateRequest(null, {
        headers: assertion === undefined ? {} : { [header]: assertion },
    });

    async function sign(overrides = {}) {
        return new jose.SignJWT({ sub: "alice", email: "alice@example.invalid" })
            .setProtectedHeader({ alg: "RS256", kid: "characterization", ...overrides.header })
            .setIssuer(overrides.issuer ?? issuer)
            .setAudience(overrides.audience ?? audience)
            .setIssuedAt()
            .setExpirationTime(overrides.expiresAt ?? "5m")
            .sign(overrides.key ?? signingKey);
    }

    async function expectRejected(assertion) {
        const control = await authenticate(validAssertion);
        assertEqual(control?.subject, "alice", "the same verifier must accept the valid control");
        assertEqual(await authenticate(assertion), null, "invalid assertion must not authenticate");
    }

    beforeAll(async () => {
        const pair = await jose.generateKeyPair("RS256", { extractable: true });
        signingKey = pair.privateKey;
        otherKey = (await jose.generateKeyPair("RS256")).privateKey;
        publicJwk = { ...await jose.exportJWK(pair.publicKey), kid: "characterization", alg: "RS256", use: "sig" };
        server = http.createServer((req, res) => {
            if (req.method !== "GET" || req.url !== "/jwks") {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [publicJwk] }));
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        provider = createProxyAuthProvider({
            env: {
                PORTAL_AUTH_PROXY_MODE: "jwt",
                PORTAL_AUTH_PROXY_JWT_HEADER: header,
                PORTAL_AUTH_PROXY_JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
                PORTAL_AUTH_PROXY_ISSUER: issuer,
                PORTAL_AUTH_PROXY_AUDIENCE: audience,
            },
        });
        validAssertion = await sign();
    });

    afterAll(async () => {
        if (!server?.listening) return;
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
    });

    it("uses a public-only signing JWKS and accepts its matching assertion", async () => {
        for (const field of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
            assertEqual(Object.hasOwn(publicJwk, field), false, `JWKS must not disclose ${field}`);
        }
        assertEqual(publicJwk.alg, "RS256");
        assertEqual(publicJwk.use, "sig");
        assertEqual((await authenticate(validAssertion))?.subject, "alice");
    });

    it("rejects expired assertions after a valid control", async () => {
        await expectRejected(await sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 }));
    });

    it("rejects a wrong issuer after a valid control", async () => {
        await expectRejected(await sign({ issuer: "https://other.example.invalid" }));
    });

    it("rejects a wrong audience after a valid control", async () => {
        await expectRejected(await sign({ audience: "another-portal" }));
    });

    it("rejects a different signing key after a valid control", async () => {
        await expectRejected(await sign({ key: otherKey }));
    });

    it("rejects an HMAC assertion using public JWKS material as its key", async () => {
        const assertion = await new jose.SignJWT({ sub: "alice" })
            .setProtectedHeader({ alg: "HS256", kid: "characterization" })
            .setIssuer(issuer).setAudience(audience).setExpirationTime("5m")
            .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));
        await expectRejected(assertion);
    });

    it("rejects unsigned assertions after a valid control", async () => {
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const assertion = [
            encode({ alg: "none" }),
            encode({ sub: "alice", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300 }),
            "",
        ].join(".");
        await expectRejected(assertion);
    });

    it("rejects a forged payload after a valid control", async () => {
        const [protectedHeader, , signature] = validAssertion.split(".");
        const payload = Buffer.from(JSON.stringify({
            sub: "mallory", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300,
        })).toString("base64url");
        await expectRejected(`${protectedHeader}.${payload}.${signature}`);
    });

    it("rejects a missing assertion after a valid control", async () => {
        await expectRejected(undefined);
    });
});

async function mintAssertion(claims, { issuer = ISSUER, audience = AUDIENCE } = {}) {
    return new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("5m")
        .sign(privateKey);
}

describe("portal proxy auth provider", () => {
    beforeAll(async () => {
        const { publicKey, privateKey: pk } = await jose.generateKeyPair("RS256", { extractable: true });
        privateKey = pk;
        const jwk = await jose.exportJWK(publicKey);
        jwk.kid = "test-key";
        jwk.alg = "RS256";
        jwksJson = JSON.stringify({ keys: [jwk] });
    });

    it("accepts a signed assertion and normalizes the principal", async () => {
        const provider = jwtProvider();
        assert(provider.enabled, "provider should be enabled when jwks/issuer/audience are set");

        const token = await mintAssertion({
            sub: "cf-subject-1",
            email: "manny@grimfanda.com",
            name: "Manny Calavera",
        });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));

        assert(principal, "a valid assertion should produce a principal");
        assertEqual(principal.provider, "proxy", "provider tag");
        assertEqual(principal.subject, "cf-subject-1", "subject comes from the sub claim");
        assertEqual(principal.email, "manny@grimfanda.com", "email claim");
        assertEqual(principal.displayName, "Manny Calavera", "name claim");
    });

    it("rejects an assertion signed for a different audience", async () => {
        const provider = jwtProvider();
        const token = await mintAssertion({ sub: "x", email: "x@y.z" }, { audience: "some-other-app" });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));
        assertEqual(principal, null, "an audience mismatch must not authenticate");
    });

    it("rejects a garbage assertion", async () => {
        const provider = jwtProvider();
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": "not-a-jwt" }));
        assertEqual(principal, null, "an unparseable assertion must not authenticate");
    });

    it("returns no principal when the proxy header is absent", async () => {
        const provider = jwtProvider();
        const principal = await provider.authenticateRequest(null, reqWith({}));
        assertEqual(principal, null, "a request that never passed through the proxy must not authenticate");
    });

    it("refuses to start in header mode without an explicit trust opt-in", () => {
        let threw = null;
        try {
            createProxyAuthProvider({ env: { PORTAL_AUTH_PROXY_MODE: "header" } });
        } catch (error) {
            threw = error;
        }
        assert(threw, "unsigned header mode must not start silently");
        assert(
            /PORTAL_AUTH_PROXY_TRUST_HEADERS/.test(threw.message),
            "the error should name the opt-in that acknowledges the risk",
        );
    });

    it("reads plain headers once trust is explicitly opted into", async () => {
        const provider = createProxyAuthProvider({
            env: { PORTAL_AUTH_PROXY_MODE: "header", PORTAL_AUTH_PROXY_TRUST_HEADERS: "true" },
        });
        const principal = await provider.authenticateRequest(null, reqWith({
            "x-forwarded-user": "eva",
            "x-forwarded-email": "eva@grimfanda.com",
            "x-forwarded-groups": "staff,records",
        }));
        assert(principal, "headers should authenticate in trusted header mode");
        assertEqual(principal.subject, "eva", "subject header");
        assertEqual(principal.email, "eva@grimfanda.com", "email header");
        assertEqual(principal.groups.join(","), "staff,records", "comma-separated groups are split");
    });

    it("falls back to the email as subject when the proxy supplies no stable id", async () => {
        const provider = jwtProvider();
        const token = await mintAssertion({ email: "glottis@grimfanda.com" });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));
        assert(principal, "an email alone is enough to key an identity");
        assertEqual(principal.subject, "glottis@grimfanda.com", "email becomes the subject");
    });

    it("advertises no browser client, because the proxy signs the user in", async () => {
        const provider = jwtProvider();
        const cfg = await provider.getPublicConfig();
        assertEqual(cfg.provider, "proxy", "public config names the provider");
        assertEqual(cfg.enabled, true, "public config reports enabled");
        assertEqual(cfg.client, null, "there is no browser-side client to configure");
    });

    it("declares that it authenticates from the request, not a bearer token", () => {
        const provider = jwtProvider();
        assertEqual(
            provider.authenticatesFromRequest,
            true,
            "the pipeline uses this to skip the bearer-token requirement",
        );
    });
});
