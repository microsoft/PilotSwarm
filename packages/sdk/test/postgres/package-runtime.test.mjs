import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { inspectAgentPackageArtifact } from "../../dist/agent-package-authorization.js";
import { PgPackageRuntimeAuthority } from "../../dist/package-runtime-authority.js";
import { SupervisedPackageRuntime } from "../../dist/package-runtime-supervisor.js";
import { installAgentPackages, loadAgentPackageTools } from "../../dist/agent-package-installer.js";

const url = process.env.PACKAGE_TEST_PG_URL ?? "postgresql://package_test@127.0.0.1:55439/postgres";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Standalone acceptance requires an isolated LOCAL PostgreSQL server");
const admin = { principal: { provider: "entra", subject: "admin" }, isAdmin: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(50); }
    assert.fail(message);
}

async function fixture(t, { mcp = false, executable = true } = {}) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const schema = `runtime_${randomUUID().replaceAll("-", "")}`;
    const base = fs.mkdtempSync(path.resolve(".test-package-runtime-"));
    const runtimes = [];
    t.after(async () => {
        await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
        fs.rmSync(base, { recursive: true, force: true });
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const migration of CMS_MIGRATIONS(schema)) {
        for (const sql of migration.steps ?? [migration.sql]) await pool.query(sql);
    }
    const catalog = new PgSessionCatalog(pool, schema);
    const authority = new PgPackageRuntimeAuthority(pool, schema);
    const marker = path.join(base, "module-events");
    const mcpMarker = path.join(base, "mcp-events");
    const events = () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
    const mcpEvents = () => fs.existsSync(mcpMarker) ? fs.readFileSync(mcpMarker, "utf8").trim().split("\n") : [];
    const sql = (text, values) => pool.query(text.replaceAll("@s", `"${schema}"`), values);
    const publish = async (versionId = "v1", semver = "1.0.0", code = executable) => {
        const dir = path.join(base, versionId);
        fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
        fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "runtime-kit", version: semver }));
        fs.writeFileSync(path.join(dir, "agents", "helper.agent.md"),
            `---\nname: helper\nschemaVersion: 2\nversion: ${semver}\ndescription: test helper\ntools: [ping]\n${mcp ? "mcpServers: [demo]\n" : ""}---\nTest.`);
        if (code) {
            fs.mkdirSync(path.join(dir, "tools"));
            fs.writeFileSync(path.join(dir, "tools", "worker-module.mjs"), `
import fs from "node:fs";
const mark = value => fs.appendFileSync(${JSON.stringify(marker)}, value + ":" + process.pid + "\\n");
mark("import");
export function createTools() {
 mark("factory");
 return [{name:"ping",description:"test",parameters:{type:"object",properties:{}},
 handler: async args => {mark("handler"); if(args.block){for(;;){}} return {pid:process.pid,args};}}];
}`);
        }
        if (mcp) {
            fs.mkdirSync(path.join(dir, "mcp-servers"));
            fs.writeFileSync(path.join(dir, "mcp-servers", "demo.mjs"), `
import fs from "node:fs";
import {createInterface} from "node:readline";
const mark = value => fs.appendFileSync(${JSON.stringify(mcpMarker)}, value + ":" + process.pid + "\\n");
mark("start");
createInterface({input:process.stdin}).on("line", line => {
 const request = JSON.parse(line); if(!request.id)return;
 let result = {};
 if(request.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"test",version:"1"}};
 if(request.method==="tools/list")result={tools:[{name:"echo",description:"echo",inputSchema:{type:"object"}}]};
 if(request.method==="tools/call"){mark("call");if(request.params.arguments?.block){for(;;){}}result={content:[{type:"text",text:"ok"}]};}
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});`);
            fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { demo: {
                command: "node", args: ["mcp-servers/demo.mjs"],
            } } }));
        }
        const packed = packAgentPackage(dir);
        const inspection = inspectAgentPackageArtifact(packed.targz, packed.sha256);
        if (code || mcp) assert.ok(inspection.execution, inspection.approvalBlockers.join("; "));
        const manifest = { agents: [{ name: "helper", tools: ["ping"], mcpServers: ["demo"] }] };
        await sql(`SELECT * FROM @s.cms_publish_reviewed_agent_package(
            'pkg',$1,'runtime-kit','shared','entra','publisher',NULL,$2,$3,$4,$5,NULL,$6,'publisher',FALSE,$7)`,
        [versionId, semver, packed.sha256, packed.rawBytes, `${versionId}.tar.gz`, JSON.stringify(manifest), JSON.stringify(inspection)]);
        return { packageId: "pkg", versionId, sha256: packed.sha256, dir, inspection, targz: packed.targz };
    };
    const decide = async (candidate, decision = "approved", revision = 1) =>
        catalog.packageReviews.decide(admin, { packageId: "pkg", versionId: candidate.versionId, sha256: candidate.sha256,
            expectedRevision: revision, decision, reason: "standalone runtime acceptance" });
    const activate = async (candidate, expectedActiveVersionId = null, expectedActivationRevision = 1) =>
        catalog.packageReviews.activate(admin, { packageId: "pkg", versionId: candidate.versionId, sha256: candidate.sha256,
            expectedReviewRevision: 2, expectedActiveVersionId, expectedActivationRevision, reason: "explicit exact activation" });
    const bind = async (id = "session-1") => {
        await catalog.createSession(id, { owner: { provider: "entra", subject: "publisher" },
            creationConfig: { boundAgentPackageId: "pkg", boundAgentName: "runtime-kit:helper" } });
    };
    const start = async (candidate, worker = "worker-a") => {
        const started = await SupervisedPackageRuntime.start(authority, candidate, candidate.dir, candidate.inspection.execution, worker);
        runtimes.push(started.runtime);
        return started;
    };
    return { pool, schema, base, runtimes, catalog, authority, sql, publish, decide, activate, bind, start, events, mcpEvents, marker };
}

