import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import { packAgentPackage } from "../../dist/agent-package-format.js";
import { inspectAgentPackageArtifact } from "../../dist/agent-package-authorization.js";
import { PgPackageRuntimeAuthority } from "../../dist/package-runtime-authority.js";
import { SupervisedPackageRuntime } from "../../dist/package-runtime-supervisor.js";
import { installAgentPackages, loadAgentPackageTools } from "../../dist/agent-package-installer.js";
import { PackageMcpGateway } from "../../dist/package-runtime-mcp-gateway.js";
import { capabilityRef } from "../../dist/capability-catalog.js";
import { runtimeProcessToken } from "../../dist/package-runtime-process.js";
import { createServer } from "node:http";
import { SessionManager } from "../../dist/session-manager.js";
import { registerActivities } from "../../dist/session-proxy.js";
import { loadAgentPackageCronPrechecks } from "../../dist/agent-package-installer.js";

const url = process.env.PACKAGE_TEST_PG_URL ?? "postgresql://package_test@127.0.0.1:55439/postgres";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Standalone acceptance requires an isolated LOCAL PostgreSQL server");
const admin = { principal: { provider: "entra", subject: "admin" }, isAdmin: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(50); }
    assert.fail(message);
}

async function fixture(t, { mcp = false, executable = true, callbacks = false, noTools = false, noMcp = false, scope = "shared", cron = false } = {}) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const schema = `runtime_${randomUUID().replaceAll("-", "")}`;
    const base = fs.mkdtempSync(path.resolve(".test-package-runtime-"));
    const runtimes = [];
    t.after(async () => {
        try {
            await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
            await authority.recoverLocal();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
        } finally { await pool.end(); }
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
    const publish = async (versionId = "v1", semver = "1.0.0", code = executable, packageId = "pkg", name = "runtime-kit") => {
        const dir = path.join(base, versionId);
        fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
        fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: semver,
            ...(callbacks ? { callbacks: { check: { agents: ["helper"], tools: ["ping"], mcpServers: mcp ? ["demo"] : [] } } } : {}),
            ...(cron ? { cronPrechecks: { queue: { callback: "check", timeoutMs: 1000 } } } : {}) }));
        fs.writeFileSync(path.join(dir, "agents", "helper.agent.md"),
            `---\nname: helper\nschemaVersion: 2\nversion: ${semver}\ndescription: test helper\ntools: ${noTools ? "[]" : "[ping]"}\n${mcp && !noMcp ? "mcpServers: [demo]\n" : ""}---\nTest.`);
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
}
${callbacks ? `export function createCallbacks() {
 mark("callback-factory");
 return [{name:"check",handler:async(args,context)=>{
  mark("callback");
  if(args.action==="block"){for(;;){}}
  ${cron ? 'if(args.reason==="block"){for(;;){}} args.action=args.reason;' : ""}
  if(args.action==="caught"){try{await context.callTool("ping",{});}catch{}return {skip:true};}
  if(args.action==="unfinished"){void context.callTool("ping",{block:true}).catch(()=>{});return {skip:true};}
  if(args.action==="mcp"){try{await context.callMcp("demo","tools/call",{name:"echo",arguments:{}});}catch{}return {skip:true};}
  return ${cron ? '{action:"skip"}' : '{skip:true}'};
 }}];
}` : ""}`);
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
        const manifest = { agents: [{ name: "helper", tools: noTools ? [] : ["ping"], mcpServers: mcp && !noMcp ? ["demo"] : [] }] };
        await sql(`SELECT * FROM @s.cms_publish_reviewed_agent_package(
            $8,$1,$9,$10,'entra','publisher',NULL,$2,$3,$4,$5,NULL,$6,'publisher',FALSE,$7)`,
        [versionId, semver, packed.sha256, packed.rawBytes, `${versionId}.tar.gz`, JSON.stringify(manifest), JSON.stringify(inspection), packageId, name, scope]);
        return { packageId, versionId, sha256: packed.sha256, dir, inspection, targz: packed.targz };
    };
    const decide = async (candidate, decision = "approved", revision = 1) =>
        catalog.packageReviews.decide(admin, { packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
            expectedRevision: revision, decision, reason: "standalone runtime acceptance" });
    const activate = async (candidate, expectedActiveVersionId = null, expectedActivationRevision = 1) =>
        catalog.packageReviews.activate(admin, { packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
            expectedReviewRevision: 2, expectedActiveVersionId, expectedActivationRevision, reason: "explicit exact activation" });
    const bind = async (id = "session-1") => {
        await catalog.createSession(id, { owner: { provider: "entra", subject: "publisher" },
            creationConfig: { boundAgentPackageId: "pkg", boundAgentName: "helper" } });
    };
    const start = async (candidate, worker = "worker-a") => {
        const started = await SupervisedPackageRuntime.start(authority, candidate, candidate.dir, candidate.inspection.execution, worker,
            runtime => runtimes.push(runtime));
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
    await assert.rejects(f.start(candidate), /not explicitly active or pinned/);
    assert.deepEqual(f.events(), [], "content approval without activation must not import or invoke factories");
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

test("standalone PostgreSQL: private executable packages need independent approval and current owner access, never scope-based trust", async t => {
    const f = await fixture(t, { scope: "user" });
    const c = await f.publish();
    await assert.rejects(f.start(c), /DENIED/);
    assert.deepEqual(f.events(), []);
    await f.decide(c); await f.activate(c); await f.bind();
    await assert.rejects(f.catalog.createSession("outsider", { owner: { provider: "entra", subject: "stranger" },
        creationConfig: { boundAgentPackageId: "pkg", boundAgentName: "helper" } }), /denied|allowed|private|unavailable|access/i);
    const { runtime } = await f.start(c);
    await runtime.invoke("session-1", "ping", {});
    const before = f.events();
    await f.sql("UPDATE @s.agent_packages SET enabled=FALSE WHERE package_id='pkg'");
    await assert.rejects(runtime.invoke("session-1", "ping", {}), /DENIED|fenced/);
    assert.deepEqual(f.events(), before);
});

test("standalone PostgreSQL: a caller's exit-observed boolean cannot fence still-live recorded processes", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const authority = new PgPackageRuntimeAuthority(f.pool, f.schema, 30_000);
    const registration = await authority.register(c, "uncooperative-test-host");
    const script = path.join(f.base, "recorded-live-process.mjs");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);");
    const child = fork(script, [], { execArgv: [], stdio: "ignore" });
    const exited = new Promise(resolve => child.once("exit", resolve));
    try {
        await authority.noteProcess(registration, child.pid, "execution");
        await authority.requestFence(registration);
        await assert.rejects(authority.acknowledgeFence(registration, true), /process has not exited/);
        assert.equal((await authority.fencingStatus(c)).outstanding, 1);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await authority.requestFence(registration);
        await authority.acknowledgeFence(registration, true);
    }
    assert.equal((await authority.fencingStatus(c)).outstanding, 0);
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
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate);
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

for (const change of ["owner", "capabilities", "session-deleted", "disabled", "agent-configuration", "package-deleted"]) {
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
        if (change === "agent-configuration") await f.sql(`UPDATE @s.sessions SET creation_config=jsonb_set(creation_config,'{boundAgentName}','"different"') WHERE session_id='session-1'`);
        if (change === "package-deleted") await f.catalog.deleteAgentPackage("runtime-kit", admin.principal, true, { scope: "shared" });
        await assert.rejects(runtime.invoke("session-1", "ping", {}), /DENIED|fenced/);
        await until(async () => (await f.sql("SELECT state FROM @s.package_runtime_registrations")).rows[0].state === "fenced", "changed authority must terminate child generation");
        assert.equal(f.events().filter(line => line.startsWith("handler:")).length, 1);
        if (change === "agent-configuration") {
            const fresh = (await f.start(candidate)).runtime;
            await assert.rejects(fresh.invoke("session-1", "ping", {}), /configuration conflicts/);
            assert.equal(f.events().filter(line => line.startsWith("handler:")).length, 1);
        }
        if (change === "package-deleted") {
            assert.deepEqual(await f.authority.fencingStatus(candidate), { denied: true, complete: true, outstanding: 0 });
            assert.equal((await f.catalog.packageReviews.audit(admin, "v1")).length, 1, "deletion must preserve decision history");
        }
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

test("standalone PostgreSQL: automatic MCP installation retains only supervised configuration and starts no raw executable", async t => {
    const f = await fixture(t, { mcp: true });
    const candidate = await f.publish(); await f.decide(candidate); await f.activate(candidate);
    const result = await installAgentPackages({ catalog: f.catalog, artifactStore: { downloadArtifact: async () => ({ body: candidate.targz }) },
        cacheDir: path.join(f.base, "cache"), runtimeAuthority: f.authority });
    assert.equal(result.packages[0].status, "ok");
    assert.equal(result.pluginDirs.length, 1);
    assert.equal(f.events().length, 0);
    assert.equal(f.mcpEvents().length, 0);
    await assert.rejects(loadAgentPackageTools({ ...result.packages[0], workerModulePath: "forged" }, {}), /DENIED/);
});

test("standalone PostgreSQL: callbacks run for a current owner without tools; caught denied calls never fabricate skip", async t => {
    const f = await fixture(t, { callbacks: true, noTools: true });
    const c = await f.publish();
    await assert.rejects(f.start(c), /DENIED/);
    assert.deepEqual(f.events(), []);
    await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    assert.deepEqual(f.events().map(e => e.split(":")[0]), ["import", "factory", "callback-factory"]);
    await assert.rejects(runtime.invokeCallback("session-1", "check", {}, { bindingRevision: 0 }), /stale.*revision/);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 0);
    assert.deepEqual(await runtime.invokeCallback("session-1", "check", {}, { bindingRevision: 1 }), { skip: true });
    await assert.rejects(runtime.invokeCallback("session-1", "check", { action: "caught" }), /NESTED_CALL_FAILED_OR_UNFINISHED/);
    assert.equal(f.events().filter(e => e.startsWith("handler:")).length, 0);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 2);
    const beforeOwnerChange = f.events();
    await f.sql("UPDATE @s.session_owners SET user_id=(SELECT user_id FROM @s.users WHERE subject='admin') WHERE session_id='session-1'").catch(async () => {
        await f.sql("DELETE FROM @s.session_owners WHERE session_id='session-1'");
    });
    await assert.rejects(runtime.invokeCallback("session-1", "check", {}), /DENIED|fenced/);
    assert.deepEqual(f.events(), beforeOwnerChange, "denial adds zero imports, factories, callbacks or handlers");
});

test("standalone PostgreSQL: caller cancellation kills a synchronous callback without recycling the worker", async t => {
    const f = await fixture(t, { callbacks: true, noTools: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    const controller = new AbortController();
    const failed = assert.rejects(runtime.invokeCallback("session-1", "check", { action: "block" },
        { signal: controller.signal, bindingRevision: 1 }), /stop|fenc|cancel|closed|exit/i);
    await until(() => f.events().filter(e => e.startsWith("callback:")).length === 1, "actual synchronous callback entered");
    controller.abort();
    await failed;
    await until(async () => (await f.authority.fencingStatus(c)).outstanding === 0, "cancellation observes child exits");
    const before = f.events();
    await assert.rejects(runtime.invokeCallback("session-1", "check", {}), /fenced/);
    assert.deepEqual(f.events(), before);
});

test("standalone PostgreSQL: unfinished callback tool requests cannot authorize skip", async t => {
    const f = await fixture(t, { callbacks: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    await assert.rejects(runtime.invokeCallback("session-1", "check", { action: "unfinished" }), /NESTED_CALL_FAILED_OR_UNFINISHED/);
    await until(async () => (await f.authority.fencingStatus(c)).outstanding === 0, "unfinished callback must clean up its generation");
});

test("standalone PostgreSQL: caught denied MCP inside a callback never starts a server or fabricates skip", async t => {
    const f = await fixture(t, { callbacks: true, mcp: true, noMcp: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    await assert.rejects(runtime.invokeCallback("session-1", "check", { action: "mcp" }), /NESTED_CALL_FAILED_OR_UNFINISHED/);
    assert.equal(f.mcpEvents().length, 0);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1);
    await f.decide(c, "revoked", 2);
    await assert.rejects(runtime.invokeCallback("session-1", "check", {}), /DENIED|fenced/);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1);
});

test("standalone PostgreSQL: declared callback deployment-MCP bridge preserves authoritative admission and latches protocol failures", async t => {
    const f = await fixture(t, { callbacks: true, mcp: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    let calls = 0;
    const services = { callMcp: async (name, method, args, context) => {
        assert.equal(name, "demo"); assert.equal(method, "tools/call"); assert.equal(context.durableSessionId, "session-1");
        calls++;
        return { isError: true, content: [{ type: "text", text: "trusted deployment MCP failed" }] };
    } };
    await assert.rejects(runtime.invokeCallback("session-1", "check", { action: "mcp" }, services),
        { code: "PACKAGE_CALLBACK_NESTED_CALL_FAILED_OR_UNFINISHED" });
    assert.equal(calls, 1);
    assert.equal(f.mcpEvents().length, 0, "a trusted deployment bridge must not silently start the package server");
    await f.decide(c, "revoked", 2);
    await assert.rejects(runtime.invokeCallback("session-1", "check", { action: "mcp" }, services), /DENIED|fenced/);
    assert.equal(calls, 1);
});

test("standalone PostgreSQL: browser review/activation/revoke workflow uses authenticated real SQL decisions and live fencing status", { timeout: 60_000 }, async t => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const f = await fixture(t);
    await f.publish();
    const token = randomUUID();
    const bundle = await build({ stdin: { contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {PackageReviewTabs} from "./packages/app/ui/react/src/package-review-tabs.js";
const rpc=async(op,args=[])=>{const r=await fetch("/api/"+op,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(args)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
const controller={transport:{
 listAgentPackageReviews:()=>rpc("list"),
 decideAgentPackageReview:arg=>rpc("decide",[arg]),
 activateAgentPackageVersion:arg=>rpc("activate",[arg]),
 getAgentPackageReviewAudit:arg=>rpc("audit",[arg]),
 getAgentPackageActivationAudit:arg=>rpc("activationAudit",[arg]),
 getAgentPackageFile:(...args)=>rpc("file",args)}};
createRoot(document.getElementById("root")).render(React.createElement(PackageReviewTabs,{controller,view:{isAdmin:ADMIN_VIEW,settingsTree:[]}}));`,
        resolveDir: path.resolve("."), loader: "js" }, bundle: true, write: false, format: "iife",
        define: { "process.env.NODE_ENV": '"test"', ADMIN_VIEW: "globalThis.ADMIN_VIEW" } });
    const server = createServer(async (req, res) => {
        const authenticatedAdmin = req.headers.cookie === `review=${token}`;
        const actor = authenticatedAdmin ? admin : { principal: { provider: "entra", subject: "viewer" }, isAdmin: false };
        try {
            if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(`<div id="root"></div><script>globalThis.ADMIN_VIEW=${authenticatedAdmin}</script><script src="/bundle.js"></script>`); return; }
            if (req.url === "/bundle.js") { res.setHeader("content-type", "application/javascript"); res.end(bundle.outputFiles[0].text); return; }
            if (req.method !== "POST" || !req.url.startsWith("/api/")) { res.writeHead(404).end(); return; }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const args = JSON.parse(Buffer.concat(chunks).toString());
            const op = req.url.slice(5);
            let result;
            if (op === "list") result = await f.catalog.packageReviews.list(actor);
            else if (op === "decide") result = await f.catalog.packageReviews.decide(actor, args[0]);
            else if (op === "activate") result = await f.catalog.packageReviews.activate(actor, args[0]);
            else if (op === "audit") result = await f.catalog.packageReviews.audit(actor, args[0]);
            else if (op === "activationAudit") result = await f.catalog.packageReviews.activationAudit(actor, args[0]);
            else if (op === "file") {
                const reviews = await f.catalog.packageReviews.list(actor);
                const candidate = reviews.find(r => r.name === args[0] && r.semver === args[1]);
                assert.ok(candidate?.inspection.files.some(file => file.path === args[2]));
                result = { content: fs.readFileSync(path.join(f.base, candidate.versionId, args[2]), "utf8") };
            } else throw new Error("Unknown test operation");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result ?? { recorded: true }));
        } catch (error) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    const browserDir = path.join(f.base, "browser-work");
    fs.mkdirSync(browserDir);
    process.env.TEMP = process.env.TMP = browserDir;
    let browser;
    try {
        browser = await chromium.launch({ channel: "msedge", headless: true, downloadsPath: browserDir });
        const context = await browser.newContext();
        await context.addCookies([{ name: "review", value: token, url: endpoint }]);
        const page = await context.newPage();
        page.on("dialog", dialog => dialog.accept("browser exact reviewed decision"));
        await page.goto(endpoint);
        assert.deepEqual(await page.getByRole("tab").allTextContents(), ["Private", "Pending Approval", "Shared"]);
        await page.getByRole("tab", { name: "Pending Approval" }).click();
        const article = semver => page.locator("article").filter({ has: page.getByRole("heading", { name: new RegExp(`runtime-kit@${semver.replaceAll(".", "\\.")} ·`) }) });
        await article("1.0.0").getByRole("button", { name: "tools/worker-module.mjs", exact: true }).click();
        await page.getByText(/export function createTools/, { exact: false }).last().waitFor();
        await article("1.0.0").getByRole("button", { name: "Approve artifact contents", exact: true }).click();
        await article("1.0.0").getByRole("heading", { name: /artifact content: approved/ }).waitFor();
        await article("1.0.0").getByRole("button", { name: "Activate exact version", exact: true }).click();
        await until(async () => (await f.sql("SELECT active_version_id FROM @s.agent_packages")).rows[0].active_version_id === "v1", "browser must activate v1 explicitly");
        await f.publish("v2", "2.0.0");
        await page.getByRole("button", { name: "Refresh reviews", exact: true }).click();
        await article("2.0.0").getByRole("button", { name: "Approve artifact contents", exact: true }).click();
        await article("2.0.0").getByRole("heading", { name: /artifact content: approved/ }).waitFor();
        assert.equal((await f.sql("SELECT active_version_id FROM @s.agent_packages")).rows[0].active_version_id, "v1");
        await article("2.0.0").getByRole("button", { name: "Activate exact version", exact: true }).click();
        await until(async () => (await f.sql("SELECT active_version_id FROM @s.agent_packages")).rows[0].active_version_id === "v2", "browser must atomically activate v2");
        await article("2.0.0").getByRole("button", { name: "Revoke", exact: true }).click();
        await article("2.0.0").getByText("Runtime: admission denied · fencing complete · outstanding 0", { exact: true }).waitFor();
        await article("2.0.0").getByRole("button", { name: "Audit", exact: true }).click();
        await page.getByText(/browser exact reviewed decision/, { exact: false }).last().waitFor();
        assert.equal((await f.catalog.packageReviews.audit(admin, "v2")).length, 2);
        const viewer = await browser.newContext();
        const viewerPage = await viewer.newPage(); await viewerPage.goto(endpoint);
        assert.deepEqual(await viewerPage.getByRole("tab").allTextContents(), ["Private", "Shared"]);
        const response = await viewer.request.post(`${endpoint}/api/decide`, { data: [{ isAdmin: true, decision: "approved" }] });
        assert.equal(response.status(), 403, "forged client admin flags cannot become a server-resolved admin");
        await context.close(); await viewer.close();
    } finally {
        await browser?.close();
        for (const key of ["TEMP", "TMP"]) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test("standalone PostgreSQL: ordinary MCP HTTP transport checks exact per-session authorization on every request", async t => {
    const f = await fixture(t, { mcp: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind(); await f.bind("session-2");
    const { runtime } = await f.start(c);
    const gateway = new PackageMcpGateway(); t.after(() => gateway.close());
    const a = await gateway.configuration(runtime, "session-1", "demo");
    const b = await gateway.configuration(runtime, "session-2", "demo");
    const rpc = async (cfg, method, params = {}) => (await fetch(cfg.url, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    for (const cfg of [a, b]) {
        assert.ok((await rpc(cfg, "initialize")).result.capabilities.tools);
        assert.equal((await rpc(cfg, "tools/list")).result.tools[0].name, "echo");
        assert.equal((await rpc(cfg, "tools/call", { name: "echo", arguments: {} })).result.content[0].text, "ok");
    }
    assert.equal(f.mcpEvents().filter(e => e.startsWith("start:")).length, 2);
    assert.equal(f.mcpEvents().filter(e => e.startsWith("call:")).length, 2);
    await f.decide(c, "revoked", 2);
    assert.match((await rpc(a, "tools/call", { name: "echo" })).error.message, /DENIED|fenced/);
    assert.equal(f.mcpEvents().length, 4);
});

test("standalone PostgreSQL: actual worker loader, session manager and native Copilot SDK start only supervised package MCP", { timeout: 60_000 }, async t => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const { ModelProviderRegistry } = await import("../../dist/model-providers.js");
    const { createNativeCopilotProvider } = await import("../helpers/native-copilot-provider.mjs");
    const f = await fixture(t, { mcp: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const server = await createNativeCopilotProvider(body => {
        if (body.messages.at(-1).role === "tool") return { content: "SUPERVISED_MCP_COMPLETE" };
        const tool = body.tools.find(tool => tool.function?.name.includes("echo"));
        assert.ok(tool, `Native SDK must discover package MCP tools: ${JSON.stringify(body.tools.map(t => t.function?.name))}`);
        return { tools: [{ name: tool.function.name, args: {} }] };
    });
    const worker = new PilotSwarmWorker({ store: "sqlite::memory:", workerNodeId: "native-mcp-worker", pluginDirs: [],
        modelProvidersPath: path.resolve("packages", "sdk", "test", "fixtures", "model-providers.test.json"),
        agentPackages: { cacheDir: path.join(f.base, "native-cache") }, sessionStateDir: path.join(f.base, "native-state") });
    worker._catalog = new PgSessionCatalog(new pg.Pool({ connectionString: url, max: 4 }), f.schema);
    worker.artifactStore = { downloadArtifact: async () => ({ body: c.targz }) };
    worker.sessionManager.setSessionCatalog(f.catalog);
    worker.sessionManager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) });
    worker.sessionManager.workerDefaults.modelProviders = new ModelProviderRegistry({ providers: [{
        id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: ["gpt-5.6-terra"],
    }] });
    worker.sessionManager.workerDefaults.turnTimeoutMs = 20_000;
    try {
        await worker.refreshAgentPackages({ force: true });
        assert.equal(worker._agentPackagesInstalled["runtime-kit"].status, "ok");
        assert.equal(f.mcpEvents().length, 0, "package discovery must never start the raw configured command");
        const config = { model: "fixture:gpt-5.6-terra", workingDirectory: f.base,
            boundAgentName: "helper", boundAgentPackageId: "pkg" };
        const managed = await worker.sessionManager.getOrCreate("session-1", config, { turnIndex: 0 });
        assert.equal((await managed.runTurn("Call the echo MCP tool once.")).content, "SUPERVISED_MCP_COMPLETE");
        assert.deepEqual(f.mcpEvents().map(e => e.split(":")[0]), ["start", "call"]);
        const warm = await worker.sessionManager.getOrCreate("session-1", config, { turnIndex: 1 });
        assert.equal(warm.getCopilotSession(), managed.getCopilotSession(), "stable supervised transport must preserve the warm SDK session");
        const requests = server.requests.length;
        await f.decide(c, "revoked", 2);
        await assert.rejects(worker.sessionManager.getOrCreate("session-1", config, { turnIndex: 1 }), /BOUND_AGENT_PACKAGE_UNAVAILABLE|unavailable|denied/i);
        assert.equal(server.requests.length, requests, "revoked warm startup must fail before model hydration or another model request");
        assert.equal(f.mcpEvents().length, 2);
    } finally { await worker.stop(); await server.close(); }
});

test("standalone PostgreSQL: exact generic-session grant survives only its current capability CAS and owner", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c);
    await f.catalog.createSession("generic", { owner: { provider: "entra", subject: "publisher" } });
    const sourceRef = capabilityRef("pkg", c.sha256, "source", "runtime-kit");
    const state = { revision: 1, selections: [{ sourceId: "pkg", sourceRef, tools: ["ping"], mcpServers: [] }] };
    assert.equal(await f.catalog.saveSessionCapabilities("generic", 0, state), true);
    assert.equal(await f.catalog.saveSessionCapabilities("generic", 0, state), false);
    const { runtime } = await f.start(c);
    await runtime.invoke("generic", "ping", {});
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.session_executable_package_grants WHERE active")).rows[0].n, 1);
    assert.equal(await f.catalog.saveSessionCapabilities("generic", 1, { revision: 2, selections: [] }), true);
    await assert.rejects(runtime.invoke("generic", "ping", {}), /DENIED|fenced/);
    assert.equal(f.events().filter(e => e.startsWith("handler:")).length, 1);
});

test("standalone PostgreSQL: one session holds TWO exact package grants without active-name or digest substitution", async t => {
    const f = await fixture(t);
    const a = await f.publish();
    const b = await f.publish("other-v1", "1.0.0", true, "other", "other-kit");
    for (const c of [a, b]) { await f.decide(c); await f.activate(c); }
    const pending = await f.publish("other-v2", "2.0.0", true, "other", "other-kit");
    await f.decide(pending);
    await f.catalog.createSession("multi", { owner: { provider: "entra", subject: "publisher" } });
    const selections = [a, b].map(c => ({ sourceId: c.packageId,
        sourceRef: capabilityRef(c.packageId, c.sha256, "source", c.packageId),
        tools: ["ping"], mcpServers: [] }));
    await assert.rejects(f.catalog.saveSessionCapabilities("multi", 0, { revision: 1, selections: [{
        ...selections[1], sourceRef: capabilityRef("other", pending.sha256, "source", "other"),
    }] }), /explicitly active version/);
    assert.equal((await f.catalog.getSessionCapabilities("multi")).revision, 0);
    await f.catalog.saveSessionCapabilities("multi", 0, { revision: 1, selections });
    const ra = (await f.start(a, "multi-a")).runtime;
    const rb = (await f.start(b, "multi-b")).runtime;
    const first = await ra.invoke("multi", "ping", { package: "a" });
    const second = await rb.invoke("multi", "ping", { package: "b" });
    assert.notEqual(first.pid, second.pid);
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.session_executable_package_grants WHERE active")).rows[0].n, 2);
    const forged = selections.map(s => s.sourceId === "other"
        ? { ...s, sourceRef: capabilityRef("other", a.sha256, "source", "other") } : s);
    await assert.rejects(f.catalog.saveSessionCapabilities("multi", 1, { revision: 2, selections: forged }), /exact selection version missing/);
    assert.equal((await f.catalog.getSessionCapabilities("multi")).revision, 1, "failed grant transaction must roll back the capability CAS");
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.session_executable_package_grants WHERE active")).rows[0].n, 2);
    await f.catalog.saveSessionCapabilities("multi", 1, { revision: 2, selections: [selections[1]] });
    await assert.rejects(ra.invoke("multi", "ping", {}), /DENIED|fenced/);
    const refreshed = (await f.start(b, "multi-b-replacement")).runtime;
    await refreshed.invoke("multi", "ping", {});
    assert.equal(f.events().filter(e => e.startsWith("handler:")).length, 3);
});

test("standalone PostgreSQL: TWO actual worker host processes fence their independently blocked package children on revoke", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const hosts = [];
    try {
        for (const workerId of ["process-worker-a", "process-worker-b"]) {
            const script = path.join(f.base, `${workerId}.mjs`);
            fs.writeFileSync(script, `import pg from "pg";
import {PgPackageRuntimeAuthority} from ${JSON.stringify(new URL("../../dist/package-runtime-authority.js", import.meta.url).href)};
import {SupervisedPackageRuntime} from ${JSON.stringify(new URL("../../dist/package-runtime-supervisor.js", import.meta.url).href)};
const pool=new pg.Pool({connectionString:${JSON.stringify(url)}});
const authority=new PgPackageRuntimeAuthority(pool,${JSON.stringify(f.schema)});
const {runtime}=await SupervisedPackageRuntime.start(authority,${JSON.stringify(c)},${JSON.stringify(c.dir)},${JSON.stringify(c.inspection.execution)},${JSON.stringify(workerId)});
void runtime.invoke("session-1","ping",{block:true}).catch(()=>{});
setInterval(()=>{},1000);`);
            hosts.push(fork(script, [], { execArgv: [], stdio: "ignore" }));
        }
        await until(() => f.events().filter(e => e.startsWith("handler:")).length === 2, "both independent worker-host children must actually enter blocked handlers");
        assert.equal(new Set(f.events().map(e => e.split(":")[1])).size, 2);
        await f.decide(c, "revoked", 2);
        await until(async () => (await f.authority.fencingStatus(c)).complete, "revocation completion requires TWO real observed child exits");
        assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.package_runtime_audit WHERE event='exit-observed'")).rows[0].n, 2);
        assert.equal(f.events().length, 6);
    } finally {
        await Promise.all(hosts.map(host => new Promise(resolve => {
            if (host.exitCode !== null || host.signalCode !== null) return resolve();
            host.once("exit", resolve); host.kill("SIGKILL");
        })));
    }
});

