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
 *  file  : src/mcp/schemas/history_backfill_schema.ts
 *  usage : implements the LongMemory history backfill schema component
 */

import * as z from 'zod/v4';

const bounded_id = z.string().trim().min(1).max(1_024);

const history_evidence = z.object({
    chunk_index: z.number().int().nonnegative(),
    turn_index: z.number().int().nonnegative(),
    part_index: z.number().int().nonnegative(),
    quote: z.string().min(1).max(500).optional(),
});

const history_finding = z.object({
    kind: z.enum([
        'completed_work',
        'knowledge',
        'problem_solution',
        'decision',
        'requirement',
        'reproduction',
    ]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1_200),
    body: z.string().trim().min(1).max(8_000),
    importance: z.number().min(0).max(1),
    is_major: z.boolean(),
    evidence: z.array(history_evidence).min(1).max(8),
});

/**
 * The caller provides only the current Codex turn capability plus opaque job
 * handles returned by this gateway.  Project, worker, and source identities
 * are deliberately absent and are derived from the locked hook registry.
 */
export const history_backfill_schema = {
    action: z.enum([
        'status',
        'claim_extract',
        'submit_extract',
        'fail_extract',
        'claim_reduce',
        'reduction_page',
        'submit_reduce',
        'fail_reduce',
    ]),
    session_id: bounded_id,
    capability: z.string().trim().min(32).max(256),
    turn_id: bounded_id,
    run_id: bounded_id.optional(),
    lease_id: z.string().trim().min(1).max(256).optional(),
    chunk_hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    lease_ms: z.number().int().min(1_000).max(60 * 60 * 1_000).optional(),
    findings: z.array(history_finding).max(24).optional(),
    error: z.string().trim().min(1).max(2_000).optional(),
    retry_at: z.number().int().nonnegative().nullable().optional(),
    cursor: z.number().int().nonnegative().optional(),
    page_token_budget: z.number().int().min(128).max(1_400).optional(),
};
