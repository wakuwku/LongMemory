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
 *  file  : src/core/central_memory/history_backfill_service.ts
 *  usage : implements the LongMemory history backfill service component
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { portable_session, portable_turn } from '../../cli/porter/types.js';
import { portable_session_revision } from '../../cli/porter/history_revision.js';
import { assert_issued_history_redaction_evidence } from '../../cli/porter/history_authorization.js';
import {
    history_redaction_mode,
    history_redaction_policy_version,
} from '../../cli/porter/history_redaction.js';
import { canonicalize } from '../hash/canonical_json.js';
import { hash_canonical } from '../hash/content_hash.js';
import { count_tokens } from '../recall/context_builder.js';
import {
    assert_no_obvious_credentials,
    obvious_credential_detector_version,
} from './sensitive_content.js';
import { has_active_history_worker_authorization } from './history_worker_authorization.js';
import {
    history_backfill_conflict_error,
    history_backfill_lease_error,
    history_backfill_limits,
    history_finding_kinds,
    type history_backfill_candidate,
    type history_backfill_chunk,
    type history_backfill_create_input,
    type history_backfill_finding,
    type history_backfill_receipt,
    type history_backfill_run,
    type history_backfill_status,
    type history_chunk_claim,
    type history_chunk_part,
    type history_chunk_payload,
    type history_consolidation_claim,
    type history_evidence_ref,
    type history_reduction_page,
    type history_reduction_page_item,
    type history_turn_usage,
    type history_worker_context,
} from './history_backfill_types.js';

type row = Record<string, unknown>;
type normalized_session = portable_session;
type chunk_draft = {
    payload: history_chunk_payload;
    payload_json: string;
    chunk_hash: string;
    character_count: number;
    token_count: number;
    first_turn_index: number;
    last_turn_index: number;
};
type reduction = {
    reduction_id: string;
    run_id: string;
    round_index: number;
    batch_index: number;
    is_final: boolean;
    input_candidate_ids: string[];
    allowed_evidence: history_evidence_ref[];
    input_hash: string;
    input_count: number;
    status: 'pending' | 'leased' | 'completed' | 'failed';
    lease_id: string | null;
    lease_expires_at: number | null;
    available_at: number;
    attempts: number;
};

const unfinished_run_statuses = [
    'pending', 'extracting', 'ready_for_consolidation', 'consolidating', 'failed',
] as const;
const finding_kind_set = new Set<string>(history_finding_kinds);
const max_sqlite_timestamp = Number.MAX_SAFE_INTEGER;
const max_worker_claim_tokens = history_backfill_limits.max_worker_transport_tokens;

const number_or_null = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const string_or_null = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

function code_point_length(value: string): number {
    return [...value].length;
}

function json_bytes(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function plain_record(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

function exact_keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const permitted = new Set(allowed);
    const unexpected = Object.keys(value).filter((key) => !permitted.has(key));
    if (unexpected.length) throw new Error(`${label} contains unsupported fields`);
}

function bounded_string(value: unknown, label: string, min: number, max: number): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    const length = code_point_length(value);
    if (length < min || length > max) throw new Error(`${label} must contain between ${min} and ${max} characters`);
    return value;
}

function optional_string(value: unknown, label: string, max: number): string | undefined {
    if (value === undefined) return undefined;
    return bounded_string(value, label, 0, max);
}

function finite_number(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
    return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function canonical_string_array(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
        throw new Error(`${label} must contain between 1 and 256 strings`);
    }
    const result = value.map((item, index) => bounded_string(item, `${label}[${index}]`, 1, 4_096));
    if (new Set(result).size !== result.length
        || result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
        throw new Error(`${label} must be unique and canonically sorted`);
    }
    return result;
}

