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
 *  file  : src/mcp/schemas/history_publication_schema.ts
 *  usage : implements the LongMemory history publication schema component
 */

import * as z from 'zod/v4';

const bounded_id = z.string().trim().min(1).max(1_024);
const bounded_key = z.string().trim().min(1).max(2_048);
const bounded_description = z.string().trim().min(1).max(8_000);

const history_role = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({
        mode: z.literal('existing'),
        role_id: bounded_id,
    }),
    z.object({
        mode: z.literal('proposed'),
        semantic_key: bounded_key,
        name: z.string().trim().min(1).max(512),
        responsibility: bounded_description,
    }),
]);

const history_task = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({
        mode: z.literal('existing'),
        task_id: bounded_id,
    }),
    z.object({
        mode: z.literal('proposed'),
        semantic_key: bounded_key,
        title: z.string().trim().min(1).max(1_024),
        objective: bounded_description,
    }),
]);

/**
 * Project, worker, source, and capability-hash identities are deliberately
 * absent. The Codex gateway derives them from the locked hook task state.
 */
export const history_publication_schema = {
    action: z.enum([
        'get',
        'list',
        'propose_hierarchy',
        'create_plan',
        'execute',
        'reconcile_confirmation',
    ]),
    session_id: bounded_id,
    capability: z.string().trim().min(32).max(256),
    turn_id: bounded_id,
    publication_id: bounded_id.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().nonnegative().optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    role: history_role.optional(),
    task: history_task.optional(),
    confidence: z.number().min(0).max(1).optional(),
    proposal_id: bounded_id.optional(),
    memory_kind: z.string().trim().min(1).max(256).optional(),
    semantic_key: bounded_key.optional(),
    plan_version: z.number().int().positive().optional(),
    attempt_id: z.string().trim().min(1).max(512).optional(),
};

function meaningful_evidence(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.some(meaningful_evidence);
    if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some(meaningful_evidence);
    }
    return false;
}

const governance_evidence = z.record(z.string().trim().min(1).max(256), z.unknown())
    .refine((value) => Object.keys(value).length > 0 && meaningful_evidence(value),
        'history governance requires non-empty evidence of a real user action');

/**
 * actor_id and actor_kind are intentionally not caller-controlled. The tool
 * handler always attributes the decision to the authenticated runtime user.
 */
export const history_governance_schema = {
    action: z.enum([
        'accept_hierarchy',
        'reject_hierarchy',
        'approve_update',
        'approve_conflict',
        'discard',
        'retry',
    ]),
    publication_id: bounded_id,
    proposal_id: bounded_id.nullable().optional(),
    plan_version: z.number().int().positive().nullable().optional(),
    action_id: z.string().trim().min(1).max(512),
    channel: z.enum(['codex_ui', 'obsidian', 'local_cli']),
    evidence: governance_evidence,
    note: z.string().trim().min(1).max(2_000).optional(),
};