test("standalone PostgreSQL: broker crash recovery kills exact recorded children and acknowledges observed exits", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    const blocked = runtime.invoke("session-1", "ping", { block: true }).catch(error => error);
    await until(() => f.events().length === 3, "handler must be blocked in real child");
    const records = (await f.sql("SELECT * FROM @s.package_runtime_processes")).rows;
    assert.deepEqual(records.map(r => r.role).sort(), ["broker", "module"]);
    process.kill(records.find(r => r.role === "broker").pid, "SIGKILL");
    await until(() => runtime.closed, "broker exit must be observed");
    await f.authority.recoverLocal();
    assert.equal((await f.authority.fencingStatus(c)).outstanding, 0);
    assert.ok(await blocked instanceof Error);
});

test("standalone PostgreSQL: broker initialization failure leaves no orphan process or fabricated fence", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const configuration = await f.authority.brokerConfiguration();
    f.authority.brokerConfiguration = async () => ({ ...configuration,
        connection: { ...configuration.connection, database: `${f.schema}_missing` } });
    await assert.rejects(f.start(c), /database .* does not exist/);
    assert.deepEqual(f.events(), [], "failed broker authority must import no package code");
    const recorded = (await f.sql("SELECT * FROM @s.package_runtime_processes WHERE role='broker'")).rows;
    assert.equal(recorded.length, 1, "parent records the idle broker before its independent authority connects");
    assert.notEqual(await runtimeProcessToken(recorded[0].pid), recorded[0].start_token);
    assert.equal((await f.authority.fencingStatus(c)).outstanding, 0);
});

