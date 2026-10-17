/**
 * REAL AUTH-PATH CONTROLS for the paged session read (issue 148).
 *
 * These exist because of a precise limitation in the companion file,
 * session-events-page-portal-authz.test.mjs: it replaces `requireAuth` with a
 * test function that returns `reject: true`. That proves a rejection
 * PROPAGATES — the request is refused and never reaches the session catalog —
 * but it proves nothing about whether the shipped code would have rejected
 * that caller in the first place. The middleware was told to refuse; it did
 * not decide to.
 *
 * So this file drives the SHIPPED credential path instead:
 *   - `createDevAuthProvider` — the real provider, with synthetic personas
 *   - `authorizePrincipal`    — the real authorization engine
 *   - `extractToken`          — the real header parsing
 *
 * Nothing is stubbed. No success-shaped result is forged: every positive case
 * authenticates by presenting a credential the real parser accepts, and every
 * negative case is a real rejection by that parser.
 *
 * ── WHAT THIS CANNOT COVER, STATED PLAINLY ──────────────────────────────
 *
 * EXPIRY IS NOT TESTED HERE, AND IS NOT TESTED ANYWHERE IN THIS REPO TODAY.
 * The dev provider has no expiry concept at all: its credential is the
 * literal string `dev:<persona>` with no validity window, so an expired dev
 * token is not a thing that can exist. Real expiry enforcement lives in the
 * Entra provider, where `jose.jwtVerify` checks `exp` (auth/providers/entra.js).
 *
 * To be precise about what that gap is and is not: it is NOT a claim that a
 * live identity provider is permanently required to test expiry. `jose`
 * verifies against a key set, and a SUPPORTED local JWKS fixture — a
 * generated key pair, a signed token with a past `exp`, and the real
 * `jwtVerify` call — would exercise the genuine validation path offline
 * without bypassing anything. That is a reasonable thing to build later.
 *
 * What I will not do is fake it HERE. A hand-rolled expiry check in this file
 * would assert my idea of expiry rather than `jose`'s, and would read in a
 * report as coverage that does not exist. So: expiry is an OPEN GAP as of
 * this head, closable by a JWKS fixture against real validation.
 *
 * The catalog substitution in the companion file also remains an explicit
 * limit: these controls are about CREDENTIALS, not about the session store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createDevAuthProvider } from "../auth/providers/dev.js";
import { authorizePrincipal } from "../auth/authz/engine.js";
import { extractToken } from "../auth/index.js";

/** Synthetic env — never process.env, so no ambient configuration leaks in. */
const DEV_ENV = {
    PORTAL_AUTH_PROVIDER: "dev",
    PORTAL_AUTH_DEV_ALLOW: "true",
    PORTAL_AUTH_DEV_USERS: "alice:user,ada:admin",
};

const provider = () => createDevAuthProvider({ env: DEV_ENV });

// ── POSITIVE: the real parser accepts a real credential ──────────────────

test("REAL AUTH: a valid dev credential authenticates through the shipped provider", async () => {
    const principal = await provider().authenticateRequest("dev:alice");
    assert.ok(principal, "the shipped parser must accept a rostered persona");
    assert.equal(principal.provider, "dev");
    assert.equal(principal.subject, "alice");
    assert.deepEqual(principal.roles, ["user"], "roles come from the roster, not the caller");
});

test("REAL AUTH: the authorization engine grants on the real principal", async () => {
    const principal = await provider().authenticateRequest("dev:alice");
    const decision = authorizePrincipal(principal, {});
    assert.equal(decision.allowed, true, "a valid rostered principal must be allowed");
    assert.equal(decision.role, "user", "and must carry its real role, not an assumed one");
});

test("REAL AUTH: an admin persona resolves to the admin role, not by assertion", async () => {
    const principal = await provider().authenticateRequest("dev:ada");
    const decision = authorizePrincipal(principal, {});
    assert.equal(decision.allowed, true);
    assert.equal(decision.role, "admin");
});

