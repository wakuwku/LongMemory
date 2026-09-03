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
 *  file  : src/stores/sqlite/central_memory_repository.ts
 *  usage : implements the LongMemory central memory repository component
 */

import type Database from 'better-sqlite3';
import type {
    central_confirmation,
    central_dependency,
    central_effective_status,
    central_metadata,
    central_memory,
    central_memory_conflict,
    central_memory_context_entry,
    central_memory_scope,
    central_memory_status,
    central_memory_version,
    central_outbox_event,
    central_project,
    central_project_link,
    central_role,
    central_source,
    central_subscription,
    central_task,
    central_thread,
    central_thread_workset,
} from '../../core/central_memory/types.js';
import { central_memory_conflict_error } from '../../core/central_memory/types.js';
import { assert_no_obvious_credentials } from '../../core/central_memory/sensitive_content.js';
import { hash_canonical } from '../../core/hash/content_hash.js';
import type { central_recall_candidate } from '../../core/central_memory/recall.js';

type row = Record<string, unknown>;

function json(value: unknown): string {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value ?? {});
    } catch {
        throw new Error('central JSON value must be serializable');
    }
    if (serialized === undefined) throw new Error('central JSON value must be serializable');
    assert_no_obvious_credentials({ central_json_value: JSON.parse(serialized) as unknown });
    return serialized;
}

function parse_json(value: unknown): central_metadata {
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as central_metadata
            : {};
    } catch {
        return {};
    }
}

const number_or_null = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const string_or_null = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

