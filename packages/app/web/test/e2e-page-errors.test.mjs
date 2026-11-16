// The Workflow specs' page-error filter (test/e2e/page-errors.mjs): it leaves out exactly WebKit's and Chromium's
// ResizeObserver reports and keeps every other page error; both Workflow spec files collect page errors through it only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { IGNORED_PAGE_ERRORS, collectPageErrors, ignoredPageError } from "./e2e/page-errors.mjs";

test("the filter leaves out exactly the two ResizeObserver reports and keeps every other page error", () => {
    assert.deepEqual([...IGNORED_PAGE_ERRORS], [
        "ResizeObserver loop completed with undelivered notifications.",
        "ResizeObserver loop limit exceeded",
    ]);
    const errors = [];
    const listen = collectPageErrors(errors);
    for (const message of [...IGNORED_PAGE_ERRORS, "ResizeObserver loop completed with undelivered notifications",
        "Uncaught ResizeObserver loop limit exceeded", "TypeError: x is undefined", "", "ResizeObserver loop limit exceeded "]) {
        listen({ message });
    }
    assert.deepEqual(errors, ["ResizeObserver loop completed with undelivered notifications", "Uncaught ResizeObserver loop limit exceeded",
        "TypeError: x is undefined", "", "ResizeObserver loop limit exceeded "]);
    assert.equal(ignoredPageError(undefined), false);
});

test("both Workflow spec files collect page errors only through the filter", () => {
    for (const file of ["workflow-tab.spec.mjs", "workflow-session-definitions.spec.mjs"]) {
        const source = fs.readFileSync(new URL(`./e2e/${file}`, import.meta.url), "utf8");
        assert.match(source, /^import \{ collectPageErrors \} from "\.\/page-errors\.mjs";$/m, file);
        const listeners = source.match(/page\.on\("pageerror", [^\n]*\)/g) ?? [];
        assert.ok(listeners.length > 30, `${file}: ${listeners.length}`);
        assert.deepEqual(listeners.filter(line => line !== 'page.on("pageerror", collectPageErrors(errors))'), [], file);
    }
});
