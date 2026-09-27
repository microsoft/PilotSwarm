/**
 * Portal side of the Azure Relay provider: one hybrid connection per host.
 *
 *   createHostEndpoint  → PUT a hybrid connection named s-<uuid>, and a Listen token for it
 *   renewHostGrant      → a fresh Listen token for it (the cluster pushes this to the host)
 *   deleteHostEndpoint  → DELETE it; a connected host drops in about 20 s
 *
 * Tokens are signed with ONE namespace-wide Listen key but limited to one
 * hybrid connection by the token's resource URI. Azure matches that URI as a
 * string PREFIX (a token for "s-a" also opens "s-ab"), so every name has the
 * same length: "s-" + a UUID. No name can then be the start of another.
 */

import { randomUUID } from "node:crypto";
import type { TokenCredential } from "@azure/identity";
import type { RelayProvisioner } from "pilotswarm-relay-core";
import { createSasToken, type AzureRelayGrant } from "./azure-relay.js";

export interface AzureProvisionerConfig {
    /** Namespace host name, for example "myns.servicebus.windows.net". */
    namespace: string;
    /** Namespace-wide SAS rule with Listen only. Only the deployment holds it (Key Vault in production). */
    mintKeyName: string;
    mintKey: string;
    /** How long a host's Listen token lasts. The cluster renews it on every connection. Default 7 days. */
    listenTokenTtlSeconds?: number;
    /** For creating and deleting hybrid connections. Not needed just to renew tokens. */
    management?: { subscriptionId: string; resourceGroup: string; credential: TokenCredential };
}

const API_VERSION = "2021-11-01";
const HOST_ENDPOINT = /^s-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AzureRelayProvisioner implements RelayProvisioner {
    // The key lives only in a #private field, so it never prints; `config` holds everything else.
    readonly #mintKey: string;
    private readonly config: Omit<AzureProvisionerConfig, "mintKey">;
    private readonly ttlSeconds: number;

    constructor(config: AzureProvisionerConfig) {
        const { mintKey, ...rest } = config;
        if (!rest.namespace || !rest.mintKeyName || !mintKey) throw new Error("AzureRelayProvisioner: namespace, mintKeyName, and mintKey are required");
        this.#mintKey = mintKey;
        this.config = rest;
        this.ttlSeconds = rest.listenTokenTtlSeconds ?? 7 * 24 * 3600;
    }

    async createHostEndpoint(): Promise<{ endpointId: string; grant: AzureRelayGrant }> {
        const path = `s-${randomUUID()}`;
        await this.arm("PUT", path, { properties: { requiresClientAuthorization: true } });
        return { endpointId: this.endpointIdOf(path), grant: this.grantFor(path) };
    }

    async renewHostGrant(endpointId: string): Promise<AzureRelayGrant> {
        return this.grantFor(this.pathOf(endpointId));
    }

    async deleteHostEndpoint(endpointId: string): Promise<void> {
        await this.arm("DELETE", this.pathOf(endpointId));
    }

    private grantFor(path: string): AzureRelayGrant {
        const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
        const listenToken = createSasToken(`http://${this.config.namespace}/${path}`, this.config.mintKeyName, this.#mintKey, this.ttlSeconds);
        return { namespace: this.config.namespace, path, listenToken, expiresAt };
    }

    private endpointIdOf(path: string): string {
        return `${this.config.namespace}/${path}`.toLowerCase();
    }

    /** Only host endpoints this provisioner could have made. Never, say, a shared hybrid connection. */
    private pathOf(endpointId: string): string {
        const prefix = `${this.config.namespace}/`.toLowerCase();
        const path = endpointId.toLowerCase().startsWith(prefix) ? endpointId.slice(prefix.length) : "";
        if (!HOST_ENDPOINT.test(path)) throw new Error(`${endpointId} is not a host endpoint in ${this.config.namespace}`);
        return path;
    }

    private async arm(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<void> {
        const management = this.config.management;
        if (!management) throw new Error("AzureRelayProvisioner: management settings are needed to create or delete endpoints");
        const namespaceName = this.config.namespace.split(".")[0];
        const url =
            `https://management.azure.com/subscriptions/${management.subscriptionId}/resourceGroups/${management.resourceGroup}` +
            `/providers/Microsoft.Relay/namespaces/${namespaceName}/hybridConnections/${path}?api-version=${API_VERSION}`;
        const token = await management.credential.getToken("https://management.azure.com/.default");
        if (!token) throw new Error("could not get an Azure management token");
        const response = await fetch(url, {
            method,
            headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (method === "DELETE" && response.status === 404) return;
        if (!response.ok) {
            const text = (await response.text()).slice(0, 300);
            throw new Error(`Azure management ${method} ${path} failed: ${response.status} ${text}`);
        }
    }
}
