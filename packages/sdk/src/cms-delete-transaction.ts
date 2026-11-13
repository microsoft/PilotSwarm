import type { Pool, PoolClient, QueryResult } from "pg";

type Query = (text: string, values?: unknown[]) => Promise<QueryResult>;

/** Abort closes the connection; a late pool acquisition must never issue a query. */
export async function deleteTransaction<T>(
    pool: Pool,
    signal: AbortSignal,
    work: (query: Query) => Promise<T>,
    deadlineAtMs = Date.now() + 3_000,
): Promise<T> {
    signal.throwIfAborted();
    let client: PoolClient | undefined;
    let released = false, finished = false;
    const release = (error?: Error) => {
        if (!client || released) return;
        released = true;
        client.release(error);
    };
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
        abort = () => {
            const error = signal.reason instanceof Error ? signal.reason : new Error("Session deletion database operation aborted");
            release(error);
            reject(error);
        };
        signal.addEventListener("abort", abort, { once: true });
    });
    const query: Query = (text, values) => {
        signal.throwIfAborted();
        if (!client) throw new Error("Session deletion connection was not acquired");
        const remaining = Math.max(1, Math.min(3_000, Math.floor(deadlineAtMs - Date.now())));
        const config = { text, values, query_timeout: remaining };
        return client.query(config);
    };
    const pending = (async () => {
        const connection = await pool.connect();
        if (finished || signal.aborted) {
            connection.release();
            signal.throwIfAborted();
            throw new Error("Session deletion connection arrived after completion");
        }
        client = connection;
        await query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const remaining = Math.max(1, Math.min(3_000, Math.floor(deadlineAtMs - Date.now())));
        await query(`SET LOCAL statement_timeout = ${remaining}; SET LOCAL lock_timeout = ${remaining}`);
        const result = await work(query);
        await query("COMMIT");
        return result;
    })();
    try { return await Promise.race([pending, aborted]); }
    catch (error) {
        // Destroy rather than return a connection with a failed or unknown transaction.
        release(error instanceof Error ? error : new Error(String(error)));
        throw error;
    } finally {
        finished = true;
        signal.removeEventListener("abort", abort);
        release();
    }
}
