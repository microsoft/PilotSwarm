/**
 * The relay profile: the one file a host needs.
 *
 * The portal makes it when a signed-in user clicks "add a host". It holds
 * the cluster's public key (so the host knows whom to trust), the relay
 * endpoint and a credential to listen on it (opaque to the core; only the
 * provider reads `relay.grant`), and a one-time activation secret that
 * expires after 10 minutes.
 *
 * The host keeps its own state next to its host key, so later runs use the
 * latest pushed credential and never resend a spent activation secret.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { HostSigner } from "./auth.js";
import { writeFileAtomic } from "./fs-util.js";
import { hashSecret, type HostRecord } from "./host-registry.js";
import { generateKeyPair, publicKeyFromPem } from "./keys.js";
import type { SessionOwner } from "./protocol.js";

export const PROFILE_VERSION = 1;
export const DEFAULT_ACTIVATION_MINUTES = 10;

export interface RelayProfile {
    version: 1;
    hostId: string;
    /** The portal that issued it. Shown on the consent screen only. */
    portal: string;
    issuedTo: SessionOwner;
    issuedAt: string;
    cluster: { publicKeys: string[] };
    relay: { provider: string; endpointId: string; grant: unknown };
    activation: { secret: string; expiresAt: string };
}

/** Portal side: a new profile and the matching pending registry record. */
export function issueProfile(input: {
    portal: string;
    issuedTo: SessionOwner;
    clusterPublicKeys: string[];
    provider: string;
    endpointId: string;
    grant: unknown;
    activationMinutes?: number;
    now?: Date;
}): { profile: RelayProfile; record: HostRecord } {
    const now = input.now ?? new Date();
    for (const pem of input.clusterPublicKeys) publicKeyFromPem(pem, "a cluster public key");
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + (input.activationMinutes ?? DEFAULT_ACTIVATION_MINUTES) * 60_000).toISOString();
    const hostId = `h-${randomUUID()}`;
    const profile: RelayProfile = {
        version: PROFILE_VERSION,
        hostId,
        portal: input.portal,
        issuedTo: input.issuedTo,
        issuedAt: now.toISOString(),
        cluster: { publicKeys: input.clusterPublicKeys },
        relay: { provider: input.provider, endpointId: input.endpointId, grant: input.grant },
        activation: { secret, expiresAt },
    };
    const record: HostRecord = {
        hostId,
        endpointId: input.endpointId,
        provider: input.provider,
        issuedTo: input.issuedTo,
        status: "pending",
        createdAt: now.toISOString(),
        // Only the hash is kept. The secret itself exists only in the profile.
        activation: { secretSha256: hashSecret(secret), expiresAt },
    };
    return { profile, record };
}

/** Host side: parse and check a profile file's text. Throws with a plain reason. */
export function parseProfile(text: string): RelayProfile {
    let value: Partial<RelayProfile>;
    try {
        value = JSON.parse(text) as Partial<RelayProfile>;
    } catch {
        throw new Error("the profile is not valid JSON");
    }
    if (value.version !== PROFILE_VERSION) throw new Error(`unsupported profile version ${String(value.version)}`);
    const str = (v: unknown) => typeof v === "string" && v.length > 0;
    if (!str(value.hostId) || !str(value.portal) || !str(value.issuedAt)) throw new Error("the profile is missing hostId, portal, or issuedAt");
    const owner = value.issuedTo;
    if (!owner || !str(owner.provider) || !str(owner.subject)) throw new Error("the profile has no valid issuedTo owner");
    if (!Array.isArray(value.cluster?.publicKeys) || value.cluster.publicKeys.length === 0) throw new Error("the profile has no cluster keys");
    for (const pem of value.cluster.publicKeys) publicKeyFromPem(String(pem), "a cluster key in the profile");
    if (!value.relay || !str(value.relay.provider) || !str(value.relay.endpointId) || value.relay.grant === undefined) {
        throw new Error("the profile has no relay endpoint");
    }
    if (!value.activation || !str(value.activation.secret) || !str(value.activation.expiresAt)) throw new Error("the profile has no activation secret");
    return value as RelayProfile;
}

export interface HostState {
    version: 1;
    hostId: string;
    portal: string;
    issuedTo: SessionOwner;
    cluster: { publicKeys: string[] };
    relay: { provider: string; endpointId: string; grant: unknown };
    /** Present until the cluster confirms activation. */
    activation?: { secret: string; expiresAt: string };
    activatedAt?: string;
}

/**
 * Host side: <stateRoot>/<hostId>/state.json and host.key, both mode 600.
 * The first run copies the profile; later runs ignore the profile's
 * credential and secret in favor of what the state holds.
 */
export class HostStateStore {
    private constructor(
        readonly dir: string,
        public state: HostState,
    ) {}

    static open(stateRoot: string, profile: RelayProfile): HostStateStore {
        const dir = path.join(stateRoot, profile.hostId);
        const file = path.join(dir, "state.json");
        if (existsSync(file)) {
            const state = JSON.parse(readFileSync(file, "utf8")) as HostState;
            if (state.hostId !== profile.hostId) throw new Error(`state in ${dir} belongs to another host`);
            return new HostStateStore(dir, state);
        }
        const { hostId, portal, issuedTo, cluster, relay, activation } = profile;
        return new HostStateStore(dir, { version: 1, hostId, portal, issuedTo, cluster, relay, activation });
    }

    get isActivated(): boolean {
        return this.state.activation === undefined;
    }

    get hostKeyFile(): string {
        return path.join(this.dir, "host.key");
    }

    /** The host key, made on first use and never leaving this machine. */
    hostSigner(): HostSigner {
        if (!existsSync(this.hostKeyFile)) {
            writeFileAtomic(this.hostKeyFile, generateKeyPair().privateKeyPem);
        }
        return new HostSigner(readFileSync(this.hostKeyFile, "utf8"));
    }

    save(): void {
        writeFileAtomic(path.join(this.dir, "state.json"), `${JSON.stringify(this.state, null, 2)}\n`);
    }
}
