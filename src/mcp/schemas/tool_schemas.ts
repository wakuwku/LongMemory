/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/mcp/schemas/tool_schemas.ts
 *  usage : implements the LongMemory tool schemas component
 */


import * as z from 'zod/v4';

const optional_text = z.string().trim().min(1).optional();
const project_id = optional_text.describe('Project scope; omitted to use the server project');
const token_budget = z.number().int().min(64).max(32_768).optional();

export const project_context_schema = {
    project_id,
    cwd: optional_text,
    task: z.string().trim().min(1),
    files: z.array(z.string().trim().min(1)).max(100).optional(),
    mode: z.enum(['coding', 'debugging', 'planning', 'review']),
    token_budget,
    agent_id: optional_text,
    framework: optional_text,
    task_id: optional_text,
};

export const match_skills_schema = {
    project_id,
    query: z.string().trim().min(1),
    agent_id: optional_text,
    limit: z.number().int().min(1).max(100).optional(),
};

export const manage_skill_schema = {
    action: z.enum(['create', 'bind', 'archive']),
    project_id: z.string().trim().min(1),
    skill_id: optional_text,
    name: optional_text,
    description: optional_text,
    triggers: z.array(z.string().trim().min(1)).max(100).optional(),
    instructions: z.array(z.string().trim().min(1)).max(200).optional(),
    validation: z.array(z.string().trim().min(1)).max(100).optional(),
    resources: z.array(z.object({ path: z.string().trim().min(1), description: optional_text, checksum: optional_text })).max(100).optional(),
    agent_ids: z.array(z.string().trim().min(1)).max(100).optional(),
    visibility: z.enum(['private', 'project', 'team', 'restricted']).optional(),
    owner: optional_text,
};

export const recall_schema = {
    query: z.string().trim().min(1),
    project_id,
    user_id: optional_text,
    mode: z.enum(['strict', 'historical', 'associative', 'world_grounded']),
    token_budget,
};

export const ingest_schema = {
    project_id,
    user_id: optional_text,
    text: z.string().trim().min(1),
    source: z.string().trim().min(1),
    source_ref: optional_text,
    memory_type: optional_text,
};

export const remember_decision_schema = {
    project_id: z.string().trim().min(1),
    decision: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    alternatives_rejected: z.array(z.string().trim().min(1)).max(50).optional(),
    files_affected: z.array(z.string().trim().min(1)).max(100).optional(),
    source_ref: optional_text,
};

export const update_task_state_schema = {
    project_id: z.string().trim().min(1),
    task: z.string().trim().min(1),
    status: z.enum(['open', 'blocked', 'completed', 'stale', 'active', 'resolved']),
    what_changed: optional_text,
    files_touched: z.array(z.string().trim().min(1)).max(100).optional(),
    errors_seen: z.array(z.string().trim().min(1)).max(100).optional(),
    next_steps: z.array(z.string().trim().min(1)).max(100).optional(),
};

export const explain_schema = {
    memory_id: optional_text,
    query_id: optional_text,
};

export const report_conflicts_schema = {
    project_id: z.string().trim().min(1),
    severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
};

export const sync_connector_schema = {
    connector_id: z.string().trim().min(1),
    project_id,
    dry_run: z.boolean().optional().default(true),
};

export const code_graph_schema = {
    action: z.enum(['search', 'callers', 'callees', 'impact']),
    project_id,
    query: optional_text,
    symbol: optional_text,
    limit: z.number().int().min(1).max(200).optional(),
    max_depth: z.number().int().min(1).max(20).optional(),
};

const asset_acl = z.object({
    subject_type: z.enum(['user', 'team', 'role', 'agent', 'task', 'framework']),
    subject_id: z.string().trim().min(1),
    permissions: z.array(z.enum(['read', 'use', 'assign', 'share', 'manage'])).min(1).max(5),
    effect: z.enum(['allow', 'deny']),
});

const asset_binding = z.object({
    target_type: z.enum(['agent', 'task', 'framework']), target_id: z.string().trim().min(1),
    injection_mode: z.enum(['direct', 'summary', 'tool', 'reference']), priority: z.number().min(0).max(1),
    required: z.boolean().optional(), enabled: z.boolean().optional(), created_by: optional_text,
});

