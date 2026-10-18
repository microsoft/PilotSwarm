import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

test("legacy pin cannot activate executable content even after approval; declarative pin remains supported", async t => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec("CREATE SCHEMA pin_review");
    for (const migration of CMS_MIGRATIONS("pin_review")) {
        for (const sql of migration.steps ?? [migration.sql]) await db.exec(sql);
    }
    const sha = "a".repeat(64);
    for (const scope of ["shared", "user"]) {
        const name = `${scope}-kit`;
        const publish = async (version, executable) => {
            const inspection = { format: 1, name, semver: `${version}.0.0`, sha256: sha, executable,
                reasons: executable ? ["worker module"] : [], approvalBlockers: [],
                files: [{ path: "plugin.json", sha256: sha, sizeBytes: 128 }],
                ...(executable ? { execution: { policy: 1, artifactSha256: sha } } : {}) };
            await db.query(`SELECT * FROM pin_review.cms_publish_reviewed_agent_package(
                $1,$2,$1,$3,'entra','publisher',NULL,$4,$5,128,'fixture.tar.gz',NULL,
                '{"agents":[{"name":"helper"}]}'::jsonb,'publisher',FALSE,$6)`,
            [name, `${name}-${version}`, scope, `${version}.0.0`, sha, JSON.stringify(inspection)]);
        };
        const pin = (semver, isAdmin = false, subject = "publisher") => db.query(
            "SELECT pin_review.cms_pin_agent_package_version($1,$2,'entra',$3,$4,$5,'entra','publisher')",
            [name, semver, subject, isAdmin, scope]);
        const snapshot = async () => ({
            package: (await db.query("SELECT active_version_id,activation_revision FROM pin_review.agent_packages WHERE package_id=$1", [name])).rows[0],
            audit: (await db.query("SELECT * FROM pin_review.agent_package_activation_audit WHERE package_id=$1", [name])).rows,
        });
        await publish(1, true);
        const before = await snapshot();
        await assert.rejects(pin("1.0.0"), /ACTIVATION_DENIED|executable.*activation/i);
        await db.query(`SELECT pin_review.cms_review_agent_package(
            $1,$2,$3,1,'approved','reviewed content','entra','admin',TRUE)`, [name, `${name}-1`, sha]);
        await db.exec(CMS_MIGRATIONS("pin_review").find(migration => migration.version === "0087").sql);
        for (const isAdmin of [false, true]) {
            await assert.rejects(pin("1.0.0", isAdmin), /executable.*activation/i);
            assert.deepEqual(await snapshot(), before);
        }
        assert.equal((await db.query("SELECT * FROM pin_review.cms_get_agent_packages_runtime_install_manifest() WHERE package_id=$1", [name])).rows.length, 0);
        await db.query(`SELECT pin_review.cms_activate_agent_package(
            $1,$2,$3,2,1,NULL,'explicit activation','entra','admin',TRUE)`, [name, `${name}-1`, sha]);
        const active = await snapshot();
        assert.equal(active.package.active_version_id, `${name}-1`);
        assert.equal(active.audit.length, 1);
        assert.equal(active.audit[0].actor_subject, "admin");
        await assert.rejects(pin("1.0.0"), /executable.*activation/i);
        assert.deepEqual(await snapshot(), active);
        await publish(2, false);
        await publish(3, false);
        await pin("2.0.0");
        assert.equal((await snapshot()).package.active_version_id, `${name}-2`);
        await assert.rejects(pin("3.0.0", false, "stranger"), /FORBIDDEN/);
        await assert.rejects(pin("4.0.0"), /VERSION_NOT_FOUND/);
    }
});
