// Resizing a pane must not re-lay-out the whole loaded transcript.
//
// WHY THIS EXISTS: dragging a splitter on a long session was a slideshow. The
// transcript is not virtualised — every loaded block is in the DOM — and a
// resize changes the wrap width, so the browser re-lays-out all of them on
// every frame. The cost is linear in node count (~1.55ms per 1000 nodes
// measured), and a session's window can reach 10k events.
//
// content-visibility on each block makes the browser skip layout for anything
// offscreen. Measured on a 30k-node transcript: 49.6ms -> 2.9ms per re-layout.
// These tests guard both the declaration (deterministic) and the outcome.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
test.beforeEach(async ({ browser }) => {
    expect(browser.browserType().name()).toBe(process.env.PS_TEST_BROWSER || "chromium");
});

// These used to target `.ps-rich-chat`, the rich renderer, served by asking the
// stub for a "workspace-dark-rich" theme. Both are gone: the rich renderer was
// retired and that theme no longer exists, so the selector matched nothing and
// all three tests timed out rather than failing loudly.
//
// They now measure the surviving transcript, which is the one that ships. That
// mattered: the content-visibility optimization had been lost along with the
// old renderer, and re-layout was back at 6-8ms — the exact cost this file was
// written to prevent — with nothing red to say so.

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 6, transcriptTurns: 600 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

