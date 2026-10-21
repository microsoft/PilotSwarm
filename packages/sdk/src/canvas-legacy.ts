/**
 * The canvas app transition (issue 181): one switch, and the old catalog.
 *
 * Before the canvas app registry, apps lived as shared facts `apps/<name>`
 * whose `source` names a pinned artifact and its sha256. While the transition
 * is on (`PILOTSWARM_CANVAS_LEGACY_MODE`, default on), those old apps keep
 * working exactly as before: they are found next to registry apps, drawn
 * fromArtifact, and their pages keep the old rules (L2/L3).
 *
 * Which old pages keep the old rules is decided by the catalog AS IT WAS when
 * the registry was installed: a card counts only if its fact was last written
 * at least CANVAS_LEGACY_CUTOFF_MARGIN_MS before the registry's CMS migration
 * was applied. Fact timestamps are set by the database on every write, never
 * by a caller, so a card written or changed after the deploy can still be
 * found and drawn, but it exempts nothing. An agent therefore cannot make its
 * own page an "old app" by writing a card. The margin covers clock skew
 * between a separate facts database and the CMS, transaction-start
 * timestamps, and sub-millisecond precision: it only narrows the set.
 *
 * Shared with Issue 184, which reuses canvasLegacyModeFromEnv().
 */

import type { FactRecord, FactStore } from "./facts-store.js";
import { CANVAS_APP_NAME_RE } from "./canvas-app-manifest.js";

/** The one transition switch: `on` (default) or `off`. */
export const CANVAS_LEGACY_MODE_ENV = "PILOTSWARM_CANVAS_LEGACY_MODE";

/** The CMS migration that installed the canvas app registry: the legacy cutoff. */
export const CANVAS_APP_REGISTRY_MIGRATION_VERSION = "0084";

/** The old catalog's fact key prefix. */
export const CANVAS_LEGACY_CATALOG_PREFIX = "apps/";

/** A card must predate the registry's install by at least this much to exempt its page. */
export const CANVAS_LEGACY_CUTOFF_MARGIN_MS = 5 * 60_000;

const LEGACY_MODE_ON = new Set(["", "on", "true", "1", "yes"]);

/**
 * PILOTSWARM_CANVAS_LEGACY_MODE: unset, empty, `on`, `true`, `1` or `yes` is
 * on; anything else (`off`, `false`, `0`, `no`, or a typo) is off, the
 * stricter rules. Each process reads its own environment; the worker and the
 * portal must agree, and where they meet the stricter side wins.
 */
export function canvasLegacyModeFromEnv(env: Record<string, string | undefined> = process.env): boolean {
    const raw = env[CANVAS_LEGACY_MODE_ENV];
    if (raw === undefined) return true;
    return LEGACY_MODE_ON.has(String(raw).trim().toLowerCase());
}

export interface CanvasLegacySource {
    sessionId: string;
    filename: string;
    sha256: string;
}

/** One old catalog card, as the fact holds it, plus whether it keeps the old rules. */
export interface CanvasLegacyCard {
    key: string;
    name: string;
    /** The whole fact value (main's card shape: name, description, version, tags, kv, source, card, …). */
    value: Record<string, unknown>;
    source: CanvasLegacySource | null;
    updatedAt: Date | null;
    /**
     * An app card (key apps/<valid app name>) with a valid source sha256,
     * written at least CANVAS_LEGACY_CUTOFF_MARGIN_MS before the registry's install.
     */
    exempt: boolean;
}

