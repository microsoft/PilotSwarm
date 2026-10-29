/**
 * A complete, inert `ServerContext` for tests that drive the REAL
 * `createMcpServer()` over an in-memory transport.
 *
 * Why this exists: `ServerContext` is a TypeScript type, so it is erased at
 * runtime. Nothing stops a `.mjs` test from passing an object that merely
 * looks close enough — and a missing field does not surface at the call site.
 * It surfaces later, as a crash inside whichever registrar touches it first
 * (`registerSkillPrompts` iterating `ctx.skills` gives `TypeError: ctx.skills
 * is not iterable`, inside built output, with no hint of which test is at
 * fault).
 *
 * The damage is worse than a confusing message: the crash happens in setup,
 * BEFORE any case runs, so the suite reports one hard failure while its actual
 * assertions are neither passed nor failed. A reader scanning for red sees a
 * single error, not "none of this file's coverage exists".
 *
 * So: start from a complete base here, override only what the test is about,
 * and let `assertContextComplete` reject a context that would crash a
 * registrar — at construction, naming the field.
 */

/** Fields `createMcpServer`'s registrars iterate or call, with the shape each needs. */
const REQUIRED = {
    mgmt: "object",
    facts: "object",
    skills: "iterable",
    registeredAgents: "iterable",
    systemAgentIds: "iterable",
    refreshSystemAgentIds: "function",
    authz: "object",
};

function isIterable(v) {
    return v != null && typeof v[Symbol.iterator] === "function";
}

/**
 * Fail at construction, naming the field — instead of deep inside a registrar
 * once the server is already half-built.
 */
export function assertContextComplete(ctx) {
    const problems = [];
    for (const [field, kind] of Object.entries(REQUIRED)) {
        const value = ctx[field];
        if (kind === "iterable" && !isIterable(value)) {
            problems.push(`ctx.${field} must be iterable (got ${value === undefined ? "undefined" : typeof value})`);
        } else if (kind === "function" && typeof value !== "function") {
            problems.push(`ctx.${field} must be a function (got ${typeof value})`);
        } else if (kind === "object" && (value === null || typeof value !== "object")) {
            problems.push(`ctx.${field} must be an object (got ${value === null ? "null" : typeof value})`);
        }
    }
    if (problems.length) {
        throw new Error(
            `Incomplete fake ServerContext — createMcpServer would crash during registration:\n  - ${problems.join("\n  - ")}`,
        );
    }
    return ctx;
}

/**
 * A complete inert context. Every capability is OFF, so only the
 * unconditional tool surface registers and a test sees nothing it did not ask
 * for. `overrides` is spread last; the result is checked before it is returned.
 */
export function makeServerContext(overrides = {}) {
    return assertContextComplete({
        client: {},
        mgmt: {},
        facts: { async readFacts() { return { count: 0, facts: [] }; } },
        enhancedFacts: null,
        graph: null,
        api: null,
        web: null,
        admin: false,
        agentMgmt: "off",
        role: null,
        authz: { ownershipEnforced: false, defaultVisibility: "private", systemVisibility: "read" },
        webMode: false,
        models: null,
        skills: [],
        registeredAgents: [],
        systemAgentIds: new Set(),
        async refreshSystemAgentIds() {},
        ...overrides,
    });
}
