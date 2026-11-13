import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";

const yaml = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: historical-composition, version: "1.0.0" }
initial: step
states:
  step:
    type: agent
    invoke: { prompt: "Report the harmless input." }
    timeoutSeconds: 120
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

describe("tool composition historical contracts", () => {
    it("preserves the exact pre-composition IR bytes and hash when all new fields are omitted", async () => {
        const current = compileWorkflow(yaml);
        expect(current.valid).toBe(true);
        const oldRoot = process.env.PS_COMPOSITION_OLD_ROOT;
        const expected = oldRoot
            ? await import(/* @vite-ignore */ `${oldRoot}/packages/sdk/src/workflow/compiler.ts`).then(({ compileWorkflow: oldCompile }) => {
                const previous = oldCompile(yaml);
                expect(previous.valid).toBe(true);
                return { irBytes: canonicalJson(previous.ir), irSha256: previous.irSha256 };
            })
            : JSON.parse(readFileSync(new URL("../fixtures/composition-omitted-fields.json", import.meta.url), "utf8"));
        expect(canonicalJson(current.ir)).toBe(expected.irBytes);
        expect(current.irSha256).toBe(expected.irSha256);
        if (oldRoot) console.info("COMPOSITION_IR_GOLDEN", JSON.stringify(expected));
    });

    it("leaves the complete pre-composition migration inventory and file contents unchanged", () => {
        const expected = JSON.parse(readFileSync(new URL("../fixtures/composition-migrations.json", import.meta.url), "utf8"));
        const root = new URL("../../", import.meta.url);
        const directory = new URL("src/migrations/", root);
        const paths = ["src/cms-migrations.ts", "src/facts-migrations.ts",
            ...readdirSync(directory).map(name => `src/migrations/${name}`)].sort();
        expect(paths).toEqual(expected.map(entry => entry.path).sort());
        for (const entry of expected) {
            const bytes = readFileSync(new URL(entry.path, root));
            const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
            expect(blob, entry.path).toBe(entry.blob);
        }
    });
});