export interface CanvasLegacyCatalogDeps {
    factStore: FactStore | null | undefined;
    /** When the registry was installed (the cutoff); null when unknown, which exempts nothing. */
    installedAt: () => Promise<Date | null>;
    /** How long one enumeration of the old catalog is reused. Default 60 s. */
    ttlMs?: number;
    now?: () => number;
    /** Most fact reads one enumeration may make; past it the snapshot is incomplete. Default 200. */
    maxReads?: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
/** The facts providers return at most this many rows per read; a full page means "maybe more". */
const PAGE = 1000;
/** Characters of a valid app name (CANVAS_APP_NAME_RE): the enumeration splits a full prefix on them. */
const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
const NAME_MAX = 64;

function parseValue(value: unknown): Record<string, unknown> | null {
    const v: any = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function parseSource(raw: unknown): CanvasLegacySource | null {
    const s: any = raw;
    if (!s || typeof s !== "object") return null;
    const sessionId = typeof s.sessionId === "string" ? s.sessionId : "";
    const filename = typeof s.filename === "string" ? s.filename : "";
    const sha256 = typeof s.sha256 === "string" ? s.sha256.toLowerCase() : "";
    if (!sessionId || !filename || !SHA256_RE.test(sha256)) return null;
    return { sessionId, filename, sha256 };
}

function toDate(value: unknown): Date | null {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d : null;
    }
    return null;
}

/** The app name of an app card key apps/<name>, or null (publication records and other keys). */
function appNameOfKey(key: string): string | null {
    if (!key.startsWith(CANVAS_LEGACY_CATALOG_PREFIX)) return null;
    const name = key.slice(CANVAS_LEGACY_CATALOG_PREFIX.length);
    return CANVAS_APP_NAME_RE.test(name) ? name : null;
}

/** Card for one fact, judged against the cutoff (installedAt minus the margin). Exported for tests. */
export function canvasLegacyCardFromFact(fact: Pick<FactRecord, "key" | "value" | "updatedAt">, installedAt: Date | null): CanvasLegacyCard | null {
    const key = String(fact?.key ?? "");
    if (!key.startsWith(CANVAS_LEGACY_CATALOG_PREFIX)) return null;
    const value = parseValue(fact.value);
    if (!value) return null;
    const source = parseSource(value.source);
    const updatedAt = toDate(fact.updatedAt);
    const name = typeof value.name === "string" && value.name ? value.name : key.slice(CANVAS_LEGACY_CATALOG_PREFIX.length);
    const cutoff = installedAt ? installedAt.getTime() - CANVAS_LEGACY_CUTOFF_MARGIN_MS : null;
    const exempt = Boolean(source && appNameOfKey(key) && cutoff !== null && updatedAt && updatedAt.getTime() <= cutoff);
    return { key, name, value, source, updatedAt, exempt };
}

interface Snapshot {
    at: number;
    cards: CanvasLegacyCard[];
    /** Every apps/<valid name> card was read. False: the exemptions are only those found. */
    complete: boolean;
}

/**
 * The old catalog. Reads only: it never writes or deletes a card.
 *
 * - `get(name)` reads the one exact key (no limit can hide it).
 * - The exempt set comes from a complete enumeration of apps/<valid name>
 *   keys, at most once per TTL: a prefix whose read comes back full is split
 *   on the next name character, so newer facts cannot push old cards out.
 * - Exemptions are served only from a snapshot taken within the TTL. A
 *   failed refresh, or an unknown install time, exempts nothing.
 */
export class CanvasLegacyCatalog {
    private snapshot: Snapshot | null = null;
    private loading: Promise<Snapshot | null> | null = null;
    private installed: Date | null = null;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly maxReads: number;

    constructor(private readonly deps: CanvasLegacyCatalogDeps) {
        this.ttlMs = Math.max(0, deps.ttlMs ?? 60_000);
        this.now = deps.now ?? Date.now;
        this.maxReads = Math.max(1, deps.maxReads ?? 200);
    }

    /** The card stored at apps/<name>, read exactly, judged against the cutoff; null if none. */
    async get(name: string): Promise<CanvasLegacyCard | null> {
        const store = this.deps.factStore;
        const appName = String(name ?? "").trim().toLowerCase();
        if (!store || !CANVAS_APP_NAME_RE.test(appName)) return null;
        const key = `${CANVAS_LEGACY_CATALOG_PREFIX}${appName}`;
        const res = await store.readFacts({ scopeKeys: [`shared:${key}`], scope: "shared", limit: 1 });
        const fact = (res?.facts ?? []).find((f) => f?.key === key && f?.shared !== false && !f?.deletedAt);
        if (!fact) return null;
        return canvasLegacyCardFromFact(fact, await this.installedAtOrNull());
    }

    /** The source sha256s that keep the old rules now; empty when that cannot be established. */
    async exemptSha256s(): Promise<Set<string>> {
        const snap = await this.freshSnapshot();
        return new Set((snap?.cards ?? []).filter((card) => card.exempt && card.source).map((card) => card.source!.sha256));
    }

    async isExemptSha256(sha256: string | null | undefined): Promise<boolean> {
        const sha = String(sha256 ?? "").toLowerCase();
        if (!SHA256_RE.test(sha)) return false;
        return (await this.exemptSha256s()).has(sha);
    }

    /** Whether the last enumeration read every app card (for diagnostics and tests). */
    async isComplete(): Promise<boolean> {
        return (await this.freshSnapshot())?.complete === true;
    }

    private async freshSnapshot(): Promise<Snapshot | null> {
        const snap = this.snapshot;
        if (snap && this.now() - snap.at < this.ttlMs) return snap;
        if (!this.loading) {
            this.loading = this.load().finally(() => { this.loading = null; });
        }
        return this.loading;
    }

    private async installedAtOrNull(): Promise<Date | null> {
        // The install time never changes once known; until then, ask again.
        if (!this.installed) this.installed = await this.deps.installedAt().catch(() => null);
        return this.installed;
    }

