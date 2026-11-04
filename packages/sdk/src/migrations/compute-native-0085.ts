/** Candidate numbering on the pinned compute branch; reconcile before integrating current main. */
export function computeNativeMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.compute_execution_admissions (
    session_id TEXT PRIMARY KEY, identity JSONB NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('active','sealed','committed','unknown','released')),
    binding JSONB, reconcile_requested BOOLEAN NOT NULL DEFAULT FALSE, detail TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.compute_execution_operations (
    session_id TEXT NOT NULL REFERENCES ${s}.compute_execution_admissions(session_id),
    generation TEXT NOT NULL, operation_id TEXT NOT NULL,
    settled BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (session_id, generation, operation_id)
);
CREATE TABLE IF NOT EXISTS ${s}.compute_turn_completions (
    session_id TEXT NOT NULL, turn_key TEXT NOT NULL, transcript_epoch INTEGER NOT NULL,
    turn_index INTEGER NOT NULL, receipt JSONB NOT NULL,
    PRIMARY KEY (session_id, turn_key)
);
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_acquire(p_identity JSONB) RETURNS VOID AS $$
DECLARE prior ${s}.compute_execution_admissions%ROWTYPE;
BEGIN
    IF NOT (p_identity ?& ARRAY['sessionId','transcriptEpoch','turnKey','attemptId','workerNodeId','generation'])
       OR COALESCE(p_identity->>'sessionId','') = '' THEN RAISE EXCEPTION 'Invalid compute execution identity'; END IF;
    INSERT INTO ${s}.compute_execution_admissions(session_id,identity,phase)
      VALUES(p_identity->>'sessionId',p_identity,'active') ON CONFLICT DO NOTHING;
    SELECT * INTO prior FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' FOR UPDATE;
    IF prior.identity=p_identity THEN RETURN; END IF;
    IF prior.phase <> 'released' OR EXISTS (
        SELECT 1 FROM ${s}.compute_execution_operations WHERE session_id=prior.session_id AND NOT settled
    ) THEN RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: prior execution requires reconciliation'; END IF;
    UPDATE ${s}.compute_execution_admissions SET identity=p_identity,phase='active',detail=NULL,reconcile_requested=FALSE,updated_at=now() WHERE session_id=prior.session_id;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_begin(p_identity JSONB,p_op TEXT) RETURNS VOID AS $$
DECLARE prior ${s}.compute_execution_admissions%ROWTYPE;
BEGIN
    SELECT * INTO prior FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' FOR UPDATE;
    IF prior.identity IS DISTINCT FROM p_identity OR prior.phase NOT IN ('active','sealed') THEN
        RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: stale compute operation'; END IF;
    INSERT INTO ${s}.compute_execution_operations VALUES(prior.session_id,p_identity->>'generation',p_op,FALSE)
        ON CONFLICT(session_id,generation,operation_id) DO UPDATE SET settled=FALSE
            WHERE ${s}.compute_execution_operations.settled;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate in-flight compute operation'; END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_end(p_identity JSONB,p_op TEXT,p_success BOOLEAN) RETURNS VOID AS $$
BEGIN
    PERFORM 1 FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' AND identity=p_identity AND phase<>'released' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: stale operation completion'; END IF;
    IF p_success THEN
        UPDATE ${s}.compute_execution_operations SET settled=TRUE WHERE session_id=p_identity->>'sessionId'
            AND generation=p_identity->>'generation' AND operation_id=p_op;
        IF NOT FOUND THEN RAISE EXCEPTION 'Unknown compute operation'; END IF;
    ELSE
        UPDATE ${s}.compute_execution_admissions SET phase='unknown',updated_at=now() WHERE session_id=p_identity->>'sessionId';
    END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_phase(p_identity JSONB,p_phase TEXT) RETURNS VOID AS $$
