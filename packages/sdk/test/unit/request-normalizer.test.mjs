/**
 * Checks the request normalizer used by the differential test C1
 * (docs/proposals/session-workspaces.md): it masks only the CLI-owned lines
 * and run values, and it never reorders or drops tools.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MASKED_LINE_LABELS, maskText, normalizeRequest, renderNormalized } from "../helpers/request-normalizer.mjs";

const SYSTEM = [
    "You are an agent.",
    "<environment_context>",
    "* Current working directory: /work/tree-a/packages/sdk",
    "* Git repository root: /work/tree-a",
    "* Git repository: example/repo",
    "* Available tools: bash, view, spawn_agent",
    "</environment_context>",
    "Session folder: /tmp/run-1234/session-state/abc",
    "Keep this line, it quotes Current working directory: mid-line.",
].join("\n");

const tool = (name, description = name) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });

function body(system = SYSTEM, tools = [tool("wait"), tool("bash"), tool("spawn_agent")]) {
    return { messages: [{ role: "system", content: system }, { role: "user", content: "hi" }], tools };
}

describe("request normalizer", () => {
    it("masks exactly the CLI-owned lines and keeps their labels", () => {
        const { system } = normalizeRequest(body());
        for (const label of MASKED_LINE_LABELS) {
            assert.match(system, new RegExp(`${label}: <masked>`), label);
        }
        assert.doesNotMatch(system, /tree-a|run-1234/);
        assert.match(system, /\* Git repository: example\/repo/, "an unlisted line stays");
        assert.match(system, /Keep this line, it quotes Current working directory: mid-line\./, "a label mid-line is not masked");
    });

    it("two trees with different paths normalize to the same text", () => {
        const other = SYSTEM.replaceAll("tree-a", "tree-b").replace("run-1234", "run-9999");
        assert.equal(renderNormalized(normalizeRequest(body(other))), renderNormalized(normalizeRequest(body())));
    });

    it("a changed unmasked line still differs", () => {
        const other = SYSTEM.replace("You are an agent.", "You are a different agent.");
        assert.notEqual(renderNormalized(normalizeRequest(body(other))), renderNormalized(normalizeRequest(body())));
    });

    it("keeps tool order and content: a reorder or a new parameter is a difference", () => {
        const base = renderNormalized(normalizeRequest(body()));
        const reordered = renderNormalized(normalizeRequest(body(SYSTEM, [tool("bash"), tool("wait"), tool("spawn_agent")])));
        assert.notEqual(reordered, base);
        const spawn = tool("spawn_agent");
        spawn.function.parameters.properties.workspace = { type: "object" };
        const widened = renderNormalized(normalizeRequest(body(SYSTEM, [tool("wait"), tool("bash"), spawn])));
        assert.notEqual(widened, base);
        assert.deepEqual(normalizeRequest(body()).tools.map(t => t.function.name), ["wait", "bash", "spawn_agent"]);
    });

    it("replaces run values anywhere, longest first", () => {
        const text = "state at /tmp/base/session-state/x and /tmp/base/other";
        assert.equal(maskText(text, { baseDir: "/tmp/base", sessionStateDir: "/tmp/base/session-state" }),
            "state at <sessionStateDir>/x and <baseDir>/other");
        const { tools } = normalizeRequest(body(SYSTEM, [tool("bash", "runs in /tmp/base")]), { baseDir: "/tmp/base" });
        assert.equal(tools[0].function.description, "runs in <baseDir>");
    });

    it("reads system content given as parts", () => {
        const parts = { messages: [{ role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }], tools: [] };
        assert.equal(normalizeRequest(parts).system, "AB");
    });
});
