// DEV-only fixture recorder: inputs are byte-derived standalone modules from the pinned source commits.
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { controllerHistoryScenarios, recordControllerHistory } from "./workflow-controller-history.mjs";

const [mainPath, boundPath, output] = process.argv.slice(2);
if (!mainPath || !boundPath || !output) throw new Error("Usage: record-workflow-controller-history.mjs <main.ts> <bound.ts> <output.json>");
const sources = [
    { path: mainPath, commit: "8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8", version: "1.0.0" },
    { path: boundPath, commit: "a684aab367ba47605a41b63d0c828d1be63ff0bb", version: "1.1.0" },
];
const histories = [];
for (const source of sources) {
    const { workflowController } = await import(pathToFileURL(source.path).href);
    source.sha256 = createHash("sha256").update(readFileSync(source.path)).digest("hex");
    for (const scenario of controllerHistoryScenarios) {
        if (source.version === "1.0.0" && scenario.type === "approval") continue;
        const history = recordControllerHistory(workflowController, scenario, source.version);
        histories.push(history);
        if (history.can) {
            histories.push(recordControllerHistory(workflowController,
                { ...scenario, name: `${scenario.name}-resumed`, forever: false, pause: false }, source.version, history.can.input));
        }
    }
}
const rendered = histories.map(history => JSON.stringify({ ...history, events: [] }, null, 2)
    .replace('  "events": []', `  "events": [\n${history.events.map(event => `    ${JSON.stringify(event)}`).join(",\n")}\n  ]`)
    .split("\n").map(line => `    ${line}`).join("\n"));
writeFileSync(output, `{\n  "sources": ${JSON.stringify(sources.map(({ path, ...metadata }) => metadata))},\n  "histories": [\n${rendered.join(",\n")}\n  ]\n}\n`);
console.log(`Recorded ${histories.length} histories and ${histories.reduce((n, h) => n + h.events.length, 0)} scheduled events.`);
