/**
 * Migration 0101: the provider call's own latency on provider_inference_operations.
 *
 * latency_ms is the worker's monotonic time around the provider call (request, response and answer parsing), not the
 * claim-to-settle window, which also holds the ledger writes. NULL when unknown (rows settled before 0101, or a worker
 * that stopped mid-call). The 6-argument settlement stays callable, unchanged, for a worker that predates 0101.
 */
export function providerInferenceLatencyMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.provider_inference_operations
    ADD COLUMN IF NOT EXISTS latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0);

-- Settlement with latency: the 6-argument settlement, then the latency on the row it settled.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_inference_operation(
    p_operation_id TEXT, p_attempt INTEGER,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT, p_latency_ms INTEGER
) RETURNS BOOLEAN AS $$
DECLARE v_first BOOLEAN;
BEGIN
    v_first := ${s}.cms_provider_settle_inference_operation(
        p_operation_id, p_attempt, p_in, p_out, p_cache_read, p_cache_write);
    IF v_first AND p_latency_ms IS NOT NULL AND p_latency_ms >= 0 THEN
        UPDATE ${s}.provider_inference_operations
           SET latency_ms = p_latency_ms
         WHERE operation_id = p_operation_id AND attempt = p_attempt;
    END IF;
    RETURN v_first;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
