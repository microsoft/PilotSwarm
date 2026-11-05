/**
 * Workflow support in the bootstrap (design 04 "Advertise capability/version
 * in bootstrap"; D11): GET /api/v1/bootstrap carries `workflows`, what the
 * deployment takes now, so a client gates its workflow surface before a call
 * is refused. It is the management client's own answer
 * (getWorkflowCapabilities) through the real NodeSdkTransport and
 * PortalRuntime.getBootstrap, over a stand-in catalog (no database):
 * - as a deployment is configured today (no workflowCommands): version 2
 *   reads on, a person's commands off, with the refusal that every command
 *   then gets, which is the refusal the real adapter gives;
 * - with the test-only option (INACTIVE): the controller version the runs
 *   start at and the operations a person may send (1.8.0, or 1.9.0 with
 *   stop and the test operations);
 * - the legacy create keeps its version 1 semantics (never a v2 draft);
 * - an older host without the getter advertises nothing (null).
 * Both HTTP-backed clients read the same value back over real fetch. The
 * route names are unchanged (their final names are API review item D11).
 *
 * Run: node --test web/test/workflow-capabilities-bootstrap.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { NodeSdkTransport } from "pilotswarm/host";
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime, portalRuntimeOptions } from "../runtime.js";

const EVERY_HOST = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel"];
const MILESTONE = ["stop", "test", "test_respond", "test_advance"];

/**
 * The actual bootstrap route over the real runtime and transport getter, with a management client stand-in that answers
 * with the real method: its catalog has a workflow store, and its options are `config` (none: a deployment's).
 */
async function bootstrapHarness({ config, getter = true } = {}) {
    const mgmt = {
        _ensureStarted() {},
        _catalog: {
            workflowStore: () => ({}),
            getSession: async (sessionId) => ({ sessionId, sessionKind: "workflow", deletedAt: null }),
        },
        config: config ?? {},
        getWorkflowCapabilities() { return PilotSwarmManagementClient.prototype.getWorkflowCapabilities.call(this); },
        updateWorkflow(...args) { return PilotSwarmManagementClient.prototype.updateWorkflow.apply(this, args); },
        // The real method's body (batch 7, n-3: updateWorkflow wraps it to classify a store that cannot be reached).
        _updateWorkflow(...args) { return PilotSwarmManagementClient.prototype._updateWorkflow.apply(this, args); },
    };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = getter ? { getWorkflowCapabilities: (...args) => NodeSdkTransport.prototype.getWorkflowCapabilities.apply({ mgmt }, args) } : {};
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "dev", subject: "alice" }, authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = async () => {
        const response = await fetch(`${origin}/api/v1/bootstrap`);
        assert.equal(response.status, 200);
        return response.json();
    };
    return { mgmt, origin, bootstrap, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a deployment as configured today advertises version 2 reads and a person's commands off, with the refusal they get", async () => {
    const h = await bootstrapHarness();
    try {
        const body = await h.bootstrap();
        assert.equal(body.ok, true);
        assert.deepEqual(body.workflows, {
            schema: 1,
            v2: {
                apiVersion: "pilotswarm.dev/v2-draft", read: true, create: false, input: false,
                commands: { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
            },
            legacyCreate: { workflowVersion: 1, draft: false },
        });
        // The advertised refusal is the adapter's own: a person's command to this deployment changes nothing and gets it.
        await assert.rejects(h.mgmt.updateWorkflow("wf1", { operation: "pause", operation_id: "p-1" }, { principal: null }), (error) => {
            assert.deepEqual({ code: error.code, status: error.status }, body.workflows.v2.commands.refusal);
            return true;
        });
    } finally {
        await h.close();
    }
});

test("with the test-only option, it advertises the controller version and the operations a person may send", async () => {
    // Workflow test mode is off by default (Workflow Simplified, spec 16): the test operations are listed only with it on.
    const flag = process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    try {
        for (const [config, controllerVersion, operations] of [
            [{ workflowCommands: {} }, "1.8.0", EVERY_HOST],
            [{ workflowCommands: { requests: false } }, "1.8.0", EVERY_HOST],
            [{ workflowCommands: { requests: true } }, "1.9.0", [...EVERY_HOST, "stop"]],
            [{ workflowCommands: { requests: true, testMode: false } }, "1.9.0", [...EVERY_HOST, "stop"]],
            [{ workflowCommands: { requests: true, testMode: true } }, "1.9.0", [...EVERY_HOST, ...MILESTONE]],
        ]) {
            const h = await bootstrapHarness({ config });
            try {
                const { workflows } = await h.bootstrap();
                assert.deepEqual(workflows.v2.commands, { available: true, controllerVersion, operations }, JSON.stringify(config));
                assert.equal(workflows.v2.read, true);
                assert.ok(!workflows.v2.commands.operations.includes("recover"), "recover stays the agent's");
                assert.deepEqual(workflows.legacyCreate, { workflowVersion: 1, draft: false });
            } finally {
                await h.close();
            }
        }
        // The deployment flag, exactly `on`, lists them too; any other value does not.
        for (const [value, listed] of [["on", true], ["1", false], ["ON", false], ["true", false]]) {
            process.env.PILOTSWARM_WORKFLOW_TEST_MODE = value;
            const h = await bootstrapHarness({ config: { workflowCommands: { requests: true } } });
            try {
                const { workflows } = await h.bootstrap();
                assert.deepEqual(workflows.v2.commands.operations, listed ? [...EVERY_HOST, ...MILESTONE] : [...EVERY_HOST, "stop"], value);
            } finally {
                await h.close();
            }
        }
        // A test operation sent anyway is refused in words while test mode is off, before the workflow is read.
        delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
        const h = await bootstrapHarness({ config: { workflowCommands: { requests: true } } });
        try {
            for (const operation of ["test", "test_respond", "test_advance"]) {
                await assert.rejects(h.mgmt.updateWorkflow("wf1", { operation, operation_id: "t-1", run_id: "run-1" }, { principal: null }), (error) => {
                    assert.equal(error.code, "WORKFLOW_COMMAND_INVALID", operation);
                    assert.equal(error.status, 400, operation);
                    assert.match(error.message, /^Testing workflows is turned off on this server\. operation must be .* or stop\.$/, operation);
                    return true;
                });
            }
        } finally {
            await h.close();
        }
    } finally {
        if (flag === undefined) delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
        else process.env.PILOTSWARM_WORKFLOW_TEST_MODE = flag;
    }
});