test("standalone PostgreSQL: unavailable broker database authority kills code first but cannot fabricate fencing acknowledgement", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const role = `${f.schema}_broker`;
    const password = randomUUID().replaceAll("-", "");
    await f.pool.query(`CREATE ROLE "${role}" LOGIN SUPERUSER PASSWORD '${password}'`);
    const configuration = await f.authority.brokerConfiguration();
    f.authority.brokerConfiguration = async () => ({ ...configuration, connection: { ...configuration.connection, user: role, password } });
    let runtime;
    try {
        ({ runtime } = await f.start(c));
        const records = (await f.sql("SELECT * FROM @s.package_runtime_processes")).rows;
        const child = records.find(r => r.role === "module"), broker = records.find(r => r.role === "broker");
        await f.pool.query(`ALTER ROLE "${role}" NOLOGIN`);
        await f.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1", [role]);
        await f.decide(c, "revoked", 2);
        await until(async () => await runtimeProcessToken(child.pid) !== child.start_token, "execution child must die even while broker authority is unavailable");
        assert.equal(await runtimeProcessToken(broker.pid), broker.start_token, "trusted broker retains incomplete acknowledgement for retry");
        assert.deepEqual(await f.authority.fencingStatus(c), { denied: true, complete: false, outstanding: 1 });
        await f.pool.query(`ALTER ROLE "${role}" LOGIN`);
        await until(async () => (await f.authority.fencingStatus(c)).complete, "restored authority must receive observed-exit acknowledgement");
        assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.package_runtime_audit WHERE event='exit-observed'")).rows[0].n, 1);
    } finally {
        await f.pool.query(`ALTER ROLE "${role}" LOGIN`);
        await runtime?.stop().catch(() => {});
        await f.pool.query(`DROP ROLE "${role}"`);
    }
});