DECLARE prior ${s}.compute_execution_admissions%ROWTYPE;
BEGIN
    SELECT * INTO prior FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' FOR UPDATE;
    IF prior.identity IS DISTINCT FROM p_identity THEN RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: stale phase transition'; END IF;
    IF prior.phase='released' THEN
        IF p_phase='released' THEN RETURN; END IF;
        RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: released execution cannot reopen'; END IF;
    IF p_phase NOT IN ('sealed','committed','unknown','released') THEN RAISE EXCEPTION 'Invalid compute phase'; END IF;
    IF p_phase <> 'unknown' AND (prior.phase='unknown' OR EXISTS (
        SELECT 1 FROM ${s}.compute_execution_operations WHERE session_id=prior.session_id AND NOT settled
    )) THEN RAISE EXCEPTION 'COMPUTE_EXECUTION_UNCERTAIN: admitted work has not settled'; END IF;
    IF p_phase='released' AND prior.phase <> 'committed' THEN RAISE EXCEPTION 'Compute release requires committed completion'; END IF;
    UPDATE ${s}.compute_execution_admissions SET phase=p_phase,updated_at=now() WHERE session_id=prior.session_id;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_inspect(p_session TEXT) RETURNS JSONB AS $$
    SELECT jsonb_build_object('identity',a.identity,'phase',a.phase,'binding',a.binding,'detail',a.detail,'pendingOperations',
        (SELECT count(*) FROM ${s}.compute_execution_operations o WHERE o.session_id=a.session_id AND NOT o.settled))
    FROM ${s}.compute_execution_admissions a WHERE a.session_id=p_session;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_failure(p_identity JSONB,p_detail TEXT) RETURNS VOID AS $$
DECLARE previous TEXT;
BEGIN
    SELECT detail INTO previous FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' AND identity=p_identity AND phase<>'released' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stale compute failure observation'; END IF;
    UPDATE ${s}.compute_execution_admissions SET phase='unknown',detail=left(p_detail,4000),updated_at=now() WHERE session_id=p_identity->>'sessionId';
    IF previous IS DISTINCT FROM left(p_detail,4000) THEN
        INSERT INTO ${s}.session_events(session_id,event_type,data,worker_node_id)
        VALUES(p_identity->>'sessionId','session.error',jsonb_build_object('errorType','compute_execution_unknown',
            'message',left(p_detail,4000),'turnKey',p_identity->>'turnKey','attemptId',p_identity->>'attemptId',
            'generation',p_identity->>'generation'),p_identity->>'workerNodeId');
    END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_binding(p_identity JSONB,p_binding JSONB) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.compute_execution_admissions SET binding=p_binding WHERE session_id=p_identity->>'sessionId' AND identity=p_identity AND phase='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'Stale compute binding'; END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_request_reconcile(p_session TEXT) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.compute_execution_admissions SET reconcile_requested=TRUE WHERE session_id=p_session AND phase='unknown';
    IF NOT FOUND THEN RAISE EXCEPTION 'Compute reconciliation requires an unknown execution'; END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_reconcile_requests() RETURNS TABLE(status JSONB) AS $$
    SELECT ${s}.cms_compute_execution_inspect(a.session_id) FROM ${s}.compute_execution_admissions a
    WHERE a.reconcile_requested AND a.phase='unknown' ORDER BY a.updated_at LIMIT 100;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_reconciled(p_identity JSONB) RETURNS BOOLEAN AS $$
BEGIN
    PERFORM 1 FROM ${s}.compute_execution_admissions WHERE session_id=p_identity->>'sessionId' AND identity=p_identity AND phase='unknown' FOR UPDATE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM ${s}.compute_execution_operations WHERE session_id=p_identity->>'sessionId' AND NOT settled) THEN RETURN FALSE; END IF;
    UPDATE ${s}.compute_execution_admissions SET phase='released',reconcile_requested=FALSE,updated_at=now() WHERE session_id=p_identity->>'sessionId';
    RETURN TRUE;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_charge_identity(p_session TEXT,p_turn INTEGER) RETURNS JSONB AS $$
    SELECT jsonb_build_object('ownerUserId',o.user_id,'isSystem',s.is_system,
        'ledgerTurnIndex',COALESCE(s.provider_ledger_base,0)+p_turn)
    FROM ${s}.sessions s LEFT JOIN ${s}.session_owners o ON o.session_id=s.session_id WHERE s.session_id=p_session;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_stopped_outcome(p_session TEXT,p_key TEXT,p_epoch INTEGER) RETURNS JSONB AS $$
    SELECT COALESCE(receipt->'turn'->'stoppedOutcome',jsonb_build_object('type','invalid'))
    FROM ${s}.compute_turn_completions WHERE session_id=p_session AND turn_key=p_key AND transcript_epoch=p_epoch
        AND receipt->'turn'->>'resultType'='stopped';
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION ${s}.cms_compute_execution_recover_completion(p_session TEXT,p_key TEXT,p_epoch INTEGER,p_identity JSONB)
RETURNS VOID AS $$
BEGIN
    IF p_identity->>'sessionId' IS DISTINCT FROM p_session OR p_identity->>'turnKey' IS DISTINCT FROM p_key
        OR (p_identity->>'transcriptEpoch')::INTEGER IS DISTINCT FROM p_epoch OR COALESCE(p_identity->>'generation','')='' THEN
        RAISE EXCEPTION 'Invalid recovered native operation identity'; END IF;
    UPDATE ${s}.compute_execution_operations SET settled=TRUE WHERE session_id=p_session AND generation=p_identity->>'generation'
        AND operation_id IN ('publication:'||p_key,'completion:'||p_key);
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_complete_execution_turn_writeback(p_session TEXT,p_key TEXT,p_epoch INTEGER,p_turn JSONB,p_charge JSONB,
    p_execution JSONB,p_operation JSONB)
