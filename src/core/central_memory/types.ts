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
 *  file  : src/core/central_memory/types.ts
 *  usage : implements the LongMemory types component
 */

export const central_memory_statuses = [
    'active',
    'superseded',
    'retracted',
    'pending_confirmation',
    'locked',
] as const;

export type central_memory_status = typeof central_memory_statuses[number];
export type central_memory_level = 1 | 2 | 3 | 4;
export type central_json_value = null | boolean | number | string | central_json_value[] | { [key: string]: central_json_value };
export type central_metadata = Record<string, central_json_value>;
export type central_effective_status = Extract<central_memory_status, 'active' | 'locked'>;
export type central_requested_status = central_effective_status | 'retracted';

export type central_project = {
    project_id: string;
    name: string;
    description: string;
    status: 'active' | 'archived';
    metadata: central_metadata;
    created_at: number;
    updated_at: number;
};

/**
 * A governed, directed permission for one project's L4 memories to be
 * recalled by another project.  Project hierarchy and L1-L3 memory never
 * cross this boundary.
 */
export type central_project_link = {
    link_id: string;
    source_project_id: string;
    target_project_id: string;
    status: 'active' | 'revoked';
    metadata: central_metadata;
    created_by: string;
    created_action_id: string;
    created_channel: 'codex_ui' | 'obsidian' | 'local_cli';
    created_evidence: central_metadata;
    created_at: number;
    revoked_by: string | null;
    revoked_action_id: string | null;
    revoked_channel: 'codex_ui' | 'obsidian' | 'local_cli' | null;
    revoked_evidence: central_metadata;
    revoked_at: number | null;
};

export type central_role = {
    role_id: string;
    project_id: string;
    name: string;
    responsibility: string;
    status: 'active' | 'archived';
    metadata: central_metadata;
    created_at: number;
    updated_at: number;
};

export type central_task = {
    task_id: string;
    project_id: string;
    role_id: string | null;
    title: string;
    objective: string;
    status: 'active' | 'completed' | 'blocked' | 'archived';
    metadata: central_metadata;
    created_at: number;
    updated_at: number;
};

export type central_thread = {
    thread_id: string;
    project_id: string;
    role_id: string | null;
    task_id: string | null;
    responsibility: string;
    status: 'active' | 'idle' | 'completed' | 'archived';
    metadata: central_metadata;
    last_safe_boundary_at: number | null;
    created_at: number;
    updated_at: number;
};

export type central_memory = {
    memory_id: string;
    project_id: string;
    role_id: string | null;
    task_id: string | null;
    level: central_memory_level;
    memory_kind: string;
    title: string;
    current_version: number | null;
    metadata: central_metadata;
    created_at: number;
    updated_at: number;
};

export type central_memory_version = {
    memory_id: string;
    version: number;
    status: central_memory_status;
    title: string;
    summary: string;
    body: string;
    content_hash: string;
    importance: number;
    is_major: boolean;
    change_reason: string;
    metadata: central_metadata;
    created_by: string;
    created_at: number;
    activated_at: number | null;
    superseded_at: number | null;
    retracted_at: number | null;
};

export type central_source = {
    source_id: string;
    source_kind: string;
    uri: string;
    thread_id: string | null;
    turn_id: string | null;
    locator: central_metadata;
    excerpt_hash: string | null;
    metadata: central_metadata;
    recorded_at: number;
};

export type central_thread_workset = {
    thread_id: string;
    memory_id: string;
    synced_version: number | null;
    consumed_version: number | null;
    pending_version: number | null;
    relevance: number;
    origin: 'own_thread' | 'shared' | 'project_map' | 'subscription' | 'manual' | 'linked_project';
    sync_state: 'pending' | 'current' | 'retracted';
    last_synced_at: number | null;
    last_consumed_at: number | null;
    updated_at: number;
};

export type central_subscription = {
    subscription_id: string;
    thread_id: string;
    selector_kind: 'memory' | 'project' | 'role' | 'task' | 'tag' | 'topic';
    selector_value: string;
    min_relevance: number;
    enabled: boolean;
    cursor_version: number | null;
    created_at: number;
    updated_at: number;
};

export type central_dependency = {
    dependency_id: string;
    subject_kind: 'task' | 'artifact' | 'decision' | 'output';
    subject_id: string;
    memory_id: string;
    memory_version: number;
    status: 'current' | 'needs_review' | 'invalidated';
    details: central_metadata;
    created_at: number;
    updated_at: number;
};

export type central_confirmation = {
    confirmation_id: string;
    memory_id: string;
    proposed_version: number;
    expected_current_version: number | null;
    requested_status: central_requested_status;
    confirmation_kind: 'major_rule' | 'conflict' | 'locked_override' | 'manual';
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    prompt: string;
    requested_by: string;
    requested_at: number;
    decided_by: string | null;
    decided_at: number | null;
    decision_note: string;
    decision_metadata: central_metadata;
    metadata: central_metadata;
};

export type central_confirmation_decision = {
    actor_id: string;
    actor_kind: 'user';
    action_id: string;
    channel: 'codex_ui' | 'obsidian' | 'local_cli';
    note?: string;
    evidence: central_metadata;
};

export type central_conflict_decision = central_confirmation_decision & {
    status: 'resolved' | 'dismissed';
    resolution_memory_id?: string | null;
    resolution_version?: number | null;
};

export type central_memory_conflict = {
    conflict_id: string;
    memory_a_id: string;
    memory_a_version: number;
    memory_b_id: string;
    memory_b_version: number;
    severity: number;
    status: 'open' | 'resolved' | 'dismissed';
    rationale: string;
    resolution_memory_id: string | null;
    resolution_version: number | null;
    created_at: number;
    resolved_at: number | null;
    metadata: central_metadata;
};

export type central_outbox_event = {
    sequence: number;
    event_id: string;
    aggregate_kind: string;
    aggregate_id: string;
    aggregate_version: number | null;
    event_type: string;
    payload: central_metadata;
    created_at: number;
    available_at: number;
    attempts: number;
    processed_at: number | null;
    last_error: string | null;
};

export type central_memory_context_entry = {
    memory: central_memory;
    version: central_memory_version;
    workset: central_thread_workset;
};

export type central_memory_scope = {
    tenant_id: string;
    user_id: string;
};

export type central_publish_result = {
    memory: central_memory;
    version: central_memory_version;
    confirmation: central_confirmation | null;
    effective: boolean;
};

export class central_memory_conflict_error extends Error {
    readonly code = 'CENTRAL_MEMORY_VERSION_CONFLICT';

    constructor(
        readonly memory_id: string,
        readonly expected: number | null,
        readonly actual: number | null,
    ) {
        super(`central memory ${memory_id} expected current version ${String(expected)}, actual ${String(actual)}`);
        this.name = 'central_memory_conflict_error';
    }
}

export class central_memory_confirmation_required_error extends Error {
    readonly code = 'CENTRAL_MEMORY_CONFIRMATION_REQUIRED';

    constructor(readonly memory_id: string, message: string) {
        super(message);
        this.name = 'central_memory_confirmation_required_error';
    }
}
