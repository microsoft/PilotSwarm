import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

test("every live session and manager proxy uses the single 1.0.84 contract", () => {
    const directory = new URL("../../src/orchestration/", import.meta.url);
    let proxies = 0;
    for (const name of readdirSync(directory).filter(name => name.endsWith(".ts"))) {
        const source = ts.createSourceFile(name, readFileSync(new URL(name, directory), "utf8"), ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const argumentIndex = node.expression.text === "createSessionProxy" ? 4
                    : node.expression.text === "createSessionManagerProxy" ? 1 : null;
                if (argumentIndex !== null) {
                    proxies++;
                    assert.equal(node.arguments[argumentIndex]?.getText(source), "LIVE_SESSION_PROXY_CONTRACT",
                        `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    assert.equal(proxies, 8);
    const frozen = readFileSync(new URL("../../src/orchestration_1_0_83/runtime.ts", import.meta.url), "utf8");
    assert.match(frozen, /"workflow-intake-v1"/);
    assert.doesNotMatch(frozen, /LIVE_SESSION_PROXY_CONTRACT/);
});
