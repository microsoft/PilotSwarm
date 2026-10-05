/**
 * Unit tests for the pg-pool factory feature switch (Chunk C).
 *
 * Pure logic — no live database needed. Imports the compiled SDK so this
 * runs from the same vitest setup as the rest of the local suites.
 */
import { describe, it, expect, afterEach } from "vitest";
import pg from "pg";
import { _setPgAadCredentialForTests, buildPgPoolConfig, readManagedIdentityFlag } from "../../src/pg-pool-factory.ts";
import { buildSessionCatalogPgClientConfig, getRuntimeStorageProvider, resolveStorageConfig } from "../../src/index.ts";

afterEach(() => {
    _setPgAadCredentialForTests(null);
});

/**
 * The config the real CMS path hands to pg.Pool for these options:
 * storage resolution, then the runtime provider's createSessionCatalog.
 * pg.Pool is swapped for a recorder, so nothing connects.
 */
async function cmsPoolConfig(options, env = {}) {
    const RealPool = pg.Pool;
    const seen = [];
    pg.Pool = class {
        constructor(config) { seen.push(config); }
        on() {}
    };
    try {
        const storage = resolveStorageConfig({ env, options });
        await getRuntimeStorageProvider(storage.runtime.provider).createSessionCatalog(storage.runtime);
    } finally {
        pg.Pool = RealPool;
    }
    expect(seen).toHaveLength(1);
    return seen[0];
}

/** Drop the fields only a pool has, and the CMS pool's own connect timeout. */
function connectionPart(config) {
    const { max: _max, connectionTimeoutMillis: _timeout, password: _password, ...rest } = config;
    return rest;
}

describe("buildPgPoolConfig", () => {
    it("legacy: returns connectionString + ssl when sslmode=require", () => {
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u:p@h:5432/db?sslmode=require",
        });
        expect(cfg.connectionString).toBeDefined();
        expect(cfg.connectionString).not.toMatch(/sslmode/i);
        expect(cfg.connectionString).toMatch(/^postgresql:\/\/u:p@h:5432\/db/);
        expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
        expect(cfg.max).toBe(3);
        expect(cfg.password).toBeUndefined();
    });

    it("legacy: omits ssl when sslmode is absent", () => {
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u:p@h:5432/db",
        });
        expect(cfg.ssl).toBeUndefined();
    });

    it("MI: strips password and installs token callback", async () => {
        const fakeCredential = {
            getToken: async () => ({ token: "fake-aad-token", expiresOnTimestamp: Date.now() + 3600_000 }),
        };
        _setPgAadCredentialForTests(fakeCredential);

        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://ignored-user:ignored-pwd@h:5432/db?sslmode=require",
            useManagedIdentity: true,
            aadUser: "uami-display-name",
        });

        expect(cfg.connectionString).toBeUndefined();
        expect(cfg.host).toBe("h");
        expect(cfg.port).toBe(5432);
        expect(cfg.database).toBe("db");
        expect(cfg.user).toBe("uami-display-name");
        expect(cfg.ssl).toEqual({ rejectUnauthorized: false });

        expect(typeof cfg.password).toBe("function");
        const token = await cfg.password();
        expect(token).toBe("fake-aad-token");
    });

    it("MI: defaults user to URL `user@` when aadUser is not provided", () => {
        const fakeCredential = {
            getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }),
        };
        _setPgAadCredentialForTests(fakeCredential);

        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://uami-name@h:5432/db?sslmode=require",
            useManagedIdentity: true,
        });
        expect(cfg.user).toBe("uami-name");
    });

    it("MI: throws when no user is available", () => {
        _setPgAadCredentialForTests({
            getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }),
        });
        expect(() =>
            buildPgPoolConfig({
                connectionString: "postgresql://h:5432/db",
                useManagedIdentity: true,
            }),
        ).toThrow(/managed-identity mode requires a Postgres user/);
    });

    it("MI: callback throws when credential returns no token", async () => {
        _setPgAadCredentialForTests({
            getToken: async () => null,
        });
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u@h:5432/db?sslmode=require",
            useManagedIdentity: true,
        });
        await expect(cfg.password()).rejects.toThrow(/Failed to acquire AAD token/);
    });
});

