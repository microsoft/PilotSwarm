import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardServer, parseDashboardArgs } from "../serve-local-test-baseline.mjs";

test("parses dashboard options", () => {
    assert.deepEqual(
        parseDashboardArgs(["--results", "custom.json", "--host=0.0.0.0", "--port", "0"]),
        { results: "custom.json", host: "0.0.0.0", port: 0, help: false },
    );
    assert.throws(() => parseDashboardArgs(["--port", "-1"]), /between 0 and 65535/);
    assert.throws(() => parseDashboardArgs(["--unknown"]), /Unknown option/);
});

test("serves live results and dashboard assets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-dashboard-"));
    const resultsPath = path.join(dir, "results.json");
    fs.writeFileSync(resultsPath, JSON.stringify({ summary: { passed: 1 }, tests: {} }));
    const server = createDashboardServer({ resultsPath });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
        const first = await fetch(`${base}/api/results`).then((response) => response.json());
        assert.equal(first.summary.passed, 1);

        fs.writeFileSync(resultsPath, JSON.stringify({ summary: { passed: 2 }, tests: {} }));
        const second = await fetch(`${base}/api/results`).then((response) => response.json());
        assert.equal(second.summary.passed, 2);

        const html = await fetch(base).then((response) => response.text());
        assert.match(html, /id="result-filter" multiple/);
        assert.match(html, /src="\/app\.js"/);

        const app = await fetch(`${base}/app.js`).then((response) => response.text());
        assert.match(app, /setInterval/);
        assert.match(app, /selectedOptions/);
        assert.match(app, /testedRevision\.commitId/);

        const missing = await fetch(`${base}/missing`);
        assert.equal(missing.status, 404);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
