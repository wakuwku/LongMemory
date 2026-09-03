/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                    /____/                                 /_____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/stores/sqlite/history_backfill_migration.ts
 *  usage : implements the LongMemory history backfill migration component
 */

/*
 * Durable queue for extracting governed central-memory candidates from
 * authorized historical chat snapshots.  Snapshot, chunk, candidate and
 * receipt payloads are append-only; only leases and lifecycle columns move.
 */

export const history_backfill_migration_sql = `
CREATE TABLE cm_history_backfill_runs (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_harness TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    source_revision TEXT NOT NULL CHECK (length(source_revision) = 64),
    source_observed_at INTEGER NOT NULL,
    inventory_id TEXT NOT NULL,
    reconciliation_digest TEXT NOT NULL CHECK (length(reconciliation_digest) = 64),
    plan_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    target_db_path TEXT NOT NULL,
    authorization_json TEXT NOT NULL
        CHECK (json_valid(authorization_json) AND json_type(authorization_json) = 'object'),
    authorization_hash TEXT NOT NULL CHECK (length(authorization_hash) = 64),
    session_snapshot_json TEXT NOT NULL
        CHECK (json_valid(session_snapshot_json) AND json_type(session_snapshot_json) = 'object'),
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
    chunk_size_chars INTEGER NOT NULL CHECK (chunk_size_chars BETWEEN 256 AND 64000),
    chunk_size_tokens INTEGER NOT NULL CHECK (chunk_size_tokens BETWEEN 256 AND 32000),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
    total_chars INTEGER NOT NULL CHECK (total_chars >= 0),
    completed_chunks INTEGER NOT NULL DEFAULT 0
        CHECK (completed_chunks BETWEEN 0 AND chunk_count),
    status TEXT NOT NULL
        CHECK (status IN (
            'pending', 'extracting', 'ready_for_consolidation',
            'consolidating', 'failed', 'candidates_ready', 'superseded'
        )),
    consolidation_lease_id TEXT,
    consolidation_reduction_id TEXT,
    consolidation_worker_id TEXT,
    consolidation_worker_session_id TEXT,
    consolidation_worker_turn_id TEXT,
    consolidation_capability_epoch_hash TEXT,
    consolidation_leased_at INTEGER,
    consolidation_lease_expires_at INTEGER,
    consolidation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (consolidation_attempts >= 0),
    consolidation_retry_at INTEGER,
    consolidation_result_hash TEXT,
    consolidation_receipt_id TEXT,
    consolidated_candidate_count INTEGER NOT NULL DEFAULT 0
        CHECK (consolidated_candidate_count >= 0),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    candidates_ready_at INTEGER,
    superseded_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, run_id),
    UNIQUE (
        tenant_id, user_id, project_id, source_harness,
        source_session_id, source_revision
    ),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE RESTRICT,
    CHECK (
        (status = 'consolidating'
            AND consolidation_lease_id IS NOT NULL
            AND consolidation_reduction_id IS NOT NULL
            AND consolidation_worker_id IS NOT NULL
            AND consolidation_worker_session_id IS NOT NULL
            AND consolidation_worker_turn_id IS NOT NULL
            AND consolidation_capability_epoch_hash IS NOT NULL
            AND length(consolidation_capability_epoch_hash) = 64
            AND consolidation_leased_at IS NOT NULL
            AND consolidation_lease_expires_at IS NOT NULL)
        OR
        (status <> 'consolidating'
            AND consolidation_lease_id IS NULL
            AND consolidation_reduction_id IS NULL
            AND consolidation_worker_id IS NULL
            AND consolidation_worker_session_id IS NULL
            AND consolidation_worker_turn_id IS NULL
            AND consolidation_capability_epoch_hash IS NULL
            AND consolidation_leased_at IS NULL
            AND consolidation_lease_expires_at IS NULL)
    ),
    CHECK (
        (status = 'candidates_ready'
            AND consolidation_result_hash IS NOT NULL
            AND consolidation_receipt_id IS NOT NULL
            AND candidates_ready_at IS NOT NULL)
        OR status <> 'candidates_ready'
    ),
    CHECK ((status = 'superseded' AND superseded_at IS NOT NULL) OR status <> 'superseded')
);

CREATE INDEX cm_history_backfill_runs_project_status
    ON cm_history_backfill_runs (
        tenant_id, user_id, project_id, status, created_at, run_id
    );

CREATE INDEX cm_history_backfill_runs_source
    ON cm_history_backfill_runs (
        tenant_id, user_id, project_id, source_harness,
        source_session_id, source_observed_at, created_at
    );

CREATE TRIGGER cm_history_backfill_runs_snapshot_immutable
BEFORE UPDATE ON cm_history_backfill_runs
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.source_harness IS NOT NEW.source_harness
  OR OLD.source_session_id IS NOT NEW.source_session_id
  OR OLD.source_revision IS NOT NEW.source_revision
  OR OLD.source_observed_at IS NOT NEW.source_observed_at
  OR OLD.inventory_id IS NOT NEW.inventory_id
  OR OLD.reconciliation_digest IS NOT NEW.reconciliation_digest
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.manifest_hash IS NOT NEW.manifest_hash
  OR OLD.target_db_path IS NOT NEW.target_db_path
  OR OLD.authorization_json IS NOT NEW.authorization_json
  OR OLD.authorization_hash IS NOT NEW.authorization_hash
  OR OLD.session_snapshot_json IS NOT NEW.session_snapshot_json
  OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
  OR OLD.chunk_size_chars IS NOT NEW.chunk_size_chars
  OR OLD.chunk_size_tokens IS NOT NEW.chunk_size_tokens
  OR OLD.chunk_count IS NOT NEW.chunk_count
  OR OLD.total_chars IS NOT NEW.total_chars
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'history backfill authorization and snapshot are immutable');
END;

CREATE TRIGGER cm_history_backfill_runs_no_delete
BEFORE DELETE ON cm_history_backfill_runs
BEGIN
    SELECT RAISE(ABORT, 'history backfill runs cannot be deleted');
END;

CREATE TRIGGER cm_history_backfill_runs_valid_transition
BEFORE UPDATE OF status ON cm_history_backfill_runs
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'pending' AND NEW.status IN ('extracting', 'ready_for_consolidation', 'superseded'))
    OR (OLD.status = 'extracting' AND NEW.status IN ('ready_for_consolidation', 'superseded'))
    OR (OLD.status = 'ready_for_consolidation' AND NEW.status IN ('consolidating', 'superseded'))
    OR (OLD.status = 'consolidating' AND NEW.status IN ('ready_for_consolidation', 'failed', 'candidates_ready', 'superseded'))
    OR (OLD.status = 'failed' AND NEW.status IN ('ready_for_consolidation', 'consolidating', 'superseded'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid history backfill run transition');
END;

CREATE TRIGGER cm_history_backfill_runs_terminal_receipt_immutable
BEFORE UPDATE ON cm_history_backfill_runs
WHEN OLD.consolidation_result_hash IS NOT NULL
 AND (
    OLD.consolidation_result_hash IS NOT NEW.consolidation_result_hash
    OR OLD.consolidation_receipt_id IS NOT NEW.consolidation_receipt_id
    OR OLD.consolidated_candidate_count IS NOT NEW.consolidated_candidate_count
    OR OLD.candidates_ready_at IS NOT NEW.candidates_ready_at
 )
BEGIN
    SELECT RAISE(ABORT, 'history backfill terminal receipt is immutable');
END;

CREATE TABLE cm_history_backfill_chunks (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_hash TEXT NOT NULL CHECK (length(chunk_hash) = 64),
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    character_count INTEGER NOT NULL CHECK (character_count >= 0),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    part_count INTEGER NOT NULL CHECK (part_count > 0),
    first_turn_index INTEGER NOT NULL CHECK (first_turn_index >= 0),
    last_turn_index INTEGER NOT NULL CHECK (last_turn_index >= first_turn_index),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
    lease_id TEXT,
    lease_worker_id TEXT,
    lease_worker_session_id TEXT,
    lease_worker_turn_id TEXT,
    lease_capability_epoch_hash TEXT,
    leased_at INTEGER,
    lease_expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at INTEGER NOT NULL,
    result_hash TEXT,
    receipt_id TEXT,
    finding_count INTEGER NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, run_id, chunk_index),
    UNIQUE (tenant_id, user_id, lease_id),
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    CHECK (
        (status = 'leased'
            AND lease_id IS NOT NULL
            AND lease_worker_id IS NOT NULL
            AND lease_worker_session_id IS NOT NULL
            AND lease_worker_turn_id IS NOT NULL
            AND lease_capability_epoch_hash IS NOT NULL
            AND length(lease_capability_epoch_hash) = 64
            AND leased_at IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'leased'
            AND lease_id IS NULL
            AND lease_worker_id IS NULL
            AND lease_worker_session_id IS NULL
            AND lease_worker_turn_id IS NULL
            AND lease_capability_epoch_hash IS NULL
            AND leased_at IS NULL
            AND lease_expires_at IS NULL)
    ),
    CHECK (
        (status = 'completed'
            AND result_hash IS NOT NULL
            AND receipt_id IS NOT NULL
            AND completed_at IS NOT NULL)
        OR status <> 'completed'
    )
);

CREATE INDEX cm_history_backfill_chunks_claim
    ON cm_history_backfill_chunks (
        tenant_id, user_id, status, available_at, lease_expires_at, run_id, chunk_index
    );

CREATE TRIGGER cm_history_backfill_chunks_payload_immutable
BEFORE UPDATE ON cm_history_backfill_chunks
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.chunk_index IS NOT NEW.chunk_index
  OR OLD.chunk_hash IS NOT NEW.chunk_hash
  OR OLD.payload_json IS NOT NEW.payload_json
  OR OLD.character_count IS NOT NEW.character_count
  OR OLD.token_count IS NOT NEW.token_count
  OR OLD.part_count IS NOT NEW.part_count
  OR OLD.first_turn_index IS NOT NEW.first_turn_index
  OR OLD.last_turn_index IS NOT NEW.last_turn_index
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'history backfill chunk payloads are immutable');
END;

CREATE TRIGGER cm_history_backfill_chunks_no_delete
BEFORE DELETE ON cm_history_backfill_chunks
BEGIN
    SELECT RAISE(ABORT, 'history backfill chunks cannot be deleted');
END;

CREATE TRIGGER cm_history_backfill_chunks_valid_transition
BEFORE UPDATE OF status ON cm_history_backfill_chunks
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'pending' AND NEW.status = 'leased')
    OR (OLD.status = 'failed' AND NEW.status IN ('pending', 'leased'))
    OR (OLD.status = 'leased' AND NEW.status IN ('leased', 'completed', 'failed'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid history backfill chunk transition');
END;

CREATE TRIGGER cm_history_backfill_chunks_terminal_receipt_immutable
BEFORE UPDATE ON cm_history_backfill_chunks
WHEN OLD.status = 'completed'
 AND (
    OLD.result_hash IS NOT NEW.result_hash
    OR OLD.receipt_id IS NOT NEW.receipt_id
    OR OLD.finding_count IS NOT NEW.finding_count
    OR OLD.completed_at IS NOT NEW.completed_at
 )
BEGIN
    SELECT RAISE(ABORT, 'history backfill chunk receipt is immutable');
END;

CREATE TABLE cm_history_backfill_receipts (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('chunk', 'consolidation')),
    operation_key TEXT NOT NULL,
    chunk_index INTEGER,
    reduction_id TEXT,
    lease_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    worker_turn_id TEXT NOT NULL,
    capability_epoch_hash TEXT NOT NULL CHECK (length(capability_epoch_hash) = 64),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, receipt_id),
    UNIQUE (tenant_id, user_id, lease_id),
    UNIQUE (tenant_id, user_id, run_id, operation_kind, operation_key),
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id, chunk_index)
        REFERENCES cm_history_backfill_chunks (tenant_id, user_id, run_id, chunk_index) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, reduction_id)
        REFERENCES cm_history_backfill_reductions (tenant_id, user_id, reduction_id) ON DELETE RESTRICT,
    CHECK (
        (operation_kind = 'chunk' AND chunk_index IS NOT NULL AND reduction_id IS NULL)
        OR (operation_kind = 'consolidation' AND chunk_index IS NULL AND reduction_id IS NOT NULL)
    )
);

CREATE TRIGGER cm_history_backfill_receipts_immutable
BEFORE UPDATE ON cm_history_backfill_receipts
BEGIN
    SELECT RAISE(ABORT, 'history backfill receipts are immutable');
END;

CREATE TRIGGER cm_history_backfill_receipts_no_delete
BEFORE DELETE ON cm_history_backfill_receipts
BEGIN
    SELECT RAISE(ABORT, 'history backfill receipts cannot be deleted');
END;

CREATE TABLE cm_history_backfill_reductions (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reduction_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    round_index INTEGER NOT NULL CHECK (round_index >= 0),
    batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
    is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
    input_candidate_ids_json TEXT NOT NULL
        CHECK (json_valid(input_candidate_ids_json) AND json_type(input_candidate_ids_json) = 'array'),
    allowed_evidence_json TEXT NOT NULL
        CHECK (json_valid(allowed_evidence_json) AND json_type(allowed_evidence_json) = 'array'),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    input_count INTEGER NOT NULL CHECK (input_count BETWEEN 0 AND 64),
    status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
    lease_id TEXT,
    lease_worker_id TEXT,
    lease_worker_session_id TEXT,
    lease_worker_turn_id TEXT,
    lease_capability_epoch_hash TEXT,
    leased_at INTEGER,
    lease_expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at INTEGER NOT NULL,
    result_hash TEXT,
    receipt_id TEXT,
    output_count INTEGER NOT NULL DEFAULT 0 CHECK (output_count >= 0),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, reduction_id),
    UNIQUE (tenant_id, user_id, run_id, round_index, batch_index),
    UNIQUE (tenant_id, user_id, lease_id),
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    CHECK (
        (status='leased' AND lease_id IS NOT NULL AND lease_worker_id IS NOT NULL
            AND lease_worker_session_id IS NOT NULL AND lease_worker_turn_id IS NOT NULL
            AND lease_capability_epoch_hash IS NOT NULL AND length(lease_capability_epoch_hash)=64
            AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status<>'leased' AND lease_id IS NULL AND lease_worker_id IS NULL
            AND lease_worker_session_id IS NULL AND lease_worker_turn_id IS NULL
            AND lease_capability_epoch_hash IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
        (status='completed' AND result_hash IS NOT NULL AND receipt_id IS NOT NULL AND completed_at IS NOT NULL)
        OR status<>'completed'
    )
);

CREATE INDEX cm_history_backfill_reductions_claim
    ON cm_history_backfill_reductions (
        tenant_id, user_id, run_id, status, available_at, lease_expires_at, round_index, batch_index
    );

CREATE TRIGGER cm_history_backfill_reductions_input_immutable
BEFORE UPDATE ON cm_history_backfill_reductions
WHEN OLD.reduction_id IS NOT NEW.reduction_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.round_index IS NOT NEW.round_index
  OR OLD.batch_index IS NOT NEW.batch_index
  OR OLD.is_final IS NOT NEW.is_final
  OR OLD.input_candidate_ids_json IS NOT NEW.input_candidate_ids_json
  OR OLD.allowed_evidence_json IS NOT NEW.allowed_evidence_json
  OR OLD.input_hash IS NOT NEW.input_hash
  OR OLD.input_count IS NOT NEW.input_count
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'history reduction inputs are immutable');
END;

CREATE TRIGGER cm_history_backfill_reductions_valid_transition
BEFORE UPDATE OF status ON cm_history_backfill_reductions
WHEN NOT (
    OLD.status=NEW.status
    OR (OLD.status='pending' AND NEW.status='leased')
    OR (OLD.status='failed' AND NEW.status IN ('pending', 'leased'))
    OR (OLD.status='leased' AND NEW.status IN ('leased', 'completed', 'failed'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid history reduction transition');
END;

CREATE TRIGGER cm_history_backfill_reductions_terminal_immutable
BEFORE UPDATE ON cm_history_backfill_reductions
WHEN OLD.status='completed' AND (
    OLD.result_hash IS NOT NEW.result_hash OR OLD.receipt_id IS NOT NEW.receipt_id
    OR OLD.output_count IS NOT NEW.output_count OR OLD.completed_at IS NOT NEW.completed_at
)
BEGIN
    SELECT RAISE(ABORT, 'history reduction receipt is immutable');
END;

CREATE TRIGGER cm_history_backfill_reductions_no_delete
BEFORE DELETE ON cm_history_backfill_reductions
BEGIN
    SELECT RAISE(ABORT, 'history reductions cannot be deleted');
END;

CREATE TABLE cm_history_backfill_turn_usage (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    worker_turn_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    capability_epoch_hash TEXT NOT NULL CHECK (length(capability_epoch_hash) = 64),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('chunk', 'consolidation')),
    run_id TEXT NOT NULL,
    chunk_index INTEGER,
    reduction_id TEXT,
    lease_id TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
    claimed_at INTEGER NOT NULL,
    consumed_at INTEGER,
    expired_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, worker_session_id, worker_turn_id),
    UNIQUE (tenant_id, user_id, lease_id),
    FOREIGN KEY (tenant_id, user_id, worker_session_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id, chunk_index)
        REFERENCES cm_history_backfill_chunks (tenant_id, user_id, run_id, chunk_index) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, reduction_id)
        REFERENCES cm_history_backfill_reductions (tenant_id, user_id, reduction_id) ON DELETE RESTRICT,
    CHECK (
        (operation_kind = 'chunk' AND chunk_index IS NOT NULL AND reduction_id IS NULL)
        OR (operation_kind = 'consolidation' AND chunk_index IS NULL AND reduction_id IS NOT NULL)
    ),
    CHECK (
        (status = 'active' AND consumed_at IS NULL AND expired_at IS NULL)
        OR (status = 'consumed' AND consumed_at IS NOT NULL AND expired_at IS NULL)
        OR (status = 'expired' AND consumed_at IS NULL AND expired_at IS NOT NULL)
    )
);

CREATE INDEX cm_history_backfill_turn_usage_status
    ON cm_history_backfill_turn_usage (
        tenant_id, user_id, project_id, status, lease_expires_at
    );

CREATE TRIGGER cm_history_backfill_turn_usage_bound_thread
BEFORE INSERT ON cm_history_backfill_turn_usage
WHEN NOT EXISTS (
        SELECT 1 FROM cm_threads AS thread
        WHERE thread.tenant_id=NEW.tenant_id
          AND thread.user_id=NEW.user_id
          AND thread.thread_id=NEW.worker_session_id
          AND thread.project_id=NEW.project_id
          AND thread.status='active'
    )
 OR NOT EXISTS (
        SELECT 1 FROM cm_history_backfill_runs AS run
        WHERE run.tenant_id=NEW.tenant_id AND run.user_id=NEW.user_id
          AND run.run_id=NEW.run_id AND run.project_id=NEW.project_id
    )
 OR (NEW.operation_kind='chunk' AND NOT EXISTS (
        SELECT 1 FROM cm_history_backfill_chunks AS chunk
        WHERE chunk.tenant_id=NEW.tenant_id AND chunk.user_id=NEW.user_id
          AND chunk.run_id=NEW.run_id AND chunk.chunk_index=NEW.chunk_index
    ))
 OR (NEW.operation_kind='consolidation' AND NOT EXISTS (
        SELECT 1 FROM cm_history_backfill_reductions AS reduction
        WHERE reduction.tenant_id=NEW.tenant_id AND reduction.user_id=NEW.user_id
          AND reduction.run_id=NEW.run_id AND reduction.reduction_id=NEW.reduction_id
    ))
BEGIN
    SELECT RAISE(ABORT, 'history turn claim requires an active project-bound thread');
END;

CREATE TRIGGER cm_history_backfill_turn_usage_identity_immutable
BEFORE UPDATE ON cm_history_backfill_turn_usage
WHEN OLD.worker_session_id IS NOT NEW.worker_session_id
  OR OLD.worker_turn_id IS NOT NEW.worker_turn_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.worker_id IS NOT NEW.worker_id
  OR OLD.capability_epoch_hash IS NOT NEW.capability_epoch_hash
  OR OLD.operation_kind IS NOT NEW.operation_kind
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.chunk_index IS NOT NEW.chunk_index
  OR OLD.reduction_id IS NOT NEW.reduction_id
  OR OLD.lease_id IS NOT NEW.lease_id
  OR OLD.lease_expires_at IS NOT NEW.lease_expires_at
  OR OLD.claimed_at IS NOT NEW.claimed_at
BEGIN
    SELECT RAISE(ABORT, 'history backfill turn claim identity is immutable');
END;

CREATE TRIGGER cm_history_backfill_turn_usage_valid_transition
BEFORE UPDATE OF status ON cm_history_backfill_turn_usage
WHEN NOT (OLD.status='active' AND NEW.status IN ('consumed', 'expired'))
BEGIN
    SELECT RAISE(ABORT, 'invalid history backfill turn usage transition');
END;

CREATE TRIGGER cm_history_backfill_turn_usage_no_delete
BEFORE DELETE ON cm_history_backfill_turn_usage
BEGIN
    SELECT RAISE(ABORT, 'history backfill turn usage cannot be deleted');
END;

CREATE TRIGGER cm_history_backfill_receipts_turn_claim_match
BEFORE INSERT ON cm_history_backfill_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_turn_usage AS usage
    WHERE usage.tenant_id=NEW.tenant_id
      AND usage.user_id=NEW.user_id
      AND usage.lease_id=NEW.lease_id
      AND usage.worker_id=NEW.worker_id
      AND usage.worker_session_id=NEW.worker_session_id
      AND usage.worker_turn_id=NEW.worker_turn_id
      AND usage.capability_epoch_hash=NEW.capability_epoch_hash
      AND usage.operation_kind=NEW.operation_kind
      AND usage.run_id=NEW.run_id
      AND usage.chunk_index IS NEW.chunk_index
      AND usage.reduction_id IS NEW.reduction_id
      AND usage.status='active'
)
BEGIN
    SELECT RAISE(ABORT, 'history receipt does not match its active turn claim');
END;

CREATE TABLE cm_history_backfill_candidates (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('chunk', 'consolidated')),
    source_chunk_index INTEGER,
    reduction_id TEXT,
    finding_index INTEGER NOT NULL CHECK (finding_index >= 0),
    finding_kind TEXT NOT NULL CHECK (finding_kind IN (
        'completed_work', 'knowledge', 'problem_solution',
        'decision', 'requirement', 'reproduction'
    )),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 1200),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
    importance REAL NOT NULL CHECK (importance BETWEEN 0.0 AND 1.0),
    is_major INTEGER NOT NULL CHECK (is_major IN (0, 1)),
    evidence_json TEXT NOT NULL
        CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
    finding_json TEXT NOT NULL
        CHECK (json_valid(finding_json) AND json_type(finding_json) = 'object'),
    finding_hash TEXT NOT NULL CHECK (length(finding_hash) = 64),
    receipt_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, candidate_id),
    UNIQUE (tenant_id, user_id, run_id, stage, source_chunk_index, finding_index),
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id, source_chunk_index)
        REFERENCES cm_history_backfill_chunks (tenant_id, user_id, run_id, chunk_index) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, reduction_id)
        REFERENCES cm_history_backfill_reductions (tenant_id, user_id, reduction_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, receipt_id)
        REFERENCES cm_history_backfill_receipts (tenant_id, user_id, receipt_id) ON DELETE RESTRICT,
    CHECK (
        (stage = 'chunk' AND source_chunk_index IS NOT NULL AND reduction_id IS NULL)
        OR (stage = 'consolidated' AND source_chunk_index IS NULL AND reduction_id IS NOT NULL)
    )
);

CREATE INDEX cm_history_backfill_candidates_run_stage
    ON cm_history_backfill_candidates (
        tenant_id, user_id, run_id, stage, source_chunk_index, finding_index
    );

CREATE UNIQUE INDEX cm_history_backfill_candidates_position
    ON cm_history_backfill_candidates (
        tenant_id, user_id, run_id, stage, ifnull(source_chunk_index, -1),
        ifnull(reduction_id, ''), finding_index
    );

CREATE TRIGGER cm_history_backfill_candidates_receipt_scope
BEFORE INSERT ON cm_history_backfill_candidates
WHEN NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_receipts AS receipt
    WHERE receipt.tenant_id=NEW.tenant_id
      AND receipt.user_id=NEW.user_id
      AND receipt.receipt_id=NEW.receipt_id
      AND receipt.run_id=NEW.run_id
      AND (
        (NEW.stage='chunk' AND receipt.operation_kind='chunk'
            AND receipt.chunk_index=NEW.source_chunk_index)
        OR (NEW.stage='consolidated' AND receipt.operation_kind='consolidation'
            AND receipt.chunk_index IS NULL AND receipt.reduction_id=NEW.reduction_id)
      )
)
BEGIN
    SELECT RAISE(ABORT, 'history candidate and receipt scopes must match');
END;

CREATE TRIGGER cm_history_backfill_candidates_immutable
BEFORE UPDATE ON cm_history_backfill_candidates
BEGIN
    SELECT RAISE(ABORT, 'history backfill candidates are immutable');
END;

CREATE TRIGGER cm_history_backfill_candidates_no_delete
BEFORE DELETE ON cm_history_backfill_candidates
BEGIN
    SELECT RAISE(ABORT, 'history backfill candidates cannot be deleted');
END;

CREATE TRIGGER cm_history_backfill_run_ready_requires_chunks
BEFORE UPDATE OF status, completed_chunks ON cm_history_backfill_runs
WHEN NEW.status IN ('ready_for_consolidation', 'consolidating', 'candidates_ready')
 AND (
    NEW.completed_chunks <> NEW.chunk_count
    OR EXISTS (
        SELECT 1 FROM cm_history_backfill_chunks AS chunk
        WHERE chunk.tenant_id=NEW.tenant_id AND chunk.user_id=NEW.user_id
          AND chunk.run_id=NEW.run_id AND chunk.status<>'completed'
    )
 )
BEGIN
    SELECT RAISE(ABORT, 'history run cannot consolidate before every chunk is completed');
END;

CREATE TRIGGER cm_history_backfill_chunk_completion_requires_receipt
BEFORE UPDATE OF status ON cm_history_backfill_chunks
WHEN NEW.status='completed' AND OLD.status<>'completed'
 AND (
 NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_receipts AS receipt
    WHERE receipt.tenant_id=NEW.tenant_id AND receipt.user_id=NEW.user_id
      AND receipt.receipt_id=NEW.receipt_id AND receipt.run_id=NEW.run_id
      AND receipt.operation_kind='chunk' AND receipt.chunk_index=NEW.chunk_index
      AND receipt.reduction_id IS NULL AND receipt.input_hash=NEW.chunk_hash
      AND receipt.result_hash=NEW.result_hash AND receipt.candidate_count=NEW.finding_count
 ) OR (SELECT count(*) FROM cm_history_backfill_candidates AS candidate
        WHERE candidate.tenant_id=NEW.tenant_id AND candidate.user_id=NEW.user_id
          AND candidate.run_id=NEW.run_id AND candidate.stage='chunk'
          AND candidate.source_chunk_index=NEW.chunk_index) <> NEW.finding_count
 )
BEGIN
    SELECT RAISE(ABORT, 'completed history chunk requires its immutable receipt');
END;

CREATE TRIGGER cm_history_backfill_reduction_completion_requires_receipt
BEFORE UPDATE OF status ON cm_history_backfill_reductions
WHEN NEW.status='completed' AND OLD.status<>'completed'
 AND (
 NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_receipts AS receipt
    WHERE receipt.tenant_id=NEW.tenant_id AND receipt.user_id=NEW.user_id
      AND receipt.receipt_id=NEW.receipt_id AND receipt.run_id=NEW.run_id
      AND receipt.operation_kind='consolidation' AND receipt.reduction_id=NEW.reduction_id
      AND receipt.chunk_index IS NULL AND receipt.input_hash=NEW.input_hash
      AND receipt.result_hash=NEW.result_hash AND receipt.candidate_count=NEW.output_count
 ) OR (SELECT count(*) FROM cm_history_backfill_candidates AS candidate
        WHERE candidate.tenant_id=NEW.tenant_id AND candidate.user_id=NEW.user_id
          AND candidate.run_id=NEW.run_id AND candidate.stage='consolidated'
          AND candidate.reduction_id=NEW.reduction_id) <> NEW.output_count
 )
BEGIN
    SELECT RAISE(ABORT, 'completed history reduction requires its immutable receipt');
END;

CREATE TRIGGER cm_history_backfill_candidates_ready_requires_final_reduction
BEFORE UPDATE OF status ON cm_history_backfill_runs
WHEN NEW.status='candidates_ready' AND OLD.status<>'candidates_ready'
 AND NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_reductions AS reduction
    JOIN cm_history_backfill_receipts AS receipt
      ON receipt.tenant_id=reduction.tenant_id AND receipt.user_id=reduction.user_id
     AND receipt.receipt_id=reduction.receipt_id
    WHERE reduction.tenant_id=NEW.tenant_id AND reduction.user_id=NEW.user_id
      AND reduction.run_id=NEW.run_id AND reduction.is_final=1
      AND reduction.status='completed'
      AND reduction.result_hash=NEW.consolidation_result_hash
      AND reduction.receipt_id=NEW.consolidation_receipt_id
      AND reduction.output_count=NEW.consolidated_candidate_count
      AND receipt.operation_kind='consolidation'
      AND receipt.reduction_id=reduction.reduction_id
 )
BEGIN
    SELECT RAISE(ABORT, 'history candidates_ready requires a completed final reduction receipt');
END;
`;