test("standalone PostgreSQL: full migrations, explicit approval/activation, child-only import/factory and exact session tools", async t => {
    const f = await fixture(t);
    const candidate = await f.publish();
    await assert.rejects(f.start(candidate), /DENIED/);
    assert.equal(f.events().length, 0);
    await f.decide(candidate);
    assert.equal((await f.sql("SELECT active_version_id FROM @s.agent_packages")).rows[0].active_version_id, null);
    await f.activate(candidate);
    assert.equal((await f.sql("SELECT * FROM @s.cms_get_agent_packages_install_manifest()")).rowCount, 0,
        "legacy cold loader must not receive approved executable artifacts");
    assert.equal((await f.catalog.getAgentPackagesInstallManifest()).length, 1);
    await f.bind();
    const { runtime, tools } = await f.start(candidate);
    const result = await tools[0].handler({ value: 7 }, { durableSessionId: "session-1" });
    assert.notEqual(result.pid, process.pid);
    assert.deepEqual(f.events().map(line => line.split(":")[0]), ["import", "factory", "handler"]);
    assert.equal(new Set(f.events().map(line => line.split(":")[1])).size, 1);
    await assert.rejects(runtime.invoke("not-a-session", "ping", {}), /DENIED/);
    await assert.rejects(runtime.invoke("session-1", "undeclared", {}), /DENIED/);
    assert.equal(f.events().length, 3);
    await runtime.stop();
    assert.equal((await f.sql("SELECT state FROM @s.package_runtime_registrations")).rows[0].state, "fenced");
    const audit = (await f.sql("SELECT operation,event FROM @s.package_runtime_audit ORDER BY sequence")).rows;
    assert.equal(audit.filter(row => row.event === "admitted").length, 3);
});

