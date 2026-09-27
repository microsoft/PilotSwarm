/**
 * Which session owners a relay host serves (`pilotswarm-relay --allow ...`).
 *
 * Each entry is either an email (compared without case) or an Entra object id.
 * Only owners whose provider is "entra" can match: PilotSwarm stores an Entra
 * owner as provider "entra", subject = the token's oid, email = preferred_username.
 *
 * With SAS keys the owner is reported by the caller (whoever holds the Send
 * key). This list limits which sessions use the relay; it does not stop a
 * caller who holds the Send key and reports a false owner.
 */

import type { ServedOwners, SessionOwner } from "./protocol.js";

export const ANY_OWNER: ServedOwners = { anyOwner: true, emails: [], objectIds: [] };

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class OwnerAllowList {
    private constructor(
        private readonly emails: ReadonlySet<string>,
        private readonly objectIds: ReadonlySet<string>,
    ) {}

    /**
     * Parses `--allow` values. Each value may hold several entries split by commas.
     * Throws on anything that is not an email or an Entra object id.
     */
    static parse(values: string[]): OwnerAllowList {
        const emails = new Set<string>();
        const objectIds = new Set<string>();
        for (const entry of values.flatMap((value) => value.split(",")).map((entry) => entry.trim()).filter(Boolean)) {
            if (OBJECT_ID.test(entry)) objectIds.add(entry.toLowerCase());
            else if (EMAIL.test(entry)) emails.add(entry.toLowerCase());
            else throw new Error(`'${entry}' is not an email or an Entra object id (use e.g. alice@example.com)`);
        }
        if (emails.size === 0 && objectIds.size === 0) throw new Error("the allow list is empty");
        return new OwnerAllowList(emails, objectIds);
    }

    /** The list for one owner (a profile's issuedTo): their email and, if known, their object id. */
    static forOwner(owner: SessionOwner): OwnerAllowList {
        if (owner.provider !== "entra") throw new Error(`only Entra owners can be served, not '${owner.provider}'`);
        const entries = [owner.email, OBJECT_ID.test(owner.subject) ? owner.subject : undefined].filter((e): e is string => Boolean(e));
        return OwnerAllowList.parse(entries);
    }

    /** Rebuilds the list a host sent in ready. Returns undefined for "any owner". Throws if malformed. */
    static fromServed(serves: ServedOwners): OwnerAllowList | undefined {
        if (typeof serves !== "object" || serves === null) throw new Error("serves must be an object");
        if (serves.anyOwner === true) return undefined;
        const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
        if (!strings(serves.emails) || !strings(serves.objectIds)) throw new Error("serves.emails and serves.objectIds must be string arrays");
        return OwnerAllowList.parse([...serves.emails, ...serves.objectIds]);
    }

    toServed(): ServedOwners {
        return { anyOwner: false, emails: [...this.emails], objectIds: [...this.objectIds] };
    }

    allows(owner: SessionOwner | undefined): boolean {
        if (!owner || owner.provider !== "entra") return false;
        if (typeof owner.subject === "string" && this.objectIds.has(owner.subject.toLowerCase())) return true;
        return typeof owner.email === "string" && this.emails.has(owner.email.toLowerCase());
    }

    describe(): string {
        return [...this.emails, ...this.objectIds].join(", ");
    }
}
