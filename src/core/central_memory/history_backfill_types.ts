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
 *  file  : src/core/central_memory/history_backfill_types.ts
 *  usage : implements the LongMemory history backfill types component
 */

import type { history_import_evidence } from '../../cli/porter/history_authorization.js';
import type { portable_session, portable_turn } from '../../cli/porter/types.js';

export const history_finding_kinds = [
    'completed_work',
    'knowledge',
    'problem_solution',
    'decision',
    'requirement',
    'reproduction',
] as const;

export type history_finding_kind = typeof history_finding_kinds[number];

export const history_backfill_limits = {
    default_max_chunk_tokens: 1_200,
    min_chunk_tokens: 256,
    max_chunk_tokens: 32_000,
    default_max_chunk_chars: 64_000,
    min_chunk_chars: 256,
    max_chunk_chars: 64_000,
    max_session_json_bytes: 128 * 1024 * 1024,
    max_authorization_json_bytes: 64 * 1024,
    max_turns: 250_000,
    max_chunk_findings: 24,
    max_reduction_inputs: 64,
    max_consolidated_findings: 24,
    max_evidence_per_finding: 8,
    max_title_chars: 160,
    max_summary_chars: 1_200,
    max_body_chars: 8_000,
    max_quote_chars: 500,
    max_chunk_findings_json_bytes: 256 * 1024,
    max_consolidated_findings_json_bytes: 1024 * 1024,
    max_error_chars: 2_000,
    min_lease_ms: 1_000,
    max_lease_ms: 60 * 60 * 1_000,
    min_reduction_page_tokens: 128,
    default_reduction_page_tokens: 1_400,
    max_reduction_page_tokens: 1_400,
    max_worker_transport_tokens: 1_800,
} as const;

export type history_backfill_run_status =
    | 'pending'
    | 'extracting'
    | 'ready_for_consolidation'
    | 'consolidating'
    | 'failed'
    | 'candidates_ready'
    | 'superseded';

export type history_backfill_chunk_status = 'pending' | 'leased' | 'completed' | 'failed';

export type history_worker_context = {
    worker_id: string;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
};

export type history_chunk_part = {
    turn_index: number;
    part_index: number;
    part_count: number;
    role: portable_turn['role'];
    text: string;
    timestamp?: number;
    model?: string;
    name?: string;
    tool_call_id?: string;
};

export type history_chunk_payload = {
    schema_version: '1.0.0';
    source_harness: portable_session['source_harness'];
    source_session_id: string;
    source_revision: string;
    chunk_index: number;
    parts: history_chunk_part[];
    model_text: string;
};

export type history_evidence_ref = {
    chunk_index: number;
    turn_index: number;
    part_index: number;
    quote?: string;
};

export type history_backfill_finding = {
    kind: history_finding_kind;
    title: string;
    summary: string;
    body: string;
    importance: number;
    is_major: boolean;
    evidence: history_evidence_ref[];
};

export type history_backfill_create_input = {
    session: portable_session;
    evidence: history_import_evidence;
    project_id: string;
    max_chunk_tokens?: number;
    max_chunk_chars?: number;
    at?: number;
};

export type history_backfill_run = {
    run_id: string;
    project_id: string;
    source_harness: string;
    source_session_id: string;
    source_revision: string;
    source_observed_at: number;
    inventory_id: string;
    reconciliation_digest: string;
    plan_id: string;
    manifest_hash: string;
    authorization_hash: string;
    snapshot_hash: string;
    max_chunk_tokens: number;
    max_chunk_chars: number;
    chunk_count: number;
    total_chars: number;
    completed_chunks: number;
    status: history_backfill_run_status;
    consolidation_attempts: number;
    consolidation_retry_at: number | null;
    consolidated_candidate_count: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    candidates_ready_at: number | null;
    superseded_at: number | null;
};

export type history_backfill_chunk = {
    run_id: string;
    chunk_index: number;
    chunk_hash: string;
    payload: history_chunk_payload;
    character_count: number;
    token_count: number;
    part_count: number;
    first_turn_index: number;
    last_turn_index: number;
    status: history_backfill_chunk_status;
    attempts: number;
    available_at: number;
    finding_count: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
};

export type history_chunk_claim = {
    run: Pick<history_backfill_run,
        'run_id' | 'project_id' | 'source_session_id' | 'source_revision'>;
    chunk: {
        run_id: string;
        chunk_index: number;
        chunk_hash: string;
        model_text: string;
        source_parts: Array<Pick<history_chunk_part,
            'turn_index' | 'part_index' | 'part_count' | 'role'>>;
        character_count: number;
        token_count: number;
    };
    lease_id: string;
    worker_id: string;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
    leased_at: number;
    lease_expires_at: number;
};

export type history_consolidation_claim = {
    run: Pick<history_backfill_run,
        'run_id' | 'project_id' | 'source_session_id' | 'source_revision'>;
    reduction_id: string;
    round_index: number;
    batch_index: number;
    is_final: boolean;
    input_candidate_ids: string[];
    lease_id: string;
    worker_id: string;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
    leased_at: number;
    lease_expires_at: number;
    chunk_candidate_count: number;
};

export type history_reduction_page_item = {
    candidate_id: string;
    /** Concatenate this candidate's fragments by index before parsing its canonical JSON. */
    fragment_index: number;
    fragment_count: number;
    fragment_text: string;
};

export type history_reduction_page = {
    run_id: string;
    reduction_id: string;
    cursor: number;
    next_cursor: number | null;
    items: history_reduction_page_item[];
};

export type history_backfill_receipt = {
    receipt_id: string;
    run_id: string;
    operation_kind: 'chunk' | 'consolidation';
    operation_key: string;
    chunk_index: number | null;
    reduction_id: string | null;
    lease_id: string;
    worker_id: string;
    worker_session_id: string;
    worker_turn_id: string;
    capability_epoch_hash: string;
    input_hash: string;
    result_hash: string;
    candidate_count: number;
    created_at: number;
};

export type history_turn_usage = history_worker_context & {
    project_id: string;
    operation_kind: 'chunk' | 'consolidation';
    run_id: string;
    chunk_index: number | null;
    reduction_id: string | null;
    lease_id: string;
    lease_expires_at: number;
    status: 'active' | 'consumed' | 'expired';
    claimed_at: number;
    consumed_at: number | null;
    expired_at: number | null;
    updated_at: number;
};

export type history_backfill_candidate = {
    candidate_id: string;
    run_id: string;
    stage: 'chunk' | 'consolidated';
    source_chunk_index: number | null;
    reduction_id: string | null;
    finding_index: number;
    finding: history_backfill_finding;
    source_locator: {
        source_harness: string;
        source_session_id: string;
        source_revision: string;
        references: history_evidence_ref[];
    };
    finding_hash: string;
    receipt_id: string;
    created_at: number;
};

export type history_backfill_status = {
    run: history_backfill_run;
    chunks: Record<history_backfill_chunk_status, number>;
    chunk_candidates: number;
    consolidated_candidates: number;
};

export class history_backfill_conflict_error extends Error {
    readonly code = 'HISTORY_BACKFILL_CONFLICT';

    constructor(message: string) {
        super(message);
        this.name = 'history_backfill_conflict_error';
    }
}

export class history_backfill_lease_error extends Error {
    readonly code = 'HISTORY_BACKFILL_LEASE_INVALID';

    constructor(message: string) {
        super(message);
        this.name = 'history_backfill_lease_error';
    }
}