export const asset_catalog_schema = {
    action: z.enum(['list', 'get', 'loadout']), project_id, asset_id: optional_text, query: optional_text,
    agent_id: optional_text, task_id: optional_text, framework: optional_text, include_unbound: z.boolean().optional(),
    asset_types: z.array(z.enum(['chat_memory', 'skill', 'llm_wiki', 'code_graph'])).max(4).optional(), token_budget,
};

export const manage_asset_schema = {
    action: z.enum(['register', 'govern']), project_id, asset_id: optional_text,
    type: z.enum(['chat_memory', 'skill', 'llm_wiki', 'code_graph']).optional(), name: optional_text, description: optional_text,
    source_type: optional_text, source_ref: optional_text, content_ref: optional_text,
    status: z.enum(['draft', 'candidate', 'approved', 'deprecated', 'archived', 'failed']).optional(),
    visibility: z.enum(['private', 'project', 'team', 'restricted', 'agent', 'task']).optional(),
    team_ids: z.array(z.string().trim().min(1)).max(100).optional(), acl: z.array(asset_acl).max(200).optional(),
    bindings: z.array(asset_binding).max(200).optional(), confidence: z.number().min(0).max(1).optional(),
    expires_at: z.number().finite().optional(), labels: z.array(z.string().trim().min(1)).max(100).optional(),
    payload: z.record(z.string(), z.unknown()).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
};

const central_metadata = z.record(z.string(), z.unknown());
const central_version = z.number().int().positive();

export const central_register_thread_schema = {
    thread_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    project_name: optional_text,
    project_description: optional_text,
    project_status: z.enum(['active', 'archived']).optional(),
    project_metadata: central_metadata.optional(),
    role_id: z.string().trim().min(1).nullable().optional(),
    role_name: optional_text,
    role_responsibility: optional_text,
    role_status: z.enum(['active', 'archived']).optional(),
    role_metadata: central_metadata.optional(),
    task_id: z.string().trim().min(1).nullable().optional(),
    task_title: optional_text,
    task_objective: optional_text,
    task_status: z.enum(['active', 'completed', 'blocked', 'archived']).optional(),
    task_metadata: central_metadata.optional(),
    responsibility: optional_text,
    thread_status: z.enum(['active', 'idle', 'completed', 'archived']).optional(),
    thread_metadata: central_metadata.optional(),
    subscribe_to_project: z.boolean().optional(),
};

export const central_context_schema = {
    thread_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    action: z.enum(['read', 'sync']).optional().default('read'),
    limit: z.number().int().min(1).max(500).optional(),
    token_budget: z.number().int().min(64).max(32_768).optional().default(1_800),
    include_consumed: z.boolean().optional().default(false),
};

const central_source_schema = z.object({
    source_id: z.string().trim().min(1),
    source_kind: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    thread_id: optional_text,
    turn_id: optional_text,
    locator: central_metadata.optional(),
    excerpt_hash: optional_text,
    metadata: central_metadata.optional(),
    recorded_at: z.number().int().nonnegative().optional(),
    evidence_role: optional_text,
    link_locator: central_metadata.optional(),
});

export const central_publish_schema = {
    memory_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    role_id: optional_text,
    task_id: optional_text,
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    memory_kind: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    body: z.string().trim().min(1),
    importance: z.number().min(0).max(1).optional(),
    major: z.boolean().optional(),
    lock: z.boolean().optional(),
    change_reason: optional_text,
    metadata: central_metadata.optional(),
    expected_current_version: central_version.nullable().optional(),
    confirmation_prompt: optional_text,
    source_thread_id: z.string().trim().min(1),
    sources: z.array(central_source_schema).max(100).optional(),
};

const central_actor_schema = z.object({
    actor_id: z.string().trim().min(1),
    actor_kind: z.literal('user'),
    action_id: z.string().trim().min(1),
    channel: z.enum(['codex_ui', 'obsidian', 'local_cli']),
    decided_at: z.number().int().nonnegative(),
    note: optional_text,
    evidence: central_metadata.refine((value) => Object.keys(value).length > 0,
        'actor evidence must not be empty'),
});

