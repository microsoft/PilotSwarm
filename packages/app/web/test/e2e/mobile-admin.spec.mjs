import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fixture, message } from "./motd-fixture.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium",
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

async function phoneFixture(page, { admin = true, themeId = "hearth" } = {}) {
    const errors = [];
    let profileSettings = { themeId, touchScale: false };
    page.on("pageerror", error => errors.push(error.message));
    const persona = { id: "phone-test", displayName: "Test User", email: "test@example.com" };
    await page.addInitScript(persona => sessionStorage.setItem("pilotswarm.devAuth.persona", JSON.stringify(persona)), persona);
    await page.route("**/api/portal-config", async route => {
        const response = await route.fetch();
        const body = await response.json();
        return route.fulfill({ json: { ...body, auth: { enabled: true, provider: "dev", client: { users: [persona] } } } });
    });
    const mutations = [];
    let deleted = false;
    const active = { versionId: "v1", semver: "1.0.0", sizeBytes: 4096, sha256: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00Z", manifest: { description: "A reusable research toolkit.", agents: [{ name: "Researcher", tools: ["search"] }] } };
    const pkg = { name: "research-kit", scope: "shared", enabled: true, owner: { provider: "none", subject: "test" },
        createdBy: "Test User", createdAt: "2026-01-01T00:00:00Z", active };
    await page.route("**/api/v1/agent-packages**", route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== "GET") {
            mutations.push({ path: url.pathname, method: request.method() });
            if (request.method() === "DELETE") deleted = true;
            return route.fulfill({ json: { ok: true, result: {} } });
        }
        let result;
        if (url.pathname.endsWith("/worker-state")) result = [];
        else if (url.pathname.endsWith("/tree")) result = { semver: "1.0.0", dirs: [], files: [{ path: "plugin.json", size: 32 }, { path: "README.md", size: 64 }] };
        else if (url.pathname.endsWith("/file")) result = { path: url.searchParams.get("filePath") || "plugin.json", encoding: "utf8", content: '{"name":"research-kit"}', size: 23 };
        else if (url.pathname.endsWith("/research-kit")) result = { ...pkg, activeVersionId: "v1", versions: [active], editors: [] };
        else result = deleted ? [] : [pkg];
        return route.fulfill({ json: { ok: true, result } });
    });
    await page.route(/\/api\/v1\/management\/(?:features\/cluster|users\/me\/features)(?:\?.*)?$/, route => route.fulfill({ json: { ok: true, result: { flags: [{
        featureKey: "copilot.native_tasks", revision: "1", displayName: "Native tasks", description: "Local delegation",
        defaultEnabled: false, defaultAllowUserOverride: true, cluster: null, user: null, effective: false, source: "default", supported: true,
    }] } } }));
    await page.route("**/api/v1/management/features/users**", route => route.fulfill({ json: { ok: true, result: [] } }));
    await page.route("**/api/v1/me/profile**", route => {
        if (new URL(route.request().url()).pathname.endsWith("/settings")) {
            profileSettings = route.request().postDataJSON().settings;
            return route.fulfill({ json: { ok: true, result: { profileSettings } } });
        }
        return route.fulfill({ json: { ok: true, result: { isAdmin: admin, profileSettings } } });
    });
    const f = await fixture(page, { admin, themeId, current: null, history: [message()] });
    await expect(page.locator(".ps-toolbar.is-mobile")).toBeVisible();
    return { ...f, mutations, errors, profileSettings: () => profileSettings };
}
const consoleRoot = page => page.locator(".ps-admin-console.is-mobile");
async function openConsole(page, admin = true) {
    await page.getByRole("button", { name: admin ? "Admin Console" : "Settings", exact: true }).click();
    await expect(consoleRoot(page).locator("[data-level='0']")).toBeVisible();
}
async function back(page, level) {
    await page.evaluate(() => history.back());
    if (level < 0) await expect(consoleRoot(page)).toHaveCount(0);
    else await expect(consoleRoot(page).locator(`[data-level='${level}']`)).toBeVisible();
}
async function screenshot(page, name) {
    if (!process.env.PS_MOBILE_ADMIN_CAPTURE_DIR) return;
    mkdirSync(process.env.PS_MOBILE_ADMIN_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.PS_MOBILE_ADMIN_CAPTURE_DIR}/${name}.png` });
}

for (const themeId of ["hearth", "github-light"]) for (const admin of [true, false]) {
    test(`phone header cog: plain ${admin ? "admin console" : "user settings"} in ${themeId}`, async ({ page }) => {
        // Hearth's firelight animates border tints; compare the buttons at rest.
        await page.emulateMedia({ reducedMotion: "reduce" });
        const f = await phoneFixture(page, { admin, themeId });
        try {
            const cog = page.getByRole("button", { name: admin ? "Admin Console" : "Settings", exact: true });
            await expect(cog).toBeVisible();
            await expect(cog.locator(".portal-mobile-settings__badge")).toHaveCount(0);
            await expect(cog).not.toContainText("✱");
            const box = await cog.boundingBox();
            const signOut = page.getByRole("button", { name: "Sign out", exact: true });
            const logout = await signOut.boundingBox();
            expect(box.width).toBe(logout.width); expect(box.height).toBe(logout.height);
            expect(box.y).toBe(logout.y);
            expect(logout.x - box.x - box.width).toBe(8);
            await expect(cog).toHaveAttribute("class", await signOut.getAttribute("class"));
            const visualStyle = node => {
                const style = getComputedStyle(node);
                return { border: style.border, radius: style.borderRadius, padding: style.padding };
            };
            // The cog renders after sign-in resolves, so a theme's border-colour
            // transition can be at a different point on each button for a moment.
            // Compare once both have settled.
            await expect.poll(async () => {
                const [mine, theirs] = [await cog.evaluate(visualStyle), await signOut.evaluate(visualStyle)];
                return JSON.stringify(mine) === JSON.stringify(theirs) ? "same" : JSON.stringify({ cog: mine, signOut: theirs });
            }).toBe("same");
            const glyph = await cog.locator("svg").boundingBox();
            const logoutGlyph = await signOut.locator("svg").boundingBox();
            expect(glyph.width).toBe(logoutGlyph.width); expect(glyph.height).toBe(logoutGlyph.height);
            const target = await cog.evaluate(node => {
                const box = node.getBoundingClientRect(), style = getComputedStyle(node, "::before");
                const width = parseFloat(style.width), height = parseFloat(style.height);
                const x = box.x + box.width / 2 - width / 2, y = box.y + node.clientTop;
                const points = [[x + 1, y + 1], [x + width - 1, y + 1], [x + 1, y + height - 1],
                    [x + width - 1, y + height - 1]];
                return { x, y, width, height, hitsButton: points.every(([x, y]) => document.elementFromPoint(x, y)?.closest("button") === node) };
            });
            expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
            expect(target.x + target.width).toBeLessThanOrEqual(logout.x);
            expect(target.hitsButton).toBe(true);
            expect(await signOut.evaluate(node => {
                const r = node.getBoundingClientRect();
                return document.elementFromPoint(r.x + 1, r.y + r.height / 2)?.closest("button") === node;
            })).toBe(true);
            console.log(JSON.stringify({ themeId, admin, button: { width: box.width, height: box.height },
                signOut: { width: logout.width, height: logout.height }, glyph: { width: glyph.width, height: glyph.height },
                target: { width: target.width, height: target.height }, gap: logout.x - box.x - box.width }));
            await screenshot(page, `header-${admin ? "admin" : "user"}-${themeId}`);
            await openConsole(page, admin);
            await expect(cog).toHaveAttribute("aria-expanded", "true");
            await cog.click();
            await expect(consoleRoot(page)).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => history.state?.psMobileAdmin || null)).toBeNull();
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

test("phone drill-in, on-screen Back, browser Back and external-close cleanup", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        const baselineLength = await page.evaluate(() => history.length);
        await openConsole(page);
        await screenshot(page, "console-root-hearth");
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
        await expect(page.getByRole("button", { name: "+ Add package", exact: true })).toHaveCount(0);
        await screenshot(page, "packages-hearth");
        await page.getByRole("button", { name: /research-kit/ }).click();
        await expect(consoleRoot(page).locator("[data-level='2']")).toBeVisible();
        await page.getByRole("button", { name: /plugin.json/ }).click();
        await expect(page.getByRole("region", { name: "File preview" })).toContainText("research-kit");
        await expect(consoleRoot(page).locator("[data-level='3']")).toBeVisible();
        expect(await page.evaluate(() => history.length)).toBe(baselineLength + 4);
        await back(page, 2);
        await page.getByRole("button", { name: "Back to Packages", exact: true }).click();
        await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
        await page.evaluate(() => history.forward());
        await expect(consoleRoot(page).locator("[data-level='2']")).toBeVisible();
        await expect(page.getByRole("heading", { name: "research-kit", exact: true }).first()).toBeVisible();
        await back(page, 1);
        await page.getByRole("searchbox", { name: "Find a package" }).fill("research");
        await page.getByRole("region", { name: "Packages", exact: true }).getByRole("button").click();
        await back(page, 1);
        await expect(page.getByRole("searchbox", { name: "Find a package" })).toHaveValue("research");
        await back(page, 0);
        await back(page, -1);
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: "Admin Console", exact: true }).click();
        await expect(consoleRoot(page)).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => history.state?.psMobileAdmin || null)).toBeNull();
        await openConsole(page);
        await back(page, -1);
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

for (const destination of ["Sessions", "Diagnostics"]) {
    test(`phone ${destination} toolbar exits the console`, async ({ page }) => {
        const f = await phoneFixture(page);
        try {
            await openConsole(page);
            await page.getByRole("button", { name: "Appearance", exact: true }).click();
            await page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: new RegExp(destination) }).click();
            await expect(consoleRoot(page)).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => history.state?.psMobileAdmin || null)).toBeNull();
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

for (const admin of [true, false]) {
    test(`phone MoTD read-only with ${admin ? "Delete" : "no author actions"}`, async ({ page }) => {
        const f = await phoneFixture(page, { admin });
        try {
            await openConsole(page, admin);
            await page.getByRole("button", { name: "Message of the day", exact: true }).click();
            const panel = page.getByRole("region", { name: "Message of the day settings" });
            await expect(panel).toContainText("Welcome");
            await expect(panel.locator("form")).toHaveCount(0);
            await expect(panel.getByRole("button", { name: /Duplicate|Phone view|Publish/ })).toHaveCount(0);
            await expect(panel.getByRole("button", { name: "Delete current message" })).toHaveCount(admin ? 1 : 0);
            if (admin) {
                await screenshot(page, "motd-hearth");
                page.once("dialog", async dialog => { expect(dialog.message()).toContain("cannot be undone"); await dialog.dismiss(); });
                await panel.getByRole("button", { name: "Delete current message" }).click();
                expect(f.state.calls).toEqual([]);
            }
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

test("phone package Delete is isolated, confirms and does not expose authoring", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: /research-kit/ }).click();
        const danger = page.getByRole("region", { name: "Package danger area" });
        await danger.scrollIntoViewIfNeeded();
        await expect(danger.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
        await expect(consoleRoot(page).getByRole("button", { name: /Update|Publish|Promote|Demote|Copy to/ })).toHaveCount(0);
        await screenshot(page, "package-danger-hearth");
        page.once("dialog", async dialog => { expect(dialog.message()).toContain("Every version"); await dialog.dismiss(); });
        await danger.getByRole("button", { name: "Delete", exact: true }).click();
        expect(f.mutations).toEqual([]);
        page.once("dialog", dialog => dialog.accept());
        await danger.getByRole("button", { name: "Delete", exact: true }).click();
        await expect.poll(() => f.mutations.length).toBe(1);
        expect(f.mutations[0].method).toBe("DELETE");
        await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

for (const themeId of ["hearth", "github-light"]) {
    test(`phone Appearance controls and ${themeId} theme`, async ({ page }) => {
        const f = await phoneFixture(page, { themeId });
        try {
            await openConsole(page);
            await page.getByRole("button", { name: "Appearance", exact: true }).click();
            const pane = page.getByRole("region", { name: "Appearance", exact: true });
            await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
            const touch = pane.getByRole("switch", { name: "Touch-size controls" });
            await expect(touch).toBeVisible();
            const checked = await touch.isChecked();
            await touch.setChecked(!checked);
            await expect(touch).toBeChecked({ checked: !checked });
            await expect.poll(() => f.profileSettings().touchScaleMobile).toBe(!checked);
            expect(f.profileSettings().touchScale).toBe(false);
            await expect(pane.getByRole("button", { name: /^Theme / })).toBeVisible();
            // Only the reading column is desktop-only; theme sounds have a phone setting.
            await expect(pane.locator("fieldset")).toHaveCount(1);
            await expect(pane.locator("fieldset").first()).toContainText("desktop only");
            for (const control of await pane.locator("fieldset input").all()) await expect(control).toBeDisabled();
            const sound = pane.getByRole("switch", { name: /Theme sounds/ });
            await expect(sound).toBeEnabled();
            await expect(sound, "on by default on a phone too").toBeChecked();
            await expect(pane.getByRole("slider", { name: "Theme sound volume" })).toBeVisible();
            await sound.setChecked(false);
            await expect(pane.getByRole("slider", { name: "Theme sound volume" })).toHaveCount(0);
            await expect.poll(() => f.profileSettings().themeSoundMobile?.on).toBe(false);
            expect(f.profileSettings().themeSound?.on ?? true, "the desktop setting is untouched").toBe(true);
            await sound.setChecked(true);
            await expect.poll(() => f.profileSettings().themeSoundMobile?.on).toBe(true);
            await screenshot(page, `appearance-${themeId}`);
            await pane.getByRole("button", { name: /^Theme / }).click();
            await expect(page.locator(".ps-modal.is-theme-picker")).toBeVisible();
            await page.evaluate(() => history.back());
            await expect(page.locator(".ps-modal.is-theme-picker")).toHaveCount(0);
            await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
            await page.reload();
            await openConsole(page);
            await page.getByRole("button", { name: "Appearance", exact: true }).click();
            await expect(page.getByRole("switch", { name: "Touch-size controls" })).toBeChecked({ checked: !checked });
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

test("phone closed history does not trap browser Back after toolbar exit", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        // A known predecessor proves the console does not merely hide while
        // leaving its old drill-in entries on the active Back path.
        await page.evaluate(() => {
            history.replaceState({ phoneTest: "before" }, "");
            history.pushState({ phoneTest: "workspace" }, "");
        });
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: /research-kit/ }).click();
        await page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: /Sessions/ }).click();
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("workspace");
        await page.evaluate(() => history.back());
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("before");
        await expect(consoleRoot(page)).toHaveCount(0);
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

test("phone console reopens after an interrupted exit rewind", async ({ page }) => {
    // Abort the first Navigation API rewind without moving, as a competing
    // navigation would. The console must still close and open again.
    await page.addInitScript(() => {
        const api = window.navigation;
        if (!api) return;
        const original = api.traverseTo.bind(api);
        let aborted = false;
        api.traverseTo = (key, options) => {
            if (aborted) return original(key, options);
            aborted = true;
            const error = new DOMException("Interrupted by a test", "AbortError");
            const finished = Promise.reject(error);
            finished.catch(() => {});
            return { committed: finished, finished };
        };
    });
    const f = await phoneFixture(page);
    try {
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: /Sessions/ }).click();
        await expect(consoleRoot(page)).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => Boolean(history.state?.psMobileAdmin))).toBe(false);
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});
test("phone providers have one entry, scope switch and full-screen add sheet", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        await openConsole(page);
        await expect(page.getByRole("button", { name: "Model Providers", exact: true })).toHaveCount(1);
        await expect(page.getByRole("button", { name: "My Providers", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "Model Providers", exact: true }).click();
        const scope = page.getByRole("group", { name: "Provider scope" });
        await expect(scope.getByRole("button", { name: "My", exact: true })).toBeVisible();
        for (const button of await scope.getByRole("button").all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await scope.getByRole("button", { name: "Shared", exact: true }).click();
        await expect(consoleRoot(page).getByRole("heading", { name: "Shared Providers", exact: true })).toBeVisible();
        await consoleRoot(page).getByRole("button", { name: "Add provider", exact: true }).click();
        const sheet = page.getByRole("dialog", { name: "Add model provider" });
        await expect(sheet).toBeVisible();
        const box = await sheet.boundingBox();
        expect(box.x).toBe(0); expect(box.y).toBe(0); expect(box.width).toBe(390); expect(box.height).toBeCloseTo(844, 1);
        await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(sheet).toHaveCount(0);
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

test("phone canvas and console never cover each other", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        const canvas = page.locator(".ps-mobile-canvas-layer");
        const entry = page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: /Show canvas/ });
        await page.locator(".ps-session-list-button").first().click();
        await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(1);
        await entry.click();
        await expect(canvas).not.toHaveClass(/is-hidden/);
        await openConsole(page);
        await expect(canvas).toHaveClass(/is-hidden/);
        await expect(consoleRoot(page).getByRole("heading", { level: 2 })).toBeFocused();
        await entry.click();
        await expect(consoleRoot(page)).toHaveCount(0);
        await expect(canvas).not.toHaveClass(/is-hidden/);
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

for (const overlay of ["provider", "theme", "motd"]) {
    test(`phone Back dismisses the ${overlay} overlay before its console section`, async ({ page }) => {
        const f = await phoneFixture(page);
        try {
            await openConsole(page);
            const section = overlay === "provider" ? "Model Providers" : overlay === "theme" ? "Appearance" : "Message of the day";
            await page.getByRole("button", { name: section, exact: true }).click();
            let dialog;
            if (overlay === "provider") {
                await consoleRoot(page).getByRole("button", { name: "Add provider", exact: true }).click();
                dialog = page.getByRole("dialog", { name: "Add model provider" });
            } else if (overlay === "theme") {
                await page.getByRole("region", { name: "Appearance", exact: true }).getByRole("button", { name: /^Theme / }).click();
                dialog = page.locator(".ps-modal.is-theme-picker");
            } else {
                await page.getByRole("button", { name: "Show splash again", exact: true }).click();
                dialog = page.getByRole("dialog", { name: "Message of the day preview", exact: true });
            }
            await expect(dialog).toBeVisible();
            await expect.poll(() => page.evaluate(() => history.state?.psMobileAdmin?.path.at(-1)?.kind)).toBe("overlay");
            await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
            await page.evaluate(() => history.back());
            await expect(dialog).toHaveCount(0);
            await expect(consoleRoot(page).locator("[data-level='1']")).toBeVisible();
            await page.evaluate(() => new Promise(resolve => {
                addEventListener("popstate", resolve, { once: true });
                history.forward();
            }));
            await expect.poll(() => page.evaluate(() => history.state?.psMobileAdmin?.path.at(-1)?.kind)).toBe("section");
            await expect(dialog).toHaveCount(0);
            await back(page, 0);
            await back(page, -1);
            expect(f.state.calls.filter(call => call.path.endsWith("/dismiss"))).toHaveLength(0);
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

test("phone reload clears abandoned console entries", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        await page.evaluate(() => {
            history.replaceState({ phoneTest: "before" }, "");
            history.pushState({ phoneTest: "workspace" }, "");
        });
        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: /research-kit/ }).click();
        await page.getByRole("button", { name: /plugin.json/ }).click();
        await expect(page.getByRole("region", { name: "File preview" })).toContainText("research-kit");
        await page.reload();
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("workspace");
        await expect(consoleRoot(page)).toHaveCount(0);
        await openConsole(page);
        await back(page, -1);
        await page.evaluate(() => history.back());
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("before");
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

test("phone pending Back and toolbar exit rewind only the remaining entries", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        await page.evaluate(() => {
            history.replaceState({ phoneTest: "before" }, "");
            history.pushState({ phoneTest: "workspace" }, "");
        });

        await openConsole(page);
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: /research-kit/ }).click();
        await page.evaluate(() => {
            history.back();
            document.querySelector('.ps-toolbar.is-mobile button[aria-label^="Sessions"]').click();
        });
        await expect(consoleRoot(page)).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("workspace");
        await openConsole(page);
        await back(page, -1);
        await page.evaluate(() => history.back());
        await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("before");
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

for (const level of [0, 2]) {
    test(`phone legacy history serializes in-app Back and exit at level ${level}`, async ({ page }) => {
        await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
        const f = await phoneFixture(page);
        try {
            await page.evaluate(() => {
                history.replaceState({ phoneTest: "before" }, "");
                history.pushState({ phoneTest: "workspace" }, "");
            });
            await openConsole(page);
            if (level === 2) {
                await page.getByRole("button", { name: "Packages", exact: true }).click();
                await page.getByRole("button", { name: /research-kit/ }).click();
            }
            await page.evaluate(() => {
                document.querySelector(".ps-admin-back").click();
                document.querySelector('.ps-toolbar.is-mobile button[aria-label^="Sessions"]').click();
            });
            await expect(consoleRoot(page)).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("workspace");
            await openConsole(page);
            await page.evaluate(() => {
                document.querySelector(".ps-admin-back").click();
                document.querySelector(".ps-admin-back")?.click();
            });
            await expect(consoleRoot(page)).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("workspace");
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => history.state?.phoneTest)).toBe("before");
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}

test("phone workers render expandable cards instead of a wide table", async ({ page }) => {
    const f = await phoneFixture(page);
    try {
        await openConsole(page);
        await page.getByRole("button", { name: "Workers", exact: true }).click();
        await expect(page.locator(".ps-admin-worker-card").first()).toBeVisible();
        await expect(page.locator(".ps-admin-workers__table")).toHaveCount(0);
        await page.locator(".ps-admin-worker-card summary").first().click();
        await expect(page.locator(".ps-admin-worker-card dl").first()).toBeVisible();
        expect(f.errors).toEqual([]);
    } finally { await f.stop(); }
});

for (const admin of [true, false]) {
    test(`phone feature flags are ${admin ? "manageable" : "read only"}`, async ({ page }) => {
        const f = await phoneFixture(page, { admin });
        try {
            await openConsole(page, admin);
            await page.getByRole("button", { name: "Feature flags", exact: true }).click();
            const flag = page.getByRole("switch", { name: /Native tasks/ });
            await expect(flag).toBeVisible();
            if (admin) {
                await expect(flag).toBeEnabled();
                const wasOn = await flag.isChecked();
                await flag.setChecked(!wasOn);
                await expect(consoleRoot(page).getByRole("button", { name: "Save changes" })).toBeEnabled();
                // Back to the saved state: no personal override is pending.
                await flag.setChecked(wasOn);
                await expect(consoleRoot(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
                await flag.setChecked(!wasOn);
                await expect(consoleRoot(page).getByRole("button", { name: "Save changes" })).toBeEnabled();
            } else {
                await expect(flag).toBeDisabled();
                await expect(consoleRoot(page).getByRole("button", { name: "Save changes" })).toHaveCount(0);
            }
            expect(f.errors).toEqual([]);
        } finally { await f.stop(); }
    });
}
