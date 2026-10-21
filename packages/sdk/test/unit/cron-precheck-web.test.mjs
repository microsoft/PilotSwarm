import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";
import { WebPilotSwarmClient } from "../../dist/web/web-client.js";
import { buildOperationRequest } from "../../api/src/protocol.js";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { PortalRuntime } from "../../../app/web/runtime.js";

const owner = { provider: "test", subject: "alice" };
const auth = { principal: owner, authorization: { role: "user" } };

function directClient() {
    const client = Object.create(PilotSwarmClient.prototype);
    const rows = [];
    Object.assign(client, {
        config: { allowedAgentNames: ["poller"] },
        sessionConfigs: new Map(),
        sessionAgentIds: new Map(),
        parentSessionIds: new Map(),
        nestingLevels: new Map(),
        _resolveCreationModel: async () => null,
        _catalog: {
            createSession: async (sessionId, row) => rows.push({ sessionId, ...row }),
            updateSession: async () => {},
        },
    });
    return { client, rows };
}

for (const operation of ["createSession", "createSessionForAgent"]) {
    const create = (client, config) => operation === "createSession"
        ? client.createSession(config) : client.createSessionForAgent("poller", config);

    test(`${operation}: cronPrecheck survives the Web client and protocol body`, async () => {
        const client = Object.create(WebPilotSwarmClient.prototype);
        const calls = [];
        client._api = { call: async (name, params) => {
            calls.push(buildOperationRequest(name, params));
            return { sessionId: "s1" };
        } };
        const session = await create(client, { cronPrecheck: "queue.ready" });
        assert.equal(session.sessionId, "s1");
        assert.equal(calls[0].body?.cronPrecheck, "queue.ready");
    });

    test(`${operation}: authenticated portal and local transport preserve the precheck through persistence`, async () => {
        const { client, rows } = directClient();
        const transport = Object.create(NodeSdkTransport.prototype);
        Object.assign(transport, {
            client,
            sessionHandles: new Map(),
            mgmt: { getSession: async () => null },
            _authorizePackageAgentCreate: async (name, principal, _admin, includePackage) => {
                assert.deepEqual(principal, { ...owner, email: null, displayName: null });
                assert.equal(includePackage, true);
                return { name, packageId: "resolved-package" };
            },
        });
        const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
        runtime.start = async () => {};
        runtime.transport = transport;
        const result = await runtime.call(operation, {
            ...(operation === "createSessionForAgent" ? { agentName: "poller" } : {}),
            cronPrecheck: " queue.ready ",
            boundAgentPackageId: "forged-package",
            owner: { provider: "forged", subject: "admin" },
        }, auth);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sessionId, result.sessionId);
        assert.equal(rows[0].creationConfig.cronPrecheck, "queue.ready");
        assert.deepEqual(rows[0].owner, { ...owner, email: null, displayName: null });
        if (operation === "createSessionForAgent") assert.equal(rows[0].creationConfig.boundAgentPackageId, "resolved-package");

        const count = rows.length;
        for (const invalid of ["bad name", 12, {}, " ".repeat(3), "x".repeat(101)]) {
            await assert.rejects(runtime.call(operation, {
                ...(operation === "createSessionForAgent" ? { agentName: "poller" } : {}),
                cronPrecheck: invalid,
            }, auth), (error) => error.code === "INVALID_CRON_PRECHECK" && error.status === 400);
        }
        assert.equal(rows.length, count, "invalid prechecks must not create rows");
    });

    test(`${operation}: direct creation persists the normalized precheck and leaves omitted defaults unset`, async () => {
        const { client, rows } = directClient();
        await create(client, { cronPrecheck: " queue.ready ", boundAgentPackageId: "resolved-package" });
        await create(client, {});
        assert.equal(rows[0].creationConfig.cronPrecheck, "queue.ready");
        assert.equal(rows[1].creationConfig.cronPrecheck, undefined);
        if (operation === "createSessionForAgent") assert.equal(rows[0].creationConfig.boundAgentPackageId, "resolved-package");
    });
}
