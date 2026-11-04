import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PgSessionCatalog } from "../../dist/cms.js";
import { PilotSwarmClient, treeComputeTarget } from "../../dist/client.js";
import { SessionManager } from "../../dist/session-manager.js";
import { startSystemAgents } from "../../dist/system-agents.js";
import { COMPUTE_ERROR_CODES } from "../../dist/compute.js";

// Only the SQL transport is fake: createSession's normalization, validation
// order and transactional writes execute on the built PgSessionCatalog.
function catalogFixture({ defaultTarget = "shared/default", persistence = true } = {}) {
    const calls = [];
    const configs = new Map();
    const rows = new Map();
    const client = {
        async query(sql, args = []) {
            calls.push({ sql, args });
            if (sql.includes("cms_compute_target_assert_session")) {
                if (args[0] === "shared/missing") throw new Error("COMPUTE_TARGET_NOT_FOUND: missing target");
                return { rows: [{ target_id: `id:${args[0]}` }] };
            }
            if (sql.includes("cms_create_session(")) rows.set(args[0], { sessionId: args[0], isSystem: args[4] });
            if (sql.includes("SET creation_config")) configs.set(args[0], JSON.parse(args[1]));
            return { rows: [] };
        },
        release() {},
    };
    const catalog = new PgSessionCatalog({ connect: async () => client }, "fixture");
    catalog.defaultComputeTarget = defaultTarget;
    catalog.supportsVisibilityCreate = async () => true;
    catalog.supportsCreationConfig = async () => persistence;
    catalog.supportsComputeTargets = async () => true;
    catalog.supportsProviderSessionModelValidation = async () => false;
    catalog.getSessionCreationConfig = async id => configs.get(id) ?? null;
    catalog.getSession = async id => rows.get(id) ?? null;
    catalog.listSessions = async () => [...rows.values()];
    catalog.updateSession = async (id, patch) => rows.set(id, { ...rows.get(id), ...patch });
    catalog.recordEvents = async () => {};
    return { catalog, configs, rows, calls };
}

for (const [label, opts] of [
    ["omitted options", undefined],
    ["system caller without creationConfig", { isSystem: true }],
    ["empty config", { creationConfig: {} }],
    ["null config", { creationConfig: null }],
]) {
    test(`default placement persists its immutable identity: ${label}`, async () => {
        const h = catalogFixture();
        await h.catalog.createSession("session", opts);
        assert.deepEqual(h.configs.get("session"), { computeTarget: "shared/default", computeTargetId: "id:shared/default" });
        assert.equal(await treeComputeTarget(h.catalog, "session", null), "shared/default");
        assert.equal(h.calls.at(-1).sql, "COMMIT");
    });
}

test("explicit placement overrides the default and validates rather than trusting a supplied id", async () => {
    const h = catalogFixture();
    const config = { computeTarget: "shared/explicit", computeTargetId: "forged" };
    await h.catalog.createSession("session", { creationConfig: config });
    assert.deepEqual(h.configs.get("session"), { computeTarget: "shared/explicit", computeTargetId: "id:shared/explicit" });
    assert.equal(config.computeTargetId, "forged", "caller configuration is not mutated");
    await assert.rejects(h.catalog.createSession("bad", { creationConfig: { computeTarget: "shared/missing" } }), {
        code: "COMPUTE_TARGET_NOT_FOUND",
    });
    assert.equal(h.calls.at(-1).sql, "ROLLBACK");
    assert.equal(h.configs.has("bad"), false);
});

test("selected placement cannot be silently lost on a catalog without creation-config persistence", async () => {
    for (const creationConfig of [undefined, { computeTarget: "shared/explicit" }]) {
        const h = catalogFixture({ persistence: false });
        await assert.rejects(h.catalog.createSession("session", { creationConfig }), /COMPUTE_TARGET_/);
        assert.equal(h.calls.length, 0, "refuse before creating a target-less record");
    }
});

test("unselected local roots and inheriting children do not gain a target or require new persistence", async () => {
    const local = catalogFixture({ defaultTarget: "", persistence: false });
    await local.catalog.createSession("local", { isSystem: true });
    assert.equal(local.configs.has("local"), false);
    assert.equal(local.calls.some(call => call.sql.includes("cms_compute_target_assert_session")), false);
    const child = catalogFixture();
    await child.catalog.createSession("child", { parentSessionId: "root" });
    assert.equal(child.configs.has("child"), false);
    assert.equal(child.calls.some(call => call.sql.includes("cms_compute_target_assert_session")), false);
});

async function assertRemoteRouting(t, catalog, sessionId) {
    catalog.computeTargets.resolveForSession = async id => {
        assert.equal(id, "id:shared/default", "routing resolves the persisted immutable target id");
        return { id, name: "shared/default", enabled: true, kind: "unregistered-fixture" };
    };
    const h = managerFixture(t, catalog);
    await assert.rejects(h.manager.getOrCreate(sessionId, {}, { turnIndex: 0 }), { code: COMPUTE_ERROR_CODES.KIND_UNKNOWN });
    assert.equal(h.launches.length, 0, "missing remote provider cannot launch the system session locally");
}