test("standalone PostgreSQL: parent death requires observed broker completion or independent restart recovery, never lease-only completion", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const driver = path.join(f.base, "host.mjs");
    fs.writeFileSync(driver, `import pg from "pg";
import {PgPackageRuntimeAuthority} from ${JSON.stringify(new URL("../../dist/package-runtime-authority.js", import.meta.url).href)};
import {SupervisedPackageRuntime} from ${JSON.stringify(new URL("../../dist/package-runtime-supervisor.js", import.meta.url).href)};
const pool=new pg.Pool({connectionString:${JSON.stringify(url)}});
const authority=new PgPackageRuntimeAuthority(pool,${JSON.stringify(f.schema)});
const {runtime}=await SupervisedPackageRuntime.start(authority,${JSON.stringify(c)},${JSON.stringify(c.dir)},${JSON.stringify(c.inspection.execution)},"doomed-host");
void runtime.invoke("session-1","ping",{block:true}).catch(()=>{});
setInterval(()=>{},1000);`);
    const host = fork(driver, [], { execArgv: [], stdio: "ignore" });
    t.after(async () => { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); });
    await until(() => f.events().length === 3, "real child of doomed worker must enter handler");
    const broker = (await f.sql("SELECT pid,start_token FROM @s.package_runtime_processes WHERE role='broker'")).rows[0];
    host.kill("SIGKILL");
    await until(() => host.exitCode !== null || host.signalCode !== null, "owned host exit must be observed");
    if (await runtimeProcessToken(broker.pid) !== broker.start_token) {
        // Windows/libuv kills the job's descendants on parent death. Missing
        // broker acknowledgement is not proof of completion, even then.
        assert.equal((await f.authority.fencingStatus(c)).complete, false);
        await new PgPackageRuntimeAuthority(f.pool, f.schema).recoverLocal();
        assert.equal((await f.authority.fencingStatus(c)).outstanding, 0);
    } else {
        await until(async () => (await f.authority.fencingStatus(c)).outstanding === 0,
            "broker must persist observed-exit acknowledgement after parent death");
    }
    assert.equal((await f.sql("SELECT count(*)::INTEGER AS n FROM @s.package_runtime_audit WHERE event='exit-observed'")).rows[0].n, 1);
});

