/**
 * CI run 114: the suite's fixed waits and limits were set on local PostgreSQL. On HorizonDB the same work takes about ten
 * times as long (workflow-v2-join-robust: 329 s on local PostgreSQL, 2,909 s on HorizonDB), so a test's own time limit, a
 * poll's timeout or a bound on how long something took must grow with the database the suite runs on. A test multiplies
 * those numbers by the scale here; what it proves does not change.
 *
 * The scale is PS_TEST_TIME_SCALE when that is a positive number, else 10 on HorizonDB and 1 otherwise.
 */

/** The default scale per runtime storage provider. */
export const PROVIDER_TIME_SCALES = Object.freeze({ postgres: 1, horizondb: 10 });

/** The scale for a runtime storage provider ("postgres", "horizondb") and an environment. */
export function timeScaleFor(provider, env = process.env) {
    const override = Number(env?.PS_TEST_TIME_SCALE);
    if (env?.PS_TEST_TIME_SCALE !== undefined && env.PS_TEST_TIME_SCALE !== "" && Number.isFinite(override) && override > 0) return override;
    return PROVIDER_TIME_SCALES[provider] ?? 1;
}

/** A scaler for `scale`: milliseconds and seconds, rounded up to whole units. */
export function timeScaler(scale) {
    return {
        scale,
        ms: value => Math.ceil(value * scale),
        seconds: value => Math.ceil(value * scale),
    };
}

/** The runtime storage provider an environment selects, as storage-config.ts resolves it: PILOTSWARM_RUNTIME_PROVIDER, else HorizonDB when HORIZON_DATABASE_URL is set. */
export function runtimeProviderFromEnv(env = process.env) {
    const raw = String(env?.PILOTSWARM_RUNTIME_PROVIDER ?? "").trim();
    if (raw) return raw === "pg" ? "postgres" : raw === "horizon" ? "horizondb" : raw;
    return String(env?.HORIZON_DATABASE_URL ?? "").trim() ? "horizondb" : "postgres";
}

/** The most the vitest safety nets (test and hook limits) grow by: tests that need more set their own scaled limits. */
export const VITEST_TIMEOUT_MAX_SCALE = 3;

/** Vitest's test and hook time limits: the given limits unchanged on every provider but HorizonDB, where they grow by the time scale, at most threefold. */
export function vitestTimeouts(provider, env = process.env, base = { testTimeout: 300_000, hookTimeout: 120_000 }) {
    if (provider !== "horizondb") return { ...base };
    const scaled = timeScaler(Math.min(timeScaleFor(provider, env), VITEST_TIMEOUT_MAX_SCALE));
    return { testTimeout: scaled.ms(base.testTimeout), hookTimeout: scaled.ms(base.hookTimeout) };
}
