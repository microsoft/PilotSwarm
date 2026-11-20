// DEV-only fixture recorder.
// Frozen sources: inputs are byte-derived standalone modules from the pinned source commits (main 1.0.0, bound 1.1.0).
// Live: `--live <commit> <fixture.json>` records the Decision scenarios on the live controller from this checkout's build
// (`npm run build` first). packages/sdk/src must equal <commit>'s; the source entry pins <commit> and the sha256 of the
// live generator's index.ts and runtime.ts there. Recordings of other versions in the fixture are kept as they are.
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { controllerHistoryScenarios, decisionHistoryScenarios, recordControllerHistory } from "./workflow-controller-history.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function recordAll(controller, scenarios, version) {
    const histories = [];
    for (const scenario of scenarios) {
        const history = recordControllerHistory(controller, scenario, version);
        histories.push(history);
        if (history.can) {
            histories.push(recordControllerHistory(controller,
                { ...scenario, name: `${scenario.name}-resumed`, forever: false, pause: false }, version, history.can.input));
        }
    }
    return histories;
}

function write(output, sources, histories) {
    const rendered = histories.map(history => JSON.stringify({ ...history, events: [] }, null, 2)
        .replace('  "events": []', `  "events": [\n${history.events.map(event => `    ${JSON.stringify(event)}`).join(",\n")}\n  ]`)
        .split("\n").map(line => `    ${line}`).join("\n"));
    writeFileSync(output, `{\n  "sources": ${JSON.stringify(sources)},\n  "histories": [\n${rendered.join(",\n")}\n  ]\n}\n`);
    console.log(`Recorded ${histories.length} histories and ${histories.reduce((n, h) => n + h.events.length, 0)} scheduled events.`);
}

const args = process.argv.slice(2);
if (args[0] === "--live") {
    const [, commitArg, output] = args;
    if (!commitArg || !output) throw new Error("Usage: record-workflow-controller-history.mjs --live <commit> <fixture.json>");
    const sdk = fileURLToPath(new URL("../..", import.meta.url));
    const git = (...gitArgs) => execFileSync("git", ["-C", sdk, ...gitArgs], { encoding: "utf8" });
    const commit = git("rev-parse", "--verify", `${commitArg}^{commit}`).trim();
    git("diff", "--quiet", commit, "--", "src");   // throws when this checkout's source differs from the commit
    if (git("status", "--porcelain", "--", "src").trim() !== "") throw new Error("packages/sdk/src has uncommitted or untracked files.");
    const prefix = git("rev-parse", "--show-prefix").trim();
    const show = path => execFileSync("git", ["-C", sdk, "show", `${commit}:${prefix}${path}`]);
    const { WORKFLOW_CONTROLLER_REGISTRY } = await import(new URL("../../dist/workflow/controller-registry.js", import.meta.url).href);
    const { WORKFLOW_CONTROLLER_VERSION: version } = await import(new URL("../../dist/workflow/controller-version.js", import.meta.url).href);
    const { handler } = WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === version);
    const fixture = JSON.parse(readFileSync(output, "utf8"));
    const sources = [...fixture.sources.filter(source => source.version !== version), {
        commit, version, sha256: sha256(show("src/workflow/controller/index.ts")),
        runtimeSha256: sha256(show("src/workflow/controller/runtime.ts")), recordedFrom: "live",
    }];
    const histories = [...fixture.histories.filter(history => history.version !== version),
        ...recordAll(handler, decisionHistoryScenarios, version)];
    write(output, sources, histories);
} else {
    const [mainPath, boundPath, output] = args;
    if (!mainPath || !boundPath || !output) {
        throw new Error("Usage: record-workflow-controller-history.mjs <main.ts> <bound.ts> <output.json> | --live <commit> <fixture.json>");
    }
    const sources = [
        { path: mainPath, commit: "8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8", version: "1.0.0" },
        { path: boundPath, commit: "a684aab367ba47605a41b63d0c828d1be63ff0bb", version: "1.1.0" },
    ];
    const histories = [];
    for (const source of sources) {
        const { workflowController } = await import(pathToFileURL(source.path).href);
        source.sha256 = sha256(readFileSync(source.path));
        histories.push(...recordAll(workflowController,
            controllerHistoryScenarios.filter(scenario => source.version !== "1.0.0" || scenario.type !== "approval"), source.version));
    }
    write(output, sources.map(({ path, ...metadata }) => metadata), histories);
}