    private async load(): Promise<Snapshot | null> {
        const store = this.deps.factStore;
        if (!store) return null;
        try {
            const installedAt = await this.installedAtOrNull();
            const byKey = new Map<string, FactRecord>();
            let reads = 0;
            let complete = true;
            const readPrefix = async (prefix: string): Promise<void> => {
                if (reads >= this.maxReads) { complete = false; return; }
                reads++;
                const res = await store.readFacts({ keyPattern: `${CANVAS_LEGACY_CATALOG_PREFIX}${prefix}*`, scope: "shared", limit: PAGE });
                const facts = res?.facts ?? [];
                for (const fact of facts) {
                    if (fact?.shared === false || fact?.deletedAt) continue;
                    if (appNameOfKey(String(fact?.key ?? ""))) byKey.set(fact.key, fact);
                }
                if (facts.length < PAGE) return;
                // Full: more keys may share this prefix. The prefix itself may be a
                // name: read it exactly, at every length up to the longest name.
                // Every longer name continues with a name character; keys under
                // "<prefix>/" are never app names.
                if (prefix && CANVAS_APP_NAME_RE.test(prefix)) {
                    if (reads >= this.maxReads) { complete = false; return; }
                    reads++;
                    const key = `${CANVAS_LEGACY_CATALOG_PREFIX}${prefix}`;
                    const exact = await store.readFacts({ scopeKeys: [`shared:${key}`], scope: "shared", limit: 1 });
                    for (const fact of exact?.facts ?? []) {
                        if (fact?.key === key && fact?.shared !== false && !fact?.deletedAt) byKey.set(key, fact);
                    }
                }
                if (prefix.length >= NAME_MAX) return;
                for (const ch of NAME_CHARS) {
                    if (!complete) return;
                    await readPrefix(prefix + ch);
                }
            };
            await readPrefix("");
            const cards = [...byKey.values()]
                .map((fact) => canvasLegacyCardFromFact(fact, installedAt))
                .filter((card): card is CanvasLegacyCard => card !== null);
            const snap: Snapshot = { at: this.now(), cards, complete };
            this.snapshot = snap;
            return snap;
        } catch {
            // A failed refresh exempts nothing; the expired snapshot is not reused.
            this.snapshot = null;
            return null;
        }
    }
}

/**
 * How a registry app of the same name answers for this user: present (it
 * wins), absent (`NOT_FOUND`, which an invisible private app also answers),
 * or a failure of the search itself.
 */
export type CanvasRegistryPresence = "present" | "absent";

/**
 * find_canvas_app's merge while the transition is on: registry hits first,
 * then old-catalog hits (main's shape, marked `legacy: true`) up to `limit`.
 * An old hit is kept only when the registry answers "absent" for its name;
 * `probe` maps the registry's error codes (a disabled or refused app is
 * present) and throws for any other failure, which fails the search. A
 * failed old-catalog search is reported, not hidden.
 */
export async function mergeLegacyCanvasAppHits(input: {
    registryHits: ReadonlyArray<object>;
    legacy: { apps: ReadonlyArray<object> } | { error: string };
    limit: number;
    probe: ((name: string) => Promise<CanvasRegistryPresence>) | null;
}): Promise<{ apps: Array<Record<string, unknown>>; legacyCount: number; legacyError: string | null }> {
    const apps = input.registryHits.map((hit) => ({ ...hit }) as Record<string, unknown>);
    const legacyError = "error" in input.legacy ? input.legacy.error : null;
    const names = new Set(apps.map((a) => String(a.name ?? "").toLowerCase()));
    let legacyCount = 0;
    for (const hit of "apps" in input.legacy ? input.legacy.apps as ReadonlyArray<Record<string, unknown>> : []) {
        if (apps.length >= input.limit) break;
        const name = String(hit.name ?? "").toLowerCase();
        if (names.has(name)) continue;
        if (input.probe && (await input.probe(name)) === "present") continue;
        names.add(name);
        apps.push({ ...hit, legacy: true });
        legacyCount++;
    }
    return { apps, legacyCount, legacyError };
}

const catalogsByStore = new WeakMap<object, CanvasLegacyCatalog>();

/**
 * One cached old catalog per fact store, so every tool call and request in a
 * process shares one enumeration per TTL. Null without a fact store. The first
 * `installedAt` given for a store is the one used: one process pairs one fact
 * store with one registry.
 */
export function canvasLegacyCatalogFor(
    factStore: FactStore | null | undefined,
    installedAt: () => Promise<Date | null>,
    opts: { ttlMs?: number } = {},
): CanvasLegacyCatalog | null {
    if (!factStore || typeof factStore !== "object") return null;
    let catalog = catalogsByStore.get(factStore);
    if (!catalog) {
        catalog = new CanvasLegacyCatalog({ factStore, installedAt, ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}) });
        catalogsByStore.set(factStore, catalog);
    }
    return catalog;
}
