import type { Pool, PoolClient } from "pg";

/** Row transport only; all CMS table access lives in stored procedures. */
export async function packageRuntimeQuery(
    connection: Pick<Pool, "query"> | Pick<PoolClient, "query">, schema: string, operation: string, values: unknown[] = [], queryTimeout?: number,
): Promise<{ rows: any[]; rowCount: number }> {
    if (!/^[a-z_]+$/.test(operation)) throw new Error("Invalid package procedure name");
    const result = await connection.query({
        text: `SELECT value FROM ${schema}.cms_pkg_${operation}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS value`,
        values, ...(queryTimeout === undefined ? {} : { query_timeout: queryTimeout }),
    });
    return { rows: result.rows.map(row => row.value), rowCount: result.rowCount ?? 0 };
}