describe("buildSessionCatalogPgClientConfig", () => {
    it("plain URL: the CMS pool's connection string, and no pool fields", async () => {
        const options = { store: "postgresql://u:p@runtime.example.test:5432/runtime" };
        const cms = await cmsPoolConfig(options);
        const listen = buildSessionCatalogPgClientConfig(options, {});
        expect(listen).toEqual({ connectionString: "postgresql://u:p@runtime.example.test:5432/runtime" });
        expect(listen).toEqual(connectionPart(cms));
    });

    it("cmsFactsDatabaseUrl wins over the store URL, with the CMS sslmode fix", async () => {
        const options = {
            store: "postgresql://u:p@runtime.example.test:5432/runtime?sslmode=require",
            cmsFactsDatabaseUrl: "postgresql://u:p@cms.example.test:5432/cms?sslmode=require",
        };
        const cms = await cmsPoolConfig(options);
        const listen = buildSessionCatalogPgClientConfig(options, {});
        expect(listen.connectionString).toBe("postgresql://u:p@cms.example.test:5432/cms");
        expect(listen.ssl).toEqual({ rejectUnauthorized: false });
        expect(listen.max).toBeUndefined();
        expect(listen).toEqual(connectionPart(cms));
    });

    it("PILOTSWARM_SESSION_CATALOG_URL picks the database exactly as for the CMS", async () => {
        const env = { PILOTSWARM_SESSION_CATALOG_URL: "postgresql://u:p@catalog.example.test:5432/catalog" };
        const options = { store: "postgresql://u:p@runtime.example.test:5432/runtime" };
        const cms = await cmsPoolConfig(options, env);
        const listen = buildSessionCatalogPgClientConfig(options, env);
        expect(listen.connectionString).toBe("postgresql://u:p@catalog.example.test:5432/catalog");
        expect(listen).toEqual(connectionPart(cms));
    });

    it("managed identity: the CMS pool's fields and the same token callback", async () => {
        let tokens = 0;
        _setPgAadCredentialForTests({
            getToken: async () => ({ token: `token-${++tokens}`, expiresOnTimestamp: Date.now() + 3600_000 }),
        });
        const options = {
            store: "postgresql://admin:pw@runtime.example.test:5432/runtime?sslmode=require",
            cmsFactsDatabaseUrl: "postgresql://cms.example.test:5432/cms?sslmode=require",
            useManagedIdentity: true,
            aadDbUser: "portal-uami",
        };
        const cms = await cmsPoolConfig(options);
        const listen = buildSessionCatalogPgClientConfig(options, {});
        expect(connectionPart(listen)).toEqual(connectionPart(cms));
        expect(listen).toMatchObject({
            host: "cms.example.test",
            port: 5432,
            database: "cms",
            user: "portal-uami",
            ssl: { rejectUnauthorized: false },
        });
        expect(listen.connectionString).toBeUndefined();
        expect(listen.max).toBeUndefined();
        expect(typeof listen.password).toBe("function");
        // Each call asks the credential again, as on each new pg connection.
        expect(await listen.password()).toBe("token-1");
        expect(await listen.password()).toBe("token-2");
        expect(await cms.password()).toBe("token-3");
    });

    it("throws for a URL that is not Postgres, without echoing the URL", () => {
        let error;
        try {
            buildSessionCatalogPgClientConfig({ store: "mysql://u:hunter2@db.example.test/db" }, {});
        } catch (caught) {
            error = caught;
        }
        expect(error?.message).toMatch(/not a PostgreSQL URL/);
        expect(error.message).not.toMatch(/hunter2|db\.example\.test/);
    });
});

describe("readManagedIdentityFlag", () => {
    const cases = [
        ["1", true],
        ["true", true],
        ["TRUE", true],
        ["yes", true],
        ["on", true],
        ["", false],
        [undefined, false],
        ["0", false],
        ["false", false],
        ["no", false],
    ];
    for (const [input, expected] of cases) {
        it(`flag=${JSON.stringify(input)} -> ${expected}`, () => {
            expect(readManagedIdentityFlag({ PILOTSWARM_USE_MANAGED_IDENTITY: input })).toBe(expected);
        });
    }
});
