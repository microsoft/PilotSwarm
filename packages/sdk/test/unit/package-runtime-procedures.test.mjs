import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

test("package authority and review providers only issue procedure calls and transaction control", () => {
    for (const name of ["package-runtime-authority", "agent-package-review-store", "package-runtime-query", "cms"]) {
        const text = fs.readFileSync(new URL(`../../src/${name}.ts`, import.meta.url), "utf8");
        const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (name === "cms" && ts.isMethodDeclaration(node) && node.name.getText(source) !== "saveSessionCapabilities") return;
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && node.expression.name.text === "query") {
                let argument = node.arguments[0];
                if (ts.isObjectLiteralExpression(argument)) argument = argument.properties.find(property => property.name?.getText(source) === "text")?.initializer;
                if (argument && (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument))) {
                    const sql = ts.isTemplateExpression(argument)
                        ? argument.head.text + argument.templateSpans.map(span => `IDENTITY${span.literal.text}`).join("")
                        : argument.text;
                    if (name === "cms" && argument.getText(source).includes(".sql.fn.packageCapabilities")) {
                        assert.match(sql, /^SELECT \* FROM IDENTITY\(/);
                    } else assert.match(sql, /^(?:BEGIN|COMMIT|ROLLBACK|SELECT (?:value FROM )?"?IDENTITY"?\.(?:cms_|IDENTITY\())/, `${name}: ${sql}`);
                    assert.doesNotMatch(sql, /\b(?:INSERT INTO|UPDATE|DELETE FROM|FOR SHARE|JOIN|WHERE|UNION|WITH)\b/i, `${name}: ${sql}`);
                } else assert.fail(`${name}: unexamined query argument`);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
});

test("0088 is additive, has documented procedures, and never introduces metadata tuple locks", () => {
    const migrations = CMS_MIGRATIONS("procedure_review");
    const migration = migrations.find(item => item.version === "0088");
    assert.ok(migration);
    assert.equal(migrations.at(-1), migration);
    assert.doesNotMatch(migration.sql, /\b(?:DROP|ALTER TABLE|TRUNCATE)\b/i);
    assert.doesNotMatch(migration.sql, /FOR SHARE/i);
    const locking = [...migration.sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$procedure\$;/g)]
        .filter(([body]) => /FOR UPDATE/i.test(body));
    assert.equal(locking.length, 1);
    assert.match(locking[0][0], /cms_pkg_live\(/);
    assert.match(locking[0][0], /package_runtime_registrations/);
    for (const version of ["0084", "0085", "0086", "0087", "0088"]) {
        assert.ok(fs.existsSync(new URL(`../../src/migrations/${version}_diff.md`, import.meta.url)), `${version} diff required`);
    }
});
