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
 *  file  : src/stores/sqlite/central_memory_migration.ts
 *  usage : implements the LongMemory central memory migration component
 */

/*
 * Central-memory governance schema.
 *
 * Hydrograph remains the retrieval projection.  The cm_* tables below are
 * the authoritative, transactional source for stable memory identities,
 * versions, confirmations, thread worksets and downstream projections.
 */

export const central_memory_migration_sql = `
CREATE TABLE cm_projects (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, project_id)
);

CREATE TABLE cm_roles (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    responsibility TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, role_id),
    UNIQUE (tenant_id, user_id, project_id, role_id),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE
);

CREATE TRIGGER cm_roles_project_immutable
BEFORE UPDATE ON cm_roles
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
    SELECT RAISE(ABORT, 'central role project binding is immutable');
END;

CREATE TABLE cm_tasks (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role_id TEXT,
    title TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'blocked', 'archived')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, task_id),
    UNIQUE (tenant_id, user_id, project_id, task_id),
    UNIQUE (tenant_id, user_id, project_id, role_id, task_id),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, project_id, role_id) ON DELETE RESTRICT
);

CREATE TRIGGER cm_tasks_hierarchy_immutable
BEFORE UPDATE ON cm_tasks
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.role_id IS NOT NEW.role_id
BEGIN
    SELECT RAISE(ABORT, 'central task hierarchy is immutable');
END;

CREATE TABLE cm_threads (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role_id TEXT,
    task_id TEXT,
    responsibility TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'idle', 'completed', 'archived')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    last_safe_boundary_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, thread_id),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, project_id, role_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, task_id)
        REFERENCES cm_tasks (tenant_id, user_id, project_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id, task_id)
        REFERENCES cm_tasks (tenant_id, user_id, project_id, role_id, task_id) ON DELETE RESTRICT
);

CREATE TRIGGER cm_threads_project_immutable
BEFORE UPDATE ON cm_threads
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
    SELECT RAISE(ABORT, 'central thread project binding is immutable');
END;

CREATE TRIGGER cm_threads_task_role_consistent_insert
BEFORE INSERT ON cm_threads
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central thread task and role bindings must match');
END;

CREATE TRIGGER cm_threads_task_role_consistent_update
BEFORE UPDATE OF project_id, role_id, task_id ON cm_threads
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central thread task and role bindings must match');
END;

CREATE TABLE cm_memories (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role_id TEXT,
    task_id TEXT,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    memory_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    current_version INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, memory_id),
    FOREIGN KEY (tenant_id, user_id, project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id)
        REFERENCES cm_roles (tenant_id, user_id, project_id, role_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, task_id)
        REFERENCES cm_tasks (tenant_id, user_id, project_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, project_id, role_id, task_id)
        REFERENCES cm_tasks (tenant_id, user_id, project_id, role_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, memory_id, current_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER cm_memories_task_role_consistent_insert
BEFORE INSERT ON cm_memories
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central memory task and role bindings must match');
END;

CREATE TABLE cm_memory_versions (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL
        CHECK (status IN ('active', 'superseded', 'retracted', 'pending_confirmation', 'locked')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0.0 AND 1.0),
    is_major INTEGER NOT NULL DEFAULT 0 CHECK (is_major IN (0, 1)),
    change_reason TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    superseded_at INTEGER,
    retracted_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, memory_id, version),
    FOREIGN KEY (tenant_id, user_id, memory_id)
        REFERENCES cm_memories (tenant_id, user_id, memory_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX cm_memory_one_effective_version
    ON cm_memory_versions (tenant_id, user_id, memory_id)
    WHERE status IN ('active', 'locked');

CREATE INDEX cm_memory_versions_status
    ON cm_memory_versions (tenant_id, user_id, status, created_at);

CREATE TRIGGER cm_memory_versions_insert_pending
BEFORE INSERT ON cm_memory_versions
WHEN NEW.status <> 'pending_confirmation'
BEGIN
    SELECT RAISE(ABORT, 'central memory versions must enter through pending_confirmation');
END;

CREATE TRIGGER cm_memory_versions_immutable_payload
BEFORE UPDATE ON cm_memory_versions
WHEN OLD.title IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
  OR OLD.body IS NOT NEW.body
  OR OLD.content_hash IS NOT NEW.content_hash
  OR OLD.importance IS NOT NEW.importance
  OR OLD.is_major IS NOT NEW.is_major
  OR OLD.change_reason IS NOT NEW.change_reason
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'central memory version payloads are immutable');
END;

CREATE TRIGGER cm_memory_versions_valid_transition
BEFORE UPDATE OF status ON cm_memory_versions
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'pending_confirmation' AND NEW.status IN ('active', 'locked', 'retracted'))
    OR (OLD.status = 'active' AND NEW.status IN ('locked', 'superseded', 'retracted'))
    OR (OLD.status = 'locked' AND NEW.status IN ('superseded', 'retracted'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central memory lifecycle transition');
END;

CREATE TRIGGER cm_major_or_locked_activation_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'pending_confirmation'
 AND NEW.status IN ('active', 'locked')
 AND (
    OLD.is_major = 1
    OR NEW.status = 'locked'
    OR EXISTS (
        SELECT 1 FROM cm_memories AS memory
        WHERE memory.tenant_id = OLD.tenant_id
          AND memory.user_id = OLD.user_id
          AND memory.memory_id = OLD.memory_id
          AND memory.level = 1
    )
    OR EXISTS (
        SELECT 1 FROM cm_memory_versions AS prior
        WHERE prior.tenant_id = OLD.tenant_id
          AND prior.user_id = OLD.user_id
          AND prior.memory_id = OLD.memory_id
          AND prior.version <> OLD.version
          AND prior.is_major = 1
          AND prior.activated_at IS NOT NULL
    )
 )
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.requested_status = NEW.status
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'major or locked central memory activation requires approved confirmation');
END;

CREATE TRIGGER cm_effective_version_requires_detached_current
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status IN ('active', 'locked')
 AND NEW.status NOT IN ('active', 'locked')
 AND EXISTS (
    SELECT 1 FROM cm_memories AS memory
    WHERE memory.tenant_id=OLD.tenant_id AND memory.user_id=OLD.user_id
      AND memory.memory_id=OLD.memory_id AND memory.current_version=OLD.version
 )
BEGIN
    SELECT RAISE(ABORT, 'detach current central memory pointer before retiring its version');
END;

CREATE TRIGGER cm_memory_versions_no_delete
BEFORE DELETE ON cm_memory_versions
BEGIN
    SELECT RAISE(ABORT, 'central memory versions cannot be deleted');
END;

CREATE TRIGGER cm_memories_current_must_be_effective
BEFORE UPDATE OF current_version ON cm_memories
WHEN NEW.current_version IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_memory_versions AS version
    WHERE version.tenant_id = NEW.tenant_id
      AND version.user_id = NEW.user_id
      AND version.memory_id = NEW.memory_id
      AND version.version = NEW.current_version
      AND version.status IN ('active', 'locked')
 )
BEGIN
    SELECT RAISE(ABORT, 'current central memory version must be active or locked');
END;

CREATE TRIGGER cm_memories_hierarchy_immutable
BEFORE UPDATE ON cm_memories
WHEN OLD.project_id IS NOT NEW.project_id
  OR OLD.role_id IS NOT NEW.role_id
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.level IS NOT NEW.level
  OR OLD.memory_kind IS NOT NEW.memory_kind
BEGIN
    SELECT RAISE(ABORT, 'central memory hierarchy and kind are immutable');
END;

CREATE TABLE cm_sources (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    thread_id TEXT,
    turn_id TEXT,
    locator_json TEXT NOT NULL DEFAULT '{}',
    excerpt_hash TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, source_id)
);

CREATE TRIGGER cm_sources_immutable
BEFORE UPDATE ON cm_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory sources are immutable');
END;

CREATE TRIGGER cm_sources_no_delete
BEFORE DELETE ON cm_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory sources cannot be deleted');
END;

CREATE TABLE cm_memory_version_sources (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    evidence_role TEXT NOT NULL DEFAULT 'support',
    locator_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, user_id, memory_id, version, source_id),
    FOREIGN KEY (tenant_id, user_id, memory_id, version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, source_id)
        REFERENCES cm_sources (tenant_id, user_id, source_id) ON DELETE RESTRICT
);

CREATE TRIGGER cm_memory_version_sources_immutable
BEFORE UPDATE ON cm_memory_version_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory source links are immutable');
END;

CREATE TRIGGER cm_memory_version_sources_no_delete
BEFORE DELETE ON cm_memory_version_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory source links cannot be deleted');
END;

CREATE TABLE cm_thread_worksets (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    synced_version INTEGER,
    consumed_version INTEGER,
    pending_version INTEGER,
    relevance REAL NOT NULL DEFAULT 0.5 CHECK (relevance BETWEEN 0.0 AND 1.0),
    origin TEXT NOT NULL DEFAULT 'shared'
        CHECK (origin IN ('own_thread', 'shared', 'project_map', 'subscription', 'manual')),
    sync_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (sync_state IN ('pending', 'current', 'retracted')),
    last_synced_at INTEGER,
    last_consumed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, thread_id, memory_id),
    CHECK (consumed_version IS NULL OR synced_version IS NOT NULL),
    CHECK (consumed_version IS NULL OR consumed_version <= synced_version),
    FOREIGN KEY (tenant_id, user_id, thread_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, memory_id)
        REFERENCES cm_memories (tenant_id, user_id, memory_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, memory_id, synced_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version),
    FOREIGN KEY (tenant_id, user_id, memory_id, consumed_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version),
    FOREIGN KEY (tenant_id, user_id, memory_id, pending_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version)
);

CREATE TABLE cm_subscriptions (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    selector_kind TEXT NOT NULL
        CHECK (selector_kind IN ('memory', 'project', 'role', 'task', 'tag', 'topic')),
    selector_value TEXT NOT NULL,
    min_relevance REAL NOT NULL DEFAULT 0.0 CHECK (min_relevance BETWEEN 0.0 AND 1.0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    cursor_version INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, subscription_id),
    FOREIGN KEY (tenant_id, user_id, thread_id)
        REFERENCES cm_threads (tenant_id, user_id, thread_id) ON DELETE CASCADE
);

CREATE INDEX cm_subscriptions_selector
    ON cm_subscriptions (tenant_id, user_id, selector_kind, selector_value, enabled);

CREATE TABLE cm_dependencies (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    dependency_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task', 'artifact', 'decision', 'output')),
    subject_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    memory_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'current'
        CHECK (status IN ('current', 'needs_review', 'invalidated')),
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, user_id, dependency_id),
    UNIQUE (tenant_id, user_id, subject_kind, subject_id, memory_id, memory_version),
    FOREIGN KEY (tenant_id, user_id, memory_id, memory_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT
);

CREATE TABLE cm_confirmations (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    proposed_version INTEGER NOT NULL,
    expected_current_version INTEGER,
    requested_status TEXT NOT NULL DEFAULT 'active'
        CHECK (requested_status IN ('active', 'locked', 'retracted')),
    confirmation_kind TEXT NOT NULL
        CHECK (confirmation_kind IN ('major_rule', 'conflict', 'locked_override', 'manual')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    prompt TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    decided_by TEXT,
    decided_at INTEGER,
    decision_note TEXT NOT NULL DEFAULT '',
    decision_metadata_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, user_id, confirmation_id),
    FOREIGN KEY (tenant_id, user_id, memory_id, proposed_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE CASCADE
);

CREATE UNIQUE INDEX cm_confirmation_one_pending_operation
    ON cm_confirmations (tenant_id, user_id, memory_id, proposed_version, requested_status)
    WHERE status='pending';

CREATE TRIGGER cm_confirmations_insert_pending
BEFORE INSERT ON cm_confirmations
WHEN NEW.status <> 'pending'
  OR NEW.decided_by IS NOT NULL
  OR NEW.decided_at IS NOT NULL
  OR length(NEW.decision_note) <> 0
  OR EXISTS (SELECT 1 FROM json_each(NEW.decision_metadata_json))
BEGIN
    SELECT RAISE(ABORT, 'central confirmations must enter as undecided pending requests');
END;

CREATE TRIGGER cm_confirmations_request_immutable
BEFORE UPDATE ON cm_confirmations
WHEN OLD.confirmation_id IS NOT NEW.confirmation_id
  OR OLD.memory_id IS NOT NEW.memory_id
  OR OLD.proposed_version IS NOT NEW.proposed_version
  OR OLD.expected_current_version IS NOT NEW.expected_current_version
  OR OLD.requested_status IS NOT NEW.requested_status
  OR OLD.confirmation_kind IS NOT NEW.confirmation_kind
  OR OLD.prompt IS NOT NEW.prompt
  OR OLD.requested_by IS NOT NEW.requested_by
  OR OLD.requested_at IS NOT NEW.requested_at
  OR OLD.metadata_json IS NOT NEW.metadata_json
BEGIN
    SELECT RAISE(ABORT, 'central confirmation requests are immutable');
END;

CREATE TRIGGER cm_confirmations_valid_decision
BEFORE UPDATE ON cm_confirmations
WHEN NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('approved', 'rejected', 'cancelled')
    AND NEW.decided_by IS NOT NULL
    AND length(trim(NEW.decided_by)) > 0
    AND NEW.decided_at IS NOT NULL
    AND (
        NEW.status = 'cancelled'
        OR (
            COALESCE(json_extract(NEW.decision_metadata_json, '$.actor_kind') = 'user', 0)
            AND COALESCE(length(trim(json_extract(NEW.decision_metadata_json, '$.action_id'))) > 0, 0)
            AND COALESCE(json_extract(NEW.decision_metadata_json, '$.channel')
                IN ('codex_ui', 'obsidian', 'local_cli'), 0)
            AND COALESCE(json_type(NEW.decision_metadata_json, '$.evidence') = 'object', 0)
            AND EXISTS (
                SELECT 1 FROM json_each(
                    json_extract(NEW.decision_metadata_json, '$.evidence')
                )
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central confirmation decision or missing human evidence');
END;

CREATE TRIGGER cm_confirmations_no_delete
BEFORE DELETE ON cm_confirmations
BEGIN
    SELECT RAISE(ABORT, 'central confirmations cannot be deleted');
END;

CREATE TRIGGER cm_locked_version_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'locked'
 AND NEW.status = 'superseded'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.proposed_version <> OLD.version
      AND confirmation.requested_status IN ('active', 'locked')
      AND confirmation.confirmation_kind = 'locked_override'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'locked central memory requires approved confirmation');
END;

CREATE TRIGGER cm_lock_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'active'
 AND NEW.status = 'locked'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.requested_status = 'locked'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'locking effective central memory requires approved confirmation');
END;

CREATE TRIGGER cm_effective_retraction_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status IN ('active', 'locked')
 AND NEW.status = 'retracted'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.requested_status = 'retracted'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'retracting effective central memory requires approved confirmation');
END;

CREATE TABLE cm_memory_conflicts (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conflict_id TEXT NOT NULL,
    memory_a_id TEXT NOT NULL,
    memory_a_version INTEGER NOT NULL,
    memory_b_id TEXT NOT NULL,
    memory_b_version INTEGER NOT NULL,
    severity REAL NOT NULL CHECK (severity BETWEEN 0.0 AND 1.0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    rationale TEXT NOT NULL DEFAULT '',
    resolution_memory_id TEXT,
    resolution_version INTEGER,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, user_id, conflict_id),
    FOREIGN KEY (tenant_id, user_id, memory_a_id, memory_a_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, memory_b_id, memory_b_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, user_id, resolution_memory_id, resolution_version)
        REFERENCES cm_memory_versions (tenant_id, user_id, memory_id, version) ON DELETE RESTRICT
);

CREATE TRIGGER cm_memory_conflicts_insert_open
BEFORE INSERT ON cm_memory_conflicts
WHEN NEW.status <> 'open' OR NEW.resolved_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'central memory conflicts must enter as open');
END;

CREATE TRIGGER cm_memory_conflicts_valid_decision
BEFORE UPDATE ON cm_memory_conflicts
WHEN NOT (
    OLD.status = 'open'
    AND NEW.status IN ('resolved', 'dismissed')
    AND NEW.resolved_at IS NOT NULL
    AND COALESCE(json_extract(NEW.metadata_json, '$.decision.actor_kind') = 'user', 0)
    AND COALESCE(length(trim(json_extract(NEW.metadata_json, '$.decision.action_id'))) > 0, 0)
    AND COALESCE(json_extract(NEW.metadata_json, '$.decision.channel')
        IN ('codex_ui', 'obsidian', 'local_cli'), 0)
    AND COALESCE(json_type(NEW.metadata_json, '$.decision.evidence') = 'object', 0)
    AND EXISTS (
        SELECT 1 FROM json_each(
            json_extract(NEW.metadata_json, '$.decision.evidence')
        )
    )
    AND (
        (
            NEW.status = 'dismissed'
            AND NEW.resolution_memory_id IS NULL
            AND NEW.resolution_version IS NULL
        )
        OR (
            NEW.status = 'resolved'
            AND NEW.resolution_memory_id IS NOT NULL
            AND NEW.resolution_version IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM cm_memory_versions AS resolution
                JOIN cm_memories AS resolution_memory
                  ON resolution_memory.tenant_id = resolution.tenant_id
                 AND resolution_memory.user_id = resolution.user_id
                 AND resolution_memory.memory_id = resolution.memory_id
                JOIN cm_memories AS conflict_memory
                  ON conflict_memory.tenant_id = OLD.tenant_id
                 AND conflict_memory.user_id = OLD.user_id
                 AND conflict_memory.memory_id = OLD.memory_a_id
                WHERE resolution.tenant_id = OLD.tenant_id
                  AND resolution.user_id = OLD.user_id
                  AND resolution.memory_id = NEW.resolution_memory_id
                  AND resolution.version = NEW.resolution_version
                  AND resolution.status IN ('active', 'locked')
                  AND resolution_memory.project_id = conflict_memory.project_id
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central memory conflict decision or missing human evidence');
END;

CREATE TRIGGER cm_memory_conflicts_identity_immutable
BEFORE UPDATE ON cm_memory_conflicts
WHEN OLD.memory_a_id IS NOT NEW.memory_a_id
  OR OLD.memory_a_version IS NOT NEW.memory_a_version
  OR OLD.memory_b_id IS NOT NEW.memory_b_id
  OR OLD.memory_b_version IS NOT NEW.memory_b_version
  OR OLD.severity IS NOT NEW.severity
  OR OLD.rationale IS NOT NEW.rationale
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'central memory conflict evidence is immutable');
END;

CREATE TRIGGER cm_memory_conflicts_no_delete
BEFORE DELETE ON cm_memory_conflicts
BEGIN
    SELECT RAISE(ABORT, 'central memory conflicts cannot be deleted');
END;

CREATE INDEX cm_memory_conflicts_open
    ON cm_memory_conflicts (tenant_id, user_id, status, severity DESC);

CREATE TABLE cm_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER,
    last_error TEXT,
    UNIQUE (tenant_id, user_id, event_id)
);

CREATE INDEX cm_outbox_pending
    ON cm_outbox (tenant_id, user_id, processed_at, available_at, sequence);

CREATE INDEX cm_memories_hierarchy
    ON cm_memories (tenant_id, user_id, project_id, role_id, task_id, level);
CREATE INDEX cm_worksets_pending
    ON cm_thread_worksets (tenant_id, user_id, thread_id, sync_state, relevance DESC);
CREATE INDEX cm_dependencies_memory
    ON cm_dependencies (tenant_id, user_id, memory_id, memory_version, status);
`;

