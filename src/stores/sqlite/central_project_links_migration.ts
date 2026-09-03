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
 *  file  : src/stores/sqlite/central_project_links_migration.ts
 *  usage : implements the LongMemory central project links migration component
 */

/*
 * Migration 11 adds governed, directed project links.  A link is deliberately
 * narrower than a project subscription: it permits semantic recall of active
 * L4 memory from source_project_id into target_project_id and nothing else.
 */
export const central_project_links_migration_sql = `
CREATE TABLE cm_project_links (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    target_project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_action_id TEXT NOT NULL,
    created_channel TEXT NOT NULL CHECK (created_channel IN ('codex_ui', 'obsidian', 'local_cli')),
    created_evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_by TEXT,
    revoked_action_id TEXT,
    revoked_channel TEXT CHECK (revoked_channel IN ('codex_ui', 'obsidian', 'local_cli')),
    revoked_evidence_json TEXT NOT NULL DEFAULT '{}',
    revoked_at INTEGER,
    PRIMARY KEY (tenant_id, user_id, link_id),
    CHECK (source_project_id <> target_project_id),
    CHECK (json_type(created_evidence_json) = 'object'),
    CHECK (json_type(revoked_evidence_json) = 'object'),
    FOREIGN KEY (tenant_id, user_id, source_project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id, target_project_id)
        REFERENCES cm_projects (tenant_id, user_id, project_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX cm_project_links_one_active_direction
    ON cm_project_links (tenant_id, user_id, source_project_id, target_project_id)
    WHERE status = 'active';

CREATE INDEX cm_project_links_target
    ON cm_project_links (tenant_id, user_id, target_project_id, status, source_project_id);

CREATE TRIGGER cm_project_links_insert_active
BEFORE INSERT ON cm_project_links
WHEN NEW.status <> 'active'
  OR length(trim(NEW.created_by)) = 0
  OR length(trim(NEW.created_action_id)) = 0
  OR json_type(NEW.created_evidence_json) <> 'object'
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.created_evidence_json))
  OR NEW.revoked_by IS NOT NULL
  OR NEW.revoked_action_id IS NOT NULL
  OR NEW.revoked_channel IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM json_each(NEW.revoked_evidence_json))
BEGIN
    SELECT RAISE(ABORT, 'central project links must enter as active');
END;

CREATE TRIGGER cm_project_links_valid_revoke
BEFORE UPDATE ON cm_project_links
WHEN NOT (
    OLD.status = 'active'
    AND NEW.status = 'revoked'
    AND NEW.revoked_by IS NOT NULL
    AND length(trim(NEW.revoked_by)) > 0
    AND NEW.revoked_action_id IS NOT NULL
    AND length(trim(NEW.revoked_action_id)) > 0
    AND NEW.revoked_channel IN ('codex_ui', 'obsidian', 'local_cli')
    AND NEW.revoked_at IS NOT NULL
    AND json_type(NEW.revoked_evidence_json) = 'object'
    AND EXISTS (SELECT 1 FROM json_each(NEW.revoked_evidence_json))
    AND OLD.link_id IS NEW.link_id
    AND OLD.source_project_id IS NEW.source_project_id
    AND OLD.target_project_id IS NEW.target_project_id
    AND OLD.metadata_json IS NEW.metadata_json
    AND OLD.created_by IS NEW.created_by
    AND OLD.created_action_id IS NEW.created_action_id
    AND OLD.created_channel IS NEW.created_channel
    AND OLD.created_evidence_json IS NEW.created_evidence_json
    AND OLD.created_at IS NEW.created_at
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid central project link revocation');
END;

CREATE TRIGGER cm_project_links_no_delete
BEFORE DELETE ON cm_project_links
BEGIN
    SELECT RAISE(ABORT, 'central project links cannot be deleted');
END;

DROP INDEX IF EXISTS cm_worksets_pending;

CREATE TABLE cm_thread_worksets_v11 (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    synced_version INTEGER,
    consumed_version INTEGER,
    pending_version INTEGER,
    relevance REAL NOT NULL DEFAULT 0.5 CHECK (relevance BETWEEN 0.0 AND 1.0),
    origin TEXT NOT NULL DEFAULT 'shared'
        CHECK (origin IN ('own_thread', 'shared', 'project_map', 'subscription', 'manual', 'linked_project')),
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

INSERT INTO cm_thread_worksets_v11
    (tenant_id, user_id, thread_id, memory_id, synced_version, consumed_version,
     pending_version, relevance, origin, sync_state, last_synced_at, last_consumed_at, updated_at)
SELECT tenant_id, user_id, thread_id, memory_id, synced_version, consumed_version,
       pending_version, relevance, origin, sync_state, last_synced_at, last_consumed_at, updated_at
FROM cm_thread_worksets;

DROP TABLE cm_thread_worksets;
ALTER TABLE cm_thread_worksets_v11 RENAME TO cm_thread_worksets;

CREATE TRIGGER cm_worksets_project_scope_insert
BEFORE INSERT ON cm_thread_worksets
WHEN NOT EXISTS (
    SELECT 1
    FROM cm_threads AS thread
    JOIN cm_memories AS memory
      ON memory.tenant_id=thread.tenant_id
     AND memory.user_id=thread.user_id
     AND memory.memory_id=NEW.memory_id
    WHERE thread.tenant_id=NEW.tenant_id
      AND thread.user_id=NEW.user_id
      AND thread.thread_id=NEW.thread_id
      AND (
        (thread.project_id=memory.project_id AND NEW.origin<>'linked_project')
        OR (
            thread.project_id<>memory.project_id
            AND NEW.origin='linked_project'
            AND memory.level=4
            AND EXISTS (
                SELECT 1 FROM cm_project_links AS project_link
                WHERE project_link.tenant_id=thread.tenant_id
                  AND project_link.user_id=thread.user_id
                  AND project_link.source_project_id=memory.project_id
                  AND project_link.target_project_id=thread.project_id
                  AND project_link.status='active'
            )
        )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'central workset project scope is not authorized');
END;

CREATE TRIGGER cm_worksets_project_scope_update
BEFORE UPDATE OF thread_id, memory_id, origin ON cm_thread_worksets
WHEN NOT EXISTS (
    SELECT 1
    FROM cm_threads AS thread
    JOIN cm_memories AS memory
      ON memory.tenant_id=thread.tenant_id
     AND memory.user_id=thread.user_id
     AND memory.memory_id=NEW.memory_id
    WHERE thread.tenant_id=NEW.tenant_id
      AND thread.user_id=NEW.user_id
      AND thread.thread_id=NEW.thread_id
      AND (
        (thread.project_id=memory.project_id AND NEW.origin<>'linked_project')
        OR (
            thread.project_id<>memory.project_id
            AND NEW.origin='linked_project'
            AND memory.level=4
            AND EXISTS (
                SELECT 1 FROM cm_project_links AS project_link
                WHERE project_link.tenant_id=thread.tenant_id
                  AND project_link.user_id=thread.user_id
                  AND project_link.source_project_id=memory.project_id
                  AND project_link.target_project_id=thread.project_id
                  AND project_link.status='active'
            )
        )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'central workset project scope is not authorized');
END;

CREATE INDEX cm_worksets_pending
    ON cm_thread_worksets (tenant_id, user_id, thread_id, sync_state, relevance DESC);
`;
