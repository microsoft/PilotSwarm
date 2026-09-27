/**
 * The Azure Relay provider.
 *
 * Host side: needs nothing but the grant in its profile (endpoint + token).
 * Deployment side (portal and cluster), from the environment:
 *   RELAY_NAMESPACE                    e.g. myns.servicebus.windows.net
 *   RELAY_CLUSTER_SEND_KEY_NAME / _KEY namespace-wide Send rule; the cluster connects to hosts with it
 *   RELAY_MINT_LISTEN_KEY_NAME / _KEY  namespace-wide Listen rule; the portal signs host tokens with it
 *   RELAY_SUBSCRIPTION, RELAY_RESOURCE_GROUP   for creating and deleting host endpoints
 *
 * Every token is limited to one host's hybrid connection when it is signed.
 */

import { AzureCliCredential } from "@azure/identity";
import type { RelayProvider } from "pilotswarm-relay-core";
import { AzureRelayTransport, parseAzureRelayGrant } from "./azure-relay.js";
import { AzureRelayProvisioner } from "./provisioner.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

function splitEndpoint(endpointId: string): { namespace: string; path: string } {
    const slash = endpointId.indexOf("/");
    if (slash <= 0 || slash === endpointId.length - 1) throw new Error(`not an Azure Relay endpoint: ${endpointId}`);
    return { namespace: endpointId.slice(0, slash), path: endpointId.slice(slash + 1) };
}

export const azureRelayProvider: RelayProvider = {
    name: "azure-relay",

    createHostTransport(grant, log) {
        const { namespace, path, listenToken } = parseAzureRelayGrant(grant);
        return new AzureRelayTransport({ namespace, path, token: listenToken, log });
    },

    createCallerTransport(endpointId, env) {
        return new AzureRelayTransport({
            ...splitEndpoint(endpointId),
            keyName: required(env, "RELAY_CLUSTER_SEND_KEY_NAME"),
            key: required(env, "RELAY_CLUSTER_SEND_KEY"),
        });
    },

    createProvisioner(env) {
        const subscriptionId = env.RELAY_SUBSCRIPTION;
        const resourceGroup = env.RELAY_RESOURCE_GROUP;
        return new AzureRelayProvisioner({
            namespace: required(env, "RELAY_NAMESPACE"),
            mintKeyName: required(env, "RELAY_MINT_LISTEN_KEY_NAME"),
            mintKey: required(env, "RELAY_MINT_LISTEN_KEY"),
            // The stand-in portal uses your az login. A real deployment would use its managed identity.
            management: subscriptionId && resourceGroup ? { subscriptionId, resourceGroup, credential: new AzureCliCredential() } : undefined,
        });
    },
};

/** Test helper: transports on one fixed hybrid connection, from hybrid-connection-level keys. */
export function transportsFromEnv(env: NodeJS.ProcessEnv): { host: () => AzureRelayTransport; caller: () => AzureRelayTransport } {
    const base = { namespace: required(env, "RELAY_NAMESPACE"), path: required(env, "RELAY_PATH") };
    return {
        host: () => new AzureRelayTransport({ ...base, keyName: required(env, "RELAY_LISTEN_KEY_NAME"), key: required(env, "RELAY_LISTEN_KEY") }),
        caller: () => new AzureRelayTransport({ ...base, keyName: required(env, "RELAY_SEND_KEY_NAME"), key: required(env, "RELAY_SEND_KEY") }),
    };
}