test("standalone PostgreSQL: accepted v2 activates only explicitly, existing v1 pins never substitute, rejected v3 and stale CAS retain v2", async t => {
    const f = await fixture(t);
    const v1 = await f.publish(); await f.decide(v1); await f.activate(v1); await f.bind();
    const v2 = await f.publish("v2", "2.0.0"); await f.decide(v2);
    assert.equal((await f.catalog.packageReviews.getSessionBinding("session-1")).versionId, "v1");
    await f.activate(v2, "v1", 2); await f.bind("session-2");
    assert.equal((await f.catalog.packageReviews.getSessionBinding("session-1")).versionId, "v1");
    assert.equal((await f.catalog.packageReviews.getSessionBinding("session-2")).versionId, "v2");
    const first = await f.start(v1);
    await first.runtime.invoke("session-1", "ping", {});
    await assert.rejects(first.runtime.invoke("session-2", "ping", {}), /DENIED/);
    const v3 = await f.publish("v3", "3.0.0"); await f.decide(v3, "rejected");
    await assert.rejects(f.decide(v3), error => error.code === "CONFLICT");
    await assert.rejects(f.activate(v2, "v1", 2), error => error.code === "CONFLICT");
    assert.equal((await f.sql("SELECT active_version_id FROM @s.agent_packages")).rows[0].active_version_id, "v2");
});

test("standalone PostgreSQL: deny-first revoke kills synchronous JS across TWO supervisors and needs observed exits", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const a = await f.start(candidate, "worker-a"), b = await f.start(candidate, "worker-b");
    const blockedA = a.runtime.invoke("session-1", "ping", { block: true }).catch(error => error);
    const blockedB = b.runtime.invoke("session-1", "ping", { block: true }).catch(error => error);
    await until(() => f.events().filter(line => line.startsWith("handler:")).length === 2, "both child handlers must actually start");
    await f.decide(candidate, "revoked", 2);
    await assert.rejects(a.runtime.invoke("session-1", "ping", {}), /DENIED|fenced/);
    await until(async () => (await f.authority.fencingStatus(candidate)).complete, "revocation cannot complete before both child exits are acknowledged");
    assert.ok(await blockedA instanceof Error);
    assert.ok(await blockedB instanceof Error);
    assert.equal(f.events().filter(line => line.startsWith("handler:")).length, 2);
    assert.deepEqual(await f.authority.fencingStatus(candidate), { denied: true, complete: true, outstanding: 0 });
    await assert.rejects(f.start(candidate, "worker-c"), /DENIED/);
    assert.equal(f.events().filter(line => line.startsWith("import:")).length, 2);
});

test("standalone PostgreSQL: unreachable registration lease expiry NEVER fabricates fencing completion", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate);
    await f.authority.register(candidate, "unreachable-worker");
    await f.decide(candidate, "revoked", 2);
    await f.sql("UPDATE @s.package_runtime_registrations SET lease_until=clock_timestamp()-interval '1 hour'");
    assert.deepEqual(await f.authority.fencingStatus(candidate), { denied: true, complete: false, outstanding: 1 });
    assert.equal(f.events().length, 0);
});