test("standalone PostgreSQL: legacy mixed fleet blocks activation and remains blocked across migration reapplication", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c);
    await f.catalog.workerHeartbeat({ workerNodeId: "legacy-worker", info: {} });
    await assert.rejects(f.activate(c), /eligible|unsupported|approval|executable|runtime/i);
    assert.equal((await f.authority.fencingStatus(c)).outstanding, 1);
    for (const version of ["0085", "0084", "0085", "0086"]) {
        await f.pool.query(CMS_MIGRATIONS(f.schema).find(m => m.version === version).sql);
    }
    assert.equal((await f.sql("SELECT @s.cms_package_executable_eligible('pkg','v1',$1) AS allowed", [c.sha256])).rows[0].allowed, false);
    await f.catalog.workerHeartbeat({ workerNodeId: "legacy-worker", info: { packageRuntimeProtocol: 1 } });
    assert.equal((await f.authority.fencingStatus(c)).complete, false,
        "a new heartbeat is not proof that an older uncontrolled process has stopped");
    const reviews = await f.catalog.packageReviews.list(admin);
    assert.deepEqual(reviews[0].runtimeFencing, { denied: true, complete: false, outstanding: 1 });
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

async function cronActivity(f, candidate, runtime) {
    const copy = { kind: "app-agent", prompt: "", packageId: candidate.packageId, packageScope: "shared",
        packageVersionId: candidate.versionId, packageSha256: candidate.sha256, toolNames: [] };
    const defaults = { agentPromptLookup: { helper: copy } };
    const manager = new SessionManager(undefined, null, defaults);
    manager.setSessionCatalog(f.catalog);
    manager.getOrCreate = () => { throw new Error("Cron precheck must not hydrate or request a model"); };
    const registrations = await loadAgentPackageCronPrechecks({
        workerModulePath: "never-import-in-parent", versionId: candidate.versionId, inspection: candidate.inspection, runtime,
    });
    manager.setPackageCronPrechecks(new Map([[candidate.packageId, new Map(registrations.map(r => [r.name, r]))]]));
    const pin = await f.catalog.packageReviews.getSessionBinding("session-1");
    const input = {
        sessionId: "session-1", precheck: "queue", packageId: candidate.packageId,
        packageIdentity: { packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256 },
        packageBindingRevision: pin.revision, reason: "poll", intervalSeconds: 15,
        agent: { boundAgentName: "helper", boundAgentPackageId: candidate.packageId },
    };
    const handlers = new Map();
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) }, manager, null, undefined, f.catalog);
    return { manager, defaults, input, call: (overrides = {}) =>
        handlers.get("runCronPrecheck")({ traceInfo() {} }, { ...input, ...overrides }) };
}

