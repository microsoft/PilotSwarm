import { test, expect } from "@playwright/test";
import { fixture, message } from "./motd-fixture.mjs";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`MoTD external-only links render honestly at ${viewport.width}px`, async ({ page, context }) => {
        await page.setViewportSize(viewport);
        await context.route("https://example.invalid/**", route => route.fulfill({ contentType: "text/html", body: "<title>Destination</title>" }));
        const f = await fixture(page, { current: message({ bodyMd:
            "[Markdown web](https://example.invalid/guide)\n\nhttps://example.invalid/bare\n\nwww.example.invalid\n\n[Email me](mailto:reader@example.invalid)\n\n"
            + "[Relative label](docs/readme.md)\n\n[Anchor label](#anchor)\n\n[Javascript label](javascript:alert%281%29)\n\n[**Bold neutral**](docs/other.md)" }) });
        try {
            const splash = page.getByRole("dialog", { name: "Message of the day", exact: true });
            await expect(splash).toBeVisible();
            for (const text of ["Relative label", "Anchor label", "Javascript label", "Bold neutral"]) {
                const label = splash.locator(".ps-motd-markdown span").filter({ hasText: text });
                await expect(label).toHaveText(text);
                await expect(splash.getByRole("link", { name: text, exact: true })).toHaveCount(0);
                await expect(label).toHaveCSS("text-decoration-line", "none");
            }
            await expect(splash.locator("span > strong").filter({ hasText: "Bold neutral" })).toHaveCount(1);
            for (const [text, href] of [["Markdown web", "https://example.invalid/guide"],
                ["https://example.invalid/bare", "https://example.invalid/bare"], ["www.example.invalid", "http://www.example.invalid"],
                ["Email me", "mailto:reader@example.invalid"]]) {
                const link = splash.getByRole("link", { name: text, exact: true });
                await expect(link).toHaveAttribute("href", href);
                await expect(link).toHaveAttribute("target", "_blank");
                await expect(link).toHaveAttribute("rel", "noopener noreferrer");
            }
            await expect(splash.locator("a")).toHaveCount(4);
            const neutral = await splash.locator(".ps-motd-markdown span").filter({ hasText: "Relative label" }).elementHandle();
            await page.setViewportSize({ width: viewport.width === 390 ? 1440 : 390, height: 844 });
            if (viewport.width === 390) await expect(splash).not.toHaveClass(/is-phone-preview/);
            else await expect(splash).toHaveClass(/is-phone-preview/);
            expect(await neutral.evaluate(node => node.isConnected)).toBe(true);
            await neutral.dispose();
            const [popup] = await Promise.all([page.waitForEvent("popup"), splash.getByRole("link", { name: "Markdown web", exact: true }).click()]);
            await popup.close();
            await expect(splash).toBeVisible();
            expect(f.state.calls).toHaveLength(0);
        } finally { await f.stop(); }
    });
}
