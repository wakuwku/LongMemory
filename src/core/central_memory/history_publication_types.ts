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
 *  file  : src/core/central_memory/history_publication_types.ts
 *  usage : implements the LongMemory history publication types component
 */

import type { history_worker_context } from './history_backfill_types.js';

export const history_publication_statuses = [
    'pending',
    'awaiting_hierarchy',
    'ready',
    'retryable',
    'needs_review',
    'pending_confirmation',
    'published',
    'discarded',
    'superseded',
] as const;

export type history_publication_status = typeof history_publication_statuses[number];
export type history_publication_relation = 'new' | 'noop' | 'update' | 'conflict';
export type history_publication_result_kind = 'created' | 'updated' | 'noop';

export type history_publication = {
    publication_id: string;
    run_id: string;
    candidate_id: string;
    status: history_publication_status;
    current_plan_version: number | null;
    result_kind: history_publication_result_kind | null;
    result_memory_id: string | null;
    result_version: number | null;
    result_confirmation_id: string | null;
    attempt_count: number;
    last_attempt_id: string | null;
    last_error_code: string | null;
    last_error_detail: string | null;
    available_at: number;
    created_at: number;
    updated_at: number;
    terminal_at: number | null;
};

export type history_hierarchy_mode = 'none' | 'existing' | 'proposed';

export type history_hierarchy_role_input =
    | { mode: 'none' }
    | { mode: 'existing'; role_id: string }
    | {
        mode: 'proposed';
        semantic_key: string;
        name: string;
        responsibility: string;
    };

export type history_hierarchy_task_input =
    | { mode: 'none' }
    | { mode: 'existing'; task_id: string }
    | {
        mode: 'proposed';
        semantic_key: string;
        title: string;
        objective: string;
    };

export type history_hierarchy_proposal_input = {
    publication_id: string;
    level: 1 | 2 | 3 | 4;
    role: history_hierarchy_role_input;
    task: history_hierarchy_task_input;
    confidence: number;
};

export type history_hierarchy_proposal = {
    proposal_id: string;
    publication_id: string;
    run_id: string;
    candidate_id: string;
    scope_kind: 'run_role' | 'candidate_task' | 'candidate_full';
    proposed_level: 1 | 2 | 3 | 4;
    role_mode: history_hierarchy_mode;
    role_id: string | null;
    role_semantic_key: string | null;
    role_name: string | null;
    role_responsibility: string | null;
    task_mode: history_hierarchy_mode;
    task_id: string | null;
    task_semantic_key: string | null;
    task_title: string | null;
    task_objective: string | null;
    confidence: number;
    evidence: unknown[];
    proposal_hash: string;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
    created_at: number;
};

export type history_governance_action =
    | 'accept_hierarchy'
    | 'reject_hierarchy'
    | 'approve_update'
    | 'approve_conflict'
    | 'discard'
    | 'retry';

export type history_governance_decision_input = {
    publication_id: string;
    proposal_id?: string | null;
    plan_version?: number | null;
    action: history_governance_action;
    actor_id: string;
    actor_kind: 'user';
    action_id: string;
    channel: 'codex_ui' | 'obsidian' | 'local_cli';
    evidence: Record<string, unknown>;
    note?: string;
};

export type history_governance_decision = {
    decision_id: string;
    publication_id: string;
    proposal_id: string | null;
    plan_version: number | null;
    action: history_governance_action;
    actor_kind: 'user' | 'policy' | 'authorized_manifest';
    actor_id: string;
    action_id: string;
    channel: 'codex_ui' | 'obsidian' | 'local_cli' | 'policy';
    evidence: Record<string, unknown>;
    note: string;
    payload_hash: string;
    created_at: number;
};

export type history_publication_plan_input = {
    publication_id: string;
    proposal_id: string;
    memory_kind: string;
    semantic_key: string;
};

export type history_publication_plan = {
    publication_id: string;
    plan_version: number;
    project_id: string;
    proposal_id: string;
    hierarchy_decision_id: string | null;
    level: 1 | 2 | 3 | 4;
    role_id: string | null;
    task_id: string | null;
    memory_kind: string;
    semantic_key_normalized: string;
    semantic_identity_hash: string;
    target_memory_id: string;
    expected_memory_exists: boolean;
    expected_current_version: number | null;
    expected_current_status: string | null;
    expected_current_content_hash: string | null;
    relation: history_publication_relation;
    conflicts: unknown[];
    candidate_finding_hash: string;
    publication_content_hash: string;
    is_major: boolean;
    plan_hash: string;
    created_by_session_id: string;
    created_by_turn_id: string;
    capability_epoch_hash: string;
    created_at: number;
};

export type history_publication_attempt = {
    attempt_id: string;
    publication_id: string;
    plan_version: number;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
    request_hash: string;
    outcome: history_publication_result_kind | 'pending_confirmation' | 'needs_review' | 'retryable';
    result_memory_id: string | null;
    result_version: number | null;
    result_confirmation_id: string | null;
    error_code: string | null;
    error_detail: string | null;
    created_at: number;
};

export type history_publication_execute_input = {
    publication_id: string;
    plan_version: number;
    attempt_id: string;
};

export type history_publication_execute_result = {
    publication: history_publication;
    attempt: history_publication_attempt;
};

export type history_publication_service_options = {
    tenant_id: string;
    user_id: string;
    now?: () => number;
    capability_guard: (worker: history_worker_context) => void;
};

export class history_publication_conflict_error extends Error {
    readonly code = 'HISTORY_PUBLICATION_CONFLICT';

    constructor(message: string) {
        super(message);
        this.name = 'history_publication_conflict_error';
    }
}