test("actual client system-session creation persists and routes the deployment target", async t => {
    const h = catalogFixture();
    const client = Object.assign(Object.create(PilotSwarmClient.prototype), {
        _catalog: h.catalog, systemSessions: new Set(), sessionConfigs: new Map(),
        _resolveCreationModel: async () => ({ model: "fixture:model", source: "fixture" }),
    });
    const session = await client.createSystemSession({ title: "Fixture system session" });
    assert.equal(h.configs.get(session.sessionId)?.computeTargetId, "id:shared/default");
    assert.equal(await treeComputeTarget(h.catalog, session.sessionId, h.rows.get(session.sessionId)), "shared/default");
    await assertRemoteRouting(t, h.catalog, session.sessionId);
});

test("actual worker system-agent startup routes the persisted deployment target", async t => {
    const h = catalogFixture();
    const starts = [];
    const results = await startSystemAgents({
        catalog: h.catalog,
        duroxideClient: { startOrchestrationVersioned: async (...args) => starts.push(args) },
        agents: [{ id: "fixture-agent", name: "fixture-agent", system: true, tools: [], prompt: "Fixture" }],
        defaultModel: "fixture:model", dehydrateThreshold: 0,
    });
    assert.equal(results[0].status, "started");
    assert.equal(h.configs.get(results[0].sessionId)?.computeTargetId, "id:shared/default");
    assert.equal(starts[0][2].config.computeTarget, "shared/default");
    await assertRemoteRouting(t, h.catalog, results[0].sessionId);
});

function managerFixture(t, catalog) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-placement-"));
    const manager = new SessionManager(undefined, null, {}, home);
    const launches = [];
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.ensureClient = async (...args) => {
        launches.push(args);
        return {
            createSession: async () => ({ disconnect: async () => {} }),
            resumeSession: async () => ({ disconnect: async () => {} }),
        };
    };
    t.after(async () => {
        await manager.dropWarmSession("session");
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { manager, launches };
}

for (const [label, catalog] of [
    ["no catalog", null],
    ["catalog without creation reader", { getSession: async () => ({ sessionId: "session" }) }],
]) {
    for (const selection of ["explicit", "remembered", "required", "unselected"]) {
        test(`${label}: ${selection} selection through getOrCreate`, async t => {
            const h = managerFixture(t, catalog);
            if (selection === "remembered") {
                await h.manager._treeComputeTarget({
                    getSessionCreationConfig: async () => ({ computeTarget: "shared/remote", computeTargetId: "remote-id" }),
                }, "session", "session");
                await assert.rejects(h.manager._prepareCompute("session", {}, undefined, null, 0),
                    { code: COMPUTE_ERROR_CODES.UNAVAILABLE },
                    "preparation itself must refuse rather than returning a local sentinel");
            }
            if (selection === "required") h.manager.setComputeOptions({ requireCompute: true });
            const config = selection === "explicit" ? { computeTarget: "shared/remote" } : {};
            if (selection === "unselected") {
                await h.manager.getOrCreate("session", config, { turnIndex: 0 });
                assert.equal(h.launches.length, 1, "ordinary local sessions keep their existing launch path");
            } else {
                await assert.rejects(h.manager.getOrCreate("session", config, { turnIndex: 0 }),
                    error => error.code === COMPUTE_ERROR_CODES.REQUIRED || error.code === COMPUTE_ERROR_CODES.UNAVAILABLE);
                assert.equal(h.launches.length, 0, "never select a local SDK client");
            }
        });
    }
}

test("an explicit selection with no persisted authority is refused, never backfilled or run locally", async t => {
    const h = managerFixture(t, {
        getSession: async () => ({ sessionId: "session" }),
        getSessionCreationConfig: async () => null,
    });
    await assert.rejects(h.manager.getOrCreate("session", { computeTarget: "shared/remote" }, { turnIndex: 0 }),
        { code: COMPUTE_ERROR_CODES.UNAVAILABLE });
    assert.equal(h.launches.length, 0);
});

test("immutable tree selection refuses conflicting child ids and missing target ids before launch", async t => {
    for (const own of [
        { computeTargetId: "other-id" },
        { computeTarget: "shared/remote" },
    ]) {
        const catalog = {
            getSession: async () => ({ rootSessionId: own.computeTargetId ? "root" : "session" }),
            getSessionCreationConfig: async id => id === "root"
                ? { computeTarget: "shared/remote", computeTargetId: "root-id" } : own,
            computeTargets: { resolveForSession: async () => assert.fail("invalid identity must not resolve") },
        };
        const h = managerFixture(t, catalog);
        await assert.rejects(h.manager.getOrCreate("session", {}, { turnIndex: 0 }),
            error => error.code === COMPUTE_ERROR_CODES.INVALID || error.code === COMPUTE_ERROR_CODES.NOT_FOUND);
        assert.equal(h.launches.length, 0);
    }
});
