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
 *  file  : src/stores/sqlite/history_publication_migration.ts
 *  usage : implements the LongMemory history publication migration component
 */

/*
 * Governed bridge from immutable history-backfill candidates to the central
 * memory truth.  Extraction (migration 7) and publication (migration 8) are
 * deliberately separate crash-recovery boundaries.
 */

export const history_publication_migration_sql = `
CREATE TABLE cm_history_publications (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review',
        'pending_confirmation', 'published', 'discarded', 'superseded'
    )),
    current_plan_version INTEGER CHECK (current_plan_version IS NULL OR current_plan_version > 0),
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('created', 'updated', 'noop')),
    result_memory_id TEXT,
    result_version INTEGER CHECK (result_version IS NULL OR result_version > 0),
    result_confirmation_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_id TEXT,
    last_error_code TEXT,
    last_error_detail TEXT,
    available_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    terminal_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, publication_id),
    UNIQUE (tenant_id, user_id, candidate_id),
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, candidate_id)
        REFERENCES cm_history_backfill_candidates (tenant_id, user_id, candidate_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, publication_id, current_plan_version)
        REFERENCES cm_history_publication_plans
            (tenant_id, user_id, publication_id, plan_version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, result_memory_id, result_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, result_confirmation_id)
        REFERENCES cm_confirmations (tenant_id, user_id, confirmation_id) ON DELETE RESTRICT,
    CHECK (
        (status='pending_confirmation' AND result_memory_id IS NOT NULL
            AND result_version IS NOT NULL AND result_confirmation_id IS NOT NULL
            AND terminal_at IS NULL)
        OR status<>'pending_confirmation'
    ),
    CHECK (
        (status='published' AND result_kind IS NOT NULL AND result_memory_id IS NOT NULL
            AND result_version IS NOT NULL AND terminal_at IS NOT NULL)
        OR status<>'published'
    ),
    CHECK (
        (status IN ('discarded', 'superseded') AND terminal_at IS NOT NULL)
        OR status NOT IN ('discarded', 'superseded')
    ),
    CHECK (
        (status IN ('pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review')
            AND terminal_at IS NULL)
        OR status NOT IN ('pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review')
    ),
    CHECK (status='published' OR result_kind IS NULL),
    CHECK (
        (result_memory_id IS NULL AND result_version IS NULL AND result_confirmation_id IS NULL)
        OR (result_memory_id IS NOT NULL AND result_version IS NOT NULL)
    ),
    CHECK (result_confirmation_id IS NULL OR result_memory_id IS NOT NULL),
    CHECK (
        status NOT IN ('pending', 'awaiting_hierarchy')
        OR (result_memory_id IS NULL AND result_version IS NULL AND result_confirmation_id IS NULL)
    ),
    CHECK (
        (attempt_count=0 AND last_attempt_id IS NULL)
        OR (attempt_count>0 AND last_attempt_id IS NOT NULL)
    ),
    CHECK (
        status NOT IN ('pending_confirmation', 'published')
        OR (current_plan_version IS NOT NULL AND last_attempt_id IS NOT NULL AND attempt_count>0)
    )
);

CREATE INDEX cm_history_publications_status
    ON cm_history_publications (
        tenant_id, user_id, status, available_at, created_at, publication_id
    );

CREATE TRIGGER cm_history_publications_initial_state
BEFORE INSERT ON cm_history_publications
WHEN NEW.publication_id <> 'history-publication:' || NEW.candidate_id
  OR NEW.status <> 'pending'
  OR NEW.current_plan_version IS NOT NULL
  OR NEW.result_kind IS NOT NULL
  OR NEW.result_memory_id IS NOT NULL
  OR NEW.result_version IS NOT NULL
  OR NEW.result_confirmation_id IS NOT NULL
  OR NEW.attempt_count <> 0
  OR NEW.last_attempt_id IS NOT NULL
  OR NEW.last_error_code IS NOT NULL
  OR NEW.last_error_detail IS NOT NULL
  OR NEW.terminal_at IS NOT NULL
  OR NEW.available_at <> NEW.created_at
  OR NEW.updated_at <> NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'history publications must enter as a derived pristine pending row');
END;

CREATE TRIGGER cm_history_publications_state_shape
BEFORE UPDATE ON cm_history_publications
WHEN (NEW.status='published' AND (
        NEW.result_kind IS NULL OR NEW.result_memory_id IS NULL
        OR NEW.result_version IS NULL OR NEW.terminal_at IS NULL))
 OR (NEW.status<>'published' AND NEW.result_kind IS NOT NULL)
 OR (NEW.status='pending_confirmation' AND (
        NEW.result_memory_id IS NULL OR NEW.result_version IS NULL
        OR NEW.result_confirmation_id IS NULL OR NEW.terminal_at IS NOT NULL))
 OR (NEW.status IN ('pending', 'awaiting_hierarchy') AND (
        NEW.result_memory_id IS NOT NULL OR NEW.result_version IS NOT NULL
        OR NEW.result_confirmation_id IS NOT NULL))
 OR ((NEW.result_memory_id IS NULL) <> (NEW.result_version IS NULL))
 OR (NEW.result_confirmation_id IS NOT NULL AND NEW.result_memory_id IS NULL)
 OR (NEW.attempt_count=0 AND NEW.last_attempt_id IS NOT NULL)
 OR (NEW.attempt_count>0 AND NEW.last_attempt_id IS NULL)
 OR (NEW.status IN ('pending_confirmation', 'published') AND (
        NEW.current_plan_version IS NULL OR NEW.last_attempt_id IS NULL
        OR NEW.attempt_count=0))
 OR (NEW.status IN ('published', 'discarded', 'superseded') AND NEW.terminal_at IS NULL)
 OR (NEW.status NOT IN ('published', 'discarded', 'superseded') AND NEW.terminal_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'history publication state shape is invalid');
END;

CREATE TRIGGER cm_history_publications_candidate_scope
BEFORE INSERT ON cm_history_publications
WHEN NOT EXISTS (
    SELECT 1
    FROM cm_history_backfill_candidates AS candidate
    JOIN cm_history_backfill_runs AS run
      ON run.tenant_id=candidate.tenant_id AND run.user_id=candidate.user_id
     AND run.run_id=candidate.run_id
    WHERE candidate.tenant_id=NEW.tenant_id
      AND candidate.user_id=NEW.user_id
      AND candidate.candidate_id=NEW.candidate_id
      AND candidate.run_id=NEW.run_id
      AND candidate.stage='consolidated'
      AND candidate.receipt_id=run.consolidation_receipt_id
      AND run.status='candidates_ready'
      AND NOT EXISTS (
          SELECT 1 FROM cm_history_backfill_runs AS newer
          WHERE newer.tenant_id=run.tenant_id AND newer.user_id=run.user_id
            AND newer.project_id=run.project_id
            AND newer.source_harness=run.source_harness
            AND newer.source_session_id=run.source_session_id
            AND newer.status='candidates_ready'
            AND (
                newer.source_observed_at > run.source_observed_at
                OR (newer.source_observed_at=run.source_observed_at
                    AND newer.created_at > run.created_at)
                OR (newer.source_observed_at=run.source_observed_at
                    AND newer.created_at=run.created_at AND newer.run_id > run.run_id)
            )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'history publication requires a final candidate from a candidates-ready run');
END;

CREATE TRIGGER cm_history_publications_identity_immutable
BEFORE UPDATE ON cm_history_publications
WHEN OLD.publication_id IS NOT NEW.publication_id
  OR OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.user_id IS NOT NEW.user_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.candidate_id IS NOT NEW.candidate_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'history publication identity is immutable');
END;

CREATE TRIGGER cm_history_publications_attempt_summary
BEFORE UPDATE ON cm_history_publications
WHEN NEW.attempt_count <> (
        SELECT count(*) FROM cm_history_publication_attempts AS attempt
        WHERE attempt.tenant_id=NEW.tenant_id AND attempt.user_id=NEW.user_id
          AND attempt.publication_id=NEW.publication_id
    )
  OR (NEW.last_attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cm_history_publication_attempts AS attempt
        WHERE attempt.tenant_id=NEW.tenant_id AND attempt.user_id=NEW.user_id
          AND attempt.publication_id=NEW.publication_id
          AND attempt.attempt_id=NEW.last_attempt_id
    ))
BEGIN
    SELECT RAISE(ABORT, 'history publication attempt summary does not match its ledger');
END;

CREATE TRIGGER cm_history_publications_result_scope
BEFORE UPDATE ON cm_history_publications
WHEN NEW.result_memory_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM cm_history_publication_plans AS plan
    JOIN cm_memories AS memory
      ON memory.tenant_id=plan.tenant_id AND memory.user_id=plan.user_id
     AND memory.memory_id=plan.target_memory_id
     AND memory.project_id=plan.project_id AND memory.level=plan.level
     AND memory.role_id IS plan.role_id AND memory.task_id IS plan.task_id
     AND memory.memory_kind=plan.memory_kind
    JOIN cm_memory_versions AS version
      ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
     AND version.memory_id=memory.memory_id AND version.version=NEW.result_version
    WHERE plan.tenant_id=NEW.tenant_id AND plan.user_id=NEW.user_id
      AND plan.publication_id=NEW.publication_id
      AND plan.plan_version=NEW.current_plan_version
      AND plan.target_memory_id=NEW.result_memory_id
      AND version.content_hash=plan.publication_content_hash
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication result is outside its current plan');
END;

CREATE TRIGGER cm_history_publications_confirmation_scope
BEFORE UPDATE ON cm_history_publications
WHEN NEW.result_confirmation_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id=NEW.tenant_id AND confirmation.user_id=NEW.user_id
      AND confirmation.confirmation_id=NEW.result_confirmation_id
      AND confirmation.memory_id=NEW.result_memory_id
      AND confirmation.proposed_version=NEW.result_version
      AND (NEW.status<>'pending_confirmation' OR confirmation.status='pending')
      AND (NEW.status<>'published' OR confirmation.status='approved')
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication confirmation does not match its result');
END;

CREATE TRIGGER cm_history_publications_terminal_attempt_scope
BEFORE UPDATE ON cm_history_publications
WHEN NEW.status IN ('pending_confirmation', 'published')
 AND NOT EXISTS (
    SELECT 1 FROM cm_history_publication_attempts AS attempt
    WHERE attempt.tenant_id=NEW.tenant_id AND attempt.user_id=NEW.user_id
      AND attempt.attempt_id=NEW.last_attempt_id
      AND attempt.publication_id=NEW.publication_id
      AND attempt.plan_version=NEW.current_plan_version
      AND attempt.result_memory_id=NEW.result_memory_id
      AND attempt.result_version=NEW.result_version
      AND (
        (NEW.status='pending_confirmation'
          AND attempt.outcome='pending_confirmation'
          AND attempt.result_confirmation_id=NEW.result_confirmation_id)
        OR
        (NEW.status='published' AND (
          (NEW.result_confirmation_id IS NULL AND attempt.outcome=NEW.result_kind
            AND attempt.result_confirmation_id IS NULL)
          OR (NEW.result_confirmation_id IS NOT NULL
            AND attempt.outcome='pending_confirmation'
            AND attempt.result_confirmation_id=NEW.result_confirmation_id)
        ))
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication terminal state lacks its scoped attempt');
END;

CREATE TRIGGER cm_history_publications_valid_transition
BEFORE UPDATE OF status ON cm_history_publications
WHEN NOT (
    OLD.status=NEW.status
    OR (OLD.status='pending' AND NEW.status IN (
        'awaiting_hierarchy', 'ready', 'needs_review', 'discarded', 'superseded'))
    OR (OLD.status='awaiting_hierarchy' AND NEW.status IN (
        'ready', 'needs_review', 'discarded', 'superseded'))
    OR (OLD.status='ready' AND NEW.status IN (
        'retryable', 'needs_review', 'pending_confirmation', 'published', 'discarded', 'superseded'))
    OR (OLD.status='retryable' AND NEW.status IN (
        'ready', 'needs_review', 'pending_confirmation', 'published', 'discarded', 'superseded'))
    OR (OLD.status='needs_review' AND NEW.status IN (
        'awaiting_hierarchy', 'ready', 'discarded', 'superseded'))
    OR (OLD.status='pending_confirmation' AND NEW.status IN (
        'published', 'discarded', 'needs_review'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid history publication transition');
END;

CREATE TRIGGER cm_history_publications_terminal_immutable
BEFORE UPDATE ON cm_history_publications
WHEN OLD.status IN ('published', 'discarded', 'superseded')
BEGIN
    SELECT RAISE(ABORT, 'terminal history publications are immutable');
END;

CREATE TRIGGER cm_history_publications_no_delete
BEFORE DELETE ON cm_history_publications
BEGIN
    SELECT RAISE(ABORT, 'history publications cannot be deleted');
END;

CREATE TABLE cm_history_hierarchy_proposals (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('run_role', 'candidate_task', 'candidate_full')),
    proposed_level INTEGER NOT NULL CHECK (proposed_level BETWEEN 1 AND 4),
    role_mode TEXT NOT NULL CHECK (role_mode IN ('none', 'existing', 'proposed')),
    role_id TEXT,
    role_semantic_key TEXT,
    role_name TEXT,
    role_responsibility TEXT,
    task_mode TEXT NOT NULL CHECK (task_mode IN ('none', 'existing', 'proposed')),
    task_id TEXT,
    task_semantic_key TEXT,
    task_title TEXT,
    task_objective TEXT,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
    evidence_json TEXT NOT NULL
        CHECK (json_valid(evidence_json) AND json_type(evidence_json)='array'),
    proposal_hash TEXT NOT NULL CHECK (length(proposal_hash)=64),
    worker_session_id TEXT NOT NULL,
    worker_turn_id TEXT NOT NULL,
    capability_epoch_hash TEXT NOT NULL CHECK (length(capability_epoch_hash)=64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, proposal_id),
    UNIQUE (tenant_id, user_id, publication_id, proposal_hash),
    UNIQUE (tenant_id, user_id, publication_id, proposal_id),
    FOREIGN KEY (tenant_id, user_id, publication_id)
        REFERENCES cm_history_publications (tenant_id, user_id, publication_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, candidate_id)
        REFERENCES cm_history_backfill_candidates (tenant_id, user_id, candidate_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, worker_session_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE RESTRICT,
    CHECK (
        (proposed_level=1 AND role_mode='none' AND role_id IS NULL
            AND task_mode='none' AND task_id IS NULL)
        OR (proposed_level=2 AND role_mode<>'none' AND role_id IS NOT NULL
            AND task_mode='none' AND task_id IS NULL)
        OR (proposed_level IN (3,4) AND role_mode<>'none' AND role_id IS NOT NULL
            AND task_mode<>'none' AND task_id IS NOT NULL)
    ),
    CHECK (
        (role_mode='none' AND role_id IS NULL AND role_semantic_key IS NULL
            AND role_name IS NULL AND role_responsibility IS NULL)
        OR (role_mode='existing' AND role_id IS NOT NULL
            AND role_semantic_key IS NULL AND role_name IS NULL
            AND role_responsibility IS NULL)
        OR (role_mode='proposed' AND role_id IS NOT NULL
            AND role_semantic_key IS NOT NULL AND length(trim(role_semantic_key))>0
            AND role_name IS NOT NULL AND length(trim(role_name))>0
            AND role_responsibility IS NOT NULL AND length(trim(role_responsibility))>0)
    ),
    CHECK (
        (task_mode='none' AND task_id IS NULL AND task_semantic_key IS NULL
            AND task_title IS NULL AND task_objective IS NULL)
        OR (task_mode='existing' AND task_id IS NOT NULL
            AND task_semantic_key IS NULL AND task_title IS NULL
            AND task_objective IS NULL)
        OR (task_mode='proposed' AND task_id IS NOT NULL
            AND task_semantic_key IS NOT NULL AND length(trim(task_semantic_key))>0
            AND task_title IS NOT NULL AND length(trim(task_title))>0
            AND task_objective IS NOT NULL AND length(trim(task_objective))>0)
    ),
    CHECK (
        (proposed_level=1 AND scope_kind='candidate_full')
        OR (proposed_level=2 AND scope_kind='run_role')
        OR (proposed_level IN (3,4) AND scope_kind='candidate_task')
    ),
    CHECK (json_array_length(evidence_json) BETWEEN 1 AND 8)
);

CREATE TRIGGER cm_history_hierarchy_proposals_scope
BEFORE INSERT ON cm_history_hierarchy_proposals
WHEN NOT EXISTS (
    SELECT 1
    FROM cm_history_publications AS publication
    JOIN cm_history_backfill_runs AS run
      ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
     AND run.run_id=publication.run_id
    JOIN cm_history_backfill_candidates AS candidate
      ON candidate.tenant_id=publication.tenant_id AND candidate.user_id=publication.user_id
     AND candidate.candidate_id=publication.candidate_id
     AND candidate.run_id=publication.run_id
    JOIN cm_threads AS worker
      ON worker.tenant_id=publication.tenant_id AND worker.user_id=publication.user_id
     AND worker.thread_id=NEW.worker_session_id
     AND worker.project_id=run.project_id AND worker.status='active'
    WHERE publication.tenant_id=NEW.tenant_id
      AND publication.user_id=NEW.user_id
      AND publication.publication_id=NEW.publication_id
      AND publication.run_id=NEW.run_id
      AND publication.candidate_id=NEW.candidate_id
      AND publication.status IN ('pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review')
      AND candidate.receipt_id=run.consolidation_receipt_id
      AND json(NEW.evidence_json)=json(json_extract(candidate.evidence_json, '$.references'))
      AND (
        NEW.role_mode<>'existing'
        OR EXISTS (
          SELECT 1 FROM cm_roles AS role
          WHERE role.tenant_id=NEW.tenant_id AND role.user_id=NEW.user_id
            AND role.role_id=NEW.role_id AND role.project_id=run.project_id
            AND role.status='active'
        )
      )
      AND (
        NEW.task_mode<>'existing'
        OR EXISTS (
          SELECT 1 FROM cm_tasks AS task
          WHERE task.tenant_id=NEW.tenant_id AND task.user_id=NEW.user_id
            AND task.task_id=NEW.task_id AND task.project_id=run.project_id
            AND task.role_id IS NEW.role_id AND task.status IN ('active', 'completed')
        )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'history hierarchy proposal is outside its publication scope');
END;

CREATE TRIGGER cm_history_hierarchy_proposals_shape
BEFORE INSERT ON cm_history_hierarchy_proposals
WHEN COALESCE((
    ((NEW.proposed_level=1 AND NEW.role_mode='none' AND NEW.role_id IS NULL
        AND NEW.task_mode='none' AND NEW.task_id IS NULL)
      OR (NEW.proposed_level=2 AND NEW.role_mode<>'none' AND NEW.role_id IS NOT NULL
        AND NEW.task_mode='none' AND NEW.task_id IS NULL)
      OR (NEW.proposed_level IN (3,4) AND NEW.role_mode<>'none' AND NEW.role_id IS NOT NULL
        AND NEW.task_mode<>'none' AND NEW.task_id IS NOT NULL))
    AND ((NEW.role_mode='none' AND NEW.role_id IS NULL
        AND NEW.role_semantic_key IS NULL AND NEW.role_name IS NULL
        AND NEW.role_responsibility IS NULL)
      OR (NEW.role_mode='existing' AND NEW.role_id IS NOT NULL
        AND NEW.role_semantic_key IS NULL AND NEW.role_name IS NULL
        AND NEW.role_responsibility IS NULL)
      OR (NEW.role_mode='proposed' AND NEW.role_id IS NOT NULL
        AND length(trim(NEW.role_semantic_key))>0 AND length(trim(NEW.role_name))>0
        AND length(trim(NEW.role_responsibility))>0))
    AND ((NEW.task_mode='none' AND NEW.task_id IS NULL
        AND NEW.task_semantic_key IS NULL AND NEW.task_title IS NULL
        AND NEW.task_objective IS NULL)
      OR (NEW.task_mode='existing' AND NEW.task_id IS NOT NULL
        AND NEW.task_semantic_key IS NULL AND NEW.task_title IS NULL
        AND NEW.task_objective IS NULL)
      OR (NEW.task_mode='proposed' AND NEW.task_id IS NOT NULL
        AND length(trim(NEW.task_semantic_key))>0 AND length(trim(NEW.task_title))>0
        AND length(trim(NEW.task_objective))>0))
    AND ((NEW.proposed_level=1 AND NEW.scope_kind='candidate_full')
      OR (NEW.proposed_level=2 AND NEW.scope_kind='run_role')
      OR (NEW.proposed_level IN (3,4) AND NEW.scope_kind='candidate_task'))
    AND json_array_length(NEW.evidence_json) BETWEEN 1 AND 8
), 0)=0
BEGIN
    SELECT RAISE(ABORT, 'history hierarchy proposal shape is invalid');
END;

CREATE TRIGGER cm_history_hierarchy_proposals_proposed_id_collision
BEFORE INSERT ON cm_history_hierarchy_proposals
WHEN (NEW.role_mode='proposed' AND EXISTS (
        SELECT 1 FROM cm_roles AS role
        JOIN cm_history_backfill_runs AS run
          ON run.tenant_id=NEW.tenant_id AND run.user_id=NEW.user_id AND run.run_id=NEW.run_id
        WHERE role.tenant_id=NEW.tenant_id AND role.user_id=NEW.user_id
          AND role.role_id=NEW.role_id AND role.project_id<>run.project_id
    ))
 OR (NEW.task_mode='proposed' AND EXISTS (
        SELECT 1 FROM cm_tasks AS task
        JOIN cm_history_backfill_runs AS run
          ON run.tenant_id=NEW.tenant_id AND run.user_id=NEW.user_id AND run.run_id=NEW.run_id
        WHERE task.tenant_id=NEW.tenant_id AND task.user_id=NEW.user_id
          AND task.task_id=NEW.task_id
          AND (task.project_id<>run.project_id OR task.role_id IS NOT NEW.role_id)
    ))
BEGIN
    SELECT RAISE(ABORT, 'proposed history hierarchy id collides with another scope');
END;

CREATE TRIGGER cm_history_hierarchy_proposals_immutable
BEFORE UPDATE ON cm_history_hierarchy_proposals
BEGIN
    SELECT RAISE(ABORT, 'history hierarchy proposals are immutable');
END;

CREATE TRIGGER cm_history_hierarchy_proposals_no_delete
BEFORE DELETE ON cm_history_hierarchy_proposals
BEGIN
    SELECT RAISE(ABORT, 'history hierarchy proposals cannot be deleted');
END;

CREATE TABLE cm_history_governance_decisions (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    proposal_id TEXT,
    plan_version INTEGER,
    action TEXT NOT NULL CHECK (action IN (
        'accept_hierarchy', 'reject_hierarchy', 'approve_update',
        'approve_conflict', 'discard', 'retry'
    )),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'policy', 'authorized_manifest')),
    actor_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('codex_ui', 'obsidian', 'local_cli', 'policy')),
    evidence_json TEXT NOT NULL
        CHECK (json_valid(evidence_json) AND json_type(evidence_json)='object'),
    note TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, decision_id),
    UNIQUE (tenant_id, user_id, action_id),
    FOREIGN KEY (tenant_id, user_id, publication_id)
        REFERENCES cm_history_publications (tenant_id, user_id, publication_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, publication_id, proposal_id)
        REFERENCES cm_history_hierarchy_proposals
            (tenant_id, user_id, publication_id, proposal_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, publication_id, plan_version)
        REFERENCES cm_history_publication_plans
            (tenant_id, user_id, publication_id, plan_version) ON DELETE RESTRICT,
    CHECK (
        (action IN ('accept_hierarchy', 'reject_hierarchy')
            AND proposal_id IS NOT NULL AND plan_version IS NULL)
        OR (action IN ('approve_update', 'approve_conflict')
            AND proposal_id IS NULL AND plan_version IS NOT NULL)
        OR (action IN ('discard', 'retry')
            AND proposal_id IS NULL AND plan_version IS NULL)
    ),
    CHECK (action='retry' OR actor_kind='user'),
    CHECK (
        (actor_kind='user' AND channel IN ('codex_ui', 'obsidian', 'local_cli'))
        OR (actor_kind<>'user' AND channel='policy')
    ),
    CHECK (length(trim(actor_id))>0 AND length(trim(action_id))>0),
    CHECK (length(note)<=2000 AND length(evidence_json)<=16384)
);

CREATE TRIGGER cm_history_governance_decisions_scope
BEFORE INSERT ON cm_history_governance_decisions
WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence_json))
 OR NOT EXISTS (
    SELECT 1 FROM cm_history_publications AS publication
    WHERE publication.tenant_id=NEW.tenant_id AND publication.user_id=NEW.user_id
      AND publication.publication_id=NEW.publication_id
      AND publication.status NOT IN ('published', 'discarded', 'superseded')
      AND (
        NEW.action NOT IN ('approve_update', 'approve_conflict')
        OR (
          publication.status='needs_review'
          AND publication.current_plan_version=NEW.plan_version
          AND EXISTS (
            SELECT 1 FROM cm_history_publication_plans AS plan
            WHERE plan.tenant_id=NEW.tenant_id AND plan.user_id=NEW.user_id
              AND plan.publication_id=NEW.publication_id
              AND plan.plan_version=NEW.plan_version
              AND plan.relation=CASE NEW.action
                WHEN 'approve_update' THEN 'update' ELSE 'conflict' END
          )
        )
      )
      AND (
        NEW.action NOT IN ('accept_hierarchy', 'reject_hierarchy')
        OR EXISTS (
          SELECT 1 FROM cm_history_hierarchy_proposals AS proposal
          WHERE proposal.tenant_id=NEW.tenant_id AND proposal.user_id=NEW.user_id
            AND proposal.publication_id=NEW.publication_id
            AND proposal.proposal_id=NEW.proposal_id
        )
      )
 )
 OR (NEW.action='accept_hierarchy' AND EXISTS (
    SELECT 1 FROM cm_history_governance_decisions AS accepted
    WHERE accepted.tenant_id=NEW.tenant_id AND accepted.user_id=NEW.user_id
      AND accepted.publication_id=NEW.publication_id
      AND accepted.action='accept_hierarchy'
      AND accepted.proposal_id IS NOT NEW.proposal_id
 ))
BEGIN
    SELECT RAISE(ABORT, 'history governance decision is outside its publication selector');
END;

CREATE TRIGGER cm_history_governance_decisions_shape
BEFORE INSERT ON cm_history_governance_decisions
WHEN COALESCE((
    ((NEW.action IN ('accept_hierarchy', 'reject_hierarchy')
        AND NEW.proposal_id IS NOT NULL AND NEW.plan_version IS NULL)
      OR (NEW.action IN ('approve_update', 'approve_conflict')
        AND NEW.proposal_id IS NULL AND NEW.plan_version IS NOT NULL)
      OR (NEW.action IN ('discard', 'retry')
        AND NEW.proposal_id IS NULL AND NEW.plan_version IS NULL))
    AND (NEW.action='retry' OR NEW.actor_kind='user')
    AND ((NEW.actor_kind='user' AND NEW.channel IN ('codex_ui', 'obsidian', 'local_cli'))
      OR (NEW.actor_kind<>'user' AND NEW.channel='policy'))
    AND length(trim(NEW.actor_id))>0 AND length(trim(NEW.action_id))>0
    AND length(NEW.note)<=2000 AND length(NEW.evidence_json)<=16384
), 0)=0
BEGIN
    SELECT RAISE(ABORT, 'history governance decision shape is invalid');
END;

CREATE TRIGGER cm_history_governance_decisions_immutable
BEFORE UPDATE ON cm_history_governance_decisions
BEGIN
    SELECT RAISE(ABORT, 'history governance decisions are immutable');
END;

CREATE TRIGGER cm_history_governance_decisions_no_delete
BEFORE DELETE ON cm_history_governance_decisions
BEGIN
    SELECT RAISE(ABORT, 'history governance decisions cannot be deleted');
END;

CREATE TABLE cm_history_publication_plans (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version > 0),
    project_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    hierarchy_decision_id TEXT,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    role_id TEXT,
    task_id TEXT,
    memory_kind TEXT NOT NULL,
    semantic_key_normalized TEXT NOT NULL,
    semantic_identity_hash TEXT NOT NULL CHECK (length(semantic_identity_hash)=64),
    target_memory_id TEXT NOT NULL,
    expected_memory_exists INTEGER NOT NULL CHECK (expected_memory_exists IN (0,1)),
    expected_current_version INTEGER CHECK (expected_current_version IS NULL OR expected_current_version > 0),
    expected_current_status TEXT CHECK (expected_current_status IS NULL OR expected_current_status IN (
        'active', 'superseded', 'retracted', 'pending_confirmation', 'locked'
    )),
    expected_current_content_hash TEXT CHECK (
        expected_current_content_hash IS NULL OR length(expected_current_content_hash)=64),
    relation TEXT NOT NULL CHECK (relation IN ('new', 'noop', 'update', 'conflict')),
    conflicts_json TEXT NOT NULL
        CHECK (json_valid(conflicts_json) AND json_type(conflicts_json)='array'),
    candidate_finding_hash TEXT NOT NULL CHECK (length(candidate_finding_hash)=64),
    publication_content_hash TEXT NOT NULL CHECK (length(publication_content_hash)=64),
    is_major INTEGER NOT NULL CHECK (is_major IN (0,1)),
    plan_hash TEXT NOT NULL CHECK (length(plan_hash)=64),
    created_by_session_id TEXT NOT NULL,
    created_by_turn_id TEXT NOT NULL,
    capability_epoch_hash TEXT NOT NULL CHECK (length(capability_epoch_hash)=64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, publication_id, plan_version),
    UNIQUE (tenant_id, user_id, publication_id, plan_hash),
    FOREIGN KEY (tenant_id, user_id, publication_id)
        REFERENCES cm_history_publications (tenant_id, user_id, publication_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, proposal_id)
        REFERENCES cm_history_hierarchy_proposals (tenant_id, user_id, proposal_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, hierarchy_decision_id)
        REFERENCES cm_history_governance_decisions (tenant_id, user_id, decision_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, role_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, task_id)
        REFERENCES cm_tasks (tenant_id, user_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, project_id, role_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id, task_id)
        REFERENCES cm_tasks
            (tenant_id, user_id, project_id, role_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, created_by_session_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE RESTRICT,
    CHECK (
        (level=1 AND role_id IS NULL AND task_id IS NULL)
        OR (level=2 AND role_id IS NOT NULL AND task_id IS NULL)
        OR (level IN (3,4) AND role_id IS NOT NULL AND task_id IS NOT NULL)
    ),
    CHECK (
        (expected_memory_exists=0 AND expected_current_version IS NULL
            AND expected_current_status IS NULL AND expected_current_content_hash IS NULL
            AND relation='new')
        OR expected_memory_exists=1
    ),
    CHECK (
        (expected_current_version IS NULL AND expected_current_status IS NULL
            AND expected_current_content_hash IS NULL)
        OR (expected_current_version IS NOT NULL AND expected_current_status IS NOT NULL
            AND expected_current_content_hash IS NOT NULL)
    ),
    CHECK (target_memory_id='cm-semantic:' || substr(semantic_identity_hash, 1, 40)),
    CHECK (length(trim(memory_kind))>0 AND length(trim(semantic_key_normalized))>0),
    CHECK (
        (relation IN ('new', 'noop') AND json_array_length(conflicts_json)=0)
        OR (relation IN ('update', 'conflict') AND json_array_length(conflicts_json)>0)
    )
);

CREATE TRIGGER cm_history_publication_plans_scope
BEFORE INSERT ON cm_history_publication_plans
WHEN NEW.plan_version <> (
        SELECT COALESCE(MAX(plan_version), 0) + 1
        FROM cm_history_publication_plans AS prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.user_id=NEW.user_id
          AND prior.publication_id=NEW.publication_id
    )
 OR NOT EXISTS (
    SELECT 1
    FROM cm_history_publications AS publication
    JOIN cm_history_backfill_runs AS run
      ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
     AND run.run_id=publication.run_id
    JOIN cm_history_backfill_candidates AS candidate
      ON candidate.tenant_id=publication.tenant_id AND candidate.user_id=publication.user_id
     AND candidate.candidate_id=publication.candidate_id
     AND candidate.run_id=publication.run_id
    JOIN cm_history_hierarchy_proposals AS proposal
      ON proposal.tenant_id=publication.tenant_id AND proposal.user_id=publication.user_id
     AND proposal.publication_id=publication.publication_id
     AND proposal.proposal_id=NEW.proposal_id
     AND proposal.run_id=publication.run_id
     AND proposal.candidate_id=publication.candidate_id
    JOIN cm_threads AS worker
      ON worker.tenant_id=publication.tenant_id AND worker.user_id=publication.user_id
     AND worker.thread_id=NEW.created_by_session_id
     AND worker.project_id=run.project_id AND worker.status='active'
    WHERE publication.tenant_id=NEW.tenant_id AND publication.user_id=NEW.user_id
      AND publication.publication_id=NEW.publication_id
      AND publication.status IN ('ready', 'retryable', 'needs_review')
      AND run.project_id=NEW.project_id
      AND candidate.receipt_id=run.consolidation_receipt_id
      AND candidate.finding_hash=NEW.candidate_finding_hash
      AND proposal.proposed_level=NEW.level
      AND proposal.role_id IS NEW.role_id
      AND proposal.task_id IS NEW.task_id
      AND (
        NEW.hierarchy_decision_id IS NULL
        OR EXISTS (
          SELECT 1 FROM cm_history_governance_decisions AS decision
          WHERE decision.tenant_id=NEW.tenant_id AND decision.user_id=NEW.user_id
            AND decision.decision_id=NEW.hierarchy_decision_id
            AND decision.publication_id=NEW.publication_id
            AND decision.proposal_id=NEW.proposal_id
            AND decision.action='accept_hierarchy'
        )
      )
      AND (
        (proposal.role_mode<>'proposed' AND proposal.task_mode<>'proposed')
        OR NEW.hierarchy_decision_id IS NOT NULL
      )
      AND (candidate.is_major=0 OR NEW.is_major=1)
      AND (NEW.level<>1 OR NEW.is_major=1)
      AND (
        NEW.level=1
        OR EXISTS (
          SELECT 1 FROM cm_roles AS role
          WHERE role.tenant_id=NEW.tenant_id AND role.user_id=NEW.user_id
            AND role.project_id=NEW.project_id AND role.role_id=NEW.role_id
            AND role.status='active'
        )
      )
      AND (
        NEW.level<3
        OR EXISTS (
          SELECT 1 FROM cm_tasks AS task
          WHERE task.tenant_id=NEW.tenant_id AND task.user_id=NEW.user_id
            AND task.project_id=NEW.project_id AND task.role_id IS NEW.role_id
            AND task.task_id=NEW.task_id AND task.status IN ('active', 'completed')
        )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication plan is outside its immutable scope');
END;

CREATE TRIGGER cm_history_publication_plans_shape
BEFORE INSERT ON cm_history_publication_plans
WHEN COALESCE((
    ((NEW.expected_current_version IS NULL AND NEW.expected_current_status IS NULL
        AND NEW.expected_current_content_hash IS NULL)
      OR (NEW.expected_current_version IS NOT NULL AND NEW.expected_current_status IS NOT NULL
        AND NEW.expected_current_content_hash IS NOT NULL))
    AND NEW.target_memory_id='cm-semantic:' || substr(NEW.semantic_identity_hash, 1, 40)
    AND length(trim(NEW.memory_kind))>0 AND length(trim(NEW.semantic_key_normalized))>0
    AND ((NEW.relation IN ('new', 'noop') AND json_array_length(NEW.conflicts_json)=0)
      OR (NEW.relation IN ('update', 'conflict') AND json_array_length(NEW.conflicts_json)>0))
), 0)=0
BEGIN
    SELECT RAISE(ABORT, 'history publication plan shape is invalid');
END;

CREATE TRIGGER cm_history_publication_plans_semantic_scope
BEFORE INSERT ON cm_history_publication_plans
WHEN EXISTS (
    SELECT 1 FROM cm_semantic_memory_keys AS semantic
    WHERE semantic.tenant_id=NEW.tenant_id AND semantic.user_id=NEW.user_id
      AND semantic.semantic_identity_hash=NEW.semantic_identity_hash
      AND (
        semantic.project_id<>NEW.project_id OR semantic.level<>NEW.level
        OR semantic.role_id IS NOT NEW.role_id OR semantic.task_id IS NOT NEW.task_id
        OR semantic.memory_kind<>NEW.memory_kind
        OR semantic.semantic_key_normalized<>NEW.semantic_key_normalized
        OR semantic.memory_id<>NEW.target_memory_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'history publication plan semantic identity is already bound elsewhere');
END;

CREATE TRIGGER cm_history_publication_plans_cas
BEFORE INSERT ON cm_history_publication_plans
WHEN (
    NEW.expected_memory_exists=0
    AND (
      EXISTS (
        SELECT 1 FROM cm_memories AS memory
        WHERE memory.tenant_id=NEW.tenant_id AND memory.user_id=NEW.user_id
          AND memory.memory_id=NEW.target_memory_id
      )
      OR EXISTS (
        SELECT 1 FROM cm_semantic_memory_keys AS semantic
        WHERE semantic.tenant_id=NEW.tenant_id AND semantic.user_id=NEW.user_id
          AND semantic.semantic_identity_hash=NEW.semantic_identity_hash
      )
    )
)
 OR (
    NEW.expected_memory_exists=1
    AND NOT EXISTS (
      SELECT 1 FROM cm_memories AS memory
      WHERE memory.tenant_id=NEW.tenant_id AND memory.user_id=NEW.user_id
        AND memory.memory_id=NEW.target_memory_id
        AND memory.project_id=NEW.project_id AND memory.level=NEW.level
        AND memory.role_id IS NEW.role_id AND memory.task_id IS NEW.task_id
        AND memory.memory_kind=NEW.memory_kind
        AND memory.current_version IS NEW.expected_current_version
        AND (
          (memory.current_version IS NULL
            AND NEW.expected_current_status IS NULL
            AND NEW.expected_current_content_hash IS NULL)
          OR EXISTS (
            SELECT 1 FROM cm_memory_versions AS version
            WHERE version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
              AND version.memory_id=memory.memory_id AND version.version=memory.current_version
              AND version.status=NEW.expected_current_status
              AND version.content_hash=NEW.expected_current_content_hash
          )
        )
    )
)
 OR (NEW.relation='new' AND NEW.expected_memory_exists<>0)
 OR (NEW.relation<>'new' AND NEW.expected_memory_exists<>1)
 OR (NEW.relation='noop' AND (
      NEW.expected_current_version IS NULL
      OR NEW.expected_current_content_hash<>NEW.publication_content_hash
 ))
BEGIN
    SELECT RAISE(ABORT, 'history publication plan CAS snapshot does not match central memory');
END;

CREATE TRIGGER cm_history_publication_plans_immutable
BEFORE UPDATE ON cm_history_publication_plans
BEGIN
    SELECT RAISE(ABORT, 'history publication plans are immutable');
END;

CREATE TRIGGER cm_history_publication_plans_no_delete
BEFORE DELETE ON cm_history_publication_plans
BEGIN
    SELECT RAISE(ABORT, 'history publication plans cannot be deleted');
END;

CREATE TABLE cm_semantic_memory_keys (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    semantic_identity_hash TEXT NOT NULL CHECK (length(semantic_identity_hash)=64),
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    role_id TEXT,
    task_id TEXT,
    memory_kind TEXT NOT NULL,
    semantic_key_normalized TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    is_canonical INTEGER NOT NULL CHECK (is_canonical IN (0,1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, semantic_identity_hash),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, project_id, role_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id, task_id)
        REFERENCES cm_tasks
            (tenant_id, user_id, project_id, role_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, memory_id)
        REFERENCES cm_memories (tenant_id, user_id, memory_id) ON DELETE RESTRICT,
    CHECK (
        (level=1 AND role_id IS NULL AND task_id IS NULL)
        OR (level=2 AND role_id IS NOT NULL AND task_id IS NULL)
        OR (level IN (3,4) AND role_id IS NOT NULL AND task_id IS NOT NULL)
    ),
    CHECK (length(trim(memory_kind))>0 AND length(trim(semantic_key_normalized))>0),
    CHECK (
        is_canonical=0
        OR memory_id='cm-semantic:' || substr(semantic_identity_hash, 1, 40)
    )
);

CREATE UNIQUE INDEX cm_semantic_memory_keys_canonical
    ON cm_semantic_memory_keys (tenant_id, user_id, memory_id)
    WHERE is_canonical=1;

CREATE UNIQUE INDEX cm_semantic_memory_keys_natural_identity
    ON cm_semantic_memory_keys (
        tenant_id, user_id, project_id, level,
        ifnull(role_id, ''), ifnull(task_id, ''),
        memory_kind, semantic_key_normalized
    );

CREATE TRIGGER cm_semantic_memory_keys_scope
BEFORE INSERT ON cm_semantic_memory_keys
WHEN NOT EXISTS (
    SELECT 1 FROM cm_memories AS memory
    WHERE memory.tenant_id=NEW.tenant_id AND memory.user_id=NEW.user_id
      AND memory.memory_id=NEW.memory_id AND memory.project_id=NEW.project_id
      AND memory.level=NEW.level AND memory.role_id IS NEW.role_id
      AND memory.task_id IS NEW.task_id AND memory.memory_kind=NEW.memory_kind
)
BEGIN
    SELECT RAISE(ABORT, 'semantic memory key is outside its central memory hierarchy');
END;

CREATE TRIGGER cm_semantic_memory_keys_shape
BEFORE INSERT ON cm_semantic_memory_keys
WHEN COALESCE((
    ((NEW.level=1 AND NEW.role_id IS NULL AND NEW.task_id IS NULL)
      OR (NEW.level=2 AND NEW.role_id IS NOT NULL AND NEW.task_id IS NULL)
      OR (NEW.level IN (3,4) AND NEW.role_id IS NOT NULL AND NEW.task_id IS NOT NULL))
    AND length(trim(NEW.memory_kind))>0
    AND length(trim(NEW.semantic_key_normalized))>0
    AND (NEW.is_canonical=0
      OR NEW.memory_id='cm-semantic:' || substr(NEW.semantic_identity_hash, 1, 40))
), 0)=0
BEGIN
    SELECT RAISE(ABORT, 'semantic memory key shape is invalid');
END;

CREATE TRIGGER cm_semantic_memory_keys_immutable
BEFORE UPDATE ON cm_semantic_memory_keys
BEGIN
    SELECT RAISE(ABORT, 'semantic memory keys are immutable');
END;

CREATE TRIGGER cm_semantic_memory_keys_no_delete
BEFORE DELETE ON cm_semantic_memory_keys
BEGIN
    SELECT RAISE(ABORT, 'semantic memory keys cannot be deleted');
END;

CREATE TABLE cm_history_publication_attempts (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    worker_session_id TEXT NOT NULL,
    worker_turn_id TEXT NOT NULL,
    capability_epoch_hash TEXT NOT NULL CHECK (length(capability_epoch_hash)=64),
    request_hash TEXT NOT NULL CHECK (length(request_hash)=64),
    outcome TEXT NOT NULL CHECK (outcome IN (
        'created', 'updated', 'noop', 'pending_confirmation', 'needs_review', 'retryable'
    )),
    result_memory_id TEXT,
    result_version INTEGER CHECK (result_version IS NULL OR result_version > 0),
    result_confirmation_id TEXT,
    error_code TEXT,
    error_detail TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, attempt_id),
    UNIQUE (tenant_id, user_id, publication_id, attempt_id),
    FOREIGN KEY (tenant_id, user_id, publication_id, plan_version)
        REFERENCES cm_history_publication_plans
            (tenant_id, user_id, publication_id, plan_version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, worker_session_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, result_memory_id, result_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, result_confirmation_id)
        REFERENCES cm_confirmations (tenant_id, user_id, confirmation_id) ON DELETE RESTRICT,
    CHECK (
        (outcome IN ('created', 'updated', 'noop')
            AND result_memory_id IS NOT NULL AND result_version IS NOT NULL
            AND result_confirmation_id IS NULL
            AND error_code IS NULL AND error_detail IS NULL)
        OR (outcome='pending_confirmation'
            AND result_memory_id IS NOT NULL AND result_version IS NOT NULL
            AND result_confirmation_id IS NOT NULL
            AND error_code IS NULL AND error_detail IS NULL)
        OR (outcome IN ('needs_review', 'retryable')
            AND result_memory_id IS NULL AND result_version IS NULL
            AND result_confirmation_id IS NULL
            AND error_code IS NOT NULL AND length(trim(error_code))>0
            AND error_detail IS NOT NULL AND length(trim(error_detail))>0)
    ),
    CHECK (length(request_hash)=64 AND length(error_detail)<=2000)
);

CREATE TRIGGER cm_history_publication_attempts_scope
BEFORE INSERT ON cm_history_publication_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM cm_history_publication_plans AS plan
    JOIN cm_history_publications AS publication
      ON publication.tenant_id=plan.tenant_id AND publication.user_id=plan.user_id
     AND publication.publication_id=plan.publication_id
     AND publication.current_plan_version=plan.plan_version
    JOIN cm_history_backfill_runs AS run
      ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
     AND run.run_id=publication.run_id
    JOIN cm_threads AS worker
      ON worker.tenant_id=plan.tenant_id AND worker.user_id=plan.user_id
     AND worker.thread_id=NEW.worker_session_id
     AND worker.project_id=plan.project_id AND worker.status='active'
    WHERE plan.tenant_id=NEW.tenant_id AND plan.user_id=NEW.user_id
      AND plan.publication_id=NEW.publication_id
      AND plan.plan_version=NEW.plan_version
      AND publication.status IN ('ready', 'retryable')
      AND run.project_id=plan.project_id
      AND (
        plan.relation NOT IN ('update', 'conflict')
        OR EXISTS (
          SELECT 1 FROM cm_history_governance_decisions AS decision
          WHERE decision.tenant_id=plan.tenant_id AND decision.user_id=plan.user_id
            AND decision.publication_id=plan.publication_id
            AND decision.plan_version=plan.plan_version
            AND decision.action=CASE plan.relation
              WHEN 'update' THEN 'approve_update' ELSE 'approve_conflict' END
            AND decision.actor_kind='user'
        )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication attempt is outside its current executable plan');
END;

CREATE TRIGGER cm_history_publication_attempts_shape
BEFORE INSERT ON cm_history_publication_attempts
WHEN COALESCE((
    (NEW.outcome IN ('created', 'updated', 'noop')
      AND NEW.result_memory_id IS NOT NULL AND NEW.result_version IS NOT NULL
      AND NEW.result_confirmation_id IS NULL
      AND NEW.error_code IS NULL AND NEW.error_detail IS NULL)
    OR (NEW.outcome='pending_confirmation'
      AND NEW.result_memory_id IS NOT NULL AND NEW.result_version IS NOT NULL
      AND NEW.result_confirmation_id IS NOT NULL
      AND NEW.error_code IS NULL AND NEW.error_detail IS NULL)
    OR (NEW.outcome IN ('needs_review', 'retryable')
      AND NEW.result_memory_id IS NULL AND NEW.result_version IS NULL
      AND NEW.result_confirmation_id IS NULL
      AND length(trim(NEW.error_code))>0 AND length(trim(NEW.error_detail))>0
      AND length(NEW.error_detail)<=2000)
), 0)=0
BEGIN
    SELECT RAISE(ABORT, 'history publication attempt shape is invalid');
END;

CREATE TRIGGER cm_history_publication_attempts_result_scope
BEFORE INSERT ON cm_history_publication_attempts
WHEN NEW.result_memory_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM cm_history_publication_plans AS plan
    JOIN cm_memories AS memory
      ON memory.tenant_id=plan.tenant_id AND memory.user_id=plan.user_id
     AND memory.memory_id=plan.target_memory_id
     AND memory.project_id=plan.project_id AND memory.level=plan.level
     AND memory.role_id IS plan.role_id AND memory.task_id IS plan.task_id
     AND memory.memory_kind=plan.memory_kind
    JOIN cm_memory_versions AS version
      ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
     AND version.memory_id=memory.memory_id AND version.version=NEW.result_version
     AND version.content_hash=plan.publication_content_hash
    WHERE plan.tenant_id=NEW.tenant_id AND plan.user_id=NEW.user_id
      AND plan.publication_id=NEW.publication_id AND plan.plan_version=NEW.plan_version
      AND plan.target_memory_id=NEW.result_memory_id
      AND (
        (NEW.outcome='pending_confirmation'
          AND version.status='pending_confirmation'
          AND EXISTS (
            SELECT 1 FROM cm_confirmations AS confirmation
            WHERE confirmation.tenant_id=NEW.tenant_id AND confirmation.user_id=NEW.user_id
              AND confirmation.confirmation_id=NEW.result_confirmation_id
              AND confirmation.memory_id=NEW.result_memory_id
              AND confirmation.proposed_version=NEW.result_version
              AND confirmation.status='pending'
          ))
        OR (NEW.outcome IN ('created', 'updated', 'noop')
          AND version.status IN ('active', 'locked'))
      )
      AND (NEW.outcome<>'created' OR plan.expected_memory_exists=0)
      AND (NEW.outcome<>'updated' OR (
        plan.expected_memory_exists=1 AND plan.relation IN ('update', 'conflict')))
      AND (NEW.outcome<>'noop' OR plan.relation='noop')
 )
BEGIN
    SELECT RAISE(ABORT, 'history publication attempt result is outside its plan');
END;

CREATE TRIGGER cm_history_publication_attempts_immutable
BEFORE UPDATE ON cm_history_publication_attempts
BEGIN
    SELECT RAISE(ABORT, 'history publication attempts are immutable');
END;

CREATE TRIGGER cm_history_publication_attempts_no_delete
BEFORE DELETE ON cm_history_publication_attempts
BEGIN
    SELECT RAISE(ABORT, 'history publication attempts cannot be deleted');
END;

CREATE TRIGGER cm_history_publications_seed_after_run
AFTER UPDATE OF status ON cm_history_backfill_runs
WHEN NEW.status='candidates_ready' AND OLD.status<>'candidates_ready'
BEGIN
    UPDATE cm_history_publications
    SET status='superseded', terminal_at=NEW.updated_at,
        last_error_code='SOURCE_REVISION_SUPERSEDED',
        last_error_detail='a newer authorized history revision became ready',
        updated_at=NEW.updated_at
    WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id
      AND status IN ('pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review')
      AND run_id IN (
        SELECT prior.run_id FROM cm_history_backfill_runs AS prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.user_id=NEW.user_id
          AND prior.project_id=NEW.project_id
          AND prior.source_harness=NEW.source_harness
          AND prior.source_session_id=NEW.source_session_id
          AND prior.run_id<>NEW.run_id
          AND (
            prior.source_observed_at < NEW.source_observed_at
            OR (prior.source_observed_at=NEW.source_observed_at
                AND prior.created_at < NEW.created_at)
            OR (prior.source_observed_at=NEW.source_observed_at
                AND prior.created_at=NEW.created_at AND prior.run_id < NEW.run_id)
          )
      );
    INSERT OR IGNORE INTO cm_history_publications (
        tenant_id, user_id, publication_id, run_id, candidate_id, status,
        available_at, created_at, updated_at
    )
    SELECT candidate.tenant_id, candidate.user_id,
        'history-publication:' || candidate.candidate_id,
        candidate.run_id, candidate.candidate_id, 'pending', NEW.updated_at, NEW.updated_at, NEW.updated_at
    FROM cm_history_backfill_candidates AS candidate
    WHERE candidate.tenant_id=NEW.tenant_id
      AND candidate.user_id=NEW.user_id
      AND candidate.run_id=NEW.run_id
      AND candidate.stage='consolidated'
      AND candidate.receipt_id=NEW.consolidation_receipt_id
      AND NOT EXISTS (
        SELECT 1 FROM cm_history_backfill_runs AS newer
        WHERE newer.tenant_id=NEW.tenant_id AND newer.user_id=NEW.user_id
          AND newer.project_id=NEW.project_id
          AND newer.source_harness=NEW.source_harness
          AND newer.source_session_id=NEW.source_session_id
          AND newer.status='candidates_ready'
          AND (
            newer.source_observed_at > NEW.source_observed_at
            OR (newer.source_observed_at=NEW.source_observed_at
                AND newer.created_at > NEW.created_at)
            OR (newer.source_observed_at=NEW.source_observed_at
                AND newer.created_at=NEW.created_at AND newer.run_id > NEW.run_id)
          )
      );
END;

INSERT OR IGNORE INTO cm_history_publications (
    tenant_id, user_id, publication_id, run_id, candidate_id, status,
    available_at, created_at, updated_at
)
SELECT candidate.tenant_id, candidate.user_id,
    'history-publication:' || candidate.candidate_id,
    candidate.run_id, candidate.candidate_id, 'pending',
    run.updated_at, run.updated_at, run.updated_at
FROM cm_history_backfill_candidates AS candidate
JOIN cm_history_backfill_runs AS run
  ON run.tenant_id=candidate.tenant_id AND run.user_id=candidate.user_id
 AND run.run_id=candidate.run_id
WHERE candidate.stage='consolidated'
  AND candidate.receipt_id=run.consolidation_receipt_id
  AND run.status='candidates_ready'
  AND NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_runs AS newer
    WHERE newer.tenant_id=run.tenant_id AND newer.user_id=run.user_id
      AND newer.project_id=run.project_id
      AND newer.source_harness=run.source_harness
      AND newer.source_session_id=run.source_session_id
      AND newer.status='candidates_ready'
      AND (
        newer.source_observed_at > run.source_observed_at
        OR (newer.source_observed_at=run.source_observed_at
            AND newer.created_at > run.created_at)
        OR (newer.source_observed_at=run.source_observed_at
            AND newer.created_at=run.created_at AND newer.run_id > run.run_id)
      )
  );
`;
