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
 *  file  : src/integrations/codex_hooks/types.ts
 *  usage : implements the LongMemory types component
 */

import type { central_memory_level } from '../../core/central_memory/types.js';

export const CODEX_HOOK_STATE_VERSION = 1 as const;
export const DEFAULT_CODEX_HOOK_TOKEN_BUDGET = 1_800;

export type codex_hook_event_name =
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreCompact'
    | 'PostCompact'
    | 'Stop';

export type codex_hook_event = {
    session_id: string;
    transcript_path: string | null;
    cwd: string;
    hook_event_name: codex_hook_event_name;
    model?: string;
    permission_mode?: string;
    turn_id?: string;
    source?: 'startup' | 'resume' | 'clear' | 'compact';
    prompt?: string;
    trigger?: 'manual' | 'auto';
    stop_hook_active?: boolean;
    last_assistant_message?: string | null;
};

export type codex_delivery_receipt = {
    delivery_id: string;
    event_name: codex_hook_event_name;
    turn_id: string | null;
    created_at: number;
    context_hash: string;
    memory_refs: Array<{ memory_id: string; version: number }>;
    retraction_refs: Array<{ memory_id: string; version: number | null }>;
};

export type codex_hook_checkpoint = {
    turn_id: string | null;
    trigger: 'manual' | 'auto' | null;
    at: number;
    worksets: Array<{
        memory_id: string;
        synced_version: number | null;
        consumed_version: number | null;
        pending_version: number | null;
        sync_state: 'pending' | 'current' | 'retracted';
    }>;
};

export type codex_hook_session_state = {
    schema_version: typeof CODEX_HOOK_STATE_VERSION;
    session_id: string;
    capability: string;
    capability_turn_id: string | null;
    project_id: string;
    project_name: string;
    project_was_configured: boolean;
    configured_project_id: string | null;
    db_path: string;
    tenant_id: string;
    user_id: string;
    cwd: string;
    transcript_path: string | null;
    bound: boolean;
    responsibility: string;
    role_id: string | null;
    task_id: string | null;
    last_checkpoint: codex_hook_checkpoint | null;
    created_at: number;
    updated_at: number;
};

export type codex_hook_runtime_options = {
    plugin_data: string;
    db_path: string;
    tenant_id: string;
    user_id: string;
    project_id: string;
    project_name: string;
    project_was_configured: boolean;
    token_budget?: number;
    now?: () => number;
};

export type codex_hook_output = {
    continue?: boolean;
    stopReason?: string;
    systemMessage?: string;
    decision?: 'block';
    reason?: string;
    hookSpecificOutput?: {
        hookEventName: 'SessionStart' | 'UserPromptSubmit';
        additionalContext: string;
    };
};

export type codex_bind_input = {
    session_id: string;
    capability: string;
    turn_id: string;
    project_id: string;
    project_name?: string;
    project_description?: string;
    responsibility: string;
    role_id?: string;
    role_name?: string;
    role_responsibility?: string;
    task_id?: string;
    task_title?: string;
    task_objective?: string;
    /** Current business request used once to stage a bounded, project-scoped initial recall. */
    initial_query?: string;
};

export type codex_memory_candidate = {
    memory_id?: string;
    expected_current_version?: number | null;
    level: central_memory_level;
    memory_kind: string;
    title: string;
    summary: string;
    body: string;
    importance?: number;
    major?: boolean;
    lock?: boolean;
    change_reason?: string;
    metadata?: Record<string, unknown>;
    conflict_with?: Array<{
        memory_id: string;
        version: number;
        severity: number;
        rationale: string;
    }>;
};

export type codex_record_turn_input = {
    session_id: string;
    capability: string;
    turn_id: string;
    memories: codex_memory_candidate[];
    acknowledged_delivery_ids?: string[];
    note?: string;
};

export type codex_recall_input = {
    session_id: string;
    capability: string;
    turn_id: string;
    query: string;
    limit?: number;
    token_budget?: number;
};
