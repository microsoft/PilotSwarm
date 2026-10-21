import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

test("package authority and review providers only issue procedure calls and transaction control", () => {
    for (const name of ["package-runtime-authority", "agent-package-review-store", "package-review-report-store", "package-runtime-query", "notification-store", "cms"]) {
        const text = fs.readFileSync(new URL(`../../src/${name}.ts`, import.meta.url), "utf8");
        const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (name === "cms" && ts.isMethodDeclaration(node) && !["saveSessionCapabilities", "getAgentPackageVersionReview",
                "getAgentPackagesInstallManifest", "publishAgentPackage"].includes(node.name.getText(source))) return;
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && node.expression.name.text === "query") {
                let argument = node.arguments[0];
                if (ts.isIdentifier(argument)) {
                    const identifier = argument.text;
                    const declarations = [];
                    const find = item => {
                        if (ts.isVariableDeclaration(item) && item.name.getText(source) === identifier) declarations.push(item.initializer);
                        ts.forEachChild(item, find);
                    };
                    find(source);
                    assert.equal(declarations.length, 1, `${name}: ambiguous SQL variable`);
                    argument = declarations[0];
                }
                if (ts.isObjectLiteralExpression(argument)) argument = argument.properties.find(property => property.name?.getText(source) === "text")?.initializer;
                if (argument && (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument))) {
                    const sql = ts.isTemplateExpression(argument)
                        ? argument.head.text + argument.templateSpans.map(span => `IDENTITY${span.literal.text}`).join("")
                        : argument.text;
                    if (name === "cms" && argument.getText(source).includes(".sql.fn.")) {
                        assert.match(sql, /^SELECT (?:\* FROM )?IDENTITY\(/);
                    } else assert.match(sql, /^(?:BEGIN|COMMIT|ROLLBACK|SELECT (?:(?:value|\*) FROM )?"?IDENTITY"?\.(?:cms_[a-zA-Z0-9_]+\(|IDENTITY\())/, `${name}: ${sql}`);
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
    assert.equal(migrations.at(-1).version, "0091");
    assert.doesNotMatch(migration.sql, /\b(?:DROP|ALTER TABLE|TRUNCATE)\b/i);
    assert.doesNotMatch(migration.sql, /FOR SHARE/i);
    const locking = [...migration.sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$procedure\$;/g)]
        .filter(([body]) => /FOR UPDATE/i.test(body));
    assert.equal(locking.length, 1);
    assert.match(locking[0][0], /cms_pkg_live\(/);
    assert.match(locking[0][0], /package_runtime_registrations/);
    for (const version of ["0084", "0085", "0086", "0087", "0088", "0089", "0090", "0091"]) {
        assert.ok(fs.existsSync(new URL(`../../src/migrations/${version}_diff.md`, import.meta.url)), `${version} diff required`);
    }
});

test("0090 notifications are additive, lock-free and never touch review, activation or binding state", () => {
    const migration = CMS_MIGRATIONS("procedure_review").find(item => item.version === "0090");
    assert.ok(migration);
    assert.doesNotMatch(migration.sql, /\b(?:DROP TABLE|DROP FUNCTION|ALTER TABLE|TRUNCATE|DELETE FROM|FOR UPDATE|FOR SHARE)\b/i);
    assert.doesNotMatch(migration.sql, /UPDATE\s+"procedure_review"\.(?!user_notifications\b)/i, "only notification rows are updated");
    assert.doesNotMatch(migration.sql, /INSERT INTO\s+"procedure_review"\.(?!user_notifications\b)/i, "only notification rows are inserted");
    assert.match(migration.sql, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/, "a notification failure never blocks a review decision");
    assert.doesNotMatch(migration.sql, /detail/i, "free-form precheck detail never reaches a notification");
});

test("0091 review reports are additive, insert-only and never touch review, activation or binding state", () => {
    const migration = CMS_MIGRATIONS("procedure_review").find(item => item.version === "0091");
    assert.ok(migration);
    assert.doesNotMatch(migration.sql, /\b(?:DROP|ALTER TABLE|TRUNCATE|DELETE FROM|UPDATE|FOR UPDATE|FOR SHARE)\b/i);
    assert.doesNotMatch(migration.sql, /INSERT INTO\s+"procedure_review"\.(?!agent_package_review_reports\b)/i, "only report rows are inserted");
    assert.match(migration.sql, /NOT \(report \?\| ARRAY\['verdict'/, "the table refuses a verdict key");
    assert.match(migration.sql, /r\.decision = 'pending'/, "reports bind only to a pending candidate");
    for (const fn of ["cms_put_agent_package_review_report", "cms_get_agent_package_review_report"]) {
        assert.match(migration.sql, new RegExp(`FUNCTION "procedure_review"\\.${fn}\\([\\s\\S]*?p_is_admin IS NOT TRUE`), `${fn} is admin-only`);
    }
});