test("standalone PostgreSQL: admission ordering blocks a concurrent revoke until the authoritative barrier is released", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate);
    const blocker = await f.pool.connect();
    try {
        await blocker.query(`BEGIN; SELECT "${f.schema}".cms_package_runtime_barrier()`);
        let finished = false;
        const revoke = f.decide(candidate, "revoked", 2).then(() => { finished = true; });
        await sleep(100); assert.equal(finished, false);
        await blocker.query("COMMIT");
        await revoke;
        await assert.rejects(f.authority.register(candidate, "late-worker"), /DENIED/);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

for (const change of ["owner", "capabilities", "session-deleted", "disabled"]) {
    test(`standalone PostgreSQL: current ${change} change invalidates live registration, warm calls and exact epochs`, async t => {
        const f = await fixture(t);
        const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
        const { runtime } = await f.start(candidate);
        await runtime.invoke("session-1", "ping", {});
        if (change === "owner") await f.sql("UPDATE @s.users SET subject='replacement' WHERE subject='publisher'");
        if (change === "capabilities") await f.sql(`INSERT INTO @s.session_capabilities(session_id,revision,state)
            VALUES('session-1',1,'{"revision":1,"selections":[]}')`);
        if (change === "session-deleted") await f.sql("UPDATE @s.sessions SET deleted_at=clock_timestamp() WHERE session_id='session-1'");
        if (change === "disabled") await f.sql("UPDATE @s.agent_packages SET enabled=FALSE WHERE package_id='pkg'");
        await assert.rejects(runtime.invoke("session-1", "ping", {}), /DENIED|fenced/);
        await until(async () => (await f.sql("SELECT state FROM @s.package_runtime_registrations")).rows[0].state === "fenced", "changed authority must terminate child generation");
        assert.equal(f.events().filter(line => line.startsWith("handler:")).length, 1);
    });
}

test("standalone PostgreSQL: broker-owned stdio MCP startup/list/call are individually authorized and revoked children exit", async t => {
    const f = await fixture(t, { mcp: true });
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const { runtime } = await f.start(candidate);
    await assert.rejects(runtime.startMcp("missing", "demo"), /DENIED/);
    assert.equal(f.mcpEvents().length, 0);
    await runtime.startMcp("session-1", "demo");
    const listed = await runtime.callMcp("session-1", "demo", "tools/list", {});
    assert.equal(listed.tools[0].name, "echo");
    await runtime.callMcp("session-1", "demo", "tools/call", { name: "echo", arguments: {} });
    assert.deepEqual(f.mcpEvents().map(line => line.split(":")[0]), ["start", "call"]);
    assert.notEqual(Number(f.mcpEvents()[0].split(":")[1]), process.pid);
    await f.decide(candidate, "revoked", 2);
    await assert.rejects(runtime.callMcp("session-1", "demo", "tools/call", { name: "echo" }), /DENIED|fenced/);
    await until(async () => (await f.authority.fencingStatus(candidate)).complete, "MCP child exit must be observed before fence completion");
    assert.equal(f.mcpEvents().length, 2);
});

test("standalone PostgreSQL: exact worker/generation/review/registry/owner/capability/digest substitutions deny before callback", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const reg = await f.authority.register(candidate, "worker");
    const context = await f.authority.context("session-1");
    const request = { ...candidate, ...reg, ...context, operation: "tool", target: "ping",
        expectedReviewRevision: reg.reviewRevision, expectedRegistryEpoch: reg.registryEpoch,
        expectedOwnerEpoch: context.ownerEpoch, expectedCapabilityEpoch: context.capabilityEpoch };
    let callbacks = 0;
    for (const patch of [
        { workerFence: "obsolete" }, { workerNodeId: "other-worker" },
        { expectedReviewRevision: reg.reviewRevision + 1 }, { expectedRegistryEpoch: reg.registryEpoch + 1 },
        { expectedOwnerEpoch: context.ownerEpoch + 1 }, { expectedCapabilityEpoch: context.capabilityEpoch + 1 },
        { sha256: "0".repeat(64) }, { versionId: "substitution" }, { target: "not-declared" },
        { effectiveOwner: { provider: "entra", subject: "other" } },
    ]) await assert.rejects(f.authority.withAdmission({ ...request, ...patch }, async () => { callbacks++; }), /DENIED/);
    assert.equal(callbacks, 0);
    await f.authority.withAdmission(request, async () => { callbacks++; });
    assert.equal(callbacks, 1);
});

test("standalone PostgreSQL: materialized warm cache and descriptor substitutions are rejected before imports", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const modulePath = path.join(candidate.dir, "tools", "worker-module.mjs"), source = fs.readFileSync(modulePath);
    fs.appendFileSync(modulePath, "\nthrow new Error('tampered');");
    await assert.rejects(f.start(candidate), /artifact mismatch/);
    assert.equal(f.events().length, 0);
    fs.writeFileSync(modulePath, source);
    await assert.rejects(SupervisedPackageRuntime.start(f.authority, candidate, candidate.dir,
        { ...candidate.inspection.execution, module: "..\\elsewhere.mjs" }, "worker"), /descriptor differs/);
    assert.equal(f.events().length, 0);
    const { runtime } = await f.start(candidate);
    await runtime.invoke("session-1", "ping", {});
    await f.decide(candidate, "revoked", 2);
    await assert.rejects(f.start(candidate), /DENIED/);
    assert.equal(f.events().length, 3);
});

