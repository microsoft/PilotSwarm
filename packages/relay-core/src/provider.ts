/**
 * What a relay service plugs into the core. The core never imports a
 * provider; a provider package passes one of these in.
 *
 * A "grant" is the provider's credential for one host endpoint (for Azure
 * Relay: the endpoint plus a SAS token). The core carries grants in profiles
 * and grant_update messages but never reads them.
 */

import type { RelayTransport } from "./transport.js";

/** A host-side transport whose credential the cluster can replace. */
export interface GrantedTransport extends RelayTransport {
    /** Swap in a fresh grant for the same endpoint. Throws if it is for another endpoint. */
    refreshGrant(grant: unknown): void;
}

/** Deployment side (portal): manages one endpoint per host. */
export interface RelayProvisioner {
    /** Makes a new endpoint for one host and a grant to listen on it. */
    createHostEndpoint(): Promise<{ endpointId: string; grant: unknown }>;
    /** A fresh listen grant for an existing endpoint. The cluster pushes it to the host. */
    renewHostGrant(endpointId: string): Promise<unknown>;
    /** Deletes the endpoint. A connected host drops soon after. */
    deleteHostEndpoint(endpointId: string): Promise<void>;
}

export interface RelayProvider {
    /** Short name, for example "azure-relay". Profiles name their provider. */
    readonly name: string;
    /** Host side: listen with the grant from a profile. */
    createHostTransport(grant: unknown, log?: (line: string) => void): GrantedTransport;
    /** Cluster side: connect to one host's endpoint, with the deployment's own credential from `env`. */
    createCallerTransport(endpointId: string, env: NodeJS.ProcessEnv): RelayTransport;
    /** Portal side. Reads its settings from `env`. */
    createProvisioner(env: NodeJS.ProcessEnv): RelayProvisioner;
}