test("both HTTP-backed clients read the advertisement back, and an older host advertises none", async () => {
    const h = await bootstrapHarness({ config: { workflowCommands: { requests: true, testMode: true } } });
    try {
        const advertised = (await h.bootstrap()).workflows;
        const api = () => new ApiClient({ apiUrl: h.origin });
        const transport = new HttpApiTransport({ api: api() });
        await transport.start();
        assert.deepEqual(await transport.getWorkflowCapabilities(), advertised);
        assert.deepEqual(await new WebPilotSwarmManagementClient({ api: api() }).getWorkflowCapabilities(), advertised);
    } finally {
        await h.close();
    }
    const older = await bootstrapHarness({ getter: false });
    try {
        assert.equal((await older.bootstrap()).workflows, null);
        const transport = new HttpApiTransport({ api: new ApiClient({ apiUrl: older.origin }) });
        await transport.start();
        assert.equal(await transport.getWorkflowCapabilities(), null);
        assert.equal(await new WebPilotSwarmManagementClient({ api: new ApiClient({ apiUrl: older.origin }) }).getWorkflowCapabilities(), null);
    } finally {
        await older.close();
    }
});

test("an advertisement that is not an object is malformed, never an older host: both HTTP-backed clients reject it", async () => {
    for (const workflows of [["v2"], "v2", 2, true]) {
        const transport = new HttpApiTransport({ apiUrl: "http://127.0.0.1:9" });
        transport.bootstrap = { ok: true, workflows };
        await assert.rejects(transport.getWorkflowCapabilities(), (error) => error.code === "WORKFLOW_CAPABILITIES_MALFORMED", JSON.stringify(workflows));
        const client = new WebPilotSwarmManagementClient({ api: { getBootstrap: async () => ({ ok: true, workflows }) } });
        await assert.rejects(client.getWorkflowCapabilities(), (error) => error.code === "WORKFLOW_CAPABILITIES_MALFORMED", JSON.stringify(workflows));
    }
    for (const bootstrap of [{ ok: true }, { ok: true, workflows: null }]) {
        const transport = new HttpApiTransport({ apiUrl: "http://127.0.0.1:9" });
        transport.bootstrap = bootstrap;
        assert.equal(await transport.getWorkflowCapabilities(), null);
        assert.equal(await new WebPilotSwarmManagementClient({ api: { getBootstrap: async () => bootstrap } }).getWorkflowCapabilities(), null);
    }
});

test("the portal's runtime options are exactly its storage options and mode unless the Workflow V2 test environment switch is on", async () => {
    const storageOptions = { store: "sqlite::memory:", useManagedIdentity: false, cmsFactsDatabaseUrl: undefined, aadDbUser: undefined };
    for (const value of [undefined, "", "1", "true", "on", "ISOLATED-TEST-ONLY", " isolated-test-only", "isolated-test-only "]) {
        const env = value === undefined ? {} : { PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: value };
        const options = portalRuntimeOptions(storageOptions, "local", env);
        assert.deepEqual(options, { ...storageOptions, mode: "local" }, JSON.stringify(value));
        assert.deepEqual(Object.keys(options), [...Object.keys(storageOptions), "mode"], JSON.stringify(value));
    }
    const on = portalRuntimeOptions(storageOptions, "remote", { PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" });
    assert.deepEqual(on, { ...storageOptions, mode: "remote", workflowCommands: { requests: true }, workerTestOptions: { workflowRequests: true },
        sessionStartVersion: "1.0.83" });

    // The runtime they build: off, no person's commands, embedded workers and new sessions as before; on, all three, and the
    // bootstrap says so. (Its session client starts new sessions there: NodeSdkTransport.start passes the version to
    // PilotSwarmClient._startSessionsAt; the SDK's workflow-v2-test-environment-sessions test runs such a client.)
    const off = new PortalRuntime(portalRuntimeOptions(storageOptions, "local", {}));
    assert.equal(off.transport.workerTestOptions, null);
    assert.equal(off.transport.sessionStartVersion, null);
    assert.equal(Object.hasOwn(off.transport.mgmt.config, "workflowCommands"), false);
    const enabled = new PortalRuntime(on);
    assert.deepEqual(enabled.transport.workerTestOptions, { workflowRequests: true });
    assert.equal(enabled.transport.sessionStartVersion, "1.0.83");
    assert.deepEqual(enabled.transport.mgmt.config.workflowCommands, { requests: true });
});