test("standalone PostgreSQL: REAL worker cold/forced-warm loader imports only into supervised children and stops owned processes", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const worker = new PilotSwarmWorker({
        store: "sqlite::memory:", workerNodeId: "actual-worker", pluginDirs: [],
        sessionStateDir: path.join(f.base, "worker-sessions"),
        modelProvidersPath: path.resolve("packages", "sdk", "test", "fixtures", "model-providers.test.json"),
        agentPackages: { cacheDir: path.join(f.base, "worker-cache") },
    });
    worker._catalog = new PgSessionCatalog(new pg.Pool({ connectionString: url, max: 4 }), f.schema);
    worker.artifactStore = { downloadArtifact: async () => ({ body: candidate.targz }) };
    try {
        for (let i = 0; i < 2; i++) {
            await worker.refreshAgentPackages({ force: true });
            assert.equal(worker._agentPackagesInstalled["runtime-kit"].status, "ok");
            const tool = worker._agentPackageToolsByPackage.get("pkg").get("ping");
            const result = await tool.handler({}, { durableSessionId: "session-1" });
            assert.notEqual(result.pid, process.pid);
        }
        assert.deepEqual(f.events().map(line => line.split(":")[0]), ["import", "factory", "handler", "import", "factory", "handler"]);
        await f.decide(candidate, "revoked", 2);
        await worker.refreshAgentPackages({ force: true });
        assert.equal(worker._agentPackageTools.size, 0);
        assert.equal(worker._agentPackagesInstalled["runtime-kit"].status, "error");
        assert.equal(f.events().length, 6);
    } finally { await worker.stop(); }
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.package_runtime_registrations WHERE state<>'fenced'")).rows[0].n, 0);
});

test("standalone PostgreSQL: unsupported automatic MCP registration is rejected as a WHOLE package, never passed to raw plugin startup", async t => {
    const f = await fixture(t, { mcp: true });
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate);
    const result = await installAgentPackages({ catalog: f.catalog, artifactStore: { downloadArtifact: async () => ({ body: candidate.targz }) },
        cacheDir: path.join(f.base, "cache"), runtimeAuthority: f.authority });
    assert.equal(result.packages[0].status, "error");
    assert.match(result.packages[0].error, /automatic package MCP registration is unsupported/);
    assert.deepEqual(result.pluginDirs, []);
    assert.equal(f.events().length, 0);
    assert.equal(f.mcpEvents().length, 0);
    await assert.rejects(loadAgentPackageTools({ ...result.packages[0], workerModulePath: "forged" }, {}), /DENIED/);
});

test("standalone PostgreSQL: synchronous stdio MCP code is killed by responsive broker, not the worker event loop", async t => {
    const f = await fixture(t, { mcp: true });
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate); await f.bind();
    const { runtime } = await f.start(candidate);
    await runtime.startMcp("session-1", "demo");
    const blocked = runtime.callMcp("session-1", "demo", "tools/call", { name: "echo", arguments: { block: true } }).catch(error => error);
    await until(() => f.mcpEvents().length === 2, "MCP call must actually enter synchronous package code");
    await f.decide(candidate, "revoked", 2);
    await until(async () => (await f.authority.fencingStatus(candidate)).complete, "MCP fencing requires observed real process exit");
    assert.ok(await blocked instanceof Error);
    assert.equal(f.mcpEvents().length, 2);
});

test("standalone PostgreSQL: ordered migration reapplication retains real eligibility/barrier, approved identities and audit", async t => {
    const f = await fixture(t);
    const candidate = await f.publish(); await f.decide(candidate);
    const migrations = CMS_MIGRATIONS(f.schema);
    for (const version of ["0085", "0084", "0085"]) {
        await f.pool.query(migrations.find(migration => migration.version === version).sql);
    }
    assert.equal((await f.sql("SELECT @s.cms_package_executable_eligible('pkg','v1',$1) AS allowed", [candidate.sha256])).rows[0].allowed, true);
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.agent_package_review_audit")).rows[0].n, 1);
    const client = await f.pool.connect();
    try {
        await client.query(`BEGIN; SELECT "${f.schema}".cms_package_runtime_barrier()`);
        const other = await f.pool.connect();
        try {
            const result = await other.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS available", [`${f.schema}:package-runtime-admission`]);
            assert.equal(result.rows[0].available, false);
        } finally { other.release(); }
    } finally { await client.query("ROLLBACK"); client.release(); }
});
