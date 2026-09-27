// Live checks against Azure Relay. Skipped when the RELAY_* settings are missing.
//
//   npm run test:live   (reads ~/.config/pilotswarm-relay/spike.env)
//
// 1. The core's shared checks, over one fixed hybrid connection.
// 2. Checks only this provider has: SAS keys and rights.
// 3. The provisioner end to end: create a host endpoint, listen with only the
//    profile's token, activate, push a fresh token, delete, and see the host drop.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ClusterSigner,
    HostSigner,
    MemoryHostRegistry,
    RelayExecClient,
    RelayTransportError,
    TrustedClusters,
    describeThisHost,
    generateKeyPair,
    issueProfile,
    serveConnection,
} from "pilotswarm-relay-core";
import { relayContract } from "pilotswarm-relay-core/testing/contract";
import { AzureRelayTransport, azureRelayProvider, parseAzureRelayGrant, transportsFromEnv } from "../dist/index.js";

const env = process.env;
const needed = ["RELAY_NAMESPACE", "RELAY_PATH", "RELAY_LISTEN_KEY_NAME", "RELAY_LISTEN_KEY", "RELAY_SEND_KEY_NAME", "RELAY_SEND_KEY"];
const provisioning = ["RELAY_SUBSCRIPTION", "RELAY_RESOURCE_GROUP", "RELAY_MINT_LISTEN_KEY_NAME", "RELAY_MINT_LISTEN_KEY", "RELAY_CLUSTER_SEND_KEY_NAME", "RELAY_CLUSTER_SEND_KEY"];
const WRONG_KEY = Buffer.from("not-the-key-not-the-key-not-the").toString("base64");

async function rejectsWith(promise, kind) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof RelayTransportError, `expected RelayTransportError, got ${error}`);
        assert.equal(error.kind, kind, error.message);
        return true;
    });
}

if (!needed.every((name) => env[name])) {
    test("azure-relay live checks", { skip: "RELAY_* settings are not set" }, () => {});
} else {
    const base = { namespace: env.RELAY_NAMESPACE, path: env.RELAY_PATH };
    const listenKey = { keyName: env.RELAY_LISTEN_KEY_NAME, key: env.RELAY_LISTEN_KEY };
    const sendKey = { keyName: env.RELAY_SEND_KEY_NAME, key: env.RELAY_SEND_KEY };

    test("azure-relay: a wrong key is refused", () => rejectsWith(new AzureRelayTransport({ ...base, ...sendKey, key: WRONG_KEY }).connect(), "unauthorized"));
    test("azure-relay: the Send key cannot listen", () => rejectsWith(new AzureRelayTransport({ ...base, ...sendKey }).listen(), "unauthorized"));
    test("azure-relay: the Listen key cannot send", () => rejectsWith(new AzureRelayTransport({ ...base, ...listenKey }).connect(), "unauthorized"));
    test("azure-relay: an unknown hybrid connection is not_found", () =>
        rejectsWith(new AzureRelayTransport({ ...base, ...sendKey, path: "no-such-endpoint" }).connect(), "not_found"));

    // The same shared checks the in-memory provider passes.
    const transports = transportsFromEnv(env);
    relayContract("azure-relay", { hostTransport: transports.host, callerTransport: transports.caller });

    if (provisioning.every((name) => env[name])) {
        test("azure-relay provisioner: a host lives on its profile alone, activates, renews, and is revoked", { timeout: 240_000 }, async () => {
            const provisioner = azureRelayProvider.createProvisioner(env);
            const clusterKey = generateKeyPair();
            const cluster = new ClusterSigner(clusterKey.privateKeyPem);
            const owner = { provider: "entra", subject: "0f8fad5b-d9cb-469f-a165-70867728950e", email: "alice@example.com" };

            // Portal: create the endpoint and the profile.
            const { endpointId, grant } = await provisioner.createHostEndpoint();
            let deleted = false;
            try {
                const { profile, record } = issueProfile({
                    portal: "https://portal.test",
                    issuedTo: owner,
                    clusterPublicKeys: [clusterKey.publicKeyPem],
                    provider: "azure-relay",
                    endpointId,
                    grant,
                });
                const registry = new MemoryHostRegistry();
                registry.add(record);

                // Host: nothing but the profile. No key of any kind.
                const hostTransport = azureRelayProvider.createHostTransport(profile.relay.grant);
                assert.equal(hostTransport.endpointId, endpointId);
                const hostKey = new HostSigner(generateKeyPair().privateKeyPem);
                let secret = profile.activation.secret;
                const pushed = [];
                const listener = await hostTransport.listen();
                const hostLost = new Promise((resolve) => listener.onClose(resolve));
                listener.onConnection((connection) =>
                    serveConnection(connection, {
                        host: describeThisHost(),
                        trustedClusters: TrustedClusters.fromPublicKeyPems(profile.cluster.publicKeys),
                        hostSigner: hostKey,
                        endpointId: hostTransport.endpointId,
                        activationSecret: () => secret,
                        onActivated: () => (secret = undefined),
                        onGrantUpdate: (g) => {
                            hostTransport.refreshGrant(g);
                            pushed.push(g);
                        },
                    }),
                );

                // Cluster: connect with the namespace Send key; activate; push a token.
                const client = new RelayExecClient(azureRelayProvider.createCallerTransport(endpointId, env), cluster, {
                    hostRegistry: registry,
                    grantUpdate: () => provisioner.renewHostGrant(endpointId),
                });
                const { result } = await client.exec({ command: ["echo", "from the provisioned host"] });
                assert.equal(result.stdout.text, "from the provisioned host\n");
                assert.equal(await registry.pinnedHostKey(endpointId), hostKey.publicKeyPem);
                assert.equal(secret, undefined, "the host never heard it was activated");
                assert.equal(pushed.length, 1);
                assert.equal(parseAzureRelayGrant(pushed[0]).path, endpointId.split("/")[1]);

                // The host token only opens this host's endpoint.
                const onlyThis = parseAzureRelayGrant(pushed[0]);
                await rejectsWith(new AzureRelayTransport({ namespace: onlyThis.namespace, path: env.RELAY_PATH, token: onlyThis.listenToken }).listen(), "unauthorized");

                // Revoke: delete the endpoint. The listening host drops.
                client.close();
                const deletedAt = Date.now();
                await provisioner.deleteHostEndpoint(endpointId);
                deleted = true;
                const lost = await Promise.race([hostLost, new Promise((resolve) => setTimeout(() => resolve("still up"), 120_000))]);
                assert.notEqual(lost, "still up", "the host kept listening on a deleted endpoint");
                console.log(`# host dropped ${((Date.now() - deletedAt) / 1000).toFixed(1)} s after the endpoint was deleted (code ${lost.code})`);
                await rejectsWith(hostTransport.listen(), "not_found");
            } finally {
                if (!deleted) await provisioner.deleteHostEndpoint(endpointId);
            }
        });
    }
}