/*
 * Migration 5 deliberately recreates the governance triggers.  Migration 4
 * existed briefly without every invariant below, so changing its SQL alone
 * would leave databases that had already recorded version 4 unprotected.
 * Keep this as an immutable upgrade snapshot rather than deriving it from the
 * current migration-4 text at runtime.
 */
export const central_memory_hardening_migration_sql = `
DROP TRIGGER IF EXISTS cm_roles_project_immutable;
DROP TRIGGER IF EXISTS cm_tasks_hierarchy_immutable;
DROP TRIGGER IF EXISTS cm_threads_project_immutable;
DROP TRIGGER IF EXISTS cm_threads_task_role_consistent_insert;
DROP TRIGGER IF EXISTS cm_threads_task_role_consistent_update;
DROP TRIGGER IF EXISTS cm_memories_task_role_consistent_insert;
DROP TRIGGER IF EXISTS cm_memory_versions_insert_pending;
DROP TRIGGER IF EXISTS cm_memory_versions_immutable_payload;
DROP TRIGGER IF EXISTS cm_memory_versions_valid_transition;
DROP TRIGGER IF EXISTS cm_major_or_locked_activation_requires_confirmation;
DROP TRIGGER IF EXISTS cm_effective_version_requires_detached_current;
DROP TRIGGER IF EXISTS cm_memory_versions_no_delete;
DROP TRIGGER IF EXISTS cm_memories_current_must_be_effective;
DROP TRIGGER IF EXISTS cm_memories_hierarchy_immutable;
DROP TRIGGER IF EXISTS cm_sources_immutable;
DROP TRIGGER IF EXISTS cm_sources_no_delete;
DROP TRIGGER IF EXISTS cm_memory_version_sources_immutable;
DROP TRIGGER IF EXISTS cm_memory_version_sources_no_delete;
DROP TRIGGER IF EXISTS cm_confirmations_insert_pending;
DROP TRIGGER IF EXISTS cm_confirmations_request_immutable;
DROP TRIGGER IF EXISTS cm_confirmations_valid_decision;
DROP TRIGGER IF EXISTS cm_confirmations_no_delete;
DROP TRIGGER IF EXISTS cm_locked_version_requires_confirmation;
DROP TRIGGER IF EXISTS cm_lock_requires_confirmation;
DROP TRIGGER IF EXISTS cm_effective_retraction_requires_confirmation;
DROP TRIGGER IF EXISTS cm_memory_conflicts_insert_open;
DROP TRIGGER IF EXISTS cm_memory_conflicts_valid_decision;
DROP TRIGGER IF EXISTS cm_memory_conflicts_identity_immutable;
DROP TRIGGER IF EXISTS cm_memory_conflicts_no_delete;

CREATE TRIGGER cm_roles_project_immutable
BEFORE UPDATE ON cm_roles
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
    SELECT RAISE(ABORT, 'central role project binding is immutable');
END;

CREATE TRIGGER cm_tasks_hierarchy_immutable
BEFORE UPDATE ON cm_tasks
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.role_id IS NOT NEW.role_id
BEGIN
    SELECT RAISE(ABORT, 'central task hierarchy is immutable');
END;

CREATE TRIGGER cm_threads_project_immutable
BEFORE UPDATE ON cm_threads
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
    SELECT RAISE(ABORT, 'central thread project binding is immutable');
END;

CREATE TRIGGER cm_threads_task_role_consistent_insert
BEFORE INSERT ON cm_threads
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central thread task and role bindings must match');
END;

CREATE TRIGGER cm_threads_task_role_consistent_update
BEFORE UPDATE OF project_id, role_id, task_id ON cm_threads
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central thread task and role bindings must match');
END;

CREATE TRIGGER cm_memories_task_role_consistent_insert
BEFORE INSERT ON cm_memories
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_tasks AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.user_id = NEW.user_id
      AND task.project_id = NEW.project_id
      AND task.task_id = NEW.task_id
      AND task.role_id IS NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'central memory task and role bindings must match');
END;

CREATE TRIGGER cm_memory_versions_insert_pending
BEFORE INSERT ON cm_memory_versions
WHEN NEW.status <> 'pending_confirmation'
BEGIN
    SELECT RAISE(ABORT, 'central memory versions must enter through pending_confirmation');
END;

CREATE TRIGGER cm_memory_versions_immutable_payload
BEFORE UPDATE ON cm_memory_versions
WHEN OLD.title IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
  OR OLD.body IS NOT NEW.body
  OR OLD.content_hash IS NOT NEW.content_hash
  OR OLD.importance IS NOT NEW.importance
  OR OLD.is_major IS NOT NEW.is_major
  OR OLD.change_reason IS NOT NEW.change_reason
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'central memory version payloads are immutable');
END;

CREATE TRIGGER cm_memory_versions_valid_transition
BEFORE UPDATE OF status ON cm_memory_versions
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'pending_confirmation' AND NEW.status IN ('active', 'locked', 'retracted'))
    OR (OLD.status = 'active' AND NEW.status IN ('locked', 'superseded', 'retracted'))
    OR (OLD.status = 'locked' AND NEW.status IN ('superseded', 'retracted'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central memory lifecycle transition');
END;

CREATE TRIGGER cm_major_or_locked_activation_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'pending_confirmation'
 AND NEW.status IN ('active', 'locked')
 AND (
    OLD.is_major = 1
    OR NEW.status = 'locked'
    OR EXISTS (
        SELECT 1 FROM cm_memories AS memory
        WHERE memory.tenant_id = OLD.tenant_id
          AND memory.user_id = OLD.user_id
          AND memory.memory_id = OLD.memory_id
          AND memory.level = 1
    )
    OR EXISTS (
        SELECT 1 FROM cm_memory_versions AS prior
        WHERE prior.tenant_id = OLD.tenant_id
          AND prior.user_id = OLD.user_id
          AND prior.memory_id = OLD.memory_id
          AND prior.version <> OLD.version
          AND prior.is_major = 1
          AND prior.activated_at IS NOT NULL
    )
 )
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.requested_status = NEW.status
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'major or locked central memory activation requires approved confirmation');
END;

CREATE TRIGGER cm_effective_version_requires_detached_current
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status IN ('active', 'locked')
 AND NEW.status NOT IN ('active', 'locked')
 AND EXISTS (
    SELECT 1 FROM cm_memories AS memory
    WHERE memory.tenant_id=OLD.tenant_id AND memory.user_id=OLD.user_id
      AND memory.memory_id=OLD.memory_id AND memory.current_version=OLD.version
 )
BEGIN
    SELECT RAISE(ABORT, 'detach current central memory pointer before retiring its version');
END;

CREATE TRIGGER cm_memory_versions_no_delete
BEFORE DELETE ON cm_memory_versions
BEGIN
    SELECT RAISE(ABORT, 'central memory versions cannot be deleted');
END;

CREATE TRIGGER cm_memories_current_must_be_effective
BEFORE UPDATE OF current_version ON cm_memories
WHEN NEW.current_version IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM cm_memory_versions AS version
    WHERE version.tenant_id = NEW.tenant_id
      AND version.user_id = NEW.user_id
      AND version.memory_id = NEW.memory_id
      AND version.version = NEW.current_version
      AND version.status IN ('active', 'locked')
 )
BEGIN
    SELECT RAISE(ABORT, 'current central memory version must be active or locked');
END;

CREATE TRIGGER cm_memories_hierarchy_immutable
BEFORE UPDATE ON cm_memories
WHEN OLD.project_id IS NOT NEW.project_id
  OR OLD.role_id IS NOT NEW.role_id
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.level IS NOT NEW.level
  OR OLD.memory_kind IS NOT NEW.memory_kind
BEGIN
    SELECT RAISE(ABORT, 'central memory hierarchy and kind are immutable');
END;

CREATE TRIGGER cm_sources_immutable
BEFORE UPDATE ON cm_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory sources are immutable');
END;

CREATE TRIGGER cm_sources_no_delete
BEFORE DELETE ON cm_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory sources cannot be deleted');
END;

CREATE TRIGGER cm_memory_version_sources_immutable
BEFORE UPDATE ON cm_memory_version_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory source links are immutable');
END;

CREATE TRIGGER cm_memory_version_sources_no_delete
BEFORE DELETE ON cm_memory_version_sources
BEGIN
    SELECT RAISE(ABORT, 'central memory source links cannot be deleted');
END;

CREATE TRIGGER cm_confirmations_insert_pending
BEFORE INSERT ON cm_confirmations
WHEN NEW.status <> 'pending'
  OR NEW.decided_by IS NOT NULL
  OR NEW.decided_at IS NOT NULL
  OR length(NEW.decision_note) <> 0
  OR EXISTS (SELECT 1 FROM json_each(NEW.decision_metadata_json))
BEGIN
    SELECT RAISE(ABORT, 'central confirmations must enter as undecided pending requests');
END;

CREATE TRIGGER cm_confirmations_request_immutable
BEFORE UPDATE ON cm_confirmations
WHEN OLD.confirmation_id IS NOT NEW.confirmation_id
  OR OLD.memory_id IS NOT NEW.memory_id
  OR OLD.proposed_version IS NOT NEW.proposed_version
  OR OLD.expected_current_version IS NOT NEW.expected_current_version
  OR OLD.requested_status IS NOT NEW.requested_status
  OR OLD.confirmation_kind IS NOT NEW.confirmation_kind
  OR OLD.prompt IS NOT NEW.prompt
  OR OLD.requested_by IS NOT NEW.requested_by
  OR OLD.requested_at IS NOT NEW.requested_at
  OR OLD.metadata_json IS NOT NEW.metadata_json
BEGIN
    SELECT RAISE(ABORT, 'central confirmation requests are immutable');
END;

CREATE TRIGGER cm_confirmations_valid_decision
BEFORE UPDATE ON cm_confirmations
WHEN NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('approved', 'rejected', 'cancelled')
    AND NEW.decided_by IS NOT NULL
    AND length(trim(NEW.decided_by)) > 0
    AND NEW.decided_at IS NOT NULL
    AND (
        NEW.status = 'cancelled'
        OR (
            COALESCE(json_extract(NEW.decision_metadata_json, '$.actor_kind') = 'user', 0)
            AND COALESCE(length(trim(json_extract(NEW.decision_metadata_json, '$.action_id'))) > 0, 0)
            AND COALESCE(json_extract(NEW.decision_metadata_json, '$.channel')
                IN ('codex_ui', 'obsidian', 'local_cli'), 0)
            AND COALESCE(json_type(NEW.decision_metadata_json, '$.evidence') = 'object', 0)
            AND EXISTS (
                SELECT 1 FROM json_each(
                    json_extract(NEW.decision_metadata_json, '$.evidence')
                )
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central confirmation decision or missing human evidence');
END;

CREATE TRIGGER cm_confirmations_no_delete
BEFORE DELETE ON cm_confirmations
BEGIN
    SELECT RAISE(ABORT, 'central confirmations cannot be deleted');
END;

CREATE TRIGGER cm_locked_version_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'locked'
 AND NEW.status = 'superseded'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.proposed_version <> OLD.version
      AND confirmation.requested_status IN ('active', 'locked')
      AND confirmation.confirmation_kind = 'locked_override'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'locked central memory requires approved confirmation');
END;

CREATE TRIGGER cm_lock_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'active'
 AND NEW.status = 'locked'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.requested_status = 'locked'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'locking effective central memory requires approved confirmation');
END;

CREATE TRIGGER cm_effective_retraction_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status IN ('active', 'locked')
 AND NEW.status = 'retracted'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.expected_current_version = OLD.version
      AND confirmation.requested_status = 'retracted'
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'retracting effective central memory requires approved confirmation');
END;

CREATE TRIGGER cm_memory_conflicts_insert_open
BEFORE INSERT ON cm_memory_conflicts
WHEN NEW.status <> 'open' OR NEW.resolved_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'central memory conflicts must enter as open');
END;

CREATE TRIGGER cm_memory_conflicts_valid_decision
BEFORE UPDATE ON cm_memory_conflicts
WHEN NOT (
    OLD.status = 'open'
    AND NEW.status IN ('resolved', 'dismissed')
    AND NEW.resolved_at IS NOT NULL
    AND COALESCE(json_extract(NEW.metadata_json, '$.decision.actor_kind') = 'user', 0)
    AND COALESCE(length(trim(json_extract(NEW.metadata_json, '$.decision.action_id'))) > 0, 0)
    AND COALESCE(json_extract(NEW.metadata_json, '$.decision.channel')
        IN ('codex_ui', 'obsidian', 'local_cli'), 0)
    AND COALESCE(json_type(NEW.metadata_json, '$.decision.evidence') = 'object', 0)
    AND EXISTS (
        SELECT 1 FROM json_each(
            json_extract(NEW.metadata_json, '$.decision.evidence')
        )
    )
    AND (
        (
            NEW.status = 'dismissed'
            AND NEW.resolution_memory_id IS NULL
            AND NEW.resolution_version IS NULL
        )
        OR (
            NEW.status = 'resolved'
            AND NEW.resolution_memory_id IS NOT NULL
            AND NEW.resolution_version IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM cm_memory_versions AS resolution
                JOIN cm_memories AS resolution_memory
                  ON resolution_memory.tenant_id = resolution.tenant_id
                 AND resolution_memory.user_id = resolution.user_id
                 AND resolution_memory.memory_id = resolution.memory_id
                JOIN cm_memories AS conflict_memory
                  ON conflict_memory.tenant_id = OLD.tenant_id
                 AND conflict_memory.user_id = OLD.user_id
                 AND conflict_memory.memory_id = OLD.memory_a_id
                WHERE resolution.tenant_id = OLD.tenant_id
                  AND resolution.user_id = OLD.user_id
                  AND resolution.memory_id = NEW.resolution_memory_id
                  AND resolution.version = NEW.resolution_version
                  AND resolution.status IN ('active', 'locked')
                  AND resolution_memory.project_id = conflict_memory.project_id
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid central memory conflict decision or missing human evidence');
END;

CREATE TRIGGER cm_memory_conflicts_identity_immutable
BEFORE UPDATE ON cm_memory_conflicts
WHEN OLD.memory_a_id IS NOT NEW.memory_a_id
  OR OLD.memory_a_version IS NOT NEW.memory_a_version
  OR OLD.memory_b_id IS NOT NEW.memory_b_id
  OR OLD.memory_b_version IS NOT NEW.memory_b_version
  OR OLD.severity IS NOT NEW.severity
  OR OLD.rationale IS NOT NEW.rationale
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'central memory conflict evidence is immutable');
END;

CREATE TRIGGER cm_memory_conflicts_no_delete
BEFORE DELETE ON cm_memory_conflicts
BEGIN
    SELECT RAISE(ABORT, 'central memory conflicts cannot be deleted');
END;
`;

