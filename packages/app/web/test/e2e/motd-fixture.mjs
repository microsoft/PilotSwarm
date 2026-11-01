import { startStubServer } from "./stub-server.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const picture = { base64: PNG, contentType: "image/png", alt: "Main picture" };
export const message = extra => ({ motdId: "1", fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
    bodyMd: "## Welcome\nUse the portal.", mobileBodyMd: null, imagePlacement: "above", hasImage: false,
    hasMobileImage: false, createdBy: { subject: "admin" }, status: "live", dismissalCount: 0, ...extra });

export async function fixture(page, { admin = true, current = message(), history = null, themeId = null } = {}) {
    const stub = await startStubServer(0, { sessionCount: 1, admin, themeId });
    const state = { current, history: history || (current ? [current] : []), calls: [], imageRequests: [],
        reads: 0, nextId: 2, failDismiss: false, failCreate: false };
    const principal = { provider: "none", subject: "test", displayName: "Test User" };
    const authorization = { allowed: true, role: admin ? "admin" : "user" };
    await page.route("**/api/v1/bootstrap", async route => {
        const response = await route.fetch();
        const body = await response.json();
        return route.fulfill({ json: { ...body, auth: { principal, authorization } } });
    });
    await page.route("**/api/auth/me", route => route.fulfill({ json: { ok: true,
        principal: { provider: "none", subject: "test", displayName: "Test User" },
        authorization: { allowed: true, role: admin ? "admin" : "user" } } }));
    await page.route("**/api/v1/management/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.endsWith("/users/me/profile")) return route.fulfill({ json: { ok: true,
            result: { ...principal, isAdmin: admin, profileSettings: themeId ? { themeId } : {} } } });
        if (!url.pathname.includes("/motd")) return route.fallback();
        if (url.pathname.endsWith("/current")) {
            state.reads++;
            return route.fulfill({ json: { ok: true, result: state.current } });
        }
        if (url.pathname.endsWith("/image")) {
            const id = url.pathname.split("/").at(-2);
            const row = state.history.find(entry => entry.motdId === id) || (state.current?.motdId === id ? state.current : null);
            if (!row || !admin && Date.parse(row.fromAt) > Date.now()) return route.fulfill({ status: 404, json: { ok: false, error: { code: "MOTD_NOT_FOUND", message: "Message not found" } } });
            state.imageRequests.push(url.searchParams.get("mobile") === "true");
            return route.fulfill({ json: { ok: true,
                result: { ...picture, alt: url.searchParams.get("mobile") === "true" && row.hasMobileImage ? "Phone picture" : "Main picture" } } });
        }
        if (request.method() === "GET") {
            const rows = admin ? state.history : state.history.filter(row => Date.parse(row.fromAt) <= Date.now())
                .map(({ createdBy, dismissalCount, ...row }) => row);
            return route.fulfill({ json: { ok: true, result: rows } });
        }
        const input = request.method() === "POST" ? request.postDataJSON() || {} : {};
        state.calls.push({ path: url.pathname, method: request.method(), input });
        if (url.pathname.endsWith("/dismiss")) {
            if (state.failDismiss) return route.fulfill({ status: 503, json: { ok: false, error: { code: "UNAVAILABLE", message: "Dismissal not saved" } } });
            state.current = null;
        } else if (!admin) {
            return route.fulfill({ status: 403, json: { ok: false, error: { code: "MOTD_FORBIDDEN", message: "Message management requires admin" } } });
        } else if (request.method() === "DELETE") {
            const id = url.pathname.split("/").at(-1);
            state.history = state.history.filter(m => m.motdId !== id);
            if (state.current?.motdId === id) state.current = null;
        } else {
            if (state.failCreate) return route.fulfill({ status: 503, json: { ok: false, error: { code: "UNAVAILABLE", message: "Publication response uncertain" } } });
            const fromAt = input.startsAt || input.fromAt || new Date().toISOString();
            const toAt = input.endsAt || input.toAt || null;
            state.history.unshift(message({ ...input, fromAt, toAt, startsAt: fromAt, endsAt: toAt,
                createdAt: input.startsAt || input.fromAt ? new Date().toISOString() : fromAt,
                motdId: String(state.nextId++), status: Date.parse(fromAt) > Date.now() ? "scheduled" : "live" }));
        }
        return route.fulfill({ json: { ok: true, result: { motdId: "1", dismissed: true } } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}`);
    return { state, stop: async () => {
        await page.close();
        // Release fixture connections before waiting for its browser HTTP client.
        const closed = new Promise(resolve => {
            stub.server.close(resolve);
            stub.server.closeAllConnections();
        });
        await page.request.dispose();
        await closed;
    } };
}
