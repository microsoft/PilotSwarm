/**
 * Connection handling for the local suite on HorizonDB (remote Azure PostgreSQL). On plain PostgreSQL every function here is
 * a no-op or a single plain attempt.
 *
 * A stalled network gave new TCP connects no answer for about seven minutes. A bare pg.Client then waited for the kernel's
 * connect timeout (about 130 s), longer than vitest's hook limit, so cleanup hooks failed as well as the tests. The cleanup
 * clients now connect with a short timeout and one retry, and a probe prints the connection count and the connect latency
 * every 30 s so a stall is visible in the log while it happens.
 *
 * This file imports nothing from vitest or the SDK sources so that node --test can load it.
 */

/** Milliseconds a cleanup client waits for one connect on HorizonDB. */
export const CLEANUP_CONNECT_TIMEOUT_MS = 15_000;
/** Pause before the retry of a failed cleanup connect. */
export const CLEANUP_RETRY_BACKOFF_MS = 2_000;
/** Time between two probes. */
export const PROBE_INTERVAL_MS = 30_000;
/** Milliseconds a probe waits for its connect. */
export const PROBE_CONNECT_TIMEOUT_MS = 10_000;

export const CONNECTION_COUNT_SQL = "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()";

function positiveInt(raw, fallback) {
    const value = Number(raw);
    return raw !== undefined && raw !== "" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** How a cleanup client connects: HorizonDB gets a connect timeout and one retry; every other provider one plain attempt. */
export function cleanupConnectPolicy(provider, env = process.env) {
    if (provider !== "horizondb") return { connectionTimeoutMillis: undefined, attempts: 1, backoffMs: 0 };
    return {
        connectionTimeoutMillis: positiveInt(env?.PS_TEST_CLEANUP_CONNECT_TIMEOUT_MS, CLEANUP_CONNECT_TIMEOUT_MS),
        attempts: 2,
        backoffMs: CLEANUP_RETRY_BACKOFF_MS,
    };
}

function discard(client) {
    // A client whose connect failed is never reused; closing it must not block or throw.
    try { Promise.resolve(client.end()).catch(() => {}); } catch { /* already closed */ }
}

/**
 * Connect a client, retrying per `policy`. `createClient(connectionTimeoutMillis)` returns a new, unconnected client for
 * every attempt. Logs one line per retry. Throws the last error when every attempt failed.
 */
export async function connectWithRetry({ createClient, policy, label = "database", log = line => console.warn(line), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const attempts = Math.max(1, policy?.attempts ?? 1);
    for (let attempt = 1; ; attempt += 1) {
        const client = await createClient(policy?.connectionTimeoutMillis);
        try {
            await client.connect();
            return client;
        } catch (err) {
            discard(client);
            if (attempt >= attempts) throw err;
            log(`  ⚠️  ${label}: connect failed (${err?.message ?? err}); retrying in ${policy.backoffMs} ms (attempt ${attempt + 1} of ${attempts})`);
            await sleep(policy.backoffMs);
        }
    }
}

/**
 * A probe that, every `intervalMs`, opens one new connection, times the connect, counts the database's connections and
 * closes the connection again, writing one line to `write`. Nothing is held between probes; a probe never overlaps the
 * previous one; the timer is unref'd and `stop()` clears it and waits for a probe in flight.
 *
 * `createClient(connectionTimeoutMillis)` returns a new, unconnected client.
 */
export function startConnectionProbe({
    createClient,
    label = "",
    intervalMs = PROBE_INTERVAL_MS,
    connectTimeoutMs = PROBE_CONNECT_TIMEOUT_MS,
    write = line => process.stderr.write(line),
    now = () => performance.now(),
    clock = () => new Date().toISOString(),
    setTimer = setInterval,
    clearTimer = clearInterval,
}) {
    let inFlight = null;
    let stopped = false;
    const prefix = `[hdb-probe${label ? ` ${label}` : ""}]`;

    async function probeOnce() {
        if (stopped || inFlight) return inFlight;
        inFlight = (async () => {
            const started = now();
            let client;
            let connectMs;
            try {
                client = await createClient(connectTimeoutMs);
                await client.connect();
                connectMs = Math.round(now() - started);
                const result = await client.query(CONNECTION_COUNT_SQL);
                write(`${prefix} ${clock()} connections=${Number(result.rows[0].count)} connect_ms=${connectMs}\n`);
            } catch (err) {
                write(`${prefix} ${clock()} probe failed after ${Math.round(now() - started)} ms${connectMs === undefined ? " (connect)" : ""}: ${err?.message ?? err}\n`);
            } finally {
                if (client) { try { await client.end(); } catch { /* the connection is gone either way */ } }
                inFlight = null;
            }
        })();
        return inFlight;
    }

    const timer = setTimer(() => { void probeOnce(); }, intervalMs);
    timer?.unref?.();
    void probeOnce();

    return {
        probeOnce,
        async stop() {
            stopped = true;
            clearTimer(timer);
            if (inFlight) await inFlight;
        },
    };
}

/** Share one started thing between callers: `acquire()` starts it on first use, `release()` stops it when the last caller leaves. */
export function createRefCounted(start) {
    let refs = 0;
    let handle = null;
    return {
        acquire() {
            refs += 1;
            if (refs === 1) handle = start();
        },
        async release() {
            if (refs === 0) return;
            refs -= 1;
            if (refs === 0 && handle) {
                const stopping = handle;
                handle = null;
                await stopping.stop();
            }
        },
        get refs() { return refs; },
    };
}

/** The probe interval for an environment: PS_TEST_DB_PROBE_INTERVAL_MS, 0 to turn the probe off. */
export function probeIntervalFor(provider, env = process.env) {
    if (provider !== "horizondb") return 0;
    const raw = env?.PS_TEST_DB_PROBE_INTERVAL_MS;
    if (raw === "0") return 0;
    return positiveInt(raw, PROBE_INTERVAL_MS);
}
