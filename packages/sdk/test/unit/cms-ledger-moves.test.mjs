import test from "node:test";
import assert from "node:assert/strict";
import { planMigrationLedgerMoves } from "../../dist/pg-migrator.js";
import { cmsLedgerMoves } from "../../dist/cms-migrator.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

// Adversarial review RT-1: reconcile a ledger that recorded the workflow migrations under their earlier numbers.

const migrations = CMS_MIGRATIONS("s");
const moves = cmsLedgerMoves(migrations);
const current = migrations.map(entry => ({ version: entry.version, name: entry.name }));
const nameAt = version => migrations.find(entry => entry.version === version).name;
const old = last => current.flatMap(row => {
    const number = Number(row.version);
    if (number <= 83) return [row];
    if (number >= 88 && number - 4 <= last) return [{ version: String(number - 4).padStart(4, "0"), name: row.name }];
    return [];
});

test("the moves: each workflow migration 0088-0105 from its earlier number", () => {
    assert.equal(moves.length, 18);
    assert.deepEqual(moves[0], { name: "workflow_session_kind", from: "0084", to: "0088" });
    assert.deepEqual(moves.at(-1), { name: nameAt("0105"), from: "0101", to: "0105" });
    assert.equal(nameAt("0084"), "motd");
});

test("a clean or correctly numbered ledger needs nothing", () => {
    assert.deepEqual(planMigrationLedgerMoves([], migrations, moves), { moves: [], error: null });
    assert.deepEqual(planMigrationLedgerMoves(current, migrations, moves), { moves: [], error: null });
    assert.deepEqual(planMigrationLedgerMoves(current.filter(row => row.version <= "0087"), migrations, moves), { moves: [], error: null });
});

test("an old prefix and the whole old sequence move to their new numbers", () => {
    const prefix = planMigrationLedgerMoves(old(85), migrations, moves);
    assert.equal(prefix.error, null);
    assert.deepEqual(prefix.moves.map(move => [move.from, move.to]), [["0084", "0088"], ["0085", "0089"]]);
    const whole = planMigrationLedgerMoves(old(101), migrations, moves);
    assert.equal(whole.error, null);
    assert.equal(whole.moves.length, 18);
});

test("an ambiguous ledger is refused", () => {
    const unknown = planMigrationLedgerMoves([...old(85), { version: "0086", name: "something_else" }], migrations, moves);
    assert.match(unknown.error, /version 0086 is recorded as 'something_else'/);
    const both = planMigrationLedgerMoves([...old(85), { version: "0088", name: "workflow_session_kind" }], migrations, moves);
    assert.match(both.error, /'workflow_session_kind' is recorded at both 0084 and 0088/);
    assert.deepEqual(both.moves, []);
});