function sha256_digest(value: unknown, label: string): string {
    const result = bounded_string(value, label, 64, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 digest`);
    return result;
}

function canonical_json(value: unknown, label: string, max_bytes: number): string {
    let ordinary_json: string | undefined;
    try {
        ordinary_json = JSON.stringify(value);
    } catch (error) {
        throw new Error(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ordinary_json === undefined) throw new Error(`${label} must be JSON serializable`);
    let result: string;
    try {
        result = canonicalize(JSON.parse(ordinary_json) as unknown);
    } catch (error) {
        throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (json_bytes(result) > max_bytes) throw new Error(`${label} exceeds ${max_bytes} UTF-8 bytes`);
    return result;
}

function normalize_turn(value: portable_turn, turn_index: number): portable_turn {
    const item = plain_record(value, `turn ${turn_index}`);
    exact_keys(item, ['role', 'text', 'timestamp', 'model', 'name', 'tool_call_id'], `turn ${turn_index}`);
    if (!['system', 'user', 'assistant', 'tool'].includes(String(item.role))) {
        throw new Error(`turn ${turn_index}.role is invalid`);
    }
    const text = bounded_string(item.text, `turn ${turn_index}.text`, 0, 32 * 1024 * 1024);
    const timestamp = item.timestamp === undefined ? undefined : finite_number(item.timestamp, `turn ${turn_index}.timestamp`);
    return {
        role: item.role as portable_turn['role'],
        text,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(item.model === undefined ? {} : { model: optional_string(item.model, `turn ${turn_index}.model`, 1_024) }),
        ...(item.name === undefined ? {} : { name: optional_string(item.name, `turn ${turn_index}.name`, 1_024) }),
        ...(item.tool_call_id === undefined ? {} : { tool_call_id: optional_string(item.tool_call_id, `turn ${turn_index}.tool_call_id`, 4_096) }),
    };
}

function normalize_session(value: portable_session): normalized_session {
    const session = plain_record(value, 'history session');
    exact_keys(session, [
        'schema_version', 'source_harness', 'source_session_id', 'source_path', 'cwd', 'title',
        'created_at', 'updated_at', 'turns', 'dropped_turns', 'source_metadata',
    ], 'history session');
    if (session.schema_version !== '1.0.0') throw new Error('history session schema_version must be 1.0.0');
    if (session.source_harness !== 'codex') throw new Error('history semantic backfill requires an authorized Codex session');
    if (!Array.isArray(session.turns)) throw new Error('history session turns must be an array');
    if (session.turns.length > history_backfill_limits.max_turns) {
        throw new Error(`history session exceeds ${history_backfill_limits.max_turns} turns`);
    }
    const source_metadata = plain_record(session.source_metadata, 'history session source_metadata');
    const metadata_json = canonical_json(source_metadata, 'history session source_metadata', 16 * 1024 * 1024);
    const created_at = session.created_at === undefined ? undefined : finite_number(session.created_at, 'history session created_at');
    const updated_at = session.updated_at === undefined ? undefined : finite_number(session.updated_at, 'history session updated_at');
    const dropped_turns = integer(session.dropped_turns, 'history session dropped_turns', 0, Number.MAX_SAFE_INTEGER);
    const normalized: portable_session = {
        schema_version: '1.0.0',
        source_harness: 'codex',
        source_session_id: bounded_string(session.source_session_id, 'history session source_session_id', 1, 1_024),
        source_path: bounded_string(session.source_path, 'history session source_path', 1, 32_768),
        cwd: bounded_string(session.cwd, 'history session cwd', 0, 32_768),
        title: bounded_string(session.title, 'history session title', 0, 8_192),
        ...(created_at === undefined ? {} : { created_at }),
        ...(updated_at === undefined ? {} : { updated_at }),
        turns: (session.turns as portable_turn[]).map(normalize_turn),
        dropped_turns,
        source_metadata: JSON.parse(metadata_json) as Record<string, unknown>,
    };
    canonical_json(normalized, 'history session snapshot', history_backfill_limits.max_session_json_bytes);
    return normalized;
}

function render_part(part: Pick<history_chunk_part, 'turn_index' | 'part_index' | 'role' | 'text'>): string {
    return `[turn=${part.turn_index} part=${part.part_index} role=${part.role}]\n${part.text}`;
}

function render_parts(parts: readonly history_chunk_part[]): string {
    return parts.map(render_part).join('\n\n');
}

function split_turn(
    turn: portable_turn,
    turn_index: number,
    max_tokens: number,
    max_chars: number,
): history_chunk_part[] {
    if (!turn.text.length) {
        return [{ turn_index, part_index: 0, part_count: 1, ...turn }];
    }
    const points = [...turn.text];
    const texts: string[] = [];
    let cursor = 0;
    while (cursor < points.length) {
        const part_index = texts.length;
        let low = cursor + 1;
        let high = Math.min(points.length, cursor + max_chars);
        let best = cursor;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const text = points.slice(cursor, middle).join('');
            const cost = count_tokens(render_part({ turn_index, part_index, role: turn.role, text }));
            if (cost <= max_tokens) {
                best = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (best === cursor) {
            throw new Error(`max_chunk_tokens is too small to contain turn ${turn_index} part ${part_index}`);
        }
        texts.push(points.slice(cursor, best).join(''));
        cursor = best;
    }
    return texts.map((text, part_index) => ({
        turn_index,
        part_index,
        part_count: texts.length,
        role: turn.role,
        text,
        ...(turn.timestamp === undefined ? {} : { timestamp: turn.timestamp }),
        ...(turn.model === undefined ? {} : { model: turn.model }),
        ...(turn.name === undefined ? {} : { name: turn.name }),
        ...(turn.tool_call_id === undefined ? {} : { tool_call_id: turn.tool_call_id }),
    }));
}

function build_chunks(
    session: portable_session,
    revision: string,
    max_tokens: number,
    max_chars: number,
): chunk_draft[] {
    const all_parts = session.turns.flatMap((turn, turn_index) => split_turn(turn, turn_index, max_tokens, max_chars));
    const groups: history_chunk_part[][] = [];
    let current: history_chunk_part[] = [];
    let current_chars = 0;
    for (const part of all_parts) {
        const part_chars = code_point_length(part.text);
        const proposed = [...current, part];
        const fits = current.length === 0 || (
            current_chars + part_chars <= max_chars
            && count_tokens(render_parts(proposed)) <= max_tokens
        );
        if (!fits) {
            groups.push(current);
            current = [];
            current_chars = 0;
        }
        current.push(part);
        current_chars += part_chars;
        const rendered = render_parts(current);
        if (current_chars > max_chars || count_tokens(rendered) > max_tokens) {
            throw new Error(`history chunk containing turn ${part.turn_index} exceeds configured bounds`);
        }
    }
    if (current.length) groups.push(current);

    return groups.map((parts, chunk_index) => {
        const model_text = render_parts(parts);
        const payload: history_chunk_payload = {
            schema_version: '1.0.0',
            source_harness: session.source_harness,
            source_session_id: session.source_session_id,
            source_revision: revision,
            chunk_index,
            parts,
            model_text,
        };
        const payload_json = canonicalize(payload);
        return {
            payload,
            payload_json,
            chunk_hash: hash_canonical(payload),
            character_count: parts.reduce((sum, part) => sum + code_point_length(part.text), 0),
            token_count: count_tokens(model_text),
            first_turn_index: parts[0]!.turn_index,
            last_turn_index: parts[parts.length - 1]!.turn_index,
        };
    });
}

function parse_chunk_payload(value: unknown): history_chunk_payload {
    if (typeof value !== 'string') throw new Error('stored history chunk payload is invalid');
    return JSON.parse(value) as history_chunk_payload;
}

function map_run(value: row): history_backfill_run {
    return {
        run_id: String(value.run_id),
        project_id: String(value.project_id),
        source_harness: String(value.source_harness),
        source_session_id: String(value.source_session_id),
        source_revision: String(value.source_revision),
        source_observed_at: Number(value.source_observed_at),
        inventory_id: String(value.inventory_id),
        reconciliation_digest: String(value.reconciliation_digest),
        plan_id: String(value.plan_id),
        manifest_hash: String(value.manifest_hash),
        authorization_hash: String(value.authorization_hash),
        snapshot_hash: String(value.snapshot_hash),
        max_chunk_tokens: Number(value.chunk_size_tokens),
        max_chunk_chars: Number(value.chunk_size_chars),
        chunk_count: Number(value.chunk_count),
        total_chars: Number(value.total_chars),
        completed_chunks: Number(value.completed_chunks),
        status: value.status as history_backfill_run['status'],
        consolidation_attempts: Number(value.consolidation_attempts),
        consolidation_retry_at: number_or_null(value.consolidation_retry_at),
        consolidated_candidate_count: Number(value.consolidated_candidate_count),
        last_error: string_or_null(value.last_error),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
        candidates_ready_at: number_or_null(value.candidates_ready_at),
        superseded_at: number_or_null(value.superseded_at),
    };
}

function map_chunk(value: row): history_backfill_chunk {
    return {
        run_id: String(value.run_id),
        chunk_index: Number(value.chunk_index),
        chunk_hash: String(value.chunk_hash),
        payload: parse_chunk_payload(value.payload_json),
        character_count: Number(value.character_count),
        token_count: Number(value.token_count),
        part_count: Number(value.part_count),
        first_turn_index: Number(value.first_turn_index),
        last_turn_index: Number(value.last_turn_index),
        status: value.status as history_backfill_chunk['status'],
        attempts: Number(value.attempts),
        available_at: Number(value.available_at),
        finding_count: Number(value.finding_count),
        last_error: string_or_null(value.last_error),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
        completed_at: number_or_null(value.completed_at),
    };
}

function claim_run(run: history_backfill_run): history_chunk_claim['run'] {
    return {
        run_id: run.run_id,
        project_id: run.project_id,
        source_session_id: run.source_session_id,
        source_revision: run.source_revision,
    };
}

function claim_chunk(chunk: history_backfill_chunk): history_chunk_claim['chunk'] {
    return {
        run_id: chunk.run_id,
        chunk_index: chunk.chunk_index,
        chunk_hash: chunk.chunk_hash,
        model_text: chunk.payload.model_text,
        source_parts: chunk.payload.parts.map((part) => ({
            turn_index: part.turn_index,
            part_index: part.part_index,
            part_count: part.part_count,
            role: part.role,
        })),
        character_count: chunk.character_count,
        token_count: chunk.token_count,
    };
}

function bounded_worker_claim<T extends history_chunk_claim | history_consolidation_claim>(claim: T): T {
    const tokens = count_tokens(canonicalize(claim));
    if (tokens > max_worker_claim_tokens) {
        throw new Error(`history worker claim exceeds the ${max_worker_claim_tokens}-token transport budget`);
    }
    return claim;
}

function reduction_page_tokens(value: history_reduction_page): number {
    return count_tokens(canonicalize(value));
}

function bounded_reduction_page(
    value: history_reduction_page,
    requested_budget: number,
): history_reduction_page {
    const budget = Math.min(requested_budget, history_backfill_limits.max_worker_transport_tokens);
    const tokens = reduction_page_tokens(value);
    if (tokens > budget) {
        throw new Error(`history reduction page exceeds its ${budget}-token transport budget`);
    }
    return value;
}

function canonical_reduction_candidate(candidate: history_backfill_candidate): string {
    return canonicalize({
        candidate_id: candidate.candidate_id,
        finding: candidate.finding,
        finding_hash: candidate.finding_hash,
    });
}

function fragment_reduction_candidate(
    candidate: history_backfill_candidate,
    run_id: string,
    reduction_id: string,
): history_reduction_page_item[] {
    const source = [...canonical_reduction_candidate(candidate)];
    const fragments: string[] = [];
    const conservative_index = Number.MAX_SAFE_INTEGER;
    let offset = 0;
    while (offset < source.length) {
        let low = 1;
        let high = source.length - offset;
        let accepted = 0;
        while (low <= high) {
            const length = low + Math.floor((high - low) / 2);
            const fragment_text = source.slice(offset, offset + length).join('');
            const probe: history_reduction_page = {
                run_id,
                reduction_id,
                cursor: conservative_index,
                next_cursor: conservative_index,
                items: [{
                    candidate_id: candidate.candidate_id,
                    fragment_index: conservative_index,
                    fragment_count: conservative_index,
                    fragment_text,
                }],
            };
            if (reduction_page_tokens(probe) <= history_backfill_limits.min_reduction_page_tokens) {
                accepted = length;
                low = length + 1;
            } else {
                high = length - 1;
            }
        }
        if (accepted < 1) {
            throw new Error('history reduction candidate metadata exceeds the minimum page budget');
        }
        fragments.push(source.slice(offset, offset + accepted).join(''));
        offset += accepted;
    }
    return fragments.map((fragment_text, fragment_index) => ({
        candidate_id: candidate.candidate_id,
        fragment_index,
        fragment_count: fragments.length,
        fragment_text,
    }));
}

function map_receipt(value: row): history_backfill_receipt {
    return {
        receipt_id: String(value.receipt_id),
        run_id: String(value.run_id),
        operation_kind: value.operation_kind as history_backfill_receipt['operation_kind'],
        operation_key: String(value.operation_key),
        chunk_index: number_or_null(value.chunk_index),
        reduction_id: string_or_null(value.reduction_id),
        lease_id: String(value.lease_id),
        worker_id: String(value.worker_id),
        worker_session_id: String(value.worker_session_id),
        worker_turn_id: String(value.worker_turn_id),
        capability_epoch_hash: String(value.capability_epoch_hash),
        input_hash: String(value.input_hash),
        result_hash: String(value.result_hash),
        candidate_count: Number(value.candidate_count),
        created_at: Number(value.created_at),
    };
}

function map_turn_usage(value: row): history_turn_usage {
    return {
        worker_id: String(value.worker_id),
        worker_session_id: String(value.worker_session_id),
        worker_turn_id: String(value.worker_turn_id),
        capability_epoch_hash: String(value.capability_epoch_hash),
        project_id: String(value.project_id),
        operation_kind: value.operation_kind as history_turn_usage['operation_kind'],
        run_id: String(value.run_id),
        chunk_index: number_or_null(value.chunk_index),
        reduction_id: string_or_null(value.reduction_id),
        lease_id: String(value.lease_id),
        lease_expires_at: Number(value.lease_expires_at),
        status: value.status as history_turn_usage['status'],
        claimed_at: Number(value.claimed_at),
        consumed_at: number_or_null(value.consumed_at),
        expired_at: number_or_null(value.expired_at),
        updated_at: Number(value.updated_at),
    };
}

function normalize_worker_context(value: history_worker_context): history_worker_context {
    const worker = plain_record(value, 'history worker context');
    exact_keys(worker, [
        'worker_id', 'worker_session_id', 'worker_turn_id', 'capability_epoch_hash',
    ], 'history worker context');
    const capability_epoch_hash = bounded_string(
        worker.capability_epoch_hash, 'capability_epoch_hash', 64, 64,
    );
    if (!/^[a-f0-9]{64}$/i.test(capability_epoch_hash)) {
        throw new Error('capability_epoch_hash must be a SHA-256 hex digest');
    }
    return {
        worker_id: bounded_string(worker.worker_id, 'worker_id', 1, 256),
        worker_session_id: bounded_string(worker.worker_session_id, 'worker_session_id', 1, 1_024),
        worker_turn_id: bounded_string(worker.worker_turn_id, 'worker_turn_id', 1, 1_024),
        capability_epoch_hash,
    };
}

function map_candidate(value: row): history_backfill_candidate {
    return {
        candidate_id: String(value.candidate_id),
        run_id: String(value.run_id),
        stage: value.stage as history_backfill_candidate['stage'],
        source_chunk_index: number_or_null(value.source_chunk_index),
        reduction_id: string_or_null(value.reduction_id),
        finding_index: Number(value.finding_index),
        finding: JSON.parse(String(value.finding_json)) as history_backfill_finding,
        source_locator: JSON.parse(String(value.evidence_json)) as history_backfill_candidate['source_locator'],
        finding_hash: String(value.finding_hash),
        receipt_id: String(value.receipt_id),
        created_at: Number(value.created_at),
    };
}

function map_reduction(value: row): reduction {
    return {
        reduction_id: String(value.reduction_id),
        run_id: String(value.run_id),
        round_index: Number(value.round_index),
        batch_index: Number(value.batch_index),
        is_final: Boolean(value.is_final),
        input_candidate_ids: JSON.parse(String(value.input_candidate_ids_json)) as string[],
        allowed_evidence: JSON.parse(String(value.allowed_evidence_json)) as history_evidence_ref[],
        input_hash: String(value.input_hash),
        input_count: Number(value.input_count),
        status: value.status as reduction['status'],
        lease_id: string_or_null(value.lease_id),
        lease_expires_at: number_or_null(value.lease_expires_at),
        available_at: Number(value.available_at),
        attempts: Number(value.attempts),
    };
}

function normalize_findings(
    value: unknown,
    chunks: readonly history_backfill_chunk[],
    stage: 'chunk' | 'consolidated',
    allowed_evidence?: readonly history_evidence_ref[],
): history_backfill_finding[] {
    if (!Array.isArray(value)) throw new Error('history findings must be an array');
    const maximum = stage === 'chunk'
        ? history_backfill_limits.max_chunk_findings
        : history_backfill_limits.max_consolidated_findings;
    if (value.length > maximum) throw new Error(`history ${stage} submission exceeds ${maximum} findings`);
    const parts = new Map<string, history_chunk_part>();
    for (const chunk of chunks) {
        for (const part of chunk.payload.parts) parts.set(`${chunk.chunk_index}:${part.turn_index}:${part.part_index}`, part);
    }
    const allowed_evidence_set = allowed_evidence === undefined
        ? null
        : new Set(allowed_evidence.map((reference) => canonicalize(reference)));
    if (stage === 'consolidated' && allowed_evidence_set === null) {
        throw new Error('history consolidation requires a server-derived evidence allowlist');
    }
    const normalized = value.map((raw, finding_index): history_backfill_finding => {
        const item = plain_record(raw, `finding ${finding_index}`);
        exact_keys(item, ['kind', 'title', 'summary', 'body', 'importance', 'is_major', 'evidence'], `finding ${finding_index}`);
        if (typeof item.kind !== 'string' || !finding_kind_set.has(item.kind)) {
            throw new Error(`finding ${finding_index}.kind is not an allowed durable-memory category`);
        }
        if (typeof item.importance !== 'number' || !Number.isFinite(item.importance)
            || item.importance < 0 || item.importance > 1) {
            throw new Error(`finding ${finding_index}.importance must be between 0 and 1`);
        }
        if (typeof item.is_major !== 'boolean') throw new Error(`finding ${finding_index}.is_major must be boolean`);
        if (!Array.isArray(item.evidence) || item.evidence.length < 1
            || item.evidence.length > history_backfill_limits.max_evidence_per_finding) {
            throw new Error(`finding ${finding_index}.evidence must contain between 1 and ${history_backfill_limits.max_evidence_per_finding} references`);
        }
        const seen = new Set<string>();
        const evidence = item.evidence.map((raw_ref, evidence_index): history_evidence_ref => {
            const ref = plain_record(raw_ref, `finding ${finding_index}.evidence ${evidence_index}`);
            exact_keys(ref, ['chunk_index', 'turn_index', 'part_index', 'quote'], `finding ${finding_index}.evidence ${evidence_index}`);
            const chunk_index = integer(ref.chunk_index, 'evidence chunk_index', 0, Number.MAX_SAFE_INTEGER);
            const turn_index = integer(ref.turn_index, 'evidence turn_index', 0, Number.MAX_SAFE_INTEGER);
            const part_index = integer(ref.part_index, 'evidence part_index', 0, Number.MAX_SAFE_INTEGER);
            if (stage === 'chunk' && chunks.length === 1 && chunk_index !== chunks[0]!.chunk_index) {
                throw new Error(`finding ${finding_index} cites a chunk outside its lease`);
            }
            const part = parts.get(`${chunk_index}:${turn_index}:${part_index}`);
            if (!part) throw new Error(`finding ${finding_index} cites missing source part ${chunk_index}:${turn_index}:${part_index}`);
            const quote = ref.quote === undefined
                ? undefined
                : bounded_string(ref.quote, `finding ${finding_index}.evidence ${evidence_index}.quote`, 1, history_backfill_limits.max_quote_chars);
            if (quote !== undefined && !part.text.includes(quote)) {
                throw new Error(`finding ${finding_index} evidence quote is not present in the cited source part`);
            }
            const identity = `${chunk_index}:${turn_index}:${part_index}:${quote ?? ''}`;
            if (seen.has(identity)) throw new Error(`finding ${finding_index} contains duplicate evidence`);
            seen.add(identity);
            const normalized_ref = { chunk_index, turn_index, part_index, ...(quote === undefined ? {} : { quote }) };
            if (allowed_evidence_set !== null && !allowed_evidence_set.has(canonicalize(normalized_ref))) {
                throw new Error(`finding ${finding_index} cites evidence outside its reduction inputs`);
            }
            return normalized_ref;
        });
        return {
            kind: item.kind as history_backfill_finding['kind'],
            title: bounded_string(item.title, `finding ${finding_index}.title`, 1, history_backfill_limits.max_title_chars).trim(),
            summary: bounded_string(item.summary, `finding ${finding_index}.summary`, 1, history_backfill_limits.max_summary_chars).trim(),
            body: bounded_string(item.body, `finding ${finding_index}.body`, 1, history_backfill_limits.max_body_chars).trim(),
            importance: item.importance,
            is_major: item.is_major,
            evidence,
        };
    });
    for (const [index, finding] of normalized.entries()) {
        if (!finding.title || !finding.summary || !finding.body) throw new Error(`finding ${index} text fields cannot be whitespace-only`);
    }
    const json = canonicalize(normalized);
    const byte_limit = stage === 'chunk'
        ? history_backfill_limits.max_chunk_findings_json_bytes
        : history_backfill_limits.max_consolidated_findings_json_bytes;
    if (json_bytes(json) > byte_limit) throw new Error(`history ${stage} findings exceed ${byte_limit} UTF-8 bytes`);
    return normalized;
}

export type history_backfill_service_options = {
    tenant_id: string;
    user_id: string;
    now?: () => number;
    capability_guard: (worker: history_worker_context) => void;
};

export class HistoryBackfillService {
    readonly tenant_id: string;
    readonly user_id: string;
    private readonly now: () => number;
    private readonly capability_guard: (worker: history_worker_context) => void;

    constructor(readonly database: Database.Database, options: history_backfill_service_options) {
        this.tenant_id = bounded_string(options.tenant_id, 'tenant_id', 1, 1_024);
        this.user_id = bounded_string(options.user_id, 'user_id', 1, 1_024);
        this.now = options.now ?? (() => Date.now());
        if (typeof options.capability_guard !== 'function') {
            throw new Error('HistoryBackfillService requires a synchronous capability_guard');
        }
        this.capability_guard = options.capability_guard;
    }

    private write<T>(operation: () => T): T {
        if (this.database.inTransaction) {
            throw new Error('history backfill mutations require their own BEGIN IMMEDIATE transaction');
        }
        const transaction = this.database.transaction(operation);
        return transaction.immediate();
    }

    private require_project(project_id: string): void {
        const found = this.database.prepare(`SELECT 1 FROM cm_projects
            WHERE tenant_id=? AND user_id=? AND project_id=?`)
            .get(this.tenant_id, this.user_id, project_id);
        if (!found) throw new Error(`central project ${project_id} was not found in this scope`);
    }

    private get_run(run_id: string): history_backfill_run | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_backfill_runs
            WHERE tenant_id=? AND user_id=? AND run_id=?`)
            .get(this.tenant_id, this.user_id, run_id) as row | undefined;
        return value ? map_run(value) : null;
    }

    private require_run(run_id: string): history_backfill_run {
        const value = this.get_run(run_id);
        if (!value) throw new Error(`history backfill run ${run_id} was not found`);
        return value;
    }

    private require_run_in_project(project_id: string, run_id: string): history_backfill_run {
        const run = this.require_run(run_id);
        if (run.project_id !== project_id) throw new Error(`history backfill run ${run_id} is outside project ${project_id}`);
        return run;
    }

    private get_chunk(run_id: string, chunk_index: number): history_backfill_chunk | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_backfill_chunks
            WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=?`)
            .get(this.tenant_id, this.user_id, run_id, chunk_index) as row | undefined;
        return value ? map_chunk(value) : null;
    }

    private require_chunk(run_id: string, chunk_index: number): history_backfill_chunk {
        const chunk = this.get_chunk(run_id, chunk_index);
        if (!chunk) throw new Error(`history backfill chunk ${run_id}:${chunk_index} was not found`);
        return chunk;
    }

    private chunks(run_id: string): history_backfill_chunk[] {
        return (this.database.prepare(`SELECT * FROM cm_history_backfill_chunks
            WHERE tenant_id=? AND user_id=? AND run_id=? ORDER BY chunk_index`)
            .all(this.tenant_id, this.user_id, run_id) as row[]).map(map_chunk);
    }

    private reductions(run_id: string): reduction[] {
        return (this.database.prepare(`SELECT * FROM cm_history_backfill_reductions
            WHERE tenant_id=? AND user_id=? AND run_id=? ORDER BY round_index, batch_index`)
            .all(this.tenant_id, this.user_id, run_id) as row[]).map(map_reduction);
    }

    private require_reduction(reduction_id: string): reduction {
        const value = this.database.prepare(`SELECT * FROM cm_history_backfill_reductions
            WHERE tenant_id=? AND user_id=? AND reduction_id=?`)
            .get(this.tenant_id, this.user_id, reduction_id) as row | undefined;
        if (!value) throw new Error(`history reduction ${reduction_id} was not found`);
        return map_reduction(value);
    }

    private ensure_next_reduction_round(run: history_backfill_run, at: number): reduction[] {
        const existing = this.reductions(run.run_id);
        let round_index = 0;
        let frontier: history_backfill_candidate[];
        if (!existing.length) {
            frontier = (this.database.prepare(`SELECT * FROM cm_history_backfill_candidates
                WHERE tenant_id=? AND user_id=? AND run_id=? AND stage='chunk'
                ORDER BY source_chunk_index, finding_index, candidate_id`)
                .all(this.tenant_id, this.user_id, run.run_id) as row[]).map(map_candidate);
        } else {
            const last_round = Math.max(...existing.map((item) => item.round_index));
            const round = existing.filter((item) => item.round_index === last_round);
            if (round.some((item) => item.status !== 'completed')) return round;
            if (round.length === 1 && round[0]!.is_final) return round;
            round_index = last_round + 1;
            const reduction_ids = round.map((item) => item.reduction_id);
            const placeholders = reduction_ids.map(() => '?').join(', ');
            frontier = (this.database.prepare(`SELECT * FROM cm_history_backfill_candidates
                WHERE tenant_id=? AND user_id=? AND run_id=? AND stage='consolidated'
                  AND reduction_id IN (${placeholders})
                ORDER BY reduction_id, finding_index, candidate_id`)
                .all(this.tenant_id, this.user_id, run.run_id, ...reduction_ids) as row[]).map(map_candidate);
        }

        const groups: history_backfill_candidate[][] = [];
        for (let index = 0; index < frontier.length; index += history_backfill_limits.max_reduction_inputs) {
            groups.push(frontier.slice(index, index + history_backfill_limits.max_reduction_inputs));
        }
        if (!groups.length) groups.push([]);
        const is_final = groups.length === 1;
        const insert = this.database.prepare(`INSERT INTO cm_history_backfill_reductions (
            tenant_id, user_id, reduction_id, run_id, round_index, batch_index, is_final,
            input_candidate_ids_json, allowed_evidence_json, input_hash, input_count,
            status, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`);
        groups.forEach((group, batch_index) => {
            const input_candidate_ids = group.map((candidate) => candidate.candidate_id);
            const evidence_by_hash = new Map<string, history_evidence_ref>();
            for (const candidate of group) {
                for (const reference of candidate.finding.evidence) {
                    evidence_by_hash.set(canonicalize(reference), reference);
                }
            }
            const allowed_evidence = [...evidence_by_hash.entries()]
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([, reference]) => reference);
            const input_hash = hash_canonical(group.map((candidate) => [
                candidate.candidate_id, candidate.finding_hash,
            ]));
            const reduction_id = `history-reduction:${hash_canonical([
                run.run_id, round_index, batch_index, input_hash,
            ]).slice(0, 40)}`;
            insert.run(this.tenant_id, this.user_id, reduction_id, run.run_id,
                round_index, batch_index, Number(is_final), canonicalize(input_candidate_ids),
                canonicalize(allowed_evidence), input_hash, group.length, at, at, at);
        });
        return this.reductions(run.run_id).filter((item) => item.round_index === round_index);
    }

    private receipt_for_lease(lease_id: string): history_backfill_receipt | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_backfill_receipts
            WHERE tenant_id=? AND user_id=? AND lease_id=?`)
            .get(this.tenant_id, this.user_id, lease_id) as row | undefined;
        return value ? map_receipt(value) : null;
    }

    private require_active_worker(
        worker: history_worker_context,
        run_id?: string,
    ): { project_id: string } {
        const result = this.capability_guard(worker) as unknown;
        if (result !== undefined && result !== null && typeof result === 'object'
            && 'then' in result && typeof result.then === 'function') {
            throw new Error('history capability_guard must be synchronous and held through the database commit');
        }
        const value = this.database.prepare(`SELECT project_id FROM cm_threads
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND status='active'`)
            .get(this.tenant_id, this.user_id, worker.worker_session_id) as { project_id: string } | undefined;
        if (!value) throw new Error(`history worker task ${worker.worker_session_id} is not actively bound`);
        const project_id = String(value.project_id);
        const authorized = has_active_history_worker_authorization(this.database, {
            tenant_id: this.tenant_id,
            user_id: this.user_id,
            project_id,
            worker_session_id: worker.worker_session_id,
            worker_id: worker.worker_id,
            ...(run_id === undefined ? {} : { run_id }),
        });
        if (!authorized) {
            throw new Error(run_id === undefined
                ? 'permission denied: this task is not an authorized dedicated history worker'
                : `permission denied: history run ${run_id} is outside the active worker authorization scope`);
        }
        return { project_id };
    }

    private get_turn_usage(worker_session_id: string, worker_turn_id: string): history_turn_usage | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_backfill_turn_usage
            WHERE tenant_id=? AND user_id=? AND worker_session_id=? AND worker_turn_id=?`)
            .get(this.tenant_id, this.user_id, worker_session_id, worker_turn_id) as row | undefined;
        return value ? map_turn_usage(value) : null;
    }

    private assert_usage_identity(usage: history_turn_usage, worker: history_worker_context): void {
        if (usage.worker_id !== worker.worker_id
            || usage.worker_session_id !== worker.worker_session_id
            || usage.worker_turn_id !== worker.worker_turn_id
            || usage.capability_epoch_hash !== worker.capability_epoch_hash) {
            throw new history_backfill_lease_error('history turn was claimed by a different capability epoch');
        }
    }

    private expire_usage_for_lease(lease_id: string, at: number): void {
        this.database.prepare(`UPDATE cm_history_backfill_turn_usage
            SET status='expired', expired_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND lease_id=? AND status='active' AND lease_expires_at<=?`)
            .run(at, at, this.tenant_id, this.user_id, lease_id, at);
    }

    private insert_turn_usage(
        worker: history_worker_context,
        project_id: string,
        operation_kind: 'chunk' | 'consolidation',
        run_id: string,
        chunk_index: number | null,
        reduction_id: string | null,
        lease_id: string,
        lease_expires_at: number,
        at: number,
    ): void {
        this.database.prepare(`INSERT INTO cm_history_backfill_turn_usage (
            tenant_id, user_id, worker_session_id, worker_turn_id, project_id,
            worker_id, capability_epoch_hash, operation_kind, run_id, chunk_index,
            reduction_id, lease_id, lease_expires_at, status, claimed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
            .run(this.tenant_id, this.user_id, worker.worker_session_id, worker.worker_turn_id,
                project_id, worker.worker_id, worker.capability_epoch_hash, operation_kind,
                run_id, chunk_index, reduction_id, lease_id, lease_expires_at, at, at);
    }

    private consume_turn_usage(lease_id: string, worker: history_worker_context, at: number): void {
        const changed = this.database.prepare(`UPDATE cm_history_backfill_turn_usage
            SET status='consumed', consumed_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND lease_id=? AND status='active'
              AND worker_id=? AND worker_session_id=? AND worker_turn_id=?
              AND capability_epoch_hash=?`)
            .run(at, at, this.tenant_id, this.user_id, lease_id, worker.worker_id,
                worker.worker_session_id, worker.worker_turn_id, worker.capability_epoch_hash);
        if (changed.changes !== 1) throw new history_backfill_lease_error('history turn claim is stale or already consumed');
    }

    create_run(input: history_backfill_create_input): history_backfill_run {
        const at = integer(input.at ?? this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        const project_id = bounded_string(input.project_id, 'project_id', 1, 1_024);
        const max_tokens = integer(
            input.max_chunk_tokens ?? history_backfill_limits.default_max_chunk_tokens,
            'max_chunk_tokens', history_backfill_limits.min_chunk_tokens, history_backfill_limits.max_chunk_tokens,
        );
        const max_chars = integer(
            input.max_chunk_chars ?? history_backfill_limits.default_max_chunk_chars,
            'max_chunk_chars', history_backfill_limits.min_chunk_chars, history_backfill_limits.max_chunk_chars,
        );
        const session = normalize_session(input.session);
        // The snapshot and derived chunks are immutable/no-delete. Keep the
        // service boundary fail-closed even when a caller does not use the
        // higher-level Codex porter preflight.
        assert_no_obvious_credentials({ history_session_snapshot: session });
        const revision = portable_session_revision(session);
        const evidence = plain_record(input.evidence, 'history import evidence');
        exact_keys(evidence, [
            'inventory_id', 'reconciliation_digest', 'plan_id', 'manifest_hash',
            'target_db_path', 'target_project_id', 'redaction_policy_hash', 'redaction_bindings',
        ], 'history import evidence');
        const raw_bindings = evidence.redaction_bindings;
        if ((evidence.redaction_policy_hash === undefined) !== (raw_bindings === undefined)) {
            throw new Error('history redaction policy hash and session binding must be supplied together');
        }
        let redaction_binding: Record<string, unknown> | undefined;
        let redaction_policy_hash: string | undefined;
        const marker_matches = [...JSON.stringify(session).matchAll(/<LMR-REDACTED-([^>\r\n]*)>/g)];
        if (marker_matches.length > 0 && raw_bindings === undefined) {
            throw new Error('history session contains redaction markers without issued binding evidence');
        }
        if (raw_bindings !== undefined) {
            assert_issued_history_redaction_evidence(input.evidence, session, project_id);
        }
        if (raw_bindings !== undefined) {
            if (!Array.isArray(raw_bindings) || raw_bindings.length !== 1) {
                throw new Error('history run evidence must contain exactly one redaction session binding');
            }
            const raw = plain_record(raw_bindings[0], 'history redaction session binding');
            exact_keys(raw, [
                'source_session_id', 'derived_source_revision',
                'detector_version', 'policy_version', 'mode', 'match_count',
                'terminal_marker_ids', 'credential_kinds', 'locations',
                'transformation_manifest_hash',
            ], 'history redaction session binding');
            if (raw.detector_version !== obvious_credential_detector_version
                || raw.policy_version !== history_redaction_policy_version
                || raw.mode !== history_redaction_mode) {
                throw new Error('history redaction binding uses an unsupported detector, policy, or mode');
            }
            const source_session_id = bounded_string(raw.source_session_id, 'history redaction source_session_id', 1, 1_024);
            const derived_source_revision = sha256_digest(raw.derived_source_revision, 'history redaction derived_source_revision');
            const match_count = integer(raw.match_count, 'history redaction match_count', 1, 999_999);
            if (!Array.isArray(raw.terminal_marker_ids) || raw.terminal_marker_ids.length !== match_count) {
                throw new Error('history redaction terminal marker ids must exactly match match_count');
            }
            const terminal_marker_ids = raw.terminal_marker_ids.map((value) =>
                integer(value, 'history redaction terminal marker id', 1, 999_999));
            if (terminal_marker_ids.some((value, index) => index > 0
                && terminal_marker_ids[index - 1]! >= value)) {
                throw new Error('history redaction terminal marker ids must be unique and sorted');
            }
            const credential_kinds = canonical_string_array(raw.credential_kinds, 'history redaction credential_kinds');
            const locations = canonical_string_array(raw.locations, 'history redaction locations');
            const transformation_manifest_hash = sha256_digest(
                raw.transformation_manifest_hash, 'history redaction transformation_manifest_hash',
            );
            if (source_session_id !== session.source_session_id || derived_source_revision !== revision) {
                throw new Error('history redaction binding does not match the exact derived session snapshot');
            }
            const snapshot_marker_ids = marker_matches.map((match) => {
                if (!/^\d{6}$/.test(match[1]!) || match[1] === '000000') {
                    throw new Error('history session contains an invalid redaction marker');
                }
                return Number(match[1]);
            }).sort((left, right) => left - right);
            if (new Set(snapshot_marker_ids).size !== snapshot_marker_ids.length) {
                throw new Error('history session contains a duplicate terminal redaction marker');
            }
            if (snapshot_marker_ids.length !== match_count
                || snapshot_marker_ids.some((value, index) => value !== terminal_marker_ids[index])) {
                throw new Error('history redaction binding does not exactly enumerate terminal markers');
            }
            redaction_policy_hash = sha256_digest(evidence.redaction_policy_hash, 'history redaction policy hash');
            redaction_binding = {
                source_session_id,
                derived_source_revision,
                detector_version: obvious_credential_detector_version,
                policy_version: history_redaction_policy_version,
                mode: history_redaction_mode,
                match_count,
                terminal_marker_ids,
                credential_kinds,
                locations,
                transformation_manifest_hash,
            };
        }
        const authorization = {
            inventory_id: bounded_string(evidence.inventory_id, 'history evidence inventory_id', 1, 1_024),
            reconciliation_digest: bounded_string(
                evidence.reconciliation_digest, 'history evidence reconciliation_digest', 64, 64,
            ),
            plan_id: bounded_string(evidence.plan_id, 'history evidence plan_id', 1, 1_024),
            manifest_hash: bounded_string(evidence.manifest_hash, 'history evidence manifest_hash', 64, 64),
            target_db_path: bounded_string(evidence.target_db_path, 'history evidence target_db_path', 1, 32_768),
            target_project_id: bounded_string(evidence.target_project_id, 'history evidence target_project_id', 1, 1_024),
            ...(redaction_policy_hash && redaction_binding ? {
                redaction_policy_hash,
                redaction_bindings: [redaction_binding],
            } : {}),
        };
        if (!/^[a-f0-9]{64}$/i.test(authorization.reconciliation_digest)) {
            throw new Error('history evidence reconciliation_digest must be a SHA-256 hex digest');
        }
        if (!/^[a-f0-9]{64}$/i.test(authorization.manifest_hash)) throw new Error('history evidence manifest_hash must be a SHA-256 hex digest');
        if (authorization.target_project_id !== project_id) throw new Error('history import evidence does not authorize the requested project');
        assert_no_obvious_credentials({ history_import_evidence: authorization });
        const authorization_json = canonical_json(
            authorization, 'history authorization snapshot', history_backfill_limits.max_authorization_json_bytes,
        );
        const authorization_hash = hash_canonical(authorization);
        const snapshot_json = canonical_json(session, 'history session snapshot', history_backfill_limits.max_session_json_bytes);
        const snapshot_hash = hash_canonical(session);
        const source_observed_at = Math.trunc(session.updated_at ?? session.created_at ?? at);
        if (!Number.isSafeInteger(source_observed_at) || source_observed_at < 0) {
            throw new Error('history session revision timestamp must be a non-negative safe integer');
        }
        const drafts = build_chunks(session, revision, max_tokens, max_chars);
        const total_chars = session.turns.reduce((sum, turn) => sum + code_point_length(turn.text), 0);
        if (drafts.reduce((sum, draft) => sum + draft.character_count, 0) !== total_chars) {
            throw new Error('history chunking failed the full-coverage invariant');
        }
        const run_id = `history-run:${hash_canonical([
            this.tenant_id, this.user_id, project_id, session.source_harness,
            session.source_session_id, revision,
        ]).slice(0, 40)}`;

        return this.write(() => {
            this.require_project(project_id);
            const existing_row = this.database.prepare(`SELECT * FROM cm_history_backfill_runs
                WHERE tenant_id=? AND user_id=? AND project_id=? AND source_harness=?
                  AND source_session_id=? AND source_revision=?`)
                .get(this.tenant_id, this.user_id, project_id, session.source_harness,
                    session.source_session_id, revision) as row | undefined;
            if (existing_row) {
                const existing = map_run(existing_row);
                if (existing.snapshot_hash !== snapshot_hash
                    || existing.authorization_hash !== authorization_hash
                    || existing.max_chunk_tokens !== max_tokens
                    || existing.max_chunk_chars !== max_chars
                    || existing.chunk_count !== drafts.length
                    || existing.total_chars !== total_chars) {
                    throw new history_backfill_conflict_error(
                        `history run ${existing.run_id} already exists with different immutable content`,
                    );
                }
                return existing;
            }

            const newer = this.database.prepare(`SELECT 1 FROM cm_history_backfill_runs
                WHERE tenant_id=? AND user_id=? AND project_id=? AND source_harness=?
                  AND source_session_id=? AND source_revision<>? AND source_observed_at>?
                LIMIT 1`)
                .get(this.tenant_id, this.user_id, project_id, session.source_harness,
                    session.source_session_id, revision, source_observed_at);
            const initial_status: history_backfill_run['status'] = newer
                ? 'superseded'
                : drafts.length ? 'pending' : 'ready_for_consolidation';

            if (!newer) {
                const placeholders = unfinished_run_statuses.map(() => '?').join(', ');
                this.database.prepare(`UPDATE cm_history_backfill_runs
                    SET status='superseded', superseded_at=?, updated_at=?,
                        consolidation_lease_id=NULL, consolidation_worker_id=NULL,
                        consolidation_worker_session_id=NULL, consolidation_worker_turn_id=NULL,
                        consolidation_capability_epoch_hash=NULL,
                        consolidation_leased_at=NULL, consolidation_lease_expires_at=NULL
                    WHERE tenant_id=? AND user_id=? AND project_id=? AND source_harness=?
                      AND source_session_id=? AND source_revision<>?
                      AND source_observed_at<=? AND status IN (${placeholders})`)
                    .run(at, at, this.tenant_id, this.user_id, project_id, session.source_harness,
                        session.source_session_id, revision, source_observed_at, ...unfinished_run_statuses);
            }

            this.database.prepare(`INSERT INTO cm_history_backfill_runs (
                tenant_id, user_id, run_id, project_id, source_harness, source_session_id,
                source_revision, source_observed_at, inventory_id, reconciliation_digest,
                plan_id, manifest_hash,
                target_db_path, authorization_json, authorization_hash, session_snapshot_json,
                snapshot_hash, chunk_size_chars, chunk_size_tokens, chunk_count, total_chars,
                completed_chunks, status, created_at, updated_at, superseded_at
            ) VALUES (
                @tenant_id, @user_id, @run_id, @project_id, @source_harness, @source_session_id,
                @source_revision, @source_observed_at, @inventory_id, @reconciliation_digest,
                @plan_id, @manifest_hash,
                @target_db_path, @authorization_json, @authorization_hash, @session_snapshot_json,
                @snapshot_hash, @chunk_size_chars, @chunk_size_tokens, @chunk_count, @total_chars,
                0, @status, @created_at, @updated_at, @superseded_at
            )`).run({
                tenant_id: this.tenant_id,
                user_id: this.user_id,
                run_id,
                project_id,
                source_harness: session.source_harness,
                source_session_id: session.source_session_id,
                source_revision: revision,
                source_observed_at,
                inventory_id: authorization.inventory_id,
                reconciliation_digest: authorization.reconciliation_digest,
                plan_id: authorization.plan_id,
                manifest_hash: authorization.manifest_hash,
                target_db_path: authorization.target_db_path,
                authorization_json,
                authorization_hash,
                session_snapshot_json: snapshot_json,
                snapshot_hash,
                chunk_size_chars: max_chars,
                chunk_size_tokens: max_tokens,
                chunk_count: drafts.length,
                total_chars,
                status: initial_status,
                created_at: at,
                updated_at: at,
                superseded_at: initial_status === 'superseded' ? at : null,
            });
            const insert_chunk = this.database.prepare(`INSERT INTO cm_history_backfill_chunks (
                tenant_id, user_id, run_id, chunk_index, chunk_hash, payload_json,
                character_count, token_count, part_count, first_turn_index, last_turn_index,
                status, available_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`);
            drafts.forEach((draft, chunk_index) => insert_chunk.run(
                this.tenant_id, this.user_id, run_id, chunk_index, draft.chunk_hash, draft.payload_json,
                draft.character_count, draft.token_count, draft.payload.parts.length,
                draft.first_turn_index, draft.last_turn_index, at, at, at,
            ));
            return this.require_run(run_id);
        });
    }

    claim_next(worker_context: history_worker_context, lease_ms: number): history_chunk_claim | null {
        const worker = normalize_worker_context(worker_context);
        const duration = integer(
            lease_ms, 'lease_ms', history_backfill_limits.min_lease_ms, history_backfill_limits.max_lease_ms,
        );
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const prior_usage = this.get_turn_usage(worker.worker_session_id, worker.worker_turn_id);
            if (prior_usage) {
                this.assert_usage_identity(prior_usage, worker);
                this.require_active_worker(worker, prior_usage.run_id);
                if (prior_usage.status !== 'active') {
                    throw new history_backfill_lease_error(`history worker turn is already ${prior_usage.status}`);
                }
                if (prior_usage.lease_expires_at <= at) {
                    this.expire_usage_for_lease(prior_usage.lease_id, at);
                    throw new history_backfill_lease_error('history worker turn lease expired; use a new turn');
                }
                if (prior_usage.operation_kind !== 'chunk' || prior_usage.chunk_index === null) {
                    throw new history_backfill_lease_error('history worker turn already owns a consolidation job');
                }
                const chunk = this.require_chunk(prior_usage.run_id, prior_usage.chunk_index);
                return bounded_worker_claim({
                    run: claim_run(this.require_run(prior_usage.run_id)),
                    chunk: claim_chunk(chunk),
                    lease_id: prior_usage.lease_id,
                    ...worker,
                    leased_at: prior_usage.claimed_at,
                    lease_expires_at: prior_usage.lease_expires_at,
                });
            }
            const targets = this.database.prepare(`SELECT chunk.run_id, chunk.chunk_index, chunk.lease_id
                FROM cm_history_backfill_chunks AS chunk
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=chunk.tenant_id AND run.user_id=chunk.user_id AND run.run_id=chunk.run_id
                WHERE chunk.tenant_id=? AND chunk.user_id=? AND run.project_id=?
                  AND EXISTS (
                    SELECT 1 FROM cm_history_worker_authorizations AS authorization
                    WHERE authorization.tenant_id=run.tenant_id
                      AND authorization.user_id=run.user_id
                      AND authorization.project_id=run.project_id
                      AND authorization.worker_session_id=?
                      AND authorization.worker_id=?
                      AND authorization.status='active'
                      AND (authorization.run_id IS NULL OR authorization.run_id=run.run_id)
                      AND (authorization.plan_id IS NULL OR authorization.plan_id=run.plan_id)
                  )
                  AND run.status IN ('pending', 'extracting')
                  AND (
                    (chunk.status IN ('pending', 'failed') AND chunk.available_at<=?)
                    OR (chunk.status='leased' AND chunk.lease_expires_at<=?)
                  )
                ORDER BY run.created_at, run.run_id, chunk.chunk_index`)
                .all(this.tenant_id, this.user_id, project_id,
                    worker.worker_session_id, worker.worker_id, at, at) as Array<{
                    run_id: string; chunk_index: number; lease_id: string | null;
                }>;
            const target = targets.find((candidate) => has_active_history_worker_authorization(
                this.database,
                {
                    tenant_id: this.tenant_id,
                    user_id: this.user_id,
                    project_id,
                    worker_session_id: worker.worker_session_id,
                    worker_id: worker.worker_id,
                    run_id: candidate.run_id,
                },
            ));
            if (!target) return null;
            if (target.lease_id) this.expire_usage_for_lease(target.lease_id, at);
            const lease_id = randomUUID();
            const expires_at = at + duration;
            const changed = this.database.prepare(`UPDATE cm_history_backfill_chunks
                SET status='leased', lease_id=?, lease_worker_id=?, lease_worker_session_id=?,
                    lease_worker_turn_id=?, lease_capability_epoch_hash=?, leased_at=?, lease_expires_at=?,
                    attempts=attempts+1, last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=?`)
                .run(lease_id, worker.worker_id, worker.worker_session_id, worker.worker_turn_id,
                    worker.capability_epoch_hash, at, expires_at, at, this.tenant_id, this.user_id,
                    target.run_id, target.chunk_index);
            if (changed.changes !== 1) throw new Error('history chunk claim lost its serialized target');
            this.database.prepare(`UPDATE cm_history_backfill_runs
                SET status='extracting', updated_at=?, last_error=NULL
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='pending'`)
                .run(at, this.tenant_id, this.user_id, target.run_id);
            this.insert_turn_usage(worker, project_id, 'chunk', target.run_id,
                target.chunk_index, null, lease_id, expires_at, at);
            return bounded_worker_claim({
                run: claim_run(this.require_run(target.run_id)),
                chunk: claim_chunk(this.require_chunk(target.run_id, target.chunk_index)),
                lease_id,
                ...worker,
                leased_at: at,
                lease_expires_at: expires_at,
            });
        });
    }

    submit_chunk(
        worker_context: history_worker_context,
        lease_id: string,
        chunk_hash: string,
        findings: unknown,
    ): history_backfill_receipt {
        const worker = normalize_worker_context(worker_context);
        const lease = bounded_string(lease_id, 'lease_id', 1, 256);
        const expected_hash = bounded_string(chunk_hash, 'chunk_hash', 64, 64);
        if (!/^[a-f0-9]{64}$/i.test(expected_hash)) throw new Error('chunk_hash must be a SHA-256 hex digest');
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const prior = this.receipt_for_lease(lease);
            if (prior) {
                this.require_active_worker(worker, prior.run_id);
                if (prior.operation_kind !== 'chunk' || prior.chunk_index === null) {
                    throw new history_backfill_conflict_error(`lease ${lease} was used for another operation`);
                }
                assert_no_obvious_credentials({ findings });
                const chunk = this.require_chunk(prior.run_id, prior.chunk_index);
                const normalized = normalize_findings(findings, [chunk], 'chunk');
                assert_no_obvious_credentials({ findings: normalized });
                const result_hash = hash_canonical(normalized);
                if (prior.input_hash !== expected_hash || prior.result_hash !== result_hash
                    || prior.worker_id !== worker.worker_id
                    || prior.worker_session_id !== worker.worker_session_id
                    || prior.worker_turn_id !== worker.worker_turn_id
                    || prior.capability_epoch_hash !== worker.capability_epoch_hash
                    || this.require_run(prior.run_id).project_id !== project_id) {
                    throw new history_backfill_conflict_error(`chunk lease ${lease} was already submitted with different content`);
                }
                return prior;
            }
            const value = this.database.prepare(`SELECT chunk.*, run.status AS run_status,
                    run.project_id AS run_project_id
                FROM cm_history_backfill_chunks AS chunk
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=chunk.tenant_id AND run.user_id=chunk.user_id AND run.run_id=chunk.run_id
                WHERE chunk.tenant_id=? AND chunk.user_id=? AND chunk.lease_id=?`)
                .get(this.tenant_id, this.user_id, lease) as row | undefined;
            if (!value || value.status !== 'leased' || value.run_status !== 'extracting') {
                throw new history_backfill_lease_error(`chunk lease ${lease} is stale or no longer active`);
            }
            this.require_active_worker(worker, String(value.run_id));
            if (String(value.run_project_id) !== project_id
                || String(value.lease_worker_id) !== worker.worker_id
                || String(value.lease_worker_session_id) !== worker.worker_session_id
                || String(value.lease_worker_turn_id) !== worker.worker_turn_id
                || String(value.lease_capability_epoch_hash) !== worker.capability_epoch_hash) {
                throw new history_backfill_lease_error('chunk lease is outside the active worker capability scope');
            }
            if (Number(value.lease_expires_at) <= at) throw new history_backfill_lease_error(`chunk lease ${lease} has expired`);
            const chunk = map_chunk(value);
            if (chunk.chunk_hash !== expected_hash) throw new history_backfill_lease_error('submitted chunk hash does not match the leased immutable chunk');
            assert_no_obvious_credentials({ findings });
            const normalized = normalize_findings(findings, [chunk], 'chunk');
            assert_no_obvious_credentials({ findings: normalized });
            const result_hash = hash_canonical(normalized);
            const receipt_id = `history-receipt:${hash_canonical([chunk.run_id, 'chunk', chunk.chunk_index, result_hash]).slice(0, 40)}`;
            const receipt_payload = { schema_version: '1.0.0', chunk_hash: expected_hash, findings: normalized };
            this.database.prepare(`INSERT INTO cm_history_backfill_receipts (
                tenant_id, user_id, receipt_id, run_id, operation_kind, operation_key,
                chunk_index, reduction_id, lease_id, worker_id, worker_session_id, worker_turn_id,
                capability_epoch_hash, input_hash, result_hash, candidate_count, payload_json, created_at
            ) VALUES (?, ?, ?, ?, 'chunk', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenant_id, this.user_id, receipt_id, chunk.run_id, String(chunk.chunk_index),
                    chunk.chunk_index, lease, worker.worker_id, worker.worker_session_id,
                    worker.worker_turn_id, worker.capability_epoch_hash, expected_hash, result_hash, normalized.length,
                    canonicalize(receipt_payload), at);
            normalized.forEach((finding, finding_index) => {
                const finding_hash = hash_canonical(finding);
                const candidate_id = `history-candidate:${hash_canonical([
                    chunk.run_id, 'chunk', chunk.chunk_index, finding_index, finding_hash,
                ]).slice(0, 40)}`;
                const locator = {
                    source_harness: chunk.payload.source_harness,
                    source_session_id: chunk.payload.source_session_id,
                    source_revision: chunk.payload.source_revision,
                    references: finding.evidence,
                };
                this.insert_candidate(candidate_id, chunk.run_id, 'chunk', chunk.chunk_index, null,
                    finding_index, finding, locator, finding_hash, receipt_id, at);
            });
            const updated = this.database.prepare(`UPDATE cm_history_backfill_chunks
                SET status='completed', lease_id=NULL, lease_worker_id=NULL,
                    lease_worker_session_id=NULL, lease_worker_turn_id=NULL,
                    lease_capability_epoch_hash=NULL, leased_at=NULL,
                    lease_expires_at=NULL, result_hash=?, receipt_id=?, finding_count=?,
                    last_error=NULL, completed_at=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=?
                  AND status='leased' AND lease_id=? AND chunk_hash=?`)
                .run(result_hash, receipt_id, normalized.length, at, at, this.tenant_id, this.user_id,
                    chunk.run_id, chunk.chunk_index, lease, expected_hash);
            if (updated.changes !== 1) throw new history_backfill_lease_error(`chunk lease ${lease} changed during submission`);
            this.consume_turn_usage(lease, worker, at);
            const completed = Number((this.database.prepare(`SELECT count(*) AS count
                FROM cm_history_backfill_chunks
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='completed'`)
                .get(this.tenant_id, this.user_id, chunk.run_id) as { count: number }).count);
            const run = this.require_run(chunk.run_id);
            this.database.prepare(`UPDATE cm_history_backfill_runs
                SET completed_chunks=?, status=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='extracting'`)
                .run(completed, completed === run.chunk_count ? 'ready_for_consolidation' : 'extracting', at,
                    this.tenant_id, this.user_id, chunk.run_id);
            return map_receipt(this.database.prepare(`SELECT * FROM cm_history_backfill_receipts
                WHERE tenant_id=? AND user_id=? AND receipt_id=?`)
                .get(this.tenant_id, this.user_id, receipt_id) as row);
        });
    }

    private insert_candidate(
        candidate_id: string,
        run_id: string,
        stage: 'chunk' | 'consolidated',
        source_chunk_index: number | null,
        reduction_id: string | null,
        finding_index: number,
        finding: history_backfill_finding,
        locator: history_backfill_candidate['source_locator'],
        finding_hash: string,
        receipt_id: string,
        at: number,
    ): void {
        this.database.prepare(`INSERT INTO cm_history_backfill_candidates (
            tenant_id, user_id, candidate_id, run_id, stage, source_chunk_index, reduction_id,
            finding_index, finding_kind, title, summary, body, importance, is_major,
            evidence_json, finding_json, finding_hash, receipt_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, candidate_id, run_id, stage, source_chunk_index, reduction_id,
                finding_index, finding.kind, finding.title, finding.summary, finding.body,
                finding.importance, Number(finding.is_major), canonicalize(locator), canonicalize(finding),
                finding_hash, receipt_id, at);
    }

    fail_chunk(
        worker_context: history_worker_context,
        lease_id: string,
        chunk_hash: string,
        error: string,
        retry_at?: number | null,
    ): void {
        const worker = normalize_worker_context(worker_context);
        const lease = bounded_string(lease_id, 'lease_id', 1, 256);
        const expected_hash = bounded_string(chunk_hash, 'chunk_hash', 64, 64);
        const detail = bounded_string(error, 'history chunk error', 1, history_backfill_limits.max_error_chars);
        // Historical text is untrusted and worker-supplied diagnostics are
        // durable. Refuse credentials before they can reach last_error rows.
        assert_no_obvious_credentials({ history_chunk_error: detail });
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        const available_at = retry_at === undefined || retry_at === null
            ? max_sqlite_timestamp
            : integer(retry_at, 'retry_at', at, Number.MAX_SAFE_INTEGER);
        this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const value = this.database.prepare(`SELECT chunk.*, run.status AS run_status,
                    run.project_id AS run_project_id
                FROM cm_history_backfill_chunks AS chunk
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=chunk.tenant_id AND run.user_id=chunk.user_id AND run.run_id=chunk.run_id
                WHERE chunk.tenant_id=? AND chunk.user_id=? AND chunk.lease_id=?`)
                .get(this.tenant_id, this.user_id, lease) as row | undefined;
            if (value) this.require_active_worker(worker, String(value.run_id));
            if (!value || value.status !== 'leased' || value.run_status !== 'extracting'
                || Number(value.lease_expires_at) <= at || String(value.chunk_hash) !== expected_hash
                || String(value.run_project_id) !== project_id
                || String(value.lease_worker_id) !== worker.worker_id
                || String(value.lease_worker_session_id) !== worker.worker_session_id
                || String(value.lease_worker_turn_id) !== worker.worker_turn_id
                || String(value.lease_capability_epoch_hash) !== worker.capability_epoch_hash) {
                throw new history_backfill_lease_error(`chunk lease ${lease} is stale, expired, or mismatched`);
            }
            const changed = this.database.prepare(`UPDATE cm_history_backfill_chunks
                SET status='failed', lease_id=NULL, lease_worker_id=NULL,
                    lease_worker_session_id=NULL, lease_worker_turn_id=NULL,
                    lease_capability_epoch_hash=NULL, leased_at=NULL,
                    lease_expires_at=NULL, available_at=?, last_error=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=? AND lease_id=?`)
                .run(available_at, detail, at, this.tenant_id, this.user_id,
                    String(value.run_id), Number(value.chunk_index), lease);
            if (changed.changes !== 1) throw new history_backfill_lease_error(`chunk lease ${lease} changed during failure handling`);
            this.consume_turn_usage(lease, worker, at);
            this.database.prepare(`UPDATE cm_history_backfill_runs SET last_error=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='extracting'`)
                .run(detail, at, this.tenant_id, this.user_id, String(value.run_id));
        });
    }

    retry_chunk(project_id: string, run_id: string, chunk_index: number, available_at?: number): history_backfill_chunk {
        const project = bounded_string(project_id, 'project_id', 1, 1_024);
        const index = integer(chunk_index, 'chunk_index', 0, Number.MAX_SAFE_INTEGER);
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        const available = integer(available_at ?? at, 'available_at', at, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const run = this.require_run_in_project(project, run_id);
            if (!['pending', 'extracting'].includes(run.status)) throw new Error(`history run ${run_id} cannot retry chunks while ${run.status}`);
            const changed = this.database.prepare(`UPDATE cm_history_backfill_chunks
                SET status='pending', available_at=?, last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=? AND status='failed'`)
                .run(available, at, this.tenant_id, this.user_id, run_id, index);
            if (changed.changes !== 1) throw new Error(`history chunk ${run_id}:${index} is not failed`);
            return this.require_chunk(run_id, index);
        });
    }

    claim_consolidation(
        worker_context: history_worker_context,
        lease_ms: number,
    ): history_consolidation_claim | null {
        const worker = normalize_worker_context(worker_context);
        const duration = integer(
            lease_ms, 'lease_ms', history_backfill_limits.min_lease_ms, history_backfill_limits.max_lease_ms,
        );
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const prior_usage = this.get_turn_usage(worker.worker_session_id, worker.worker_turn_id);
            if (prior_usage) {
                this.assert_usage_identity(prior_usage, worker);
                this.require_active_worker(worker, prior_usage.run_id);
                if (prior_usage.status !== 'active') {
                    throw new history_backfill_lease_error(`history worker turn is already ${prior_usage.status}`);
                }
                if (prior_usage.lease_expires_at <= at) {
                    this.expire_usage_for_lease(prior_usage.lease_id, at);
                    throw new history_backfill_lease_error('history worker turn lease expired; use a new turn');
                }
                if (prior_usage.operation_kind !== 'consolidation' || !prior_usage.reduction_id) {
                    throw new history_backfill_lease_error('history worker turn already owns a chunk job');
                }
                const reduction = this.require_reduction(prior_usage.reduction_id);
                const count = Number((this.database.prepare(`SELECT count(*) AS count
                    FROM cm_history_backfill_candidates
                    WHERE tenant_id=? AND user_id=? AND run_id=? AND stage='chunk'`)
                    .get(this.tenant_id, this.user_id, reduction.run_id) as { count: number }).count);
                return bounded_worker_claim({
                    run: claim_run(this.require_run(reduction.run_id)),
                    reduction_id: reduction.reduction_id,
                    round_index: reduction.round_index,
                    batch_index: reduction.batch_index,
                    is_final: reduction.is_final,
                    input_candidate_ids: reduction.input_candidate_ids,
                    lease_id: prior_usage.lease_id,
                    ...worker,
                    leased_at: prior_usage.claimed_at,
                    lease_expires_at: prior_usage.lease_expires_at,
                    chunk_candidate_count: count,
                });
            }
            const targets = this.database.prepare(`SELECT run.run_id, run.consolidation_lease_id
                FROM cm_history_backfill_runs AS run
                WHERE run.tenant_id=? AND run.user_id=? AND run.project_id=?
                  AND EXISTS (
                    SELECT 1 FROM cm_history_worker_authorizations AS authorization
                    WHERE authorization.tenant_id=run.tenant_id
                      AND authorization.user_id=run.user_id
                      AND authorization.project_id=run.project_id
                      AND authorization.worker_session_id=?
                      AND authorization.worker_id=?
                      AND authorization.status='active'
                      AND (authorization.run_id IS NULL OR authorization.run_id=run.run_id)
                      AND (authorization.plan_id IS NULL OR authorization.plan_id=run.plan_id)
                  )
                  AND (
                    run.status='ready_for_consolidation'
                    OR (run.status='failed' AND run.consolidation_retry_at IS NOT NULL AND run.consolidation_retry_at<=?)
                    OR (run.status='consolidating' AND run.consolidation_lease_expires_at<=?)
                  )
                ORDER BY run.created_at, run.run_id`)
                .all(this.tenant_id, this.user_id, project_id,
                    worker.worker_session_id, worker.worker_id, at, at) as Array<{
                    run_id: string; consolidation_lease_id: string | null;
                }>;
            const target = targets.find((candidate) => has_active_history_worker_authorization(
                this.database,
                {
                    tenant_id: this.tenant_id,
                    user_id: this.user_id,
                    project_id,
                    worker_session_id: worker.worker_session_id,
                    worker_id: worker.worker_id,
                    run_id: candidate.run_id,
                },
            ));
            if (!target) return null;
            if (target.consolidation_lease_id) this.expire_usage_for_lease(target.consolidation_lease_id, at);
            const run = this.require_run(target.run_id);
            const reductions = this.ensure_next_reduction_round(run, at);
            const reduction = reductions.find((item) => (
                (item.status === 'pending' || item.status === 'failed') && item.available_at <= at
            ) || (item.status === 'leased' && (item.lease_expires_at ?? max_sqlite_timestamp) <= at));
            if (!reduction) return null;
            if (reduction.lease_id) this.expire_usage_for_lease(reduction.lease_id, at);
            const lease_id = randomUUID();
            const expires_at = at + duration;
            const reduction_changed = this.database.prepare(`UPDATE cm_history_backfill_reductions
                SET status='leased', lease_id=?, lease_worker_id=?, lease_worker_session_id=?,
                    lease_worker_turn_id=?, lease_capability_epoch_hash=?, leased_at=?,
                    lease_expires_at=?, attempts=attempts+1, last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND reduction_id=?`)
                .run(lease_id, worker.worker_id, worker.worker_session_id, worker.worker_turn_id,
                    worker.capability_epoch_hash, at, expires_at, at,
                    this.tenant_id, this.user_id, reduction.reduction_id);
            if (reduction_changed.changes !== 1) throw new Error('history reduction claim lost its serialized target');
            this.database.prepare(`UPDATE cm_history_backfill_runs
                SET status='consolidating', consolidation_lease_id=?, consolidation_reduction_id=?,
                    consolidation_worker_id=?, consolidation_worker_session_id=?,
                    consolidation_worker_turn_id=?, consolidation_capability_epoch_hash=?,
                    consolidation_leased_at=?, consolidation_lease_expires_at=?,
                    consolidation_attempts=consolidation_attempts+1,
                    consolidation_retry_at=NULL, last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=?`)
                .run(lease_id, reduction.reduction_id, worker.worker_id, worker.worker_session_id,
                    worker.worker_turn_id, worker.capability_epoch_hash, at, expires_at, at,
                    this.tenant_id, this.user_id, target.run_id);
            this.insert_turn_usage(worker, project_id, 'consolidation', target.run_id,
                null, reduction.reduction_id, lease_id, expires_at, at);
            const count = Number((this.database.prepare(`SELECT count(*) AS count
                FROM cm_history_backfill_candidates
                WHERE tenant_id=? AND user_id=? AND run_id=? AND stage='chunk'`)
                .get(this.tenant_id, this.user_id, target.run_id) as { count: number }).count);
            return bounded_worker_claim({
                run: claim_run(this.require_run(target.run_id)),
                reduction_id: reduction.reduction_id,
                round_index: reduction.round_index,
                batch_index: reduction.batch_index,
                is_final: reduction.is_final,
                input_candidate_ids: reduction.input_candidate_ids,
                lease_id,
                ...worker,
                leased_at: at,
                lease_expires_at: expires_at,
                chunk_candidate_count: count,
            });
        });
    }

    reduction_page(
        worker_context: history_worker_context,
        lease_id: string,
        cursor: number = 0,
        page_token_budget: number = history_backfill_limits.default_reduction_page_tokens,
    ): history_reduction_page {
        const worker = normalize_worker_context(worker_context);
        const lease = bounded_string(lease_id, 'lease_id', 1, 256);
        const start = integer(cursor, 'history reduction cursor', 0, Number.MAX_SAFE_INTEGER);
        const requested_budget = integer(
            page_token_budget,
            'history reduction page_token_budget',
            history_backfill_limits.min_reduction_page_tokens,
            history_backfill_limits.max_reduction_page_tokens,
        );
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        const { project_id } = this.require_active_worker(worker);
        const value = this.database.prepare(`SELECT reduction.*, run.project_id AS run_project_id,
                run.status AS run_status
            FROM cm_history_backfill_reductions AS reduction
            JOIN cm_history_backfill_runs AS run
              ON run.tenant_id=reduction.tenant_id AND run.user_id=reduction.user_id
             AND run.run_id=reduction.run_id
            WHERE reduction.tenant_id=? AND reduction.user_id=? AND reduction.lease_id=?
              AND run.consolidation_lease_id=reduction.lease_id
              AND run.consolidation_reduction_id=reduction.reduction_id`)
            .get(this.tenant_id, this.user_id, lease) as row | undefined;
        if (value) this.require_active_worker(worker, String(value.run_id));
        if (!value || value.status !== 'leased' || value.run_status !== 'consolidating'
            || Number(value.lease_expires_at) <= at
            || String(value.run_project_id) !== project_id
            || String(value.lease_worker_id) !== worker.worker_id
            || String(value.lease_worker_session_id) !== worker.worker_session_id
            || String(value.lease_worker_turn_id) !== worker.worker_turn_id
            || String(value.lease_capability_epoch_hash) !== worker.capability_epoch_hash) {
            throw new history_backfill_lease_error('history reduction page lease is stale, expired, or outside the active capability scope');
        }
        const usage = this.get_turn_usage(worker.worker_session_id, worker.worker_turn_id);
        if (!usage || usage.status !== 'active' || usage.operation_kind !== 'consolidation'
            || usage.lease_id !== lease || usage.project_id !== project_id
            || usage.run_id !== String(value.run_id)
            || usage.reduction_id !== String(value.reduction_id)) {
            throw new history_backfill_lease_error('history reduction page lease is not bound to the active worker turn');
        }
        this.assert_usage_identity(usage, worker);

        const reduction = map_reduction(value);
        const candidate_statement = this.database.prepare(`SELECT * FROM cm_history_backfill_candidates
            WHERE tenant_id=? AND user_id=? AND run_id=? AND candidate_id=?`);
        const seen_candidate_ids = new Set<string>();
        const candidates = reduction.input_candidate_ids.map((candidate_id) => {
            if (seen_candidate_ids.has(candidate_id)) {
                throw new Error('history reduction contains duplicate input candidates');
            }
            seen_candidate_ids.add(candidate_id);
            const candidate = candidate_statement.get(
                this.tenant_id, this.user_id, reduction.run_id, candidate_id,
            ) as row | undefined;
            if (!candidate) throw new Error('history reduction input candidate was not found in its run');
            return map_candidate(candidate);
        });
        const fragments = candidates.flatMap((candidate) => fragment_reduction_candidate(
            candidate, reduction.run_id, reduction.reduction_id,
        ));
        if (start > fragments.length) {
            throw new Error('history reduction cursor is beyond the available fragments');
        }

        let items: history_reduction_page_item[] = [];
        for (let index = start; index < fragments.length; index++) {
            const trial_items = [...items, fragments[index]!];
            const next = index + 1 < fragments.length ? index + 1 : null;
            const trial: history_reduction_page = {
                run_id: reduction.run_id,
                reduction_id: reduction.reduction_id,
                cursor: start,
                next_cursor: next,
                items: trial_items,
            };
            if (reduction_page_tokens(trial) > Math.min(
                requested_budget, history_backfill_limits.max_worker_transport_tokens,
            )) break;
            items = trial_items;
        }
        if (start < fragments.length && items.length === 0) {
            throw new Error('history reduction page budget cannot carry its next fragment');
        }
        const next_cursor = start + items.length < fragments.length
            ? start + items.length
            : null;
        return bounded_reduction_page({
            run_id: reduction.run_id,
            reduction_id: reduction.reduction_id,
            cursor: start,
            next_cursor,
            items,
        }, requested_budget);
    }

    complete_consolidation(
        worker_context: history_worker_context,
        lease_id: string,
        findings: unknown,
    ): history_backfill_receipt {
        const worker = normalize_worker_context(worker_context);
        const lease = bounded_string(lease_id, 'lease_id', 1, 256);
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const prior = this.receipt_for_lease(lease);
            if (prior) {
                this.require_active_worker(worker, prior.run_id);
                if (prior.operation_kind !== 'consolidation' || !prior.reduction_id) {
                    throw new history_backfill_conflict_error(`lease ${lease} was used for another operation`);
                }
                assert_no_obvious_credentials({ findings });
                const reduction = this.require_reduction(prior.reduction_id);
                const normalized = normalize_findings(
                    findings, this.chunks(prior.run_id), 'consolidated', reduction.allowed_evidence,
                );
                assert_no_obvious_credentials({ findings: normalized });
                if (prior.result_hash !== hash_canonical(normalized)
                    || prior.worker_id !== worker.worker_id
                    || prior.worker_session_id !== worker.worker_session_id
                    || prior.worker_turn_id !== worker.worker_turn_id
                    || prior.capability_epoch_hash !== worker.capability_epoch_hash
                    || this.require_run(prior.run_id).project_id !== project_id) {
                    throw new history_backfill_conflict_error(`consolidation lease ${lease} was already submitted with different content`);
                }
                return prior;
            }
            const value = this.database.prepare(`SELECT reduction.*, run.project_id AS run_project_id,
                    run.status AS run_status, run.source_harness, run.source_session_id, run.source_revision
                FROM cm_history_backfill_reductions AS reduction
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=reduction.tenant_id AND run.user_id=reduction.user_id
                 AND run.run_id=reduction.run_id
                WHERE reduction.tenant_id=? AND reduction.user_id=? AND reduction.lease_id=?
                  AND run.consolidation_lease_id=reduction.lease_id
                  AND run.consolidation_reduction_id=reduction.reduction_id`)
                .get(this.tenant_id, this.user_id, lease) as row | undefined;
            if (!value || value.status !== 'leased' || value.run_status !== 'consolidating') {
                throw new history_backfill_lease_error(`consolidation lease ${lease} is stale or no longer active`);
            }
            this.require_active_worker(worker, String(value.run_id));
            if (Number(value.lease_expires_at) <= at) {
                throw new history_backfill_lease_error(`consolidation lease ${lease} has expired`);
            }
            if (String(value.run_project_id) !== project_id
                || String(value.lease_worker_id) !== worker.worker_id
                || String(value.lease_worker_session_id) !== worker.worker_session_id
                || String(value.lease_worker_turn_id) !== worker.worker_turn_id
                || String(value.lease_capability_epoch_hash) !== worker.capability_epoch_hash) {
                throw new history_backfill_lease_error('consolidation lease is outside the active worker capability scope');
            }
            const reduction = map_reduction(value);
            const run = this.require_run(reduction.run_id);
            const chunks = this.chunks(reduction.run_id);
            if (chunks.some((chunk) => chunk.status !== 'completed')) {
                throw new Error(`history run ${run.run_id} cannot consolidate incomplete chunks`);
            }
            assert_no_obvious_credentials({ findings });
            const normalized = normalize_findings(
                findings, chunks, 'consolidated', reduction.allowed_evidence,
            );
            assert_no_obvious_credentials({ findings: normalized });
            const result_hash = hash_canonical(normalized);
            const receipt_id = `history-receipt:${hash_canonical([
                run.run_id, reduction.reduction_id, result_hash,
            ]).slice(0, 40)}`;
            const receipt_payload = {
                schema_version: '1.0.0', reduction_id: reduction.reduction_id,
                input_hash: reduction.input_hash, findings: normalized,
            };
            this.database.prepare(`INSERT INTO cm_history_backfill_receipts (
                tenant_id, user_id, receipt_id, run_id, operation_kind, operation_key,
                chunk_index, reduction_id, lease_id, worker_id, worker_session_id, worker_turn_id,
                capability_epoch_hash, input_hash, result_hash, candidate_count, payload_json, created_at
            ) VALUES (?, ?, ?, ?, 'consolidation', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenant_id, this.user_id, receipt_id, run.run_id, reduction.reduction_id,
                    reduction.reduction_id, lease, worker.worker_id, worker.worker_session_id,
                    worker.worker_turn_id, worker.capability_epoch_hash, reduction.input_hash,
                    result_hash, normalized.length, canonicalize(receipt_payload), at);
            normalized.forEach((finding, finding_index) => {
                const finding_hash = hash_canonical(finding);
                const candidate_id = `history-candidate:${hash_canonical([
                    run.run_id, reduction.reduction_id, finding_index, finding_hash,
                ]).slice(0, 40)}`;
                const locator = {
                    source_harness: run.source_harness,
                    source_session_id: run.source_session_id,
                    source_revision: run.source_revision,
                    references: finding.evidence,
                };
                this.insert_candidate(candidate_id, run.run_id, 'consolidated', null, reduction.reduction_id,
                    finding_index, finding, locator, finding_hash, receipt_id, at);
            });
            const reduction_changed = this.database.prepare(`UPDATE cm_history_backfill_reductions
                SET status='completed', lease_id=NULL, lease_worker_id=NULL,
                    lease_worker_session_id=NULL, lease_worker_turn_id=NULL,
                    lease_capability_epoch_hash=NULL, leased_at=NULL, lease_expires_at=NULL,
                    result_hash=?, receipt_id=?, output_count=?, last_error=NULL,
                    completed_at=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND reduction_id=? AND status='leased' AND lease_id=?`)
                .run(result_hash, receipt_id, normalized.length, at, at,
                    this.tenant_id, this.user_id, reduction.reduction_id, lease);
            if (reduction_changed.changes !== 1) {
                throw new history_backfill_lease_error(`consolidation lease ${lease} changed during completion`);
            }
            const next_status = reduction.is_final ? 'candidates_ready' : 'ready_for_consolidation';
            const changed = this.database.prepare(`UPDATE cm_history_backfill_runs
                SET status=?, consolidation_lease_id=NULL, consolidation_reduction_id=NULL,
                    consolidation_worker_id=NULL, consolidation_worker_session_id=NULL,
                    consolidation_worker_turn_id=NULL, consolidation_capability_epoch_hash=NULL,
                    consolidation_leased_at=NULL, consolidation_lease_expires_at=NULL,
                    consolidation_result_hash=?, consolidation_receipt_id=?,
                    consolidated_candidate_count=?, last_error=NULL, candidates_ready_at=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=?
                  AND status='consolidating' AND consolidation_lease_id=?`)
                .run(next_status, reduction.is_final ? result_hash : null,
                    reduction.is_final ? receipt_id : null,
                    reduction.is_final ? normalized.length : 0,
                    reduction.is_final ? at : null, at,
                    this.tenant_id, this.user_id, run.run_id, lease);
            if (changed.changes !== 1) throw new history_backfill_lease_error(`consolidation lease ${lease} changed during completion`);
            this.consume_turn_usage(lease, worker, at);
            return map_receipt(this.database.prepare(`SELECT * FROM cm_history_backfill_receipts
                WHERE tenant_id=? AND user_id=? AND receipt_id=?`)
                .get(this.tenant_id, this.user_id, receipt_id) as row);
        });
    }

    fail_consolidation(
        worker_context: history_worker_context,
        lease_id: string,
        error: string,
        retry_at?: number | null,
    ): history_backfill_run {
        const worker = normalize_worker_context(worker_context);
        const lease = bounded_string(lease_id, 'lease_id', 1, 256);
        const detail = bounded_string(error, 'history consolidation error', 1, history_backfill_limits.max_error_chars);
        assert_no_obvious_credentials({ history_consolidation_error: detail });
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        const retry = retry_at === undefined || retry_at === null
            ? null
            : integer(retry_at, 'retry_at', at, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            const { project_id } = this.require_active_worker(worker);
            const value = this.database.prepare(`SELECT reduction.*, run.status AS run_status,
                    run.project_id AS run_project_id
                FROM cm_history_backfill_reductions AS reduction
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=reduction.tenant_id AND run.user_id=reduction.user_id
                 AND run.run_id=reduction.run_id
                WHERE reduction.tenant_id=? AND reduction.user_id=? AND reduction.lease_id=?
                  AND run.consolidation_lease_id=reduction.lease_id`)
                .get(this.tenant_id, this.user_id, lease) as row | undefined;
            if (value) this.require_active_worker(worker, String(value.run_id));
            if (!value || value.status !== 'leased' || value.run_status !== 'consolidating'
                || Number(value.lease_expires_at) <= at || String(value.run_project_id) !== project_id
                || String(value.lease_worker_id) !== worker.worker_id
                || String(value.lease_worker_session_id) !== worker.worker_session_id
                || String(value.lease_worker_turn_id) !== worker.worker_turn_id
                || String(value.lease_capability_epoch_hash) !== worker.capability_epoch_hash) {
                throw new history_backfill_lease_error(`consolidation lease ${lease} is stale or expired`);
            }
            const available_at = retry ?? max_sqlite_timestamp;
            this.database.prepare(`UPDATE cm_history_backfill_reductions
                SET status='failed', lease_id=NULL, lease_worker_id=NULL,
                    lease_worker_session_id=NULL, lease_worker_turn_id=NULL,
                    lease_capability_epoch_hash=NULL, leased_at=NULL, lease_expires_at=NULL,
                    available_at=?, last_error=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND reduction_id=? AND lease_id=?`)
                .run(available_at, detail, at, this.tenant_id, this.user_id,
                    String(value.reduction_id), lease);
            this.database.prepare(`UPDATE cm_history_backfill_runs
                SET status='failed', consolidation_lease_id=NULL, consolidation_reduction_id=NULL,
                    consolidation_worker_id=NULL, consolidation_worker_session_id=NULL,
                    consolidation_worker_turn_id=NULL, consolidation_capability_epoch_hash=NULL,
                    consolidation_leased_at=NULL, consolidation_lease_expires_at=NULL,
                    consolidation_retry_at=?, last_error=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND consolidation_lease_id=?`)
                .run(retry, detail, at, this.tenant_id, this.user_id, String(value.run_id), lease);
            this.consume_turn_usage(lease, worker, at);
            return this.require_run(String(value.run_id));
        });
    }

    retry_consolidation(project_id: string, run_id: string): history_backfill_run {
        const project = bounded_string(project_id, 'project_id', 1, 1_024);
        const at = integer(this.now(), 'history backfill timestamp', 0, Number.MAX_SAFE_INTEGER);
        return this.write(() => {
            this.require_run_in_project(project, run_id);
            this.database.prepare(`UPDATE cm_history_backfill_reductions
                SET status='pending', available_at=?, last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='failed'`)
                .run(at, at, this.tenant_id, this.user_id, run_id);
            const changed = this.database.prepare(`UPDATE cm_history_backfill_runs
                SET status='ready_for_consolidation', consolidation_retry_at=NULL,
                    last_error=NULL, updated_at=?
                WHERE tenant_id=? AND user_id=? AND run_id=? AND status='failed'
                  AND completed_chunks=chunk_count`)
                .run(at, this.tenant_id, this.user_id, run_id);
            if (changed.changes !== 1) throw new Error(`history run ${run_id} is not a retryable failed consolidation`);
            return this.require_run(run_id);
        });
    }

    status(project_id: string, run_id: string): history_backfill_status {
        const project = bounded_string(project_id, 'project_id', 1, 1_024);
        const run = this.require_run_in_project(project, run_id);
        const counts: history_backfill_status['chunks'] = { pending: 0, leased: 0, completed: 0, failed: 0 };
        const rows = this.database.prepare(`SELECT status, count(*) AS count
            FROM cm_history_backfill_chunks WHERE tenant_id=? AND user_id=? AND run_id=? GROUP BY status`)
            .all(this.tenant_id, this.user_id, run_id) as Array<{ status: keyof typeof counts; count: number }>;
        for (const value of rows) counts[value.status] = Number(value.count);
        const candidate_rows = this.database.prepare(`SELECT stage, count(*) AS count
            FROM cm_history_backfill_candidates WHERE tenant_id=? AND user_id=? AND run_id=? GROUP BY stage`)
            .all(this.tenant_id, this.user_id, run_id) as Array<{ stage: 'chunk' | 'consolidated'; count: number }>;
        let chunk_candidates = 0;
        let consolidated_candidates = 0;
        for (const value of candidate_rows) {
            if (value.stage === 'chunk') chunk_candidates = Number(value.count);
            else consolidated_candidates = Number(value.count);
        }
        return { run, chunks: counts, chunk_candidates, consolidated_candidates };
    }

    status_for_worker(
        worker_context: history_worker_context,
        project_id: string,
        run_id: string,
    ): history_backfill_status {
        const worker = normalize_worker_context(worker_context);
        const project = bounded_string(project_id, 'project_id', 1, 1_024);
        const run = bounded_string(run_id, 'run_id', 1, 1_024);
        const active = this.require_active_worker(worker, run);
        if (active.project_id !== project) {
            throw new Error(`permission denied: history run ${run} is outside project ${project}`);
        }
        return this.status(project, run);
    }

    turn_usage(worker_session_id: string, worker_turn_id: string): history_turn_usage | null {
        const session_id = bounded_string(worker_session_id, 'worker_session_id', 1, 1_024);
        const turn_id = bounded_string(worker_turn_id, 'worker_turn_id', 1, 1_024);
        return this.get_turn_usage(session_id, turn_id);
    }

    assert_turn_available_for_regular_memory(
        worker_session_id: string,
        worker_turn_id: string,
        has_nonempty_memories: boolean,
    ): void {
        if (!has_nonempty_memories) return;
        const usage = this.turn_usage(worker_session_id, worker_turn_id);
        if (usage) {
            throw new Error(
                `turn ${worker_session_id}/${worker_turn_id} is reserved for the history workflow (${usage.status})`,
            );
        }
    }

    list_candidates(
        project_id: string,
        run_id: string,
        options: { stage?: 'chunk' | 'consolidated'; limit?: number; offset?: number } = {},
    ): history_backfill_candidate[] {
        const project = bounded_string(project_id, 'project_id', 1, 1_024);
        this.require_run_in_project(project, run_id);
        const limit = integer(options.limit ?? 100, 'candidate limit', 1, 500);
        const offset = integer(options.offset ?? 0, 'candidate offset', 0, Number.MAX_SAFE_INTEGER);
        if (options.stage && !['chunk', 'consolidated'].includes(options.stage)) throw new Error('candidate stage is invalid');
        const values = options.stage
            ? this.database.prepare(`SELECT * FROM cm_history_backfill_candidates
                WHERE tenant_id=? AND user_id=? AND run_id=? AND stage=?
                ORDER BY source_chunk_index, finding_index, candidate_id LIMIT ? OFFSET ?`)
                .all(this.tenant_id, this.user_id, run_id, options.stage, limit, offset) as row[]
            : this.database.prepare(`SELECT * FROM cm_history_backfill_candidates
                WHERE tenant_id=? AND user_id=? AND run_id=?
                ORDER BY stage, source_chunk_index, finding_index, candidate_id LIMIT ? OFFSET ?`)
                .all(this.tenant_id, this.user_id, run_id, limit, offset) as row[];
        return values.map(map_candidate);
    }
}