test("standalone PostgreSQL: binding writer row locks cannot invert authoritative admission barrier order", async t => {
    const f = await fixture(t);
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const writer = await f.pool.connect();
    let timer;
    try {
        await writer.query("BEGIN");
        await writer.query(`SELECT * FROM "${f.schema}".session_agent_package_bindings WHERE session_id='session-1' FOR UPDATE`);
        const current = f.authority.context("session-1", c);
        const outcome = await Promise.race([
            current.then(() => "read-before-writer"),
            new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 1200); }),
        ]);
        await writer.query("ROLLBACK");
        await current;
        assert.equal(outcome, "read-before-writer", "MVCC admission ordered before mutation must not wait on a writer entering its BEFORE trigger");
    } finally { clearTimeout(timer); await writer.query("ROLLBACK"); writer.release(); }
});

test("standalone PostgreSQL CRON: exact no-tool activity skips, denied child tool cannot fabricate skip, current root owner denies warm entry", async t => {
    const f = await fixture(t, { callbacks: true, noTools: true, cron: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    const h = await cronActivity(f, c, runtime);
    const initial = await h.call();
    assert.deepEqual(initial, { skip: true, outcome: "skip", precheck: "queue", shadow: false },
        JSON.stringify(await f.catalog.getSessionEvents("session-1")));
    assert.deepEqual(await h.call({ reason: "caught" }), { skip: false, outcome: "error", precheck: "queue", shadow: false });
    assert.equal(f.events().filter(e => e.startsWith("handler:")).length, 0);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 2);
    await f.catalog.createSession("other-root", { owner: { provider: "entra", subject: "different-owner" } });
    await f.sql("UPDATE @s.sessions SET root_session_id='other-root' WHERE session_id='session-1'");
    const before = f.events();
    await assert.rejects(h.call(), /DENIED|denied|stale|unavailable/i);
    assert.deepEqual(f.events(), before);
});

test("standalone PostgreSQL CRON: timeout cancellation kills synchronous supervised callback and admits no warm replacement", async t => {
    const f = await fixture(t, { callbacks: true, noTools: true, cron: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    const h = await cronActivity(f, c, runtime);
    assert.equal((await h.call({ reason: "block" })).outcome, "timeout");
    await until(async () => (await f.authority.fencingStatus(c)).outstanding === 0, "timeout must fence the actual blocked callback");
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1);
    assert.equal((await h.call()).skip, false);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1);
});

test("standalone PostgreSQL CRON: explicit rebind/activation cannot retarget an armed v1 schedule, missing/substituted digest denied", async t => {
    const f = await fixture(t, { callbacks: true, noTools: true, cron: true });
    const v1 = await f.publish(); await f.decide(v1); await f.activate(v1); await f.bind();
    const { runtime } = await f.start(v1);
    const h = await cronActivity(f, v1, runtime);
    assert.equal((await h.call()).skip, true);
    for (const packageIdentity of [undefined, { ...h.input.packageIdentity, sha256: "b".repeat(64) }]) {
        await assert.rejects(h.call({ packageIdentity }), /stale|denied/i);
    }
    const v2 = await f.publish("v2", "2.0.0"); await f.decide(v2); await f.activate(v2, "v1", 2);
    await f.catalog.packageReviews.rebind(admin, {
        sessionId: "session-1", packageId: v2.packageId, versionId: v2.versionId, sha256: v2.sha256,
        agentName: "helper", expectedBindingRevision: 1, reason: "explicit fixture rebind",
    });
    h.defaults.agentPromptLookup.helper.packageVersionId = v2.versionId;
    h.defaults.agentPromptLookup.helper.packageSha256 = v2.sha256;
    const before = f.events();
    await assert.rejects(h.call(), /stale|denied/i);
    assert.deepEqual(f.events(), before, "same-name callback must not replace the armed content pin");
    const fresh = await f.start(v2, "new-generation");
    await assert.rejects(fresh.runtime.invokeCallback("session-1", "check", {}, { bindingRevision: 1 }), /stale.*revision/i);
    assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1,
        "fresh exact content/generation cannot launder a stale schedule binding revision");
});

test("standalone PostgreSQL CRON: current MCP revocation after callback admission cannot start own server or fabricate skip", async t => {
    const f = await fixture(t, { callbacks: true, mcp: true, noTools: true, cron: true });
    const c = await f.publish(); await f.decide(c); await f.activate(c); await f.bind();
    const { runtime } = await f.start(c);
    const h = await cronActivity(f, c, runtime);
    let checks = 0;
    const resolveCurrentServers = h.manager.getCronPrecheckMcpServers.bind(h.manager);
    h.manager.getCronPrecheckMcpServers = async (...args) => {
        checks++;
        assert.equal(f.events().filter(e => e.startsWith("callback:")).length, 1);
        await f.sql(`UPDATE @s.sessions SET creation_config=COALESCE(creation_config,'{}'::jsonb)
            || '{"mcpServers":{}}'::jsonb WHERE session_id='session-1'`);
        return resolveCurrentServers(...args);
    };
    assert.equal((await h.call({ reason: "mcp" })).skip, false);
    assert.equal(checks, 1);
    assert.deepEqual(f.mcpEvents(), []);
    await until(async () => (await f.authority.fencingStatus(c)).outstanding === 0,
        "real current configuration mutation must fence the admitted callback generation");
});
