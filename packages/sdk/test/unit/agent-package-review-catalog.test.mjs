import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { executablePackageReviewsMigration } from "../../dist/migrations/executable-package-reviews-0084.js";
import { PgAgentPackageReviewStore } from "../../dist/agent-package-review-store.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import fs from "node:fs";
import path from "node:path";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { installAgentPackages } from "../../dist/agent-package-installer.js";

const admin = { principal: { provider: "entra", subject: "admin-1" }, isAdmin: true };
const sha = "a".repeat(64);
const sha2 = "b".repeat(64);

function artifact(t, executable = false) {
    const root = fs.mkdtempSync(path.resolve(".test-review-artifact-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "review-kit", version: "1.0.0" }));
    fs.mkdirSync(path.join(root, "agents"));
    fs.writeFileSync(path.join(root, "agents", "helper.agent.md"), "---\nname: helper\ndescription: helper\n---\nDeclarative helper.");
    if (executable) {
        fs.mkdirSync(path.join(root, "tools"));
        fs.writeFileSync(path.join(root, "tools", "worker-module.js"), "throw new Error('never import legacy code');");
    }
    return packAgentPackage(root);
}

// A pre-0084 package catalog snapshot. Tests exercise real PostgreSQL
// functions/triggers, entirely in-memory, without touching operator databases.
async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`
        CREATE SCHEMA authz;
        CREATE TABLE authz.agent_packages (
            package_id TEXT PRIMARY KEY, source_id TEXT, name TEXT, scope TEXT,
            owner_provider TEXT, owner_subject TEXT, enabled BOOLEAN DEFAULT TRUE,
            active_version_id TEXT, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE NULLS NOT DISTINCT(name, scope, owner_provider, owner_subject)
        );
        CREATE TABLE authz.agent_package_versions (
            version_id TEXT PRIMARY KEY, package_id TEXT REFERENCES authz.agent_packages ON DELETE CASCADE,
            semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, commit_sha TEXT,
            manifest JSONB, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(package_id, semver)
        );
        CREATE TABLE authz.agent_registry_state(epoch BIGINT);
        INSERT INTO authz.agent_registry_state VALUES(1);
        CREATE FUNCTION authz.cms_agent_registry_bump() RETURNS VOID AS $$
            UPDATE authz.agent_registry_state SET epoch = epoch + 1;
        $$ LANGUAGE sql;
        CREATE FUNCTION authz.cms_agent_package_is_editor(TEXT,TEXT,TEXT) RETURNS BOOLEAN AS $$
            SELECT FALSE;
        $$ LANGUAGE sql;
        CREATE TABLE authz.sessions(session_id TEXT PRIMARY KEY, root_session_id TEXT, deleted_at TIMESTAMPTZ);
        CREATE TABLE authz.users(user_id TEXT PRIMARY KEY, provider TEXT, subject TEXT);
        CREATE TABLE authz.session_owners(session_id TEXT PRIMARY KEY, user_id TEXT REFERENCES authz.users);
        INSERT INTO authz.users VALUES('owner','entra','publisher'),('other','entra','other-owner');
    `);
    await db.exec(executablePackageReviewsMigration("authz"));
    const publish = async (versionId, digest, executable, semver = "1.0.0", packageId = "pkg-1", scope = "shared", ownerSubject = "publisher", uninspected = false) => {
        const inspection = { format: 1, sha256: digest, name: "review-kit", semver,
            executable, reasons: executable ? ["worker module"] : [],
            files: [{ path: "plugin.json", sha256: digest, sizeBytes: 128 }],
            approvalBlockers: executable ? ["dependency closure and fencing unavailable"] : [] };
        return db.query(`SELECT * FROM authz.cms_publish_reviewed_agent_package(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [packageId, versionId, "review-kit", scope, "entra", ownerSubject, null,
            semver, digest, 128, `${versionId}.tar.gz`, null, '{"agents":[{"name":"helper"}]}', "publisher", false, uninspected ? null : JSON.stringify(inspection)]);
    };
    const decision = (input = {}) => db.query(
        "SELECT authz.cms_review_agent_package($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [input.packageId ?? "pkg-1", input.versionId ?? "v2", input.sha256 ?? sha2,
            input.expectedRevision ?? 1, input.decision ?? "rejected", input.reason ?? "review reason",
            input.provider ?? "entra", input.subject ?? "admin-1", input.isAdmin ?? true],
    );
    const activate = (input = {}) => db.query(
        "SELECT authz.cms_activate_agent_package($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [input.packageId ?? "pkg-1", input.versionId ?? "v2", input.sha256 ?? sha2,
            input.expectedReviewRevision ?? 1, input.expectedActivationRevision ?? 2,
            input.expectedActiveVersionId === undefined ? "v1" : input.expectedActiveVersionId,
            input.reason ?? "activate exact reviewed target", input.provider ?? "entra",
            input.subject ?? "admin-1", input.isAdmin ?? true]);
    const bind = async (sessionId, packageId = "pkg-1") => {
        await db.query("INSERT INTO authz.sessions(session_id) VALUES($1) ON CONFLICT DO NOTHING", [sessionId]);
        await db.query("INSERT INTO authz.session_owners VALUES($1,'owner') ON CONFLICT DO NOTHING", [sessionId]);
        return db.query("SELECT authz.cms_bind_new_session_agent_package($1,$2,'review-kit:helper')", [sessionId, packageId]);
    };
    const binding = async (sessionId) =>
        (await db.query("SELECT authz.cms_get_session_agent_package_binding($1) AS binding", [sessionId])).rows[0].binding;
    const rebind = (input = {}) => db.query(
        "SELECT authz.cms_rebind_session_agent_package($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [input.sessionId ?? "s1", input.packageId ?? "pkg-1", input.versionId ?? "v2", input.sha256 ?? sha2,
            input.agentName ?? "review-kit:helper", input.expectedRevision ?? 1, input.reason ?? "explicit rebind",
            input.provider ?? "entra", input.subject ?? "admin-1", input.isAdmin ?? true]);
    return { db, publish, decision, activate, bind, binding, rebind };
}

test("declarative publication activates; executable v2 remains pending while v1 stays active; legacy pin cannot bypass", async (t) => {
    const { db, publish } = await fixture(t);
    await publish("v1", sha, false);
    await publish("v2", sha2, true, "2.0.0");
    assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, "v1");
    const review = (await db.query("SELECT * FROM authz.agent_package_reviews WHERE version_id = 'v2'")).rows[0];
    assert.equal(review.decision, "pending");
    assert.equal(review.prior_active_version_id, "v1");
    assert.equal(review.sha256, sha2);
    await assert.rejects(db.exec("UPDATE authz.agent_packages SET active_version_id = 'v2'"), /ACTIVATION_DENIED/);
    assert.equal((await db.query("SELECT * FROM authz.cms_get_agent_packages_install_manifest()")).rows[0].version_id, "v1");
});

test("artifact-content approval succeeds but executable-only activation remains denied, with no implicit pointer change", async (t) => {
    const { db, publish, decision, activate } = await fixture(t);
    await publish("v2", sha2, true);
    assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, null);
    await decision({ decision: "approved" });
    await assert.rejects(activate({ expectedReviewRevision: 2, expectedActivationRevision: 1, expectedActiveVersionId: null }), /dependency closure is not verified/);
    assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, null);
    assert.equal((await db.query("SELECT count(*) AS n FROM authz.agent_package_review_audit")).rows[0].n, 1);
});

for (const executable of [false, true]) {
    test(`first legacy ${executable ? "executable" : "declarative"} inspection verifies actual bytes once, audits classification and never grants execution`, async (t) => {
        const { db, publish, decision } = await fixture(t);
        const packed = artifact(t, executable);
        await publish("v1", packed.sha256, executable, "1.0.0", "pkg-1", "shared", "publisher", true);
        let rollback = Promise.resolve();
        const query = (text, values) => typeof text === "object" ? db.query(text.text, text.values)
            : text.includes(";") ? db.exec(text) : db.query(text, values);
        const store = new PgAgentPackageReviewStore({ query,
            connect: async () => ({ query, release: error => { if (error) rollback = db.exec("ROLLBACK"); } }),
        }, "authz");
        const identity = { packageId: "pkg-1", versionId: "v1", sha256: packed.sha256 };
        await assert.rejects(store.inspectArtifact(identity, 1, Buffer.from("not an artifact")));
        assert.equal((await store.list(admin))[0].inspection, null);
        await store.inspectArtifact(identity, 1, packed.targz);
        const candidate = (await store.list(admin))[0];
        assert.equal(candidate.revision, 2);
        assert.equal(candidate.decision, executable ? "pending" : "not_required");
        assert.equal(candidate.inspection.sha256, packed.sha256);
        await store.inspectArtifact(identity, 2, packed.targz);
        assert.equal((await store.audit(admin, "v1")).length, 1, "warm identical inspection is a no-op");
        await assert.rejects(store.inspectArtifact(identity, 1, packed.targz), error => error.code === "CONFLICT");
        await rollback;
        if (executable) {
            await decision({ versionId: "v1", sha256: packed.sha256, expectedRevision: 2, decision: "approved" });
            await assert.rejects(store.activate(admin, { ...identity, expectedReviewRevision: 3,
                expectedActivationRevision: 1, expectedActiveVersionId: null, reason: "must still deny code" }), /dependency closure/);
            await rollback;
        }
        assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, null);
    });
}

for (const result of ["approved", "rejected"]) {
    test(`${result} executable v2 preserves approved active v1 and its immutable session pin`, async (t) => {
        const { db, publish, decision, activate, bind, binding } = await fixture(t);
        await publish("v1", sha, false);
        await decision({ versionId: "v1", sha256: sha, decision: "approved" });
        await bind("s1");
        await publish("v2", sha2, true, "2.0.0");
        await decision({ decision: result });
        await assert.rejects(activate({ expectedReviewRevision: 2 }), /REVIEW_BLOCKED/);
        await assert.rejects(activate({ expectedReviewRevision: 1 }), /CONFLICT/);
        await bind("s2");
        assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, "v1");
        assert.equal((await binding("s1")).versionId, "v1");
        assert.equal((await binding("s2")).versionId, "v1");
        assert.equal((await binding("s1")).allowed, true);
        assert.equal((await db.query("SELECT count(*) AS n FROM authz.agent_package_activation_audit")).rows[0].n, 0);
    });
}

test("explicit declarative activation CAS changes new bindings only; rebind is audited exact-content CAS", async (t) => {
    const { db, publish, activate, bind, binding, rebind } = await fixture(t);
    await publish("v1", sha, false);
    await bind("s1");
    await publish("v2", sha2, false, "2.0.0");
    await bind("s2");
    await bind("s1");
    assert.equal((await binding("s1")).versionId, "v1");
    assert.equal((await binding("s2")).versionId, "v2");
    const rollback = { versionId: "v1", sha256: sha, expectedActivationRevision: 3, expectedActiveVersionId: "v2" };
    await assert.rejects(activate({ ...rollback, isAdmin: false }), /FORBIDDEN/);
    await assert.rejects(activate({ ...rollback, sha256: sha2 }), /CONFLICT/);
    await assert.rejects(activate({ ...rollback, expectedActivationRevision: 2 }), /CONFLICT/);
    await assert.rejects(activate({ ...rollback, expectedActiveVersionId: "other" }), /CONFLICT/);
    await activate(rollback);
    await assert.rejects(activate(rollback), /CONFLICT/);
    await bind("s3");
    assert.equal((await binding("s2")).versionId, "v2");
    assert.equal((await binding("s3")).versionId, "v1");
    const audit = (await db.query("SELECT * FROM authz.agent_package_activation_audit")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before_version_id, "v2");
    assert.equal(audit[0].after_version_id, "v1");
    assert.equal(Number(audit[0].activation_revision), 4);
    await assert.rejects(rebind({ isAdmin: false }), /FORBIDDEN/);
    await assert.rejects(rebind({ sha256: sha }), /NOT_FOUND/);
    await assert.rejects(rebind({ agentName: "review-kit:other" }), /FORBIDDEN/);
    await rebind();
    await assert.rejects(rebind(), /CONFLICT/);
    assert.equal((await binding("s1")).versionId, "v2");
    assert.equal((await binding("s1")).sha256, sha2);
    assert.equal((await binding("s1")).revision, 2);
    const history = (await db.query("SELECT * FROM authz.session_agent_package_binding_audit WHERE session_id='s1' ORDER BY revision")).rows;
    assert.equal(history.length, 2);
    assert.equal(history[1].before_version_id, "v1");
    assert.equal(history[1].actor_subject, "admin-1");
    await assert.rejects(db.exec("DELETE FROM authz.agent_package_activation_audit"), /append-only/);
    await assert.rejects(db.exec("DELETE FROM authz.session_agent_package_binding_audit"), /append-only/);
});

for (const denial of ["disabled", "revoked", "owner", "deleted", "session-deleted"]) {
    test(`saved binding fails current ${denial} checks without retargeting or losing history`, async (t) => {
        const { db, publish, decision, bind, binding } = await fixture(t);
        await publish("v1", sha, false, "1.0.0", "pkg-1", "user");
        await bind("s1");
        if (denial === "disabled") await db.exec("UPDATE authz.agent_packages SET enabled=FALSE");
        if (denial === "revoked") await decision({ versionId: "v1", sha256: sha, decision: "revoked" });
        if (denial === "owner") await db.exec("UPDATE authz.session_owners SET user_id='other'");
        if (denial === "deleted") await db.exec("DELETE FROM authz.agent_packages");
        if (denial === "session-deleted") await db.exec("UPDATE authz.sessions SET deleted_at=now()");
        const saved = await binding("s1");
        assert.equal(saved.allowed, false);
        assert.equal(saved.versionId, "v1");
        assert.equal(saved.sha256, sha);
        assert.equal(saved.revision, 1);
        assert.equal((await db.query("SELECT count(*) AS n FROM authz.session_agent_package_binding_audit")).rows[0].n, 1);
    });
}

test("CAS denies nonadmin, anonymous, digest substitution, other package/version and stale decisions without audit", async (t) => {
    const { db, publish, decision } = await fixture(t);
    await publish("v2", sha2, true);
    await assert.rejects(decision({ isAdmin: false }), /FORBIDDEN/);
    await assert.rejects(decision({ provider: "" }), /FORBIDDEN/);
    await assert.rejects(decision({ sha256: sha }), /CONFLICT/);
    await assert.rejects(decision({ packageId: "foreign" }), /NOT_FOUND/);
    await assert.rejects(decision({ versionId: "foreign" }), /NOT_FOUND/);
    await assert.rejects(decision({ expectedRevision: 2 }), /CONFLICT/);
    await assert.rejects(decision({ reason: " " }), /INVALID/);
    assert.equal((await db.query("SELECT count(*) AS n FROM authz.agent_package_review_audit")).rows[0].n, 0);
});

test("one winner per candidate revision; reject/revoke audited atomically and retained after deletion", async (t) => {
    const { db, publish, decision } = await fixture(t);
    await publish("v1", sha, false);
    await publish("v2", sha2, true, "2.0.0");
    const outcomes = await Promise.allSettled([decision(), decision()]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const first = (await db.query("SELECT * FROM authz.agent_package_review_audit")).rows[0];
    assert.equal(first.actor_subject, "admin-1");
    assert.equal(first.before_decision, "pending");
    assert.equal(first.after_decision, "rejected");
    assert.equal(first.revision, 2);
    await decision({ expectedRevision: 2, decision: "revoked", reason: "deny this exact artifact" });
    await assert.rejects(decision({ expectedRevision: 2 }), /CONFLICT/);
    await assert.rejects(db.exec("DELETE FROM authz.agent_package_review_audit"), /append-only/);
    assert.equal((await db.query("SELECT active_version_id FROM authz.agent_packages")).rows[0].active_version_id, "v1");
    await db.exec("DELETE FROM authz.agent_packages");
    assert.equal((await db.query("SELECT count(*) AS n FROM authz.agent_package_review_audit")).rows[0].n, 2);
});

test("immutable publication no-op preserves rejected state; same semver digest change cannot substitute content", async (t) => {
    const { db, publish, decision } = await fixture(t);
    await publish("v2", sha2, true);
    await decision();
    const repeated = await publish("ignored-version", sha2, true);
    assert.equal(repeated.rows[0].status, "noop");
    assert.equal(repeated.rows[0].version_id, "v2");
    await assert.rejects(publish("new-digest", sha, false), /SEMVER_CONFLICT/);
    await assert.rejects(db.exec("UPDATE authz.agent_package_versions SET sha256=repeat('c',64)"), /immutable/);
    await assert.rejects(db.exec("UPDATE authz.agent_package_reviews SET inspection='{}'::JSONB"), /immutable/);
    assert.equal((await db.query("SELECT decision FROM authz.agent_package_reviews WHERE version_id='v2'")).rows[0].decision, "rejected");
});

test("historical sessions cannot silently bind; admin exact-target revision-zero rebind is explicit and audited", async (t) => {
    const { db, publish, bind, binding, rebind } = await fixture(t);
    await publish("v1", sha, false);
    await db.exec("INSERT INTO authz.sessions(session_id,package_binding_policy_version) VALUES('s1',NULL); INSERT INTO authz.session_owners VALUES('s1','owner')");
    await assert.rejects(bind("s1"), /historical session requires explicit/);
    assert.equal(await binding("s1"), null);
    await assert.rejects(rebind({ versionId: "v1", sha256: sha }), /revision zero/);
    await rebind({ versionId: "v1", sha256: sha, expectedRevision: 0, reason: "explicitly pin historical session to reviewed bytes" });
    assert.equal((await binding("s1")).versionId, "v1");
    await assert.rejects(rebind({ versionId: "v1", sha256: sha, expectedRevision: 0 }), /CONFLICT/);
    const audit = (await db.query("SELECT * FROM authz.session_agent_package_binding_audit")).rows[0];
    assert.equal(audit.actor_subject, "admin-1");
    assert.equal(audit.before_version_id, null);
});

test("child bindings follow the current effective root owner, not a misleading direct child owner row", async (t) => {
    const { db, publish, bind, binding } = await fixture(t);
    await publish("v1", sha, false, "1.0.0", "pkg-1", "user");
    await bind("root");
    await db.exec("INSERT INTO authz.sessions(session_id,root_session_id) VALUES('child','root'); INSERT INTO authz.session_owners VALUES('child','other')");
    await bind("child");
    assert.equal((await binding("child")).owner.subject, "publisher");
    await db.exec("UPDATE authz.session_owners SET user_id='other' WHERE session_id='root'");
    assert.equal((await binding("child")).allowed, false);
    assert.equal((await binding("root")).allowed, false);
});

test("private same-named packages have independent exact review candidates and normalized publisher identity", async (t) => {
    const { db, publish, decision } = await fixture(t);
    await publish("alice-v1", sha, true, "1.0.0", "alice-pkg", "user", "alice");
    await publish("bob-v1", sha, true, "1.0.0", "bob-pkg", "user", "bob");
    const duplicate = await publish("ignored-id", sha, true, "1.0.0", "ignored-pkg", "user", " alice ");
    assert.equal(duplicate.rows[0].version_id, "alice-v1");
    await decision({ packageId: "alice-pkg", versionId: "alice-v1", sha256: sha });
    const reviews = (await db.query("SELECT version_id, decision FROM authz.agent_package_reviews ORDER BY version_id")).rows;
    assert.deepEqual(reviews, [{ version_id: "alice-v1", decision: "rejected" }, { version_id: "bob-v1", decision: "pending" }]);
});

test("provider catalog read requires trusted administrator and migration reapplication preserves decisions/audit", async (t) => {
    const { db, publish, decision } = await fixture(t);
    await publish("v2", sha2, true);
    await decision();
    await db.exec(executablePackageReviewsMigration("authz"));
    let queries = 0;
    const pool = { query: async (query) => { queries++; return db.query(query.text, query.values); } };
    const store = new PgAgentPackageReviewStore(pool, "authz");
    await assert.rejects(store.list({ ...admin, isAdmin: false }), /administrator/);
    await assert.rejects(store.audit({ principal: null, isAdmin: true }, "v2"), /administrator/);
    assert.equal(queries, 0);
    const list = await store.list(admin);
    assert.equal(list[0].decision, "rejected");
    assert.equal(list[0].sha256, sha2);
    assert.deepEqual(list[0].owner, { provider: "entra", subject: "publisher" });
    assert.equal((await store.audit(admin, "v2"))[0].reason, "review reason");
});

test("provider decision transaction commits audit and state together, maps conflicts, and refuses nonadmin before acquisition", async (t) => {
    const { db, publish } = await fixture(t);
    await publish("v2", sha2, true);
    let acquired = 0;
    let rollback = Promise.resolve();
    const query = (text, values) => typeof text === "object"
        ? db.query(text.text, text.values)
        : text.includes(";") ? db.exec(text) : db.query(text, values);
    const pool = {
        query,
        connect: async () => {
            acquired++;
            return { query, release: (error) => { if (error) rollback = db.exec("ROLLBACK"); } };
        },
    };
    const store = new PgAgentPackageReviewStore(pool, "authz");
    const input = { packageId: "pkg-1", versionId: "v2", sha256: sha2,
        expectedRevision: 1, decision: "rejected", reason: "exact candidate rejected" };
    await assert.rejects(store.decide({ ...admin, isAdmin: false }, input), /administrator/);
    assert.equal(acquired, 0);
    await store.decide(admin, input);
    assert.equal((await store.list(admin))[0].revision, 2);
    await assert.rejects(store.decide(admin, input), (error) => error.code === "CONFLICT");
    await rollback;
    assert.equal((await store.audit(admin, "v2")).length, 1);
    await store.decide(admin, { ...input, expectedRevision: 2, decision: "revoked" });
    assert.equal((await store.audit(admin, "v2")).length, 2);
});

test("provider-neutral activation and binding methods execute exact mutations and return retained audit/current eligibility", async (t) => {
    const { db, publish, bind } = await fixture(t);
    await publish("v1", sha, false);
    await bind("s1");
    await publish("v2", sha2, false, "2.0.0");
    const query = (text, values) => typeof text === "object"
        ? db.query(text.text, text.values)
        : text.includes(";") ? db.exec(text) : db.query(text, values);
    const store = new PgAgentPackageReviewStore({
        query, connect: async () => ({ query, release: () => {} }),
    }, "authz");
    const target = { packageId: "pkg-1", versionId: "v1", sha256: sha, expectedReviewRevision: 1,
        expectedActivationRevision: 3, expectedActiveVersionId: "v2", reason: "explicit rollback" };
    await assert.rejects(store.activate({ ...admin, isAdmin: false }, target), /administrator/);
    await store.activate(admin, target);
    assert.equal((await store.activationAudit(admin, "pkg-1"))[0].before_version_id, "v2");
    await assert.rejects(store.activationAudit({ principal: null, isAdmin: true }, "pkg-1"), /administrator/);
    await store.bindNewSession("s1", "pkg-1", "review-kit:helper");
    assert.equal((await store.getSessionBinding("s1")).versionId, "v1");
    await store.rebind(admin, { sessionId: "s1", packageId: "pkg-1", versionId: "v2", sha256: sha2,
        agentName: "review-kit:helper", expectedBindingRevision: 1, reason: "explicit version migration" });
    assert.equal((await store.getSessionBinding("s1")).versionId, "v2");
    assert.equal((await store.getSessionBinding("s1")).revision, 2);
    const list = await store.list(admin);
    assert.equal(list[0].approvalScope, "artifact-content");
    assert.equal(list[0].activationRevision, 4);
    assert.equal(list[0].activeVersionId, "v1");
});

test("entire CMS migration chain upgrades legacy executable versions without grandfathering or broken SQL dependencies", async (t) => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec("CREATE SCHEMA full_catalog");
    const migrations = CMS_MIGRATIONS("full_catalog");
    for (const migration of migrations.filter((m) => m.version < "0084")) {
        for (const sql of migration.steps ?? [migration.sql]) await db.exec(sql);
    }
    let rollback = Promise.resolve();
    const query = (text, values) => typeof text === "object" ? db.query(text.text, text.values)
        : text.includes(";") ? db.exec(text) : db.query(text, values);
    const pool = { query, connect: async () => ({ query, release: error => { if (error) rollback = db.exec("ROLLBACK"); } }) };
    const catalog = new PgSessionCatalog(pool, "full_catalog");
    await catalog.createSession("historical", { owner: { provider: "entra", subject: "publisher" } });
    await db.query(`SELECT * FROM full_catalog.cms_publish_agent_package(
        'legacy-pkg','legacy-v1','legacy-kit','shared','entra','publisher',NULL,
        '1.0.0',$1,128,'legacy.tar.gz',NULL,'{"tools":true}'::JSONB,'publisher',FALSE)`, [sha]);
    const legacyData = artifact(t);
    await db.query(`SELECT * FROM full_catalog.cms_publish_agent_package(
        'legacy-data','legacy-data-v1','review-kit','shared','entra','publisher',NULL,
        '1.0.0',$1,128,'legacy-data.tar.gz',NULL,'{"agents":[{"name":"helper"}]}'::JSONB,'publisher',FALSE)`, [legacyData.sha256]);
    await db.exec(migrations.find((m) => m.version === "0084").sql);
    const review = (await db.query("SELECT * FROM full_catalog.agent_package_reviews WHERE version_id = 'legacy-v1'")).rows[0];
    assert.equal(review.decision, "pending");
    assert.equal(review.inspection, null);
    const install = (await db.query("SELECT * FROM full_catalog.cms_get_agent_packages_install_manifest() WHERE version_id='legacy-v1'")).rows[0];
    assert.equal(install.version_id, "legacy-v1");
    assert.equal(install.review_decision, "pending");
    // Retained active metadata is NOT executable authority: the installer
    // independently inspects and rejects the bytes, including legacy versions.
    await assert.rejects(db.query(`SELECT full_catalog.cms_review_agent_package(
        'legacy-pkg','legacy-v1',$1,1,'approved','approve old code','entra','admin',TRUE)`, [sha]), /REVIEW_BLOCKED/);
    const inspection = { format: 1, sha256: sha2, name: "safe-kit", semver: "1.0.0",
        executable: false, reasons: [], approvalBlockers: [],
        files: [{ path: "plugin.json", sha256: sha2, sizeBytes: 128 }] };
    await db.query(`SELECT * FROM full_catalog.cms_publish_reviewed_agent_package(
        'safe-pkg','safe-v1','safe-kit','shared','entra','publisher',NULL,
        '1.0.0',$1,128,'safe.tar.gz',NULL,'{"agents":[{"name":"helper"}]}'::JSONB,'publisher',FALSE,$2)`,
    [sha2, JSON.stringify(inspection)]);
    await assert.rejects(catalog.packageReviews.bindNewSession("historical", "safe-pkg", "safe-kit:helper"), /historical session/);
    await rollback;
    const cacheDir = fs.mkdtempSync(path.resolve(".test-legacy-cache-"));
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const installed = await installAgentPackages({ catalog, cacheDir, artifactStore: {
        downloadArtifact: async (_sessionId, filename) => {
            if (filename === "legacy-data.tar.gz") return { body: legacyData.targz };
            throw new Error("Other fixture artifacts deliberately unavailable");
        },
    } });
    const legacyInstall = installed.packages.find(pkg => pkg.versionId === "legacy-data-v1");
    assert.equal(legacyInstall.status, "ok", legacyInstall.error);
    await catalog.createSession("legacy-data-new-session", { owner: { provider: "entra", subject: "publisher" },
        creationConfig: { boundAgentName: "review-kit:helper", boundAgentPackageId: "legacy-data" } });
    assert.equal((await catalog.packageReviews.getSessionBinding("legacy-data-new-session")).allowed, true);
    const owner = { provider: "entra", subject: "publisher" };
    await catalog.createSession("new-bound", { owner,
        creationConfig: { boundAgentName: "safe-kit:helper", boundAgentPackageId: "safe-pkg" } });
    assert.equal((await catalog.packageReviews.getSessionBinding("new-bound")).versionId, "safe-v1");
    await catalog.createSession("new-root", { owner, agentId: "safe-kit:helper" });
    await catalog.packageReviews.bindNewSession("new-root", "safe-pkg", "safe-kit:helper");
    assert.equal((await catalog.packageReviews.getSessionBinding("new-root")).allowed, true);
    await assert.rejects(catalog.createSession("denied-create", { owner,
        creationConfig: { boundAgentName: "legacy-kit:helper", boundAgentPackageId: "legacy-pkg" } }), /REVIEW_BLOCKED/);
    assert.equal((await db.query("SELECT count(*) AS n FROM full_catalog.sessions WHERE session_id='denied-create'")).rows[0].n, 0);
});