RETURNS BOOLEAN AS $$
DECLARE previous ${s}.compute_turn_completions%ROWTYPE; controls BOOLEAN; base INTEGER;
BEGIN
    PERFORM 1 FROM ${s}.sessions WHERE session_id=p_session FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native completion session is missing'; END IF;
    SELECT * INTO previous FROM ${s}.compute_turn_completions WHERE session_id=p_session AND turn_key=p_key;
    IF FOUND THEN
        IF previous.transcript_epoch<>p_epoch OR previous.turn_index<>(p_turn->>'turnIndex')::INTEGER THEN
            RAISE EXCEPTION 'Native completion key belongs to a different turn'; END IF;
        PERFORM ${s}.cms_compute_execution_recover_completion(p_session,p_key,p_epoch,previous.receipt->'execution');
        PERFORM ${s}.cms_compute_execution_recover_completion(p_session,p_key,p_epoch,p_operation);
        RETURN EXISTS(SELECT 1 FROM ${s}.cms_turn_open_controls(p_session,(p_turn->>'turnIndex')::INTEGER));
    END IF;
    IF p_turn->>'sessionId' IS DISTINCT FROM p_session OR p_key='' OR p_epoch<0 THEN RAISE EXCEPTION 'Invalid native completion identity'; END IF;
    INSERT INTO ${s}.compute_turn_completions VALUES(p_session,p_key,p_epoch,(p_turn->>'turnIndex')::INTEGER,
        jsonb_build_object('turn',p_turn,'providerCharge',p_charge,'execution',p_execution));
    controls := ${s}.cms_complete_turn_writeback(p_session,p_turn->>'agentId',p_turn->>'model',p_turn->>'reasoningEffort',
        (p_turn->>'turnIndex')::INTEGER,(p_turn->>'startedAt')::TIMESTAMPTZ,(p_turn->>'endedAt')::TIMESTAMPTZ,
        (p_turn->>'durationMs')::INTEGER,(p_turn->>'tokensInput')::BIGINT,(p_turn->>'tokensOutput')::BIGINT,
        (p_turn->>'tokensCacheRead')::BIGINT,(p_turn->>'tokensCacheWrite')::BIGINT,
        (p_turn->>'toolCalls')::INTEGER,(p_turn->>'toolErrors')::INTEGER,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_turn->'toolNames','[]'::jsonb))),
        p_turn->>'resultType',p_turn->>'errorMessage',p_turn->>'workerNodeId',p_turn->>'state',
        (p_turn->>'lastActiveAt')::TIMESTAMPTZ,p_turn->>'lastError',p_turn->>'waitReason',(p_turn->>'currentIteration')::INTEGER);
    IF p_charge IS NOT NULL AND p_charge <> 'null'::jsonb THEN
        IF p_charge->>'sessionId' IS DISTINCT FROM p_session OR p_charge->>'turnIndex' IS DISTINCT FROM p_turn->>'turnIndex'
            OR (p_charge->>'ledgerTurnIndex')::INTEGER < 0 THEN RAISE EXCEPTION 'Invalid native charge identity'; END IF;
        SELECT COALESCE(provider_ledger_base,0) INTO base FROM ${s}.sessions WHERE session_id=p_session;
        PERFORM ${s}.cms_provider_settle_turn(p_session,(p_charge->>'ledgerTurnIndex')::INTEGER-base,
            p_charge->>'providerName',p_charge->>'modelQualified',(p_charge->>'ownerUserId')::BIGINT,
            p_charge->>'chargeClass',p_charge->>'agentId',(p_charge->>'tokensInput')::BIGINT,(p_charge->>'tokensOutput')::BIGINT,
            (p_charge->>'tokensCacheRead')::BIGINT,(p_charge->>'tokensCacheWrite')::BIGINT);
    END IF;
    PERFORM ${s}.cms_compute_execution_recover_completion(p_session,p_key,p_epoch,p_execution);
    PERFORM ${s}.cms_compute_execution_recover_completion(p_session,p_key,p_epoch,p_operation);
    RETURN controls;
END; $$ LANGUAGE plpgsql;
`;
}