/*
 * Migration 6 protects the tombstone boundary for databases that already
 * recorded the earlier central-memory migrations.  It intentionally keys off
 * the latest previously activated version: a retracted latest version means
 * this activation is a revival, while an approved revival followed by an
 * ordinary replacement has a newer superseded version and is not over-gated.
 */
export const central_memory_tombstone_revival_migration_sql = `
DROP TRIGGER IF EXISTS cm_tombstone_revival_requires_confirmation;

CREATE TRIGGER cm_tombstone_revival_requires_confirmation
BEFORE UPDATE OF status ON cm_memory_versions
WHEN OLD.status = 'pending_confirmation'
 AND NEW.status IN ('active', 'locked')
 AND (
    SELECT prior.status
    FROM cm_memory_versions AS prior
    WHERE prior.tenant_id = OLD.tenant_id
      AND prior.user_id = OLD.user_id
      AND prior.memory_id = OLD.memory_id
      AND prior.version <> OLD.version
      AND prior.activated_at IS NOT NULL
    ORDER BY prior.version DESC
    LIMIT 1
 ) = 'retracted'
 AND NOT EXISTS (
    SELECT 1 FROM cm_confirmations AS confirmation
    WHERE confirmation.tenant_id = OLD.tenant_id
      AND confirmation.user_id = OLD.user_id
      AND confirmation.memory_id = OLD.memory_id
      AND confirmation.proposed_version = OLD.version
      AND confirmation.expected_current_version IS NULL
      AND confirmation.requested_status = NEW.status
      AND confirmation.status = 'approved'
 )
BEGIN
    SELECT RAISE(ABORT, 'reviving retracted central memory requires approved confirmation');
END;
`;