// ── NEGATIVE: real rejections by the real parser ─────────────────────────

test("REAL AUTH (anonymous): no credential is rejected by the shipped parser", async () => {
    // The companion file SCRIPTS this outcome. Here the parser decides.
    for (const absent of [undefined, null, ""]) {
        assert.equal(await provider().authenticateRequest(absent), null,
            `absent credential ${JSON.stringify(absent)} must not authenticate`);
    }
});

test("REAL AUTH: an unknown persona is rejected even with a well-formed credential", async () => {
    assert.equal(await provider().authenticateRequest("dev:mallory"), null,
        "a credential whose shape is right but whose subject is not rostered must fail");
});

test("REAL AUTH: a foreign or forged credential shape is rejected", async () => {
    for (const forged of [
        "Bearer dev:alice",                 // scheme left on by mistake
        "eyJhbGciOiJIUzI1NiJ9.e30.x",       // a JWT-shaped string
        "alice",                            // bare persona, no provider prefix
        "DEV:alice",                        // wrong-case prefix
        "dev:",                             // empty persona
        "dev:alice extra",                  // trailing junk
    ]) {
        assert.equal(await provider().authenticateRequest(forged), null,
            `forged credential ${JSON.stringify(forged)} must not authenticate`);
    }
});

test("REAL AUTH: a non-string credential cannot authenticate", async () => {
    for (const bad of [0, 1, true, {}, [], { toString: () => "dev:alice" }]) {
        assert.equal(await provider().authenticateRequest(bad), null,
            "only a real string credential may authenticate");
    }
});

// ── The shipped header parsing, not a reimplementation ───────────────────

test("REAL AUTH: extractToken reads the credential the shipped way", () => {
    assert.equal(extractToken({ headers: { authorization: "Bearer dev:alice" } }), "dev:alice");
    assert.equal(extractToken({ headers: {} }), undefined, "no header yields no credential");
    assert.equal(extractToken({ headers: { authorization: "dev:alice" } }), undefined,
        "a credential without the Bearer scheme is not extracted");
});

test("REAL AUTH: a header-extracted credential survives the full parse", async () => {
    const token = extractToken({ headers: { authorization: "Bearer dev:alice" } });
    const principal = await provider().authenticateRequest(token);
    assert.ok(principal, "extraction and validation must agree end to end");
    assert.equal(principal.subject, "alice");
});

// ── The provider's own refusal-to-start guards ───────────────────────────

test("REAL AUTH: the dev provider refuses to start without an explicit opt-in", () => {
    assert.throws(
        () => createDevAuthProvider({ env: { PORTAL_AUTH_PROVIDER: "dev" } }),
        /PORTAL_AUTH_DEV_ALLOW/,
        "a provider that authenticates anyone must not start by default",
    );
});

test("REAL AUTH: the dev provider refuses to coexist with a real identity provider", () => {
    assert.throws(
        () => createDevAuthProvider({
            env: { ...DEV_ENV, PORTAL_AUTH_ENTRA_TENANT_ID: "contoso" },
        }),
        /PORTAL_AUTH_ENTRA_/,
        "a test provider must never silently shadow a configured real IdP",
    );
});

// ── The gap, asserted as a gap ───────────────────────────────────────────

test("REAL AUTH: expiry is NOT enforceable by this provider, and is not faked", async () => {
    // Recorded as an executable statement rather than a comment, so the day
    // the dev provider grows a validity window this test fails and forces the
    // expiry coverage to be written properly.
    const principal = await provider().authenticateRequest("dev:alice");
    assert.ok(principal, "control: the credential authenticates");
    assert.equal(principal.rawClaims?.exp, undefined,
        "the dev credential carries no expiry claim, so expiry cannot be exercised through "
        + "this provider. Real enforcement is jose.jwtVerify in the Entra provider; a local "
        + "JWKS fixture could drive that genuine path later. Open gap, not faked here.");
});