export const central_confirmation_schema = {
    action: z.enum(['approve', 'reject']),
    confirmation_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    decision_note: optional_text,
    actor: central_actor_schema,
};

export const central_conflict_schema = {
    action: z.enum(['list', 'report', 'resolve', 'dismiss']),
    project_id: z.string().trim().min(1),
    status: z.enum(['open', 'resolved', 'dismissed']).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    conflict_id: optional_text,
    memory_a_id: optional_text,
    memory_a_version: central_version.optional(),
    memory_b_id: optional_text,
    memory_b_version: central_version.optional(),
    severity: z.number().min(0).max(1).optional(),
    rationale: optional_text,
    metadata: central_metadata.optional(),
    resolution_memory_id: optional_text,
    resolution_version: central_version.optional(),
    decision_note: optional_text,
    actor: central_actor_schema.optional(),
};

export const central_project_link_schema = {
    action: z.enum(['list', 'create', 'revoke']),
    project_id: z.string().trim().min(1),
    source_project_id: optional_text,
    target_project_id: optional_text,
    direction: z.enum(['one_way', 'two_way']).optional(),
    link_id: optional_text,
    status: z.enum(['active', 'revoked']).optional(),
    metadata: central_metadata.optional(),
    actor: central_actor_schema.optional(),
};

export const central_usage_schema = {
    action: z.enum(['consume', 'dependency']),
    thread_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    memory_id: z.string().trim().min(1),
    memory_version: central_version,
    dependency_id: optional_text,
    subject_kind: z.enum(['task', 'artifact', 'decision', 'output']).optional(),
    subject_id: optional_text,
    details: central_metadata.optional(),
};

export const central_finalize_turn_schema = {
    thread_id: z.string().trim().min(1),
    turn_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    memory_extracted: z.boolean(),
    memory_id: optional_text,
    memory_version: central_version.optional(),
    note: optional_text,
};

const codex_conflict_reference = z.object({
    memory_id: z.string().trim().min(1),
    version: central_version,
    severity: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(8_192),
});

const codex_memory_candidate = z.object({
    memory_id: optional_text,
    expected_current_version: central_version.nullable().optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    memory_kind: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(1_024),
    summary: z.string().trim().min(1).max(8_192),
    body: z.string().trim().min(1).max(64_000),
    importance: z.number().min(0).max(1).optional(),
    major: z.boolean().optional(),
    lock: z.boolean().optional(),
    change_reason: z.string().trim().min(1).max(8_192).optional(),
    metadata: central_metadata.optional(),
    conflict_with: z.array(codex_conflict_reference).max(10).optional(),
});

export const codex_memory_schema = {
    action: z.enum(['bind', 'recall', 'record_turn']),
    session_id: z.string().trim().min(1).max(1_024),
    capability: z.string().trim().min(32).max(256),
    project_id: z.string().trim().min(1).max(1_024).optional(),
    project_name: z.string().trim().min(1).max(1_024).optional(),
    project_description: z.string().trim().max(8_192).optional(),
    responsibility: z.string().trim().min(1).max(8_192).optional(),
    role_id: z.string().trim().min(1).max(1_024).optional(),
    role_name: z.string().trim().min(1).max(512).optional(),
    role_responsibility: z.string().trim().min(1).max(8_192).optional(),
    task_id: z.string().trim().min(1).max(1_024).optional(),
    task_title: z.string().trim().min(1).max(1_024).optional(),
    task_objective: z.string().trim().max(8_192).optional(),
    initial_query: z.string().trim().min(1).max(2_048).optional(),
    turn_id: z.string().trim().min(1).max(1_024),
    memories: z.array(codex_memory_candidate).max(20).optional(),
    acknowledged_delivery_ids: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    note: z.string().trim().max(8_192).optional(),
    query: z.string().trim().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(24).optional(),
    token_budget: z.number().int().min(256).max(1_800).optional(),
};