async function openTranscript(page) {
    await page.goto(`${base}/?session=11111110-2222-3333-4444-555555555550`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-chat-panel .ps-line", { timeout: 20_000 });
    await page.waitForTimeout(1500);
}

// This used to assert `content-visibility: auto` on transcript lines. That
// optimization was tried, measured (8.0ms -> 2.3ms per re-layout), and then
// REVERTED, because the chat pane anchors to the bottom with pixel math over
// scrollHeight and content-visibility makes scrollHeight an estimate: measured
// 43,205 against a true 56,760, and the app's own scroll-to-bottom landed 251px
// short, permanently.
//
// So the assertion is inverted. The invariant that matters is not "is the
// optimization on" but "can you actually reach the end of the transcript",
// which is what the optimization broke and what nothing was guarding.
test("opening a session lands at the BOTTOM of its transcript", async ({ page }) => {
    await openTranscript(page);
    // Give the app's own anchoring, and the browser's scroll anchoring, time to
    // settle — a short wait here reads a mid-flight position and passes.
    await page.waitForTimeout(4000);

    const { gap, lines } = await page.evaluate(() => {
        const all = document.querySelectorAll(".ps-chat-panel .ps-line");
        let p = all[0]?.parentElement;
        while (p && p !== document.body && !(p.scrollHeight > p.clientHeight + 1)) p = p.parentElement;
        return { gap: Math.round(p.scrollHeight - p.clientHeight - p.scrollTop), lines: all.length };
    });

    expect(lines, "expected a long transcript to measure against").toBeGreaterThan(100);
    // 251px was the content-visibility regression; 0 is correct. A few px of
    // slack for sub-pixel rounding, nothing like a line height.
    expect(gap, `transcript settled ${gap}px short of the bottom over ${lines} lines`).toBeLessThan(8);
});

test("re-laying out the chat pane stays cheap on a long transcript", async ({ page }) => {
    await openTranscript(page);

    const blocks = await page.locator(".ps-chat-panel .ps-line").count();
    expect(blocks, "expected a long transcript to measure against").toBeGreaterThan(100);

    const { ms, reference, ratio, samples } = await page.evaluate(() => {
        const relayout = (node) => {
            const t0 = performance.now();
            node.style.width = `${node.clientWidth - 9}px`;
            void node.offsetHeight;   // force synchronous layout
            node.style.width = "";
            void node.offsetHeight;
            return performance.now() - t0;
        };
        const panel = document.querySelector(".ps-chat-panel");
        // The same number of plain wrapped lines, same width and font, laid
        // out on the same machine: what a re-layout costs here without any
        // portal structure. The portal is measured against that, not against
        // a fixed number from one developer's laptop.
        const lines = [...panel.querySelectorAll(".ps-line")];
        const ref = document.createElement("div");
        ref.style.cssText = `position:absolute;left:0;top:0;width:${panel.clientWidth}px;visibility:hidden;white-space:pre-wrap;font:${getComputedStyle(lines[0]).font}`;
        for (const line of lines) { const d = document.createElement("div"); d.textContent = line.textContent; ref.appendChild(d); }
        document.body.appendChild(ref);
        void ref.offsetHeight;
        relayout(ref); relayout(panel);
        const samples = { reference: [], panel: [], referenceBatches: [], panelBatches: [], relayoutsPerSample: 3 };
        const sample = node => Array.from({ length: samples.relayoutsPerSample }, () => relayout(node));
        const startedAt = Date.now();
        for (let i = 0; i < 7; i++) {
            const referenceBatch = sample(ref);
            samples.referenceBatches.push(referenceBatch);
            samples.reference.push(referenceBatch.reduce((sum, ms) => sum + ms, 0));
            const panelBatch = sample(panel);
            samples.panelBatches.push(panelBatch);
            samples.panel.push(panelBatch.reduce((sum, ms) => sum + ms, 0));
        }
        samples.measurementWindow = { startedAt, endedAt: Date.now(), clock: "Date.now" };
        samples.ratios = samples.panel.map((ms, i) => ms / samples.reference[i]);
        const median = samples.ratios.map((ratio, index) => ({ ratio, index }))
            .sort((a, b) => a.ratio - b.ratio)[3];
        samples.selectedPair = median.index;
        ref.remove();
        return { ms: samples.panel[median.index], reference: samples.reference[median.index], ratio: median.ratio, samples };
    });
    console.log(`TRANSCRIPT-PERF ${JSON.stringify({ browser: process.env.PS_TEST_BROWSER || "chromium", ms, reference, ratio, blocks, samples })}`);
    // Warm both layouts, then alternate seven reference/panel pairs of sums
    // over three consecutive relayouts, reducing per-call timer noise. Separate
    // sampling windows can expose only the panel to a later scheduling burst.
    // Median paired ratios compare matched moments, unlike dividing minima
    // taken independently from the two sample sets.
    // The reference keeps the ceiling relative to this machine rather than
    // fixing a millisecond limit.
    //
    // The ceiling is a REGRESSION CEILING relative to this machine: it catches
    // the cost going up several-fold, which is what an accidental re-layout of
    // every block, or losing the block memo guarded below, would do.
    // Twenty mixed-load runs per browser peaked at 4.20x and 3.56x.
    // Fifteen percent headroom, rounded up to the next tenth, gives 4.9x.
    expect(ratio, `${ms.toFixed(1)}ms for ${samples.relayoutsPerSample} relayouts of ${blocks} lines, ${reference.toFixed(1)}ms for the same plain-line batch in the median-ratio pair`).toBeLessThan(4.9);
});

test("dragging the pane splitter does not re-render the whole transcript", async ({ page }) => {
    // Rich message blocks are memoized on identity-stable block objects, so a
    // width change reconciles the container and skips the bodies — which is
    // where markdown parsing lives. Measured over a 20-step drag at 6x CPU
    // throttle with 300 blocks: ~1250ms without the memo, ~985ms with (the
    // figures include ~600ms of deliberate inter-step waiting, so the work
    // itself roughly halves).
    //
    // Generous ceiling on purpose: this guards against unbounded per-step work
    // coming back, it is not a benchmark, and CI machines vary.
    await openTranscript(page);
    const handle = await page.locator(".ps-column-resizer").first().boundingBox();
    test.skip(!handle, "no column resizer in this layout");

    const widthOf = () => page.evaluate(() =>
        Math.round(document.querySelector(".ps-chat-panel").getBoundingClientRect().width));
    const before = await widthOf();

    const y = handle.y + handle.height / 2;
    const x0 = handle.x + handle.width / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const started = Date.now();
    for (let i = 1; i <= 20; i += 1) await page.mouse.move(x0 - i * 12, y);
    await page.mouse.up();
    const elapsed = Date.now() - started;

    // The drag must actually have resized something, or the timing below is
    // measuring nothing — a trap this suite has fallen into before.
    const after = await widthOf();
    expect(Math.abs(after - before), "the drag did not resize the chat pane").toBeGreaterThan(50);

    expect(elapsed, `${elapsed}ms for a 20-step splitter drag`).toBeLessThan(4000);
});
