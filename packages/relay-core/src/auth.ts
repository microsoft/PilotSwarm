/**
 * Both ends prove who they are on every connection.
 *
 *   1. Host → cluster: a fresh challenge H.
 *      Cluster signs  (its fingerprint + the endpoint it dialed + H)  with the cluster key.
 *   2. Cluster → host: a fresh challenge C, sent with that signature.
 *      Host signs  (its fingerprint + the cluster's fingerprint + the endpoint + C)  with the host key.
 *
 * Fresh challenges stop replay. Naming the endpoint stops a signature made for
 * one host from working on another. The host checks the cluster against the
 * public keys in its profile; the cluster checks the host against the key it
 * pinned when the host was activated.
 */

import { randomBytes } from "node:crypto";
import { KeySigner, fingerprintOf, publicKeyFromPem, verifyBytes, type KeyObject } from "./keys.js";

export function newChallenge(): string {
    return randomBytes(32).toString("base64url");
}

/** The exact bytes a cluster signs. A format change needs a new version line. */
export function clusterStatement(fields: { cluster: string; endpointId: string; challenge: string }): Buffer {
    return Buffer.from(
        `pilotswarm-relay/cluster-auth/v2\ncluster=${fields.cluster}\nendpoint=${fields.endpointId}\nchallenge=${fields.challenge}\n`,
        "utf8",
    );
}

/** The exact bytes a host signs. */
export function hostStatement(fields: { host: string; cluster: string; endpointId: string; challenge: string }): Buffer {
    return Buffer.from(
        `pilotswarm-relay/host-auth/v2\nhost=${fields.host}\ncluster=${fields.cluster}\nendpoint=${fields.endpointId}\nchallenge=${fields.challenge}\n`,
        "utf8",
    );
}

/** The cluster side. Holds the cluster's private key. */
export class ClusterSigner extends KeySigner {
    constructor(privateKeyPem: string) {
        super(privateKeyPem, "the cluster private key");
    }

    signChallenge(endpointId: string, challenge: string): string {
        return this.signBytes(clusterStatement({ cluster: this.fingerprint, endpointId, challenge }));
    }
}

/** The host side. Holds the host's private key, made on the host at first run. */
export class HostSigner extends KeySigner {
    constructor(privateKeyPem: string) {
        super(privateKeyPem, "the host private key");
    }

    signChallenge(cluster: string, endpointId: string, challenge: string): string {
        return this.signBytes(hostStatement({ host: this.fingerprint, cluster, endpointId, challenge }));
    }
}

/** The host side. The public keys of the clusters this host accepts (from its profile). */
export class TrustedClusters {
    private constructor(private readonly keys: ReadonlyMap<string, KeyObject>) {}

    static fromPublicKeyPems(pems: string[]): TrustedClusters {
        const keys = new Map<string, KeyObject>();
        for (const pem of pems) {
            const key = publicKeyFromPem(pem, "a trusted cluster key");
            keys.set(fingerprintOf(key), key);
        }
        if (keys.size === 0) throw new Error("no trusted cluster keys");
        return new TrustedClusters(keys);
    }

    get fingerprints(): string[] {
        return [...this.keys.keys()];
    }

    /** True only when `cluster` is trusted and `signature` covers this endpoint and challenge. */
    check(cluster: unknown, signature: unknown, endpointId: string, challenge: string): boolean {
        if (typeof cluster !== "string") return false;
        const key = this.keys.get(cluster);
        return key !== undefined && verifyBytes(key, clusterStatement({ cluster, endpointId, challenge }), signature);
    }
}

/**
 * The cluster side. True only when `publicKeyPem` is the key `host` names and
 * `signature` covers this cluster, endpoint, and challenge.
 */
export function checkHostProof(
    publicKeyPem: string,
    fields: { host: string; cluster: string; endpointId: string; challenge: string },
    signature: unknown,
): boolean {
    let key: KeyObject;
    try {
        key = publicKeyFromPem(publicKeyPem, "the host public key");
    } catch {
        return false;
    }
    return fingerprintOf(key) === fields.host && verifyBytes(key, hostStatement(fields), signature);
}
