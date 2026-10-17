function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

const nullableString = (value) => value === null || typeof value === "string";
const stringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const nonemptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function parseRequestAuthContext(payload) {
    if (!object(payload) || !object(payload.authorization)) {
        return { status: "error", error: "The proxy admission response is missing an authorization decision." };
    }
    const authorization = payload.authorization;
    if (authorization.allowed === false) {
        return { status: "forbidden", error: "This identity is not authorized to access the portal." };
    }
    if (authorization.allowed !== true) {
        return { status: "error", error: "The proxy admission response has an invalid authorization decision." };
    }
    const principal = payload.principal;
    if (!object(principal) || !nonemptyString(principal.provider) || !nonemptyString(principal.subject)
        || !nullableString(principal.displayName) || !nullableString(principal.email) || !nullableString(principal.tenantId)
        || !stringArray(principal.groups) || !stringArray(principal.roles)
        || !nullableString(authorization.role) || !nullableString(authorization.reason)
        || !stringArray(authorization.matchedGroups)) {
        return { status: "error", error: "The proxy admission response does not contain a valid public identity." };
    }
    return {
        status: "authorized",
        principal: {
            provider: principal.provider, subject: principal.subject,
            displayName: principal.displayName, email: principal.email, tenantId: principal.tenantId,
            groups: [...principal.groups], roles: [...principal.roles],
        },
        authorization: {
            allowed: true, role: authorization.role, reason: authorization.reason,
            matchedGroups: [...authorization.matchedGroups],
        },
    };
}

export async function fetchRequestAuthContext(paths, fetchImpl = globalThis.fetch) {
    let response;
    try {
        response = await fetchImpl(paths.path("/api/auth/me"), { credentials: "same-origin", cache: "no-store", redirect: "error" });
    } catch (error) {
        return { status: "error", error: `Could not contact the portal for proxy sign-in: ${error?.message || String(error)}` };
    }
    if (response.status === 401) return { status: "unauthorized", error: "Sign in through the upstream proxy, then retry." };
    if (response.status === 403) return { status: "forbidden", error: "This identity is not authorized to access the portal." };
    if (!response.ok) return { status: "error", error: `Proxy admission failed (HTTP ${response.status}).` };
    if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get("content-type") || "")) {
        return { status: "error", error: "The proxy returned a non-JSON sign-in page instead of portal admission." };
    }
    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { status: "error", error: "The proxy admission response is not valid JSON." };
    }
    return parseRequestAuthContext(payload);
}