function map_project(value: row): central_project {
    return {
        project_id: String(value.project_id),
        name: String(value.name),
        description: String(value.description),
        status: value.status as central_project['status'],
        metadata: parse_json(value.metadata_json),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_project_link(value: row): central_project_link {
    return {
        link_id: String(value.link_id),
        source_project_id: String(value.source_project_id),
        target_project_id: String(value.target_project_id),
        status: value.status as central_project_link['status'],
        metadata: parse_json(value.metadata_json),
        created_by: String(value.created_by),
        created_action_id: String(value.created_action_id),
        created_channel: value.created_channel as central_project_link['created_channel'],
        created_evidence: parse_json(value.created_evidence_json),
        created_at: Number(value.created_at),
        revoked_by: string_or_null(value.revoked_by),
        revoked_action_id: string_or_null(value.revoked_action_id),
        revoked_channel: value.revoked_channel === null || value.revoked_channel === undefined
            ? null : value.revoked_channel as central_project_link['revoked_channel'],
        revoked_evidence: parse_json(value.revoked_evidence_json),
        revoked_at: number_or_null(value.revoked_at),
    };
}

function map_role(value: row): central_role {
    return {
        role_id: String(value.role_id),
        project_id: String(value.project_id),
        name: String(value.name),
        responsibility: String(value.responsibility),
        status: value.status as central_role['status'],
        metadata: parse_json(value.metadata_json),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_task(value: row): central_task {
    return {
        task_id: String(value.task_id),
        project_id: String(value.project_id),
        role_id: string_or_null(value.role_id),
        title: String(value.title),
        objective: String(value.objective),
        status: value.status as central_task['status'],
        metadata: parse_json(value.metadata_json),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_thread(value: row): central_thread {
    return {
        thread_id: String(value.thread_id),
        project_id: String(value.project_id),
        role_id: string_or_null(value.role_id),
        task_id: string_or_null(value.task_id),
        responsibility: String(value.responsibility),
        status: value.status as central_thread['status'],
        metadata: parse_json(value.metadata_json),
        last_safe_boundary_at: number_or_null(value.last_safe_boundary_at),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_memory(value: row): central_memory {
    return {
        memory_id: String(value.memory_id),
        project_id: String(value.project_id),
        role_id: string_or_null(value.role_id),
        task_id: string_or_null(value.task_id),
        level: Number(value.level) as central_memory['level'],
        memory_kind: String(value.memory_kind),
        title: String(value.title),
        current_version: number_or_null(value.current_version),
        metadata: parse_json(value.metadata_json),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_version(value: row): central_memory_version {
    return {
        memory_id: String(value.memory_id),
        version: Number(value.version),
        status: value.status as central_memory_status,
        title: String(value.title),
        summary: String(value.summary),
        body: String(value.body),
        content_hash: String(value.content_hash),
        importance: Number(value.importance),
        is_major: Boolean(value.is_major),
        change_reason: String(value.change_reason),
        metadata: parse_json(value.metadata_json),
        created_by: String(value.created_by),
        created_at: Number(value.created_at),
        activated_at: number_or_null(value.activated_at),
        superseded_at: number_or_null(value.superseded_at),
        retracted_at: number_or_null(value.retracted_at),
    };
}

function map_confirmation(value: row): central_confirmation {
    return {
        confirmation_id: String(value.confirmation_id),
        memory_id: String(value.memory_id),
        proposed_version: Number(value.proposed_version),
        expected_current_version: number_or_null(value.expected_current_version),
        requested_status: value.requested_status as central_confirmation['requested_status'],
        confirmation_kind: value.confirmation_kind as central_confirmation['confirmation_kind'],
        status: value.status as central_confirmation['status'],
        prompt: String(value.prompt),
        requested_by: String(value.requested_by),
        requested_at: Number(value.requested_at),
        decided_by: string_or_null(value.decided_by),
        decided_at: number_or_null(value.decided_at),
        decision_note: String(value.decision_note),
        decision_metadata: parse_json(value.decision_metadata_json),
        metadata: parse_json(value.metadata_json),
    };
}

function map_conflict(value: row): central_memory_conflict {
    return {
        conflict_id: String(value.conflict_id),
        memory_a_id: String(value.memory_a_id),
        memory_a_version: Number(value.memory_a_version),
        memory_b_id: String(value.memory_b_id),
        memory_b_version: Number(value.memory_b_version),
        severity: Number(value.severity),
        status: value.status as central_memory_conflict['status'],
        rationale: String(value.rationale),
        resolution_memory_id: string_or_null(value.resolution_memory_id),
        resolution_version: number_or_null(value.resolution_version),
        created_at: Number(value.created_at),
        resolved_at: number_or_null(value.resolved_at),
        metadata: parse_json(value.metadata_json),
    };
}

function map_workset(value: row): central_thread_workset {
    return {
        thread_id: String(value.thread_id),
        memory_id: String(value.memory_id),
        synced_version: number_or_null(value.synced_version),
        consumed_version: number_or_null(value.consumed_version),
        pending_version: number_or_null(value.pending_version),
        relevance: Number(value.relevance),
        origin: value.origin as central_thread_workset['origin'],
        sync_state: value.sync_state as central_thread_workset['sync_state'],
        last_synced_at: number_or_null(value.last_synced_at),
        last_consumed_at: number_or_null(value.last_consumed_at),
        updated_at: Number(value.updated_at),
    };
}

function stronger_workset_origin(
    current: central_thread_workset['origin'],
    incoming: central_thread_workset['origin'],
): central_thread_workset['origin'] {
    const priority: Record<central_thread_workset['origin'], number> = {
        own_thread: 5,
        manual: 4,
        project_map: 3,
        subscription: 2,
        shared: 1,
        linked_project: 0,
    };
    return priority[current] >= priority[incoming] ? current : incoming;
}

function map_subscription(value: row): central_subscription {
    return {
        subscription_id: String(value.subscription_id),
        thread_id: String(value.thread_id),
        selector_kind: value.selector_kind as central_subscription['selector_kind'],
        selector_value: String(value.selector_value),
        min_relevance: Number(value.min_relevance),
        enabled: Boolean(value.enabled),
        cursor_version: number_or_null(value.cursor_version),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_dependency(value: row): central_dependency {
    return {
        dependency_id: String(value.dependency_id),
        subject_kind: value.subject_kind as central_dependency['subject_kind'],
        subject_id: String(value.subject_id),
        memory_id: String(value.memory_id),
        memory_version: Number(value.memory_version),
        status: value.status as central_dependency['status'],
        details: parse_json(value.details_json),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
    };
}

function map_outbox(value: row): central_outbox_event {
    return {
        sequence: Number(value.sequence),
        event_id: String(value.event_id),
        aggregate_kind: String(value.aggregate_kind),
        aggregate_id: String(value.aggregate_id),
        aggregate_version: number_or_null(value.aggregate_version),
        event_type: String(value.event_type),
        payload: parse_json(value.payload_json),
        created_at: Number(value.created_at),
        available_at: Number(value.available_at),
        attempts: Number(value.attempts),
        processed_at: number_or_null(value.processed_at),
        last_error: string_or_null(value.last_error),
    };
}

export type central_memory_repository_options = central_memory_scope & { now?: () => number };

export class CentralMemoryRepository {
    readonly tenant_id: string;
    readonly user_id: string;
    private readonly now: () => number;

    constructor(readonly database: Database.Database, options: central_memory_repository_options) {
        this.tenant_id = options.tenant_id;
        this.user_id = options.user_id;
        this.now = options.now ?? (() => Date.now());
    }

    transaction<T>(operation: () => T): T {
        const transaction = this.database.transaction(operation);
        return this.database.inTransaction ? transaction() : transaction.immediate();
    }

    register_project(input: {
        project_id: string; name: string; description?: string; status?: central_project['status'];
        metadata?: Record<string, unknown>; at?: number;
    }): central_project {
        assert_no_obvious_credentials({ central_project: input });
        const at = input.at ?? this.now();
        this.database.prepare(`INSERT INTO cm_projects
            (tenant_id, user_id, project_id, name, description, status, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, user_id, project_id) DO UPDATE SET
                name=excluded.name, description=excluded.description, status=excluded.status,
                metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.project_id, input.name, input.description ?? '',
                input.status ?? 'active', json(input.metadata), at, at);
        return this.require_project(input.project_id);
    }

    require_project(project_id: string): central_project {
        const value = this.database.prepare(`SELECT * FROM cm_projects
            WHERE tenant_id=? AND user_id=? AND project_id=?`)
            .get(this.tenant_id, this.user_id, project_id) as row | undefined;
        if (!value) throw new Error(`central project ${project_id} was not found`);
        return map_project(value);
    }

    create_project_link(input: {
        link_id: string;
        source_project_id: string;
        target_project_id: string;
        metadata: central_metadata;
        created_by: string;
        created_action_id: string;
        created_channel: central_project_link['created_channel'];
        created_evidence: central_metadata;
        at?: number;
    }): central_project_link {
        assert_no_obvious_credentials({ central_project_link: input });
        const at = input.at ?? this.now();
        this.require_project(input.source_project_id);
        this.require_project(input.target_project_id);
        this.database.prepare(`INSERT INTO cm_project_links
            (tenant_id, user_id, link_id, source_project_id, target_project_id, status,
             metadata_json, created_by, created_action_id, created_channel,
             created_evidence_json, created_at, revoked_by, revoked_action_id,
             revoked_channel, revoked_evidence_json, revoked_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '{}', NULL)`)
            .run(this.tenant_id, this.user_id, input.link_id, input.source_project_id,
                input.target_project_id, json(input.metadata), input.created_by,
                input.created_action_id, input.created_channel, json(input.created_evidence), at);
        return this.require_project_link(input.link_id);
    }

    require_project_link(link_id: string): central_project_link {
        const value = this.database.prepare(`SELECT * FROM cm_project_links
            WHERE tenant_id=? AND user_id=? AND link_id=?`)
            .get(this.tenant_id, this.user_id, link_id) as row | undefined;
        if (!value) throw new Error(`central project link ${link_id} was not found`);
        return map_project_link(value);
    }

    find_active_project_link(source_project_id: string, target_project_id: string): central_project_link | null {
        const value = this.database.prepare(`SELECT * FROM cm_project_links
            WHERE tenant_id=? AND user_id=? AND source_project_id=? AND target_project_id=?
              AND status='active'`)
            .get(this.tenant_id, this.user_id, source_project_id, target_project_id) as row | undefined;
        return value ? map_project_link(value) : null;
    }

    list_project_links(input: {
        project_id?: string;
        status?: central_project_link['status'];
    } = {}): central_project_link[] {
        const values = input.project_id === undefined
            ? input.status === undefined
                ? this.database.prepare(`SELECT * FROM cm_project_links
                    WHERE tenant_id=? AND user_id=?
                    ORDER BY created_at, link_id`).all(this.tenant_id, this.user_id)
                : this.database.prepare(`SELECT * FROM cm_project_links
                    WHERE tenant_id=? AND user_id=? AND status=?
                    ORDER BY created_at, link_id`).all(this.tenant_id, this.user_id, input.status)
            : input.status === undefined
                ? this.database.prepare(`SELECT * FROM cm_project_links
                    WHERE tenant_id=? AND user_id=?
                      AND (source_project_id=? OR target_project_id=?)
                    ORDER BY created_at, link_id`)
                    .all(this.tenant_id, this.user_id, input.project_id, input.project_id)
                : this.database.prepare(`SELECT * FROM cm_project_links
                    WHERE tenant_id=? AND user_id=? AND status=?
                      AND (source_project_id=? OR target_project_id=?)
                    ORDER BY created_at, link_id`)
                    .all(this.tenant_id, this.user_id, input.status, input.project_id, input.project_id);
        return (values as row[]).map(map_project_link);
    }

    revoke_project_link(input: {
        link_id: string;
        revoked_by: string;
        revoked_action_id: string;
        revoked_channel: NonNullable<central_project_link['revoked_channel']>;
        revoked_evidence: central_metadata;
        at?: number;
    }): central_project_link {
        assert_no_obvious_credentials({ central_project_link_revocation: input });
        const at = input.at ?? this.now();
        const result = this.database.prepare(`UPDATE cm_project_links SET
                status='revoked', revoked_by=?, revoked_action_id=?, revoked_channel=?,
                revoked_evidence_json=?, revoked_at=?
            WHERE tenant_id=? AND user_id=? AND link_id=? AND status='active'`)
            .run(input.revoked_by, input.revoked_action_id, input.revoked_channel,
                json(input.revoked_evidence), at, this.tenant_id, this.user_id, input.link_id);
        if (result.changes !== 1) throw new Error(`central project link ${input.link_id} is not active`);
        return this.require_project_link(input.link_id);
    }

    retract_linked_project_worksets(
        source_project_id: string,
        target_project_id: string,
        at = this.now(),
    ): number {
        return this.database.prepare(`UPDATE cm_thread_worksets SET
                pending_version=NULL, sync_state='retracted', updated_at=?
            WHERE tenant_id=? AND user_id=? AND origin='linked_project'
              AND EXISTS (
                SELECT 1 FROM cm_threads AS thread
                WHERE thread.tenant_id=cm_thread_worksets.tenant_id
                  AND thread.user_id=cm_thread_worksets.user_id
                  AND thread.thread_id=cm_thread_worksets.thread_id
                  AND thread.project_id=?
              )
              AND EXISTS (
                SELECT 1 FROM cm_memories AS memory
                WHERE memory.tenant_id=cm_thread_worksets.tenant_id
                  AND memory.user_id=cm_thread_worksets.user_id
                  AND memory.memory_id=cm_thread_worksets.memory_id
                  AND memory.project_id=?
              )`)
            .run(at, this.tenant_id, this.user_id, target_project_id, source_project_id).changes;
    }

    register_role(input: {
        role_id: string; project_id: string; name: string; responsibility?: string;
        status?: central_role['status']; metadata?: Record<string, unknown>; at?: number;
    }): central_role {
        assert_no_obvious_credentials({ central_role: input });
        const at = input.at ?? this.now();
        const existing = this.get_role(input.role_id);
        if (existing && existing.project_id !== input.project_id) {
            throw new Error(`central role ${input.role_id} belongs to project ${existing.project_id}, not ${input.project_id}`);
        }
        this.database.prepare(`INSERT INTO cm_roles
            (tenant_id, user_id, role_id, project_id, name, responsibility, status, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET
                name=excluded.name, responsibility=excluded.responsibility, status=excluded.status,
                metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.role_id, input.project_id, input.name,
                input.responsibility ?? '', input.status ?? 'active', json(input.metadata), at, at);
        return this.require_role(input.role_id);
    }

    get_role(role_id: string): central_role | null {
        const value = this.database.prepare(`SELECT * FROM cm_roles
            WHERE tenant_id=? AND user_id=? AND role_id=?`)
            .get(this.tenant_id, this.user_id, role_id) as row | undefined;
        return value ? map_role(value) : null;
    }

    require_role(role_id: string): central_role {
        const value = this.get_role(role_id);
        if (!value) throw new Error(`central role ${role_id} was not found`);
        return value;
    }

    register_task(input: {
        task_id: string; project_id: string; role_id?: string | null; title: string; objective?: string;
        status?: central_task['status']; metadata?: Record<string, unknown>; at?: number;
    }): central_task {
        assert_no_obvious_credentials({ central_task: input });
        const at = input.at ?? this.now();
        const existing = this.get_task(input.task_id);
        if (existing && (existing.project_id !== input.project_id || existing.role_id !== (input.role_id ?? null))) {
            throw new Error(`central task ${input.task_id} hierarchy is immutable`);
        }
        this.database.prepare(`INSERT INTO cm_tasks
            (tenant_id, user_id, task_id, project_id, role_id, title, objective, status, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, user_id, task_id) DO UPDATE SET
                title=excluded.title, objective=excluded.objective, status=excluded.status,
                metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.task_id, input.project_id, input.role_id ?? null,
                input.title, input.objective ?? '', input.status ?? 'active', json(input.metadata), at, at);
        return this.require_task(input.task_id);
    }

    get_task(task_id: string): central_task | null {
        const value = this.database.prepare(`SELECT * FROM cm_tasks
            WHERE tenant_id=? AND user_id=? AND task_id=?`)
            .get(this.tenant_id, this.user_id, task_id) as row | undefined;
        return value ? map_task(value) : null;
    }

    require_task(task_id: string): central_task {
        const value = this.get_task(task_id);
        if (!value) throw new Error(`central task ${task_id} was not found`);
        return value;
    }

    register_thread(input: {
        thread_id: string; project_id: string; role_id?: string | null; task_id?: string | null;
        responsibility?: string; status?: central_thread['status']; metadata?: Record<string, unknown>; at?: number;
    }): central_thread {
        assert_no_obvious_credentials({ central_thread: input });
        const at = input.at ?? this.now();
        const existing = this.get_thread(input.thread_id);
        if (existing && existing.project_id !== input.project_id) {
            throw new Error(`central thread ${input.thread_id} belongs to project ${existing.project_id}, not ${input.project_id}`);
        }
        this.database.prepare(`INSERT INTO cm_threads
            (tenant_id, user_id, thread_id, project_id, role_id, task_id, responsibility, status,
             metadata_json, last_safe_boundary_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT (tenant_id, user_id, thread_id) DO UPDATE SET
                project_id=excluded.project_id, role_id=excluded.role_id, task_id=excluded.task_id,
                responsibility=excluded.responsibility, status=excluded.status,
                metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.thread_id, input.project_id, input.role_id ?? null,
                input.task_id ?? null, input.responsibility ?? '', input.status ?? 'active',
                json(input.metadata), at, at);
        return this.require_thread(input.thread_id);
    }

    require_thread(thread_id: string): central_thread {
        const value = this.get_thread(thread_id);
        if (!value) throw new Error(`central thread ${thread_id} was not found`);
        return value;
    }

    get_thread(thread_id: string): central_thread | null {
        const value = this.database.prepare(`SELECT * FROM cm_threads
            WHERE tenant_id=? AND user_id=? AND thread_id=?`)
            .get(this.tenant_id, this.user_id, thread_id) as row | undefined;
        return value ? map_thread(value) : null;
    }

    touch_safe_boundary(thread_id: string, at = this.now()): void {
        const result = this.database.prepare(`UPDATE cm_threads
            SET last_safe_boundary_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND thread_id=?`)
            .run(at, at, this.tenant_id, this.user_id, thread_id);
        if (result.changes !== 1) throw new Error(`central thread ${thread_id} was not found`);
    }

    insert_memory(input: {
        memory_id: string; project_id: string; role_id?: string | null; task_id?: string | null;
        level: central_memory['level']; memory_kind: string; title: string;
        metadata?: Record<string, unknown>; at?: number;
    }): central_memory {
        assert_no_obvious_credentials({ central_memory_record: input });
        const at = input.at ?? this.now();
        this.database.prepare(`INSERT INTO cm_memories
            (tenant_id, user_id, memory_id, project_id, role_id, task_id, level, memory_kind,
             title, current_version, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.memory_id, input.project_id, input.role_id ?? null,
                input.task_id ?? null, input.level, input.memory_kind, input.title,
                json(input.metadata), at, at);
        return this.require_memory(input.memory_id);
    }

    get_memory(memory_id: string): central_memory | null {
        const value = this.database.prepare(`SELECT * FROM cm_memories
            WHERE tenant_id=? AND user_id=? AND memory_id=?`)
            .get(this.tenant_id, this.user_id, memory_id) as row | undefined;
        return value ? map_memory(value) : null;
    }

    require_memory(memory_id: string): central_memory {
        const value = this.get_memory(memory_id);
        if (!value) throw new Error(`central memory ${memory_id} was not found`);
        return value;
    }

    next_version(memory_id: string): number {
        const value = this.database.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS next_version
            FROM cm_memory_versions WHERE tenant_id=? AND user_id=? AND memory_id=?`)
            .get(this.tenant_id, this.user_id, memory_id) as { next_version: number };
        return Number(value.next_version);
    }

    insert_version(input: Omit<central_memory_version,
        'activated_at' | 'superseded_at' | 'retracted_at'> & {
            activated_at?: number | null; superseded_at?: number | null; retracted_at?: number | null;
        }): central_memory_version {
        assert_no_obvious_credentials({ central_memory_version: input });
        this.database.prepare(`INSERT INTO cm_memory_versions
            (tenant_id, user_id, memory_id, version, status, title, summary, body, content_hash,
             importance, is_major, change_reason, metadata_json, created_by, created_at,
             activated_at, superseded_at, retracted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.memory_id, input.version, input.status,
                input.title, input.summary, input.body, input.content_hash, input.importance,
                Number(input.is_major), input.change_reason, json(input.metadata), input.created_by,
                input.created_at, input.activated_at ?? null, input.superseded_at ?? null,
                input.retracted_at ?? null);
        return this.require_version(input.memory_id, input.version);
    }

    get_version(memory_id: string, version: number): central_memory_version | null {
        const value = this.database.prepare(`SELECT * FROM cm_memory_versions
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND version=?`)
            .get(this.tenant_id, this.user_id, memory_id, version) as row | undefined;
        return value ? map_version(value) : null;
    }

    require_version(memory_id: string, version: number): central_memory_version {
        const value = this.get_version(memory_id, version);
        if (!value) throw new Error(`central memory ${memory_id}@${version} was not found`);
        return value;
    }

    current_version(memory_id: string): central_memory_version | null {
        const memory = this.require_memory(memory_id);
        return memory.current_version === null ? null : this.require_version(memory_id, memory.current_version);
    }

    list_versions(memory_id: string): central_memory_version[] {
        return (this.database.prepare(`SELECT * FROM cm_memory_versions
            WHERE tenant_id=? AND user_id=? AND memory_id=? ORDER BY version`)
            .all(this.tenant_id, this.user_id, memory_id) as row[]).map(map_version);
    }

    list_effective_memories(project_id?: string): central_memory[] {
        const values = project_id === undefined
            ? this.database.prepare(`SELECT memory.* FROM cm_memories AS memory
                JOIN cm_memory_versions AS version
                  ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
                 AND version.memory_id=memory.memory_id AND version.version=memory.current_version
                WHERE memory.tenant_id=? AND memory.user_id=? AND version.status IN ('active', 'locked')
                ORDER BY memory.level, memory.memory_id`)
                .all(this.tenant_id, this.user_id)
            : this.database.prepare(`SELECT memory.* FROM cm_memories AS memory
                JOIN cm_memory_versions AS version
                  ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
                 AND version.memory_id=memory.memory_id AND version.version=memory.current_version
                WHERE memory.tenant_id=? AND memory.user_id=? AND memory.project_id=?
                  AND version.status IN ('active', 'locked')
                ORDER BY memory.level, memory.memory_id`)
                .all(this.tenant_id, this.user_id, project_id);
        return (values as row[]).map(map_memory);
    }

    private update_version_status(memory_id: string, version: number, status: central_memory_status, at = this.now()): central_memory_version {
        const result = this.database.prepare(`UPDATE cm_memory_versions SET
                status=?,
                activated_at=CASE WHEN ? IN ('active', 'locked') THEN COALESCE(activated_at, ?) ELSE activated_at END,
                superseded_at=CASE WHEN ?='superseded' THEN ? ELSE superseded_at END,
                retracted_at=CASE WHEN ?='retracted' THEN ? ELSE retracted_at END
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND version=?`)
            .run(status, status, at, status, at, status, at,
                this.tenant_id, this.user_id, memory_id, version);
        if (result.changes !== 1) throw new Error(`central memory ${memory_id}@${version} was not found`);
        return this.require_version(memory_id, version);
    }

    private set_current_version(
        memory_id: string,
        expected: number | null,
        next: number | null,
        title: string,
        metadata: central_metadata | null,
        at = this.now(),
    ): boolean {
        const result = this.database.prepare(`UPDATE cm_memories
            SET current_version=?, title=?,
                metadata_json=CASE WHEN ? IS NULL THEN metadata_json ELSE ? END,
                updated_at=?
            WHERE tenant_id=? AND user_id=? AND memory_id=?
              AND ((current_version IS NULL AND ? IS NULL) OR current_version=?)`)
            .run(next, title, metadata === null ? null : json(metadata), metadata === null ? null : json(metadata),
                at, this.tenant_id, this.user_id, memory_id, expected, expected);
        return result.changes === 1;
    }

    activate_candidate(
        memory_id: string,
        expected_current_version: number | null,
        candidate_version: number,
        target_status: central_effective_status,
        at = this.now(),
    ): central_memory_version {
        return this.transaction(() => {
            const memory = this.require_memory(memory_id);
            if (memory.current_version !== expected_current_version) {
                throw new central_memory_conflict_error(memory_id, expected_current_version, memory.current_version);
            }
            const candidate = this.require_version(memory_id, candidate_version);
            if (candidate.status !== 'pending_confirmation') {
                throw new Error(`central memory ${memory_id}@${candidate_version} is not pending confirmation`);
            }
            if (expected_current_version !== null) {
                if (!this.set_current_version(memory_id, expected_current_version, null, memory.title, null, at)) {
                    throw new central_memory_conflict_error(
                        memory_id,
                        expected_current_version,
                        this.require_memory(memory_id).current_version,
                    );
                }
                this.update_version_status(memory_id, expected_current_version, 'superseded', at);
            }
            const activated = this.update_version_status(memory_id, candidate_version, target_status, at);
            if (!this.set_current_version(memory_id, null, candidate_version, candidate.title, candidate.metadata, at)) {
                throw new central_memory_conflict_error(memory_id, null, this.require_memory(memory_id).current_version);
            }
            return activated;
        });
    }

    lock_current_version(memory_id: string, expected_current_version: number, at = this.now()): central_memory_version {
        return this.transaction(() => {
            const memory = this.require_memory(memory_id);
            if (memory.current_version !== expected_current_version) {
                throw new central_memory_conflict_error(memory_id, expected_current_version, memory.current_version);
            }
            const current = this.require_version(memory_id, expected_current_version);
            if (current.status === 'locked') return current;
            if (current.status !== 'active') {
                throw new Error(`central memory ${memory_id}@${expected_current_version} is not active`);
            }
            return this.update_version_status(memory_id, expected_current_version, 'locked', at);
        });
    }

    retract_current_version(memory_id: string, expected_current_version: number, at = this.now()): central_memory_version {
        return this.transaction(() => {
            const memory = this.require_memory(memory_id);
            if (memory.current_version !== expected_current_version) {
                throw new central_memory_conflict_error(memory_id, expected_current_version, memory.current_version);
            }
            const current = this.require_version(memory_id, expected_current_version);
            if (current.status !== 'active' && current.status !== 'locked') {
                throw new Error(`central memory ${memory_id}@${expected_current_version} is not effective`);
            }
            if (!this.set_current_version(memory_id, expected_current_version, null, memory.title, null, at)) {
                throw new central_memory_conflict_error(
                    memory_id,
                    expected_current_version,
                    this.require_memory(memory_id).current_version,
                );
            }
            return this.update_version_status(memory_id, expected_current_version, 'retracted', at);
        });
    }

    reject_candidate(memory_id: string, version: number, at = this.now()): central_memory_version {
        const candidate = this.require_version(memory_id, version);
        if (candidate.status !== 'pending_confirmation') {
            throw new Error(`central memory ${memory_id}@${version} is not pending confirmation`);
        }
        return this.update_version_status(memory_id, version, 'retracted', at);
    }

    upsert_source(input: Omit<central_source, never>): central_source {
        assert_no_obvious_credentials({ central_source: input });
        this.database.prepare(`INSERT OR IGNORE INTO cm_sources
            (tenant_id, user_id, source_id, source_kind, uri, thread_id, turn_id, locator_json,
             excerpt_hash, metadata_json, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.source_id, input.source_kind, input.uri,
                input.thread_id, input.turn_id, json(input.locator), input.excerpt_hash,
                json(input.metadata), input.recorded_at);
        const value = this.database.prepare(`SELECT * FROM cm_sources
            WHERE tenant_id=? AND user_id=? AND source_id=?`)
            .get(this.tenant_id, this.user_id, input.source_id) as row;
        const source: central_source = {
            source_id: String(value.source_id), source_kind: String(value.source_kind), uri: String(value.uri),
            thread_id: string_or_null(value.thread_id), turn_id: string_or_null(value.turn_id),
            locator: parse_json(value.locator_json), excerpt_hash: string_or_null(value.excerpt_hash),
            metadata: parse_json(value.metadata_json), recorded_at: Number(value.recorded_at),
        };
        const normalized_input: central_source = {
            ...input,
            locator: parse_json(json(input.locator)),
            metadata: parse_json(json(input.metadata)),
        };
        if (hash_canonical(source) !== hash_canonical(normalized_input)) {
            throw new Error(`central source ${input.source_id} is immutable and already has different content`);
        }
        return source;
    }

    link_source(memory_id: string, version: number, source_id: string, evidence_role = 'support', locator: Record<string, unknown> = {}): void {
        assert_no_obvious_credentials({
            central_source_link: { memory_id, version, source_id, evidence_role, locator },
        });
        this.database.prepare(`INSERT OR IGNORE INTO cm_memory_version_sources
            (tenant_id, user_id, memory_id, version, source_id, evidence_role, locator_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, memory_id, version, source_id, evidence_role, json(locator));
        const value = this.database.prepare(`SELECT evidence_role, locator_json
            FROM cm_memory_version_sources
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND version=? AND source_id=?`)
            .get(this.tenant_id, this.user_id, memory_id, version, source_id) as row;
        const expected = { evidence_role, locator: parse_json(json(locator)) };
        const actual = { evidence_role: String(value.evidence_role), locator: parse_json(value.locator_json) };
        if (hash_canonical(expected) !== hash_canonical(actual)) {
            throw new Error(`central source link ${memory_id}@${version}/${source_id} is immutable and already has different content`);
        }
    }

    insert_confirmation(input: central_confirmation): central_confirmation {
        assert_no_obvious_credentials({ central_confirmation: input });
        this.database.prepare(`INSERT INTO cm_confirmations
            (tenant_id, user_id, confirmation_id, memory_id, proposed_version,
             expected_current_version, requested_status, confirmation_kind, status, prompt,
             requested_by, requested_at, decided_by, decided_at, decision_note,
             decision_metadata_json, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.confirmation_id, input.memory_id,
                input.proposed_version, input.expected_current_version, input.requested_status,
                input.confirmation_kind, input.status, input.prompt, input.requested_by,
                input.requested_at, input.decided_by, input.decided_at, input.decision_note,
                json(input.decision_metadata), json(input.metadata));
        return this.require_confirmation(input.confirmation_id);
    }

    require_confirmation(confirmation_id: string): central_confirmation {
        const value = this.database.prepare(`SELECT * FROM cm_confirmations
            WHERE tenant_id=? AND user_id=? AND confirmation_id=?`)
            .get(this.tenant_id, this.user_id, confirmation_id) as row | undefined;
        if (!value) throw new Error(`central confirmation ${confirmation_id} was not found`);
        return map_confirmation(value);
    }

    pending_confirmation_for(
        memory_id: string,
        proposed_version: number,
        requested_status: central_confirmation['requested_status'],
    ): central_confirmation | null {
        const value = this.database.prepare(`SELECT * FROM cm_confirmations
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND proposed_version=?
              AND requested_status=? AND status='pending'`)
            .get(this.tenant_id, this.user_id, memory_id, proposed_version, requested_status) as row | undefined;
        return value ? map_confirmation(value) : null;
    }

    list_pending_confirmations(memory_id?: string): central_confirmation[] {
        const values = memory_id === undefined
            ? this.database.prepare(`SELECT * FROM cm_confirmations
                WHERE tenant_id=? AND user_id=? AND status='pending'
                ORDER BY requested_at, confirmation_id`)
                .all(this.tenant_id, this.user_id)
            : this.database.prepare(`SELECT * FROM cm_confirmations
                WHERE tenant_id=? AND user_id=? AND memory_id=? AND status='pending'
                ORDER BY requested_at, confirmation_id`)
                .all(this.tenant_id, this.user_id, memory_id);
        return (values as row[]).map(map_confirmation);
    }

    decide_confirmation(
        confirmation_id: string,
        status: Extract<central_confirmation['status'], 'approved' | 'rejected' | 'cancelled'>,
        decision: { actor_id: string; note: string; evidence?: central_metadata },
        at = this.now(),
    ): central_confirmation {
        assert_no_obvious_credentials({
            central_confirmation_decision: { confirmation_id, status, decision },
        });
        const result = this.database.prepare(`UPDATE cm_confirmations
            SET status=?, decided_by=?, decided_at=?, decision_note=?, decision_metadata_json=?
            WHERE tenant_id=? AND user_id=? AND confirmation_id=? AND status='pending'`)
            .run(status, decision.actor_id, at, decision.note, json(decision.evidence),
                this.tenant_id, this.user_id, confirmation_id);
        if (result.changes !== 1) throw new Error(`central confirmation ${confirmation_id} is not pending`);
        return this.require_confirmation(confirmation_id);
    }

    insert_conflict(input: central_memory_conflict): central_memory_conflict {
        assert_no_obvious_credentials({ central_memory_conflict: input });
        if (input.status !== 'open' || input.resolved_at !== null) {
            throw new Error('new central memory conflicts must be open and unresolved');
        }
        this.database.prepare(`INSERT OR IGNORE INTO cm_memory_conflicts
            (tenant_id, user_id, conflict_id, memory_a_id, memory_a_version,
             memory_b_id, memory_b_version, severity, status, rationale,
             resolution_memory_id, resolution_version, created_at, resolved_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.conflict_id,
                input.memory_a_id, input.memory_a_version, input.memory_b_id, input.memory_b_version,
                input.severity, input.status, input.rationale, input.resolution_memory_id,
                input.resolution_version, input.created_at, input.resolved_at, json(input.metadata));
        const conflict = this.require_conflict(input.conflict_id);
        if (hash_canonical(conflict) !== hash_canonical(input)) {
            throw new Error(`central memory conflict ${input.conflict_id} already exists with different content`);
        }
        return conflict;
    }

    get_conflict(conflict_id: string): central_memory_conflict | null {
        const value = this.database.prepare(`SELECT * FROM cm_memory_conflicts
            WHERE tenant_id=? AND user_id=? AND conflict_id=?`)
            .get(this.tenant_id, this.user_id, conflict_id) as row | undefined;
        return value ? map_conflict(value) : null;
    }

    require_conflict(conflict_id: string): central_memory_conflict {
        const value = this.get_conflict(conflict_id);
        if (!value) throw new Error(`central memory conflict ${conflict_id} was not found`);
        return value;
    }

    list_conflicts(status?: central_memory_conflict['status'], limit = 100): central_memory_conflict[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
            throw new Error('central conflict limit must be an integer between 1 and 10000');
        }
        const values = status === undefined
            ? this.database.prepare(`SELECT * FROM cm_memory_conflicts
                WHERE tenant_id=? AND user_id=? ORDER BY severity DESC, created_at, conflict_id LIMIT ?`)
                .all(this.tenant_id, this.user_id, limit)
            : this.database.prepare(`SELECT * FROM cm_memory_conflicts
                WHERE tenant_id=? AND user_id=? AND status=?
                ORDER BY severity DESC, created_at, conflict_id LIMIT ?`)
                .all(this.tenant_id, this.user_id, status, limit);
        return (values as row[]).map(map_conflict);
    }

    decide_conflict(input: {
        conflict_id: string;
        status: Extract<central_memory_conflict['status'], 'resolved' | 'dismissed'>;
        resolution_memory_id?: string | null;
        resolution_version?: number | null;
        metadata: central_metadata;
        at?: number;
    }): central_memory_conflict {
        assert_no_obvious_credentials({ central_conflict_decision: input });
        const at = input.at ?? this.now();
        const result = this.database.prepare(`UPDATE cm_memory_conflicts SET
                status=?, resolution_memory_id=?, resolution_version=?, resolved_at=?, metadata_json=?
            WHERE tenant_id=? AND user_id=? AND conflict_id=? AND status='open'`)
            .run(input.status, input.resolution_memory_id ?? null, input.resolution_version ?? null,
                at, json(input.metadata), this.tenant_id, this.user_id, input.conflict_id);
        if (result.changes !== 1) throw new Error(`central memory conflict ${input.conflict_id} is not open`);
        return this.require_conflict(input.conflict_id);
    }

    upsert_subscription(input: central_subscription): central_subscription {
        assert_no_obvious_credentials({ central_subscription: input });
        this.database.prepare(`INSERT INTO cm_subscriptions
            (tenant_id, user_id, subscription_id, thread_id, selector_kind, selector_value,
             min_relevance, enabled, cursor_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, user_id, subscription_id) DO UPDATE SET
                selector_kind=excluded.selector_kind, selector_value=excluded.selector_value,
                min_relevance=excluded.min_relevance, enabled=excluded.enabled,
                cursor_version=excluded.cursor_version, updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.subscription_id, input.thread_id,
                input.selector_kind, input.selector_value, input.min_relevance, Number(input.enabled),
                input.cursor_version, input.created_at, input.updated_at);
        const value = this.database.prepare(`SELECT * FROM cm_subscriptions
            WHERE tenant_id=? AND user_id=? AND subscription_id=?`)
            .get(this.tenant_id, this.user_id, input.subscription_id) as row;
        return map_subscription(value);
    }

    list_matching_subscriptions(memory: central_memory): central_subscription[] {
        const values = this.database.prepare(`SELECT subscription.* FROM cm_subscriptions AS subscription
            JOIN cm_threads AS thread
              ON thread.tenant_id=subscription.tenant_id AND thread.user_id=subscription.user_id
             AND thread.thread_id=subscription.thread_id AND thread.status IN ('active', 'idle')
            WHERE subscription.tenant_id=? AND subscription.user_id=? AND subscription.enabled=1
              AND thread.project_id=?
              AND (
                (selector_kind='memory' AND selector_value=?)
                OR (selector_kind='project' AND selector_value=? AND ?<=3)
                OR (selector_kind='role' AND selector_value=?)
                OR (selector_kind='task' AND selector_value=?)
              )`)
            .all(this.tenant_id, this.user_id, memory.project_id, memory.memory_id,
                memory.project_id, memory.level,
                memory.role_id, memory.task_id) as row[];
        const direct = values.map(map_subscription);
        const semantic = (this.database.prepare(`SELECT subscription.* FROM cm_subscriptions AS subscription
            JOIN cm_threads AS thread
              ON thread.tenant_id=subscription.tenant_id AND thread.user_id=subscription.user_id
             AND thread.thread_id=subscription.thread_id AND thread.status IN ('active', 'idle')
            WHERE subscription.tenant_id=? AND subscription.user_id=? AND subscription.enabled=1
              AND thread.project_id=?
              AND selector_kind IN ('tag', 'topic')`)
            .all(this.tenant_id, this.user_id, memory.project_id) as row[]).map(map_subscription);
        const tags = Array.isArray(memory.metadata.tags) ? memory.metadata.tags.map(String) : [];
        return [...direct, ...semantic.filter((subscription) => subscription.selector_kind === 'tag'
            ? tags.includes(subscription.selector_value)
            : memory.title.toLocaleLowerCase().includes(subscription.selector_value.toLocaleLowerCase()))];
    }

    list_thread_subscriptions(thread_id: string, limit = 128): central_subscription[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
            throw new Error('central recall subscription limit must be an integer between 1 and 128');
        }
        return (this.database.prepare(`SELECT subscription.* FROM cm_subscriptions AS subscription
            JOIN cm_threads AS thread
              ON thread.tenant_id=subscription.tenant_id AND thread.user_id=subscription.user_id
             AND thread.thread_id=subscription.thread_id
            WHERE subscription.tenant_id=? AND subscription.user_id=?
              AND subscription.thread_id=? AND subscription.enabled=1
            ORDER BY subscription.min_relevance DESC, subscription.selector_kind,
                     subscription.selector_value, subscription.subscription_id
            LIMIT ?`)
            .all(this.tenant_id, this.user_id, thread_id, limit) as row[]).map(map_subscription);
    }

    /**
     * Return a strictly bounded set of current, effective candidates.  Project
     * scope is derived from the registered thread rather than caller input.
     */
    recall_candidates(thread_id: string, search_terms: string[], limit: number): central_recall_candidate[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 512) {
            throw new Error('central recall candidate limit must be an integer between 1 and 512');
        }
        if (search_terms.length < 1 || search_terms.length > 32
            || search_terms.some((term) => !term || term.length > 64)) {
            throw new Error('central recall requires between 1 and 32 bounded search terms');
        }
        const predicates = search_terms.map(() => 'instr(search_blob, ?) > 0').join(' OR ');
        const lexical_hits = search_terms
            .map(() => 'CASE WHEN instr(search_blob, ?) > 0 THEN 1 ELSE 0 END')
            .join(' + ');
        const values = this.database.prepare(`WITH scoped AS MATERIALIZED (
            SELECT
                memory.*,
                version.version AS v_version, version.status AS v_status,
                version.title AS v_title, version.summary AS v_summary, version.body AS v_body,
                version.content_hash AS v_content_hash, version.importance AS v_importance,
                version.is_major AS v_is_major, version.change_reason AS v_change_reason,
                version.metadata_json AS v_metadata_json, version.created_by AS v_created_by,
                version.created_at AS v_created_at, version.activated_at AS v_activated_at,
                version.superseded_at AS v_superseded_at, version.retracted_at AS v_retracted_at,
                workset.thread_id AS w_thread_id, workset.synced_version AS w_synced_version,
                workset.consumed_version AS w_consumed_version,
                workset.pending_version AS w_pending_version, workset.relevance AS w_relevance,
                workset.origin AS w_origin, workset.sync_state AS w_sync_state,
                workset.last_synced_at AS w_last_synced_at,
                workset.last_consumed_at AS w_last_consumed_at, workset.updated_at AS w_updated_at,
                CASE WHEN memory.task_id IS NOT NULL AND memory.task_id=thread.task_id THEN 1 ELSE 0 END
                    AS task_affinity,
                CASE WHEN memory.role_id IS NOT NULL AND memory.role_id=thread.role_id THEN 1 ELSE 0 END
                    AS role_affinity,
                CASE WHEN memory.project_id=thread.project_id THEN 'local_project' ELSE 'linked_project' END
                    AS project_scope,
                lower(
                    substr(version.title, 1, 512) || char(10)
                    || substr(version.summary, 1, 4096) || char(10)
                    || substr(version.body, 1, 16384) || char(10)
                    || substr(version.metadata_json, 1, 4096) || char(10)
                    || substr(memory.title, 1, 512) || char(10)
                    || substr(memory.metadata_json, 1, 4096)
                ) AS search_blob
            FROM cm_threads AS thread
            JOIN cm_memories AS memory
              ON memory.tenant_id=thread.tenant_id AND memory.user_id=thread.user_id
             AND (
                memory.project_id=thread.project_id
                OR (
                    memory.level=4
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
            JOIN cm_memory_versions AS version
              ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
             AND version.memory_id=memory.memory_id AND version.version=memory.current_version
             AND version.status IN ('active', 'locked')
            LEFT JOIN cm_thread_worksets AS workset
              ON workset.tenant_id=thread.tenant_id AND workset.user_id=thread.user_id
             AND workset.thread_id=thread.thread_id AND workset.memory_id=memory.memory_id
            WHERE thread.tenant_id=? AND thread.user_id=? AND thread.thread_id=?
              AND thread.status IN ('active', 'idle')
        )
            SELECT scoped.*, (${lexical_hits}) AS lexical_hits
            FROM scoped
            WHERE ${predicates}
            ORDER BY lexical_hits DESC, task_affinity DESC, role_affinity DESC,
                     CASE WHEN level=4 THEN 0 ELSE 1 END,
                     v_importance DESC, v_activated_at DESC, memory_id
            LIMIT ?`)
            .all(this.tenant_id, this.user_id, thread_id, ...search_terms, ...search_terms, limit) as row[];
        return values.map((value) => ({
            memory: map_memory(value),
            version: map_version({
                memory_id: value.memory_id,
                version: value.v_version,
                status: value.v_status,
                title: value.v_title,
                summary: value.v_summary,
                body: value.v_body,
                content_hash: value.v_content_hash,
                importance: value.v_importance,
                is_major: value.v_is_major,
                change_reason: value.v_change_reason,
                metadata_json: value.v_metadata_json,
                created_by: value.v_created_by,
                created_at: value.v_created_at,
                activated_at: value.v_activated_at,
                superseded_at: value.v_superseded_at,
                retracted_at: value.v_retracted_at,
            }),
            workset: value.w_thread_id === null || value.w_thread_id === undefined
                ? null
                : map_workset({
                    thread_id: value.w_thread_id,
                    memory_id: value.memory_id,
                    synced_version: value.w_synced_version,
                    consumed_version: value.w_consumed_version,
                    pending_version: value.w_pending_version,
                    relevance: value.w_relevance,
                    origin: value.w_origin,
                    sync_state: value.w_sync_state,
                    last_synced_at: value.w_last_synced_at,
                    last_consumed_at: value.w_last_consumed_at,
                    updated_at: value.w_updated_at,
                }),
            project_scope: value.project_scope as central_recall_candidate['project_scope'],
        }));
    }

    /** Stage a recalled current version without perturbing an equivalent workset. */
    stage_recalled_workset(input: {
        thread_id: string;
        memory_id: string;
        version: number;
        relevance: number;
        origin: Extract<central_thread_workset['origin'],
            'shared' | 'project_map' | 'subscription' | 'linked_project'>;
        at?: number;
    }): central_thread_workset | null {
        if (!Number.isFinite(input.relevance) || input.relevance < 0 || input.relevance > 1) {
            throw new Error('central recall relevance must be between 0 and 1');
        }
        const thread = this.require_thread(input.thread_id);
        if (thread.status !== 'active' && thread.status !== 'idle') return null;
        const effective = this.database.prepare(`SELECT memory.project_id AS memory_project_id,
                memory.level AS memory_level
            FROM cm_threads AS thread
            JOIN cm_memories AS memory
              ON memory.tenant_id=thread.tenant_id AND memory.user_id=thread.user_id
             AND memory.memory_id=?
            JOIN cm_memory_versions AS version
              ON version.tenant_id=memory.tenant_id AND version.user_id=memory.user_id
             AND version.memory_id=memory.memory_id AND version.version=memory.current_version
            WHERE thread.tenant_id=? AND thread.user_id=? AND thread.thread_id=?
              AND memory.current_version=? AND version.status IN ('active', 'locked')
              AND (
                memory.project_id=thread.project_id
                OR (
                    memory.level=4
                    AND EXISTS (
                        SELECT 1 FROM cm_project_links AS project_link
                        WHERE project_link.tenant_id=thread.tenant_id
                          AND project_link.user_id=thread.user_id
                          AND project_link.source_project_id=memory.project_id
                          AND project_link.target_project_id=thread.project_id
                          AND project_link.status='active'
                    )
                )
              )`)
            .get(input.memory_id, this.tenant_id, this.user_id,
                input.thread_id, input.version) as row | undefined;
        if (!effective) return null;
        const cross_project = String(effective.memory_project_id) !== thread.project_id;
        if (cross_project !== (input.origin === 'linked_project')) return null;

        const at = input.at ?? this.now();
        const existing_value = this.database.prepare(`SELECT * FROM cm_thread_worksets
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?`)
            .get(this.tenant_id, this.user_id, input.thread_id, input.memory_id) as row | undefined;
        if (!existing_value) {
            this.database.prepare(`INSERT INTO cm_thread_worksets
                (tenant_id, user_id, thread_id, memory_id, synced_version, consumed_version,
                 pending_version, relevance, origin, sync_state, last_synced_at, last_consumed_at, updated_at)
                VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'pending', NULL, NULL, ?)`)
                .run(this.tenant_id, this.user_id, input.thread_id, input.memory_id,
                    input.version, input.relevance, input.origin, at);
            return this.require_workset(input.thread_id, input.memory_id);
        }

        const existing = map_workset(existing_value);
        const relevance = Math.max(existing.relevance, input.relevance);
        const origin = stronger_workset_origin(existing.origin, input.origin);
        const already_synced = existing.synced_version === input.version && existing.sync_state !== 'retracted';
        const pending_version = already_synced ? null : input.version;
        const sync_state: central_thread_workset['sync_state'] = already_synced ? 'current' : 'pending';
        if (existing.pending_version === pending_version
            && existing.relevance === relevance
            && existing.origin === origin
            && existing.sync_state === sync_state) {
            return existing;
        }
        this.database.prepare(`UPDATE cm_thread_worksets SET
                pending_version=?, relevance=?, origin=?, sync_state=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?`)
            .run(pending_version, relevance, origin, sync_state, at,
                this.tenant_id, this.user_id, input.thread_id, input.memory_id);
        return this.require_workset(input.thread_id, input.memory_id);
    }

    stage_workset(input: {
        thread_id: string; memory_id: string; pending_version: number;
        relevance?: number; origin?: central_thread_workset['origin']; at?: number;
    }): central_thread_workset {
        const at = input.at ?? this.now();
        const thread = this.require_thread(input.thread_id);
        const memory = this.require_memory(input.memory_id);
        const cross_project = memory.project_id !== thread.project_id;
        if (cross_project) {
            const linked = memory.level === 4
                && input.origin === 'linked_project'
                && this.find_active_project_link(memory.project_id, thread.project_id) !== null;
            if (!linked) throw new Error('cross-project worksets require an active governed L4 project link');
        } else if (input.origin === 'linked_project') {
            throw new Error('linked_project origin requires a cross-project memory');
        }
        this.database.prepare(`INSERT INTO cm_thread_worksets
            (tenant_id, user_id, thread_id, memory_id, synced_version, consumed_version,
             pending_version, relevance, origin, sync_state, last_synced_at, last_consumed_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'pending', NULL, NULL, ?)
            ON CONFLICT (tenant_id, user_id, thread_id, memory_id) DO UPDATE SET
                pending_version=excluded.pending_version,
                relevance=MAX(cm_thread_worksets.relevance, excluded.relevance),
                origin=CASE
                    WHEN (CASE cm_thread_worksets.origin
                        WHEN 'own_thread' THEN 5 WHEN 'manual' THEN 4 WHEN 'project_map' THEN 3
                        WHEN 'subscription' THEN 2 WHEN 'shared' THEN 1 ELSE 0 END)
                       >= (CASE excluded.origin
                        WHEN 'own_thread' THEN 5 WHEN 'manual' THEN 4 WHEN 'project_map' THEN 3
                        WHEN 'subscription' THEN 2 WHEN 'shared' THEN 1 ELSE 0 END)
                    THEN cm_thread_worksets.origin ELSE excluded.origin END,
                sync_state='pending',
                updated_at=excluded.updated_at`)
            .run(this.tenant_id, this.user_id, input.thread_id, input.memory_id,
                input.pending_version, input.relevance ?? 0.5, input.origin ?? 'subscription', at);
        return this.require_workset(input.thread_id, input.memory_id);
    }

    stage_matching_worksets(memory_id: string, version: number, at = this.now()): number {
        const memory = this.require_memory(memory_id);
        const existing = this.database.prepare(`SELECT workset.thread_id, workset.relevance, workset.origin
            FROM cm_thread_worksets AS workset
            JOIN cm_threads AS thread
              ON thread.tenant_id=workset.tenant_id AND thread.user_id=workset.user_id
             AND thread.thread_id=workset.thread_id AND thread.status IN ('active', 'idle')
            WHERE workset.tenant_id=? AND workset.user_id=? AND workset.memory_id=?
              AND (
                thread.project_id=?
                OR (
                    ?=4
                    AND EXISTS (
                        SELECT 1 FROM cm_project_links AS project_link
                        WHERE project_link.tenant_id=thread.tenant_id
                          AND project_link.user_id=thread.user_id
                          AND project_link.source_project_id=?
                          AND project_link.target_project_id=thread.project_id
                          AND project_link.status='active'
                    )
                )
              )`)
            .all(this.tenant_id, this.user_id, memory_id, memory.project_id,
                memory.level, memory.project_id) as Array<{
                    thread_id: string;
                    relevance: number;
                    origin: central_thread_workset['origin'];
                }>;
        const subscriptions = this.list_matching_subscriptions(memory);
        const targets = new Map<string, { relevance: number; origin: central_thread_workset['origin'] }>();
        for (const value of existing) {
            const target_thread = this.require_thread(value.thread_id);
            targets.set(value.thread_id, {
                relevance: value.relevance,
                origin: target_thread.project_id === memory.project_id ? value.origin : 'linked_project',
            });
        }
        for (const subscription of subscriptions) {
            targets.set(subscription.thread_id, {
                relevance: Math.max(subscription.min_relevance, targets.get(subscription.thread_id)?.relevance ?? 0),
                origin: 'subscription',
            });
        }
        for (const [thread_id, target] of targets) {
            this.stage_workset({ thread_id, memory_id, pending_version: version, ...target, at });
        }
        return targets.size;
    }

    require_workset(thread_id: string, memory_id: string): central_thread_workset {
        const value = this.database.prepare(`SELECT * FROM cm_thread_worksets
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?`)
            .get(this.tenant_id, this.user_id, thread_id, memory_id) as row | undefined;
        if (!value) throw new Error(`central workset ${thread_id}/${memory_id} was not found`);
        return map_workset(value);
    }

    list_worksets(thread_id: string): central_thread_workset[] {
        return (this.database.prepare(`SELECT * FROM cm_thread_worksets
            WHERE tenant_id=? AND user_id=? AND thread_id=?
            ORDER BY relevance DESC, memory_id`)
            .all(this.tenant_id, this.user_id, thread_id) as row[]).map(map_workset);
    }

    sync_workset(
        thread_id: string,
        memory_id: string,
        expected_pending_version: number,
        at = this.now(),
    ): central_thread_workset {
        const thread = this.require_thread(thread_id);
        if (thread.status !== 'active' && thread.status !== 'idle') {
            return this.require_workset(thread_id, memory_id);
        }
        const memory = this.require_memory(memory_id);
        if (memory.project_id !== thread.project_id
            && (memory.level !== 4
                || this.find_active_project_link(memory.project_id, thread.project_id) === null)) {
            this.database.prepare(`UPDATE cm_thread_worksets SET
                    pending_version=NULL, sync_state='retracted', updated_at=?
                WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?`)
                .run(at, this.tenant_id, this.user_id, thread_id, memory_id);
            return this.require_workset(thread_id, memory_id);
        }
        if (memory.current_version === null) {
            const result = this.database.prepare(`UPDATE cm_thread_worksets SET
                pending_version=NULL, sync_state='retracted', updated_at=?
                WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=? AND pending_version=?`)
                .run(at, this.tenant_id, this.user_id, thread_id, memory_id, expected_pending_version);
            if (result.changes === 0) return this.require_workset(thread_id, memory_id);
            return this.require_workset(thread_id, memory_id);
        }
        const workset = this.require_workset(thread_id, memory_id);
        const target_version = workset.pending_version;
        if (target_version === null) return workset;
        if (target_version !== expected_pending_version || memory.current_version !== expected_pending_version) return workset;
        const result = this.database.prepare(`UPDATE cm_thread_worksets SET
            synced_version=?, pending_version=NULL, sync_state='current', last_synced_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=? AND pending_version=?`)
            .run(expected_pending_version, at, at, this.tenant_id, this.user_id,
                thread_id, memory_id, expected_pending_version);
        if (result.changes === 0) return this.require_workset(thread_id, memory_id);
        return this.require_workset(thread_id, memory_id);
    }

    consume_workset(
        thread_id: string,
        memory_id: string,
        expected_synced_version: number,
        at = this.now(),
    ): central_thread_workset {
        const thread = this.require_thread(thread_id);
        const memory = this.require_memory(memory_id);
        if (memory.project_id !== thread.project_id
            && (memory.level !== 4
                || this.find_active_project_link(memory.project_id, thread.project_id) === null)) {
            throw new Error('central linked-project memory is no longer authorized for this thread');
        }
        const result = this.database.prepare(`UPDATE cm_thread_worksets SET
            consumed_version=synced_version, last_consumed_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?
              AND sync_state<>'retracted' AND synced_version=?
              AND EXISTS (
                SELECT 1 FROM cm_threads AS thread
                WHERE thread.tenant_id=cm_thread_worksets.tenant_id
                  AND thread.user_id=cm_thread_worksets.user_id
                  AND thread.thread_id=cm_thread_worksets.thread_id
                  AND thread.status IN ('active', 'idle')
              )`)
            .run(at, at, this.tenant_id, this.user_id, thread_id, memory_id, expected_synced_version);
        if (result.changes !== 1) {
            throw new Error(`central workset ${thread_id}/${memory_id} is not synced to version ${expected_synced_version}`);
        }
        return this.require_workset(thread_id, memory_id);
    }

    mark_worksets_retracted(memory_id: string, at = this.now()): number {
        return this.database.prepare(`UPDATE cm_thread_worksets SET
            pending_version=NULL, sync_state='retracted', updated_at=?
            WHERE tenant_id=? AND user_id=? AND memory_id=?
              AND EXISTS (
                SELECT 1 FROM cm_threads AS thread
                WHERE thread.tenant_id=cm_thread_worksets.tenant_id
                  AND thread.user_id=cm_thread_worksets.user_id
                  AND thread.thread_id=cm_thread_worksets.thread_id
                  AND thread.status IN ('active', 'idle')
              )`)
            .run(at, this.tenant_id, this.user_id, memory_id).changes;
    }

    thread_context(thread_id: string): central_memory_context_entry[] {
        const values = this.database.prepare(`SELECT
                m.*, v.status AS v_status, v.title AS v_title, v.summary AS v_summary,
                v.body AS v_body, v.content_hash AS v_content_hash, v.importance AS v_importance,
                v.is_major AS v_is_major, v.change_reason AS v_change_reason,
                v.metadata_json AS v_metadata_json, v.created_by AS v_created_by,
                v.created_at AS v_created_at, v.activated_at AS v_activated_at,
                v.superseded_at AS v_superseded_at, v.retracted_at AS v_retracted_at,
                w.thread_id AS w_thread_id, w.synced_version AS w_synced_version,
                w.consumed_version AS w_consumed_version, w.pending_version AS w_pending_version,
                w.relevance AS w_relevance, w.origin AS w_origin, w.sync_state AS w_sync_state,
                w.last_synced_at AS w_last_synced_at, w.last_consumed_at AS w_last_consumed_at,
                w.updated_at AS w_updated_at
            FROM cm_thread_worksets AS w
            JOIN cm_threads AS thread ON thread.tenant_id=w.tenant_id AND thread.user_id=w.user_id
                AND thread.thread_id=w.thread_id AND thread.status IN ('active', 'idle')
            JOIN cm_memories AS m ON m.tenant_id=w.tenant_id AND m.user_id=w.user_id AND m.memory_id=w.memory_id
            JOIN cm_memory_versions AS v ON v.tenant_id=w.tenant_id AND v.user_id=w.user_id
                AND v.memory_id=w.memory_id AND v.version=w.synced_version
            WHERE w.tenant_id=? AND w.user_id=? AND w.thread_id=?
              AND w.synced_version IS NOT NULL AND w.sync_state<>'retracted'
              AND (
                m.project_id=thread.project_id
                OR (
                    m.level=4 AND w.origin='linked_project'
                    AND EXISTS (
                        SELECT 1 FROM cm_project_links AS project_link
                        WHERE project_link.tenant_id=thread.tenant_id
                          AND project_link.user_id=thread.user_id
                          AND project_link.source_project_id=m.project_id
                          AND project_link.target_project_id=thread.project_id
                          AND project_link.status='active'
                    )
                )
              )
            ORDER BY m.level,
                     CASE w.origin
                        WHEN 'own_thread' THEN 0 WHEN 'manual' THEN 1 WHEN 'project_map' THEN 2
                        WHEN 'subscription' THEN 3 WHEN 'shared' THEN 4 ELSE 5 END,
                     w.relevance DESC, m.memory_id`)
            .all(this.tenant_id, this.user_id, thread_id) as row[];
        return values.map((value) => ({
            memory: map_memory(value),
            version: map_version({
                memory_id: value.memory_id, version: value.w_synced_version, status: value.v_status,
                title: value.v_title, summary: value.v_summary, body: value.v_body,
                content_hash: value.v_content_hash, importance: value.v_importance,
                is_major: value.v_is_major, change_reason: value.v_change_reason,
                metadata_json: value.v_metadata_json, created_by: value.v_created_by,
                created_at: value.v_created_at, activated_at: value.v_activated_at,
                superseded_at: value.v_superseded_at, retracted_at: value.v_retracted_at,
            }),
            workset: map_workset({
                thread_id: value.w_thread_id, memory_id: value.memory_id,
                synced_version: value.w_synced_version, consumed_version: value.w_consumed_version,
                pending_version: value.w_pending_version, relevance: value.w_relevance,
                origin: value.w_origin, sync_state: value.w_sync_state,
                last_synced_at: value.w_last_synced_at, last_consumed_at: value.w_last_consumed_at,
                updated_at: value.w_updated_at,
            }),
        }));
    }

    insert_dependency(input: central_dependency): central_dependency {
        assert_no_obvious_credentials({ central_dependency: input });
        this.database.prepare(`INSERT INTO cm_dependencies
            (tenant_id, user_id, dependency_id, subject_kind, subject_id, memory_id,
             memory_version, status, details_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.dependency_id, input.subject_kind,
                input.subject_id, input.memory_id, input.memory_version, input.status,
                json(input.details), input.created_at, input.updated_at);
        return this.require_dependency(input.dependency_id);
    }

    require_dependency(dependency_id: string): central_dependency {
        const value = this.database.prepare(`SELECT * FROM cm_dependencies
            WHERE tenant_id=? AND user_id=? AND dependency_id=?`)
            .get(this.tenant_id, this.user_id, dependency_id) as row | undefined;
        if (!value) throw new Error(`central dependency ${dependency_id} was not found`);
        return map_dependency(value);
    }

    invalidate_prior_dependencies(memory_id: string, effective_version: number, at = this.now()): number {
        return this.database.prepare(`UPDATE cm_dependencies SET status='needs_review', updated_at=?
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND memory_version<>? AND status='current'`)
            .run(at, this.tenant_id, this.user_id, memory_id, effective_version).changes;
    }

    invalidate_dependencies(memory_id: string, memory_version: number, at = this.now()): number {
        return this.database.prepare(`UPDATE cm_dependencies SET status='invalidated', updated_at=?
            WHERE tenant_id=? AND user_id=? AND memory_id=? AND memory_version=?
              AND status IN ('current', 'needs_review')`)
            .run(at, this.tenant_id, this.user_id, memory_id, memory_version).changes;
    }

    enqueue(input: {
        event_id: string; aggregate_kind: string; aggregate_id: string; aggregate_version?: number | null;
        event_type: string; payload?: Record<string, unknown>; at?: number; available_at?: number;
    }): central_outbox_event {
        assert_no_obvious_credentials({ central_outbox_event: input });
        const at = input.at ?? this.now();
        this.database.prepare(`INSERT INTO cm_outbox
            (tenant_id, user_id, event_id, aggregate_kind, aggregate_id, aggregate_version,
             event_type, payload_json, created_at, available_at, attempts, processed_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
            ON CONFLICT (tenant_id, user_id, event_id) DO NOTHING`)
            .run(this.tenant_id, this.user_id, input.event_id, input.aggregate_kind,
                input.aggregate_id, input.aggregate_version ?? null, input.event_type,
                json(input.payload), at, input.available_at ?? at);
        const event = this.require_outbox(input.event_id);
        const expected = {
            event_id: input.event_id,
            aggregate_kind: input.aggregate_kind,
            aggregate_id: input.aggregate_id,
            aggregate_version: input.aggregate_version ?? null,
            event_type: input.event_type,
            payload: parse_json(json(input.payload)),
        };
        const actual = {
            event_id: event.event_id,
            aggregate_kind: event.aggregate_kind,
            aggregate_id: event.aggregate_id,
            aggregate_version: event.aggregate_version,
            event_type: event.event_type,
            payload: event.payload,
        };
        if (hash_canonical(expected) !== hash_canonical(actual)) {
            throw new Error(`central outbox event ${input.event_id} already exists with different content`);
        }
        return event;
    }

    get_outbox(event_id: string): central_outbox_event | null {
        const value = this.database.prepare(`SELECT * FROM cm_outbox
            WHERE tenant_id=? AND user_id=? AND event_id=?`)
            .get(this.tenant_id, this.user_id, event_id) as row | undefined;
        return value ? map_outbox(value) : null;
    }

    require_outbox(event_id: string): central_outbox_event {
        const event = this.get_outbox(event_id);
        if (!event) throw new Error(`central outbox event ${event_id} was not found`);
        return event;
    }

    pending_outbox(limit = 100, at = this.now()): central_outbox_event[] {
        return (this.database.prepare(`SELECT * FROM cm_outbox
            WHERE tenant_id=? AND user_id=? AND processed_at IS NULL AND available_at<=?
            ORDER BY sequence LIMIT ?`)
            .all(this.tenant_id, this.user_id, at, limit) as row[]).map(map_outbox);
    }

    mark_outbox_processed(event_id: string, at = this.now()): void {
        const result = this.database.prepare(`UPDATE cm_outbox
            SET processed_at=?, attempts=attempts+1, last_error=NULL
            WHERE tenant_id=? AND user_id=? AND event_id=? AND processed_at IS NULL`)
            .run(at, this.tenant_id, this.user_id, event_id);
        if (result.changes !== 1) throw new Error(`central outbox event ${event_id} is not pending`);
    }

    mark_outbox_failed(event_id: string, error: string, retry_at: number): void {
        assert_no_obvious_credentials({ central_outbox_failure: { event_id, error } });
        const result = this.database.prepare(`UPDATE cm_outbox
            SET attempts=attempts+1, last_error=?, available_at=?
            WHERE tenant_id=? AND user_id=? AND event_id=? AND processed_at IS NULL`)
            .run(error, retry_at, this.tenant_id, this.user_id, event_id);
        if (result.changes !== 1) throw new Error(`central outbox event ${event_id} is not pending`);
    }
}
