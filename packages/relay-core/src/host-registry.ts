/**
 * The deployment's record of every host: which endpoint it listens on, whose
 * sessions it serves, and the host key pinned at activation.
 *
 * In PilotSwarm this would be a CMS table. The spike keeps it in memory
 * (tests) or in a JSON file (the portal and cluster stand-ins).
 *
 * Activation rules (checked by activate()):
 *   - the host is pending, not active or revoked
 *   - the secret matches (compared as SHA-256, in constant time)
 *   - the activation window has not closed
 * On success the host key is pinned and the secret can never be used again.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-util.js";
import { fingerprintOfPem } from "./keys.js";
import type { HostSummary, SessionOwner } from "./protocol.js";

export type HostStatus = "pending" | "active" | "revoked";

export interface HostRecord {
    hostId: string;
    endpointId: string;
    /** Relay provider name, for example "azure-relay". */
    provider: string;
    /** The person whose sessions this host serves. */
    issuedTo: SessionOwner;
    status: HostStatus;
    createdAt: string;
    activation: { secretSha256: string; expiresAt: string; usedAt?: string };
    hostKey?: { fingerprint: string; publicKeyPem: string };
    /** What the host said about itself at activation. Untrusted. */
    host?: HostSummary;
    activatedAt?: string;
    revokedAt?: string;
}

export type ActivationResult = { ok: true } | { ok: false; reason: string };

/** What the cluster side of the handshake needs. */
export interface HostRegistry {
    /** The host key pinned for this endpoint, or undefined if the host is not active. */
    pinnedHostKey(endpointId: string): Promise<string | undefined>;
    /** Pins `publicKeyPem` if `secret` activates this endpoint's host. */
    activate(endpointId: string, secret: string, publicKeyPem: string, host: HostSummary): Promise<ActivationResult>;
}

export function hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretMatches(secret: string, expectedSha256: string): boolean {
    const actual = Buffer.from(hashSecret(secret), "hex");
    const expected = Buffer.from(expectedSha256, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Registry logic over any storage that can read and write the whole list. */
abstract class BaseHostRegistry implements HostRegistry {
    protected abstract read(): HostRecord[];
    protected abstract write(records: HostRecord[]): void;

    list(): HostRecord[] {
        return this.read();
    }

    get(hostId: string): HostRecord | undefined {
        return this.read().find((record) => record.hostId === hostId);
    }

    add(record: HostRecord): void {
        const records = this.read();
        if (records.some((r) => r.hostId === record.hostId || (r.endpointId === record.endpointId && r.status !== "revoked"))) {
            throw new Error(`a host with id ${record.hostId} or endpoint ${record.endpointId} already exists`);
        }
        this.write([...records, record]);
    }

    revoke(hostId: string, now: Date = new Date()): HostRecord {
        const records = this.read();
        const record = records.find((r) => r.hostId === hostId);
        if (!record) throw new Error(`no host ${hostId}`);
        record.status = "revoked";
        record.revokedAt = now.toISOString();
        this.write(records);
        return record;
    }

    async pinnedHostKey(endpointId: string): Promise<string | undefined> {
        const record = this.read().find((r) => r.endpointId === endpointId && r.status === "active");
        return record?.hostKey?.publicKeyPem;
    }

    async activate(endpointId: string, secret: string, publicKeyPem: string, host: HostSummary, now: Date = new Date()): Promise<ActivationResult> {
        const records = this.read();
        const record = records.find((r) => r.endpointId === endpointId && r.status !== "revoked");
        if (!record) return { ok: false, reason: "no host is registered for this endpoint (revoked or never added)" };
        if (record.status === "active" || record.activation.usedAt) return { ok: false, reason: "this profile was already activated" };
        if (typeof secret !== "string" || !secretMatches(secret, record.activation.secretSha256)) {
            return { ok: false, reason: "wrong activation secret" };
        }
        if (now.getTime() > Date.parse(record.activation.expiresAt)) {
            return { ok: false, reason: `the activation window closed at ${record.activation.expiresAt}; download a new profile` };
        }
        let fingerprint: string;
        try {
            fingerprint = fingerprintOfPem(publicKeyPem);
        } catch (error) {
            return { ok: false, reason: (error as Error).message };
        }
        record.status = "active";
        record.hostKey = { fingerprint, publicKeyPem };
        record.host = host;
        record.activatedAt = now.toISOString();
        record.activation.usedAt = record.activatedAt;
        this.write(records);
        return { ok: true };
    }
}

export class MemoryHostRegistry extends BaseHostRegistry {
    private records: HostRecord[] = [];

    protected read(): HostRecord[] {
        return structuredClone(this.records);
    }

    protected write(records: HostRecord[]): void {
        this.records = structuredClone(records);
    }
}

/** A JSON file, mode 600. Stands in for a database table. */
export class FileHostRegistry extends BaseHostRegistry {
    constructor(readonly file: string) {
        super();
    }

    protected read(): HostRecord[] {
        if (!existsSync(this.file)) return [];
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { hosts?: HostRecord[] };
        return Array.isArray(parsed.hosts) ? parsed.hosts : [];
    }

    protected write(records: HostRecord[]): void {
        writeFileAtomic(this.file, `${JSON.stringify({ hosts: records }, null, 2)}\n`);
    }
}
