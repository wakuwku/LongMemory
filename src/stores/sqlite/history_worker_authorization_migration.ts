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
 *  file  : src/stores/sqlite/history_worker_authorization_migration.ts
 *  usage : implements the LongMemory history worker authorization migration component
 */

/*
 * Machine-enforced authorization for dedicated history workers.  Grants are
 * append-only audit records; revocation is the only allowed state change.
 */

export const history_worker_authorization_migration_sql = `
CREATE TABLE cm_history_worker_authorizations (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    run_id TEXT,
    plan_id TEXT,
    scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    authorized_by TEXT NOT NULL,
    authorize_action_id TEXT NOT NULL,
    authorize_evidence_json TEXT NOT NULL
        CHECK (json_valid(authorize_evidence_json) AND json_type(authorize_evidence_json) = 'object'),
    authorized_at INTEGER NOT NULL,
    revoked_by TEXT,
    revoke_action_id TEXT,
    revoke_evidence_json TEXT
        CHECK (revoke_evidence_json IS NULL OR (
            json_valid(revoke_evidence_json) AND json_type(revoke_evidence_json) = 'object'
        )),
    revoked_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, authorization_id),
    UNIQUE (tenant_id, user_id, authorize_action_id),
    UNIQUE (tenant_id, user_id, revoke_action_id),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, worker_session_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, run_id)
        REFERENCES cm_history_backfill_runs (tenant_id, user_id, run_id) ON DELETE RESTRICT,
    CHECK (length(authorization_id) BETWEEN 1 AND 512),
    CHECK (length(project_id) BETWEEN 1 AND 1024),
    CHECK (length(worker_session_id) BETWEEN 1 AND 1024),
    CHECK (length(worker_id) BETWEEN 1 AND 256),
    CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 1024),
    CHECK (plan_id IS NULL OR length(plan_id) BETWEEN 1 AND 1024),
    CHECK (length(authorized_by) BETWEEN 1 AND 1024),
    CHECK (length(authorize_action_id) BETWEEN 1 AND 512),
    CHECK (
        (status = 'active'
            AND revoked_by IS NULL
            AND revoke_action_id IS NULL
            AND revoke_evidence_json IS NULL
            AND revoked_at IS NULL)
        OR
        (status = 'revoked'
            AND revoked_by IS NOT NULL
            AND length(revoked_by) BETWEEN 1 AND 1024
            AND revoke_action_id IS NOT NULL
            AND length(revoke_action_id) BETWEEN 1 AND 512
            AND revoke_evidence_json IS NOT NULL
            AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX cm_history_worker_authorizations_active_scope
    ON cm_history_worker_authorizations (
        tenant_id, user_id, project_id, worker_session_id, worker_id,
        ifnull(run_id, ''), ifnull(plan_id, '')
    )
    WHERE status = 'active';

CREATE INDEX cm_history_worker_authorizations_claim
    ON cm_history_worker_authorizations (
        tenant_id, user_id, worker_session_id, worker_id, project_id, status,
        run_id, plan_id
    );

CREATE TRIGGER cm_history_worker_authorizations_thread_scope_insert
BEFORE INSERT ON cm_history_worker_authorizations
WHEN NOT EXISTS (
    SELECT 1 FROM cm_threads AS thread
    WHERE thread.tenant_id = NEW.tenant_id
      AND thread.user_id = NEW.user_id
      AND thread.thread_id = NEW.worker_session_id
      AND thread.project_id = NEW.project_id
      AND thread.status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'history worker authorization requires an active task in the same project');
END;

CREATE TRIGGER cm_history_worker_authorizations_run_scope_insert
BEFORE INSERT ON cm_history_worker_authorizations
WHEN NEW.run_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.user_id = NEW.user_id
      AND run.run_id = NEW.run_id
      AND run.project_id = NEW.project_id
      AND (NEW.plan_id IS NULL OR run.plan_id = NEW.plan_id)
 )
BEGIN
    SELECT RAISE(ABORT, 'history worker run scope is outside its project or plan');
END;

CREATE TRIGGER cm_history_worker_authorizations_plan_scope_insert
BEFORE INSERT ON cm_history_worker_authorizations
WHEN NEW.plan_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.user_id = NEW.user_id
      AND run.project_id = NEW.project_id
      AND run.plan_id = NEW.plan_id
 )
BEGIN
    SELECT RAISE(ABORT, 'history worker plan scope is outside its project');
END;

CREATE TRIGGER cm_history_worker_authorizations_scope_immutable
BEFORE UPDATE ON cm_history_worker_authorizations
WHEN OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.user_id IS NOT NEW.user_id
  OR OLD.authorization_id IS NOT NEW.authorization_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.worker_session_id IS NOT NEW.worker_session_id
  OR OLD.worker_id IS NOT NEW.worker_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.scope_hash IS NOT NEW.scope_hash
  OR OLD.authorized_by IS NOT NEW.authorized_by
  OR OLD.authorize_action_id IS NOT NEW.authorize_action_id
  OR OLD.authorize_evidence_json IS NOT NEW.authorize_evidence_json
  OR OLD.authorized_at IS NOT NEW.authorized_at
BEGIN
    SELECT RAISE(ABORT, 'history worker authorization scope is immutable');
END;

CREATE TRIGGER cm_history_worker_authorizations_valid_transition
BEFORE UPDATE OF status ON cm_history_worker_authorizations
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'active' AND NEW.status = 'revoked')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid history worker authorization transition');
END;

CREATE TRIGGER cm_history_worker_authorizations_revocation_immutable
BEFORE UPDATE ON cm_history_worker_authorizations
WHEN OLD.status = 'revoked'
 AND (
    OLD.status IS NOT NEW.status
    OR OLD.revoked_by IS NOT NEW.revoked_by
    OR OLD.revoke_action_id IS NOT NEW.revoke_action_id
    OR OLD.revoke_evidence_json IS NOT NEW.revoke_evidence_json
    OR OLD.revoked_at IS NOT NEW.revoked_at
 )
BEGIN
    SELECT RAISE(ABORT, 'history worker revocation is immutable');
END;

CREATE TRIGGER cm_history_worker_authorizations_no_delete
BEFORE DELETE ON cm_history_worker_authorizations
BEGIN
    SELECT RAISE(ABORT, 'history worker authorizations cannot be deleted');
END;
`;
