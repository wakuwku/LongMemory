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
 *  file  : src/stores/sqlite/integrity.ts
 *  usage : implements the LongMemory integrity component
 */


import type Database from 'better-sqlite3';
import { hash_canonical, verify_node_hash } from '../../core/hash/content_hash.js';
import { CountMinSketch } from '../../core/math/count_min.js';
import { FrequentDirections } from '../../core/math/frequent_directions.js';
import { OjaTracker } from '../../core/math/oja.js';
import { MemorySketches } from '../../core/math/sketches.js';
import type { HydroNode } from '../../core/types/hydro_node.js';
import { history_worker_scope_hash } from '../../core/central_memory/history_worker_authorization.js';

export type IntegrityIssue = {
    table: string;
    record_id: string;
    code: 'sqlite' | 'invalid_json' | 'hash_mismatch' | 'id_mismatch' | 'invalid_sketch' | 'dangling_edge'
        | 'central_current' | 'central_confirmation' | 'central_hierarchy' | 'foreign_key'
        | 'central_project_link' | 'history_publication' | 'history_scope' | 'history_attempt'
        | 'semantic_identity';
    message: string;
};

export type IntegrityReport = {
    ok: boolean;
    checked_nodes: number;
    checked_edges: number;
    checked_sketches: number;
    checked_central_memories?: number;
    checked_project_links?: number;
    checked_history_publications?: number;
    issues: IntegrityIssue[];
};

export type IntegrityScope = { tenant_id: string; user_id: string };

export function decode_node_safely(
    row: { node_json: string; content_hash: string },
    record_id: string,
    issues?: IntegrityIssue[],
): HydroNode | null {
    try {
        const parsed = JSON.parse(row.node_json) as HydroNode;
        const node = parsed.metadata === undefined ? { ...parsed, metadata: {} } : parsed;
        if (node.id !== record_id) {
            issues?.push({ table: 'hydro_nodes', record_id: record_id, code: 'id_mismatch', message: `payload id ${node.id}` });
            return null;
        }
        if (node.content_hash !== row.content_hash || !verify_node_hash(node)) {
            issues?.push({ table: 'hydro_nodes', record_id: record_id, code: 'hash_mismatch', message: 'content hash does not verify' });
            return null;
        }
        return node;
    } catch (error) {
        issues?.push({
            table: 'hydro_nodes', record_id: record_id, code: 'invalid_json',
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

function validate_sketch(state: string): void {
    const data = JSON.parse(state) as { kind?: string };
    if (data.kind === 'memory-sketches') MemorySketches.deserialize(data as never);
    else if (data.kind === 'count-min') CountMinSketch.deserialize(data as never);
    else if (data.kind === 'frequent-directions') FrequentDirections.deserialize(data as never);
    else if (data.kind === 'oja') OjaTracker.deserialize(data as never);
    else throw new Error(`unknown sketch kind ${String(data.kind)}`);
}

type integrity_row = Record<string, unknown>;

const nullable_string = (value: unknown): string | null => (
    value === null || value === undefined ? null : String(value)
);

const nonempty_string = (value: unknown): boolean => (
    typeof value === 'string' && value.trim().length > 0
);

function integrity_table_exists(db: Database.Database, table: string): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
}

function parse_integrity_json(
    raw: unknown,
    table: string,
    record_id: string,
    field: string,
    issues: IntegrityIssue[],
): { ok: true; value: unknown } | { ok: false } {
    try {
        if (typeof raw !== 'string') throw new Error(`${field} is not text`);
        return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (error) {
        issues.push({
            table,
            record_id,
            code: 'invalid_json',
            message: `${field}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return { ok: false };
    }
}

function history_issue(
    issues: IntegrityIssue[],
    table: string,
    record_id: string,
    code: IntegrityIssue['code'],
    message: string,
): void {
    issues.push({ table, record_id, code, message });
}

function central_project_link_integrity(
    db: Database.Database,
    scope: IntegrityScope,
    issues: IntegrityIssue[],
): number {
    if (!integrity_table_exists(db, 'cm_project_links')) return 0;
    const links = db.prepare(`SELECT * FROM cm_project_links
        WHERE tenant_id=? AND user_id=?`)
        .all(scope.tenant_id, scope.user_id) as integrity_row[];
    for (const link of links) {
        const link_id = String(link.link_id);
        const status = String(link.status);
        const created_evidence = parse_integrity_json(
            link.created_evidence_json,
            'cm_project_links',
            link_id,
            'created_evidence_json',
            issues,
        );
        const revoked_evidence = parse_integrity_json(
            link.revoked_evidence_json,
            'cm_project_links',
            link_id,
            'revoked_evidence_json',
            issues,
        );
        const is_nonempty_object = (value: unknown): boolean => value !== null
            && typeof value === 'object'
            && !Array.isArray(value)
            && Object.keys(value as integrity_row).length > 0;
        const is_empty_object = (value: unknown): boolean => value !== null
            && typeof value === 'object'
            && !Array.isArray(value)
            && Object.keys(value as integrity_row).length === 0;
        const active_shape = status === 'active'
            && link.revoked_by === null
            && link.revoked_action_id === null
            && link.revoked_channel === null
            && link.revoked_at === null
            && revoked_evidence.ok
            && is_empty_object(revoked_evidence.value);
        const revoked_shape = status === 'revoked'
            && nonempty_string(link.revoked_by)
            && nonempty_string(link.revoked_action_id)
            && ['codex_ui', 'obsidian', 'local_cli'].includes(String(link.revoked_channel))
            && link.revoked_at !== null
            && revoked_evidence.ok
            && is_nonempty_object(revoked_evidence.value);
        if (String(link.source_project_id) === String(link.target_project_id)
            || !nonempty_string(link.created_by)
            || !nonempty_string(link.created_action_id)
            || !['codex_ui', 'obsidian', 'local_cli'].includes(String(link.created_channel))
            || !created_evidence.ok
            || !is_nonempty_object(created_evidence.value)
            || (!active_shape && !revoked_shape)) {
            issues.push({
                table: 'cm_project_links',
                record_id: link_id,
                code: 'central_project_link',
                message: 'project link direction, evidence, or lifecycle fields are inconsistent',
            });
        }
    }

    if (!integrity_table_exists(db, 'cm_thread_worksets')) return links.length;
    const invalid_worksets = db.prepare(`SELECT
            workset.thread_id, workset.memory_id, workset.origin, workset.sync_state,
            thread.project_id AS target_project_id,
            memory.project_id AS source_project_id, memory.level AS memory_level,
            EXISTS (
                SELECT 1 FROM cm_project_links AS active_link
                WHERE active_link.tenant_id=workset.tenant_id
                  AND active_link.user_id=workset.user_id
                  AND active_link.source_project_id=memory.project_id
                  AND active_link.target_project_id=thread.project_id
                  AND active_link.status='active'
            ) AS has_active_link,
            EXISTS (
                SELECT 1 FROM cm_project_links AS historical_link
                WHERE historical_link.tenant_id=workset.tenant_id
                  AND historical_link.user_id=workset.user_id
                  AND historical_link.source_project_id=memory.project_id
                  AND historical_link.target_project_id=thread.project_id
            ) AS has_historical_link
        FROM cm_thread_worksets AS workset
        JOIN cm_threads AS thread
          ON thread.tenant_id=workset.tenant_id AND thread.user_id=workset.user_id
         AND thread.thread_id=workset.thread_id
        JOIN cm_memories AS memory
          ON memory.tenant_id=workset.tenant_id AND memory.user_id=workset.user_id
         AND memory.memory_id=workset.memory_id
        WHERE workset.tenant_id=? AND workset.user_id=?
          AND NOT (
            (thread.project_id=memory.project_id AND workset.origin<>'linked_project')
            OR (
                thread.project_id<>memory.project_id
                AND workset.origin='linked_project'
                AND memory.level=4
                AND (
                    workset.sync_state='retracted' AND has_historical_link=1
                    OR workset.sync_state<>'retracted' AND has_active_link=1
                )
            )
          )`)
        .all(scope.tenant_id, scope.user_id) as integrity_row[];
    for (const workset of invalid_worksets) {
        issues.push({
            table: 'cm_thread_worksets',
            record_id: `${String(workset.thread_id)}/${String(workset.memory_id)}`,
            code: 'central_project_link',
            message: 'workset project scope is not backed by the required governed L4 project link',
        });
    }
    return links.length;
}

function history_publication_integrity(
    db: Database.Database,
    scope: IntegrityScope,
    issues: IntegrityIssue[],
): number {
    if (!integrity_table_exists(db, 'cm_history_publications')) return 0;
    const required_tables = [
        'cm_history_backfill_runs',
        'cm_history_backfill_candidates',
        'cm_history_hierarchy_proposals',
        'cm_history_governance_decisions',
        'cm_history_publication_plans',
        'cm_semantic_memory_keys',
        'cm_history_publication_attempts',
        'cm_projects',
        'cm_roles',
        'cm_tasks',
        'cm_threads',
        'cm_memories',
        'cm_memory_versions',
        'cm_confirmations',
    ];
    const missing_tables = required_tables.filter((table) => !integrity_table_exists(db, table));
    if (missing_tables.length) {
        for (const table of missing_tables) {
            history_issue(issues, table, 'schema', 'sqlite', 'required history-publication table is missing');
        }
        return 0;
    }

    const load = (table: string): integrity_row[] => db.prepare(
        `SELECT * FROM ${table} WHERE tenant_id=? AND user_id=?`,
    ).all(scope.tenant_id, scope.user_id) as integrity_row[];
    const publications = load('cm_history_publications');
    const runs = load('cm_history_backfill_runs');
    const candidates = load('cm_history_backfill_candidates');
    const proposals = load('cm_history_hierarchy_proposals');
    const decisions = load('cm_history_governance_decisions');
    const plans = load('cm_history_publication_plans');
    const semantic_keys = load('cm_semantic_memory_keys');
    const attempts = load('cm_history_publication_attempts');
    const roles = load('cm_roles');
    const tasks = load('cm_tasks');
    const threads = load('cm_threads');
    const memories = load('cm_memories');
    const versions = load('cm_memory_versions');
    const confirmations = load('cm_confirmations');

    const by = (rows: integrity_row[], field: string): Map<string, integrity_row> => new Map(
        rows.map((row) => [String(row[field]), row]),
    );
    const publication_by_id = by(publications, 'publication_id');
    const run_by_id = by(runs, 'run_id');
    const candidate_by_id = by(candidates, 'candidate_id');
    const proposal_by_id = by(proposals, 'proposal_id');
    const decision_by_id = by(decisions, 'decision_id');
    const semantic_by_hash = by(semantic_keys, 'semantic_identity_hash');
    const attempt_by_id = by(attempts, 'attempt_id');
    const role_by_id = by(roles, 'role_id');
    const task_by_id = by(tasks, 'task_id');
    const thread_by_id = by(threads, 'thread_id');
    const memory_by_id = by(memories, 'memory_id');
    const confirmation_by_id = by(confirmations, 'confirmation_id');
    const plan_key = (publication_id: unknown, plan_version: unknown): string => (
        `${String(publication_id)}\0${String(plan_version)}`
    );
    const plan_by_key = new Map(plans.map((row) => [
        plan_key(row.publication_id, row.plan_version), row,
    ]));
    const version_key = (memory_id: unknown, version: unknown): string => (
        `${String(memory_id)}\0${String(version)}`
    );
    const version_by_key = new Map(versions.map((row) => [
        version_key(row.memory_id, row.version), row,
    ]));
    const candidate_findings = new Map<string, unknown>();
    const candidate_evidence = new Map<string, unknown>();

    for (const candidate of candidates) {
        const candidate_id = String(candidate.candidate_id);
        const finding = parse_integrity_json(
            candidate.finding_json, 'cm_history_backfill_candidates', candidate_id, 'finding_json', issues,
        );
        if (finding.ok) {
            candidate_findings.set(candidate_id, finding.value);
            if (hash_canonical(finding.value) !== String(candidate.finding_hash)) {
                history_issue(issues, 'cm_history_backfill_candidates', candidate_id,
                    'hash_mismatch', 'history candidate finding_hash does not verify');
            }
            if (finding.value && typeof finding.value === 'object' && !Array.isArray(finding.value)) {
                const item = finding.value as integrity_row;
                if (String(item.kind) !== String(candidate.finding_kind)
                    || String(item.title) !== String(candidate.title)
                    || String(item.summary) !== String(candidate.summary)
                    || String(item.body) !== String(candidate.body)
                    || Number(item.importance) !== Number(candidate.importance)
                    || Boolean(item.is_major) !== Boolean(Number(candidate.is_major))) {
                    history_issue(issues, 'cm_history_backfill_candidates', candidate_id,
                        'history_scope', 'candidate finding JSON does not match its indexed fields');
                }
            }
        }
        const evidence = parse_integrity_json(
            candidate.evidence_json, 'cm_history_backfill_candidates', candidate_id, 'evidence_json', issues,
        );
        if (evidence.ok) candidate_evidence.set(candidate_id, evidence.value);
    }

    const attempts_by_publication = new Map<string, integrity_row[]>();
    for (const attempt of attempts) {
        const publication_id = String(attempt.publication_id);
        const rows = attempts_by_publication.get(publication_id) ?? [];
        rows.push(attempt);
        attempts_by_publication.set(publication_id, rows);
    }

    for (const publication of publications) {
        const publication_id = String(publication.publication_id);
        const candidate_id = String(publication.candidate_id);
        const run_id = String(publication.run_id);
        const candidate = candidate_by_id.get(candidate_id);
        const run = run_by_id.get(run_id);
        if (!candidate || String(candidate.run_id) !== run_id
            || String(candidate.stage) !== 'consolidated'
            || !run || String(run.status) !== 'candidates_ready'
            || nullable_string(candidate.receipt_id) !== nullable_string(run.consolidation_receipt_id)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_scope', 'publication is not bound to a final candidate from a candidates-ready run');
        }
        if (['pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review']
            .includes(String(publication.status))
            && run && runs.some((other) => String(other.run_id) !== run_id
            && String(other.status) === 'candidates_ready'
            && String(other.project_id) === String(run.project_id)
            && String(other.source_harness) === String(run.source_harness)
            && String(other.source_session_id) === String(run.source_session_id)
            && (Number(other.source_observed_at) > Number(run.source_observed_at)
                || (Number(other.source_observed_at) === Number(run.source_observed_at)
                    && Number(other.created_at) > Number(run.created_at))
                || (Number(other.source_observed_at) === Number(run.source_observed_at)
                    && Number(other.created_at) === Number(run.created_at)
                    && String(other.run_id) > run_id)))) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_scope', 'publication belongs to a superseded source revision');
        }
        if (publication_id !== `history-publication:${candidate_id}`) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'id_mismatch', 'publication_id is not derived from candidate_id');
        }

        const status = String(publication.status);
        const result_kind = nullable_string(publication.result_kind);
        const result_memory_id = nullable_string(publication.result_memory_id);
        const result_version = publication.result_version === null ? null : Number(publication.result_version);
        const result_confirmation_id = nullable_string(publication.result_confirmation_id);
        const terminal_at = publication.terminal_at === null ? null : Number(publication.terminal_at);
        const known_statuses = [
            'pending', 'awaiting_hierarchy', 'ready', 'retryable', 'needs_review',
            'pending_confirmation', 'published', 'discarded', 'superseded',
        ];
        if (!known_statuses.includes(status)
            || (result_version !== null && (!Number.isInteger(result_version) || result_version <= 0))
            || (terminal_at !== null && !Number.isFinite(terminal_at))) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'publication has an invalid status, result version, or terminal time');
        }
        const result_pair = (result_memory_id === null) === (result_version === null);
        if (!result_pair || (result_confirmation_id !== null && result_memory_id === null)
            || (result_kind !== null && result_memory_id === null)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'publication result fields are only partially populated');
        }
        if (status === 'pending_confirmation'
            && (result_kind !== null || result_memory_id === null || result_version === null
                || result_confirmation_id === null || terminal_at !== null)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'pending_confirmation publication has inconsistent result state');
        }
        if (status === 'published'
            && (result_kind === null || result_memory_id === null || result_version === null
                || terminal_at === null)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'published publication has incomplete terminal result state');
        }
        if (status !== 'published' && result_kind !== null) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'non-published publication carries a result_kind');
        }
        if (!['pending_confirmation', 'published'].includes(status)
            && (result_memory_id !== null || result_version !== null || result_confirmation_id !== null)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'inactive publication carries a publication result');
        }
        const terminal_status = ['published', 'discarded', 'superseded'].includes(status);
        if (terminal_status !== (terminal_at !== null)) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'publication terminal_at does not match status');
        }
        if (result_confirmation_id !== null) {
            const confirmation = confirmation_by_id.get(result_confirmation_id);
            const permitted_publication_status = status === 'pending_confirmation' || status === 'published';
            if (!confirmation
                || nullable_string(confirmation.memory_id) !== result_memory_id
                || Number(confirmation.proposed_version) !== result_version
                || !permitted_publication_status
                || (status === 'published' && String(confirmation.status) !== 'approved')) {
                history_issue(issues, 'cm_history_publications', publication_id,
                    'history_publication', 'publication confirmation does not bind its result state');
            }
        }

        const publication_attempts = attempts_by_publication.get(publication_id) ?? [];
        const attempt_count = Number(publication.attempt_count);
        const last_attempt_id = nullable_string(publication.last_attempt_id);
        const last_attempt = last_attempt_id === null ? undefined : attempt_by_id.get(last_attempt_id);
        if (!Number.isInteger(attempt_count) || attempt_count < 0
            || attempt_count !== publication_attempts.length
            || (attempt_count === 0) !== (last_attempt_id === null)
            || (last_attempt_id !== null && (!last_attempt
                || String(last_attempt.publication_id) !== publication_id))) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_attempt', 'attempt_count or last_attempt_id does not match immutable attempts');
        }
        if (status === 'retryable' && (!last_attempt || String(last_attempt.outcome) !== 'retryable')) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_attempt', 'retryable publication is not backed by its last retryable attempt');
        }
        if (status === 'pending_confirmation' && last_attempt) {
            if (String(last_attempt.outcome) !== 'pending_confirmation'
                || Number(last_attempt.plan_version) !== Number(publication.current_plan_version)
                || nullable_string(last_attempt.result_memory_id) !== result_memory_id
                || Number(last_attempt.result_version) !== result_version
                || nullable_string(last_attempt.result_confirmation_id) !== result_confirmation_id) {
                history_issue(issues, 'cm_history_publications', publication_id,
                    'history_attempt', 'pending publication result does not match its last attempt');
            }
        }
        if (status === 'published' && last_attempt) {
            const outcome = String(last_attempt.outcome);
            const reconciled = outcome === 'pending_confirmation';
            if ((!reconciled && outcome !== result_kind)
                || Number(last_attempt.plan_version) !== Number(publication.current_plan_version)
                || nullable_string(last_attempt.result_memory_id) !== result_memory_id
                || Number(last_attempt.result_version) !== result_version
                || (reconciled && nullable_string(last_attempt.result_confirmation_id) !== result_confirmation_id)) {
                history_issue(issues, 'cm_history_publications', publication_id,
                    'history_attempt', 'published result is not backed by its last successful attempt');
            }
        }

        const current_plan_version = publication.current_plan_version === null
            ? null : Number(publication.current_plan_version);
        const current_plan = current_plan_version === null
            ? undefined : plan_by_key.get(plan_key(publication_id, current_plan_version));
        if (current_plan_version !== null && !current_plan) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_scope', 'current_plan_version does not resolve inside the publication');
        }
        if (['retryable', 'pending_confirmation', 'published'].includes(status) && !current_plan) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', `${status} publication requires a current immutable plan`);
        }
        if (result_memory_id !== null && current_plan) {
            const semantic = semantic_by_hash.get(String(current_plan.semantic_identity_hash));
            if (!semantic || String(semantic.memory_id) !== result_memory_id) {
                history_issue(issues, 'cm_history_publications', publication_id,
                    'semantic_identity', 'publication result is not bound by its plan semantic identity');
            }
        }
        if (status === 'published' && current_plan) {
            const expected_kind = String(current_plan.relation) === 'noop'
                ? 'noop' : Boolean(Number(current_plan.expected_memory_exists)) ? 'updated' : 'created';
            if (result_kind !== expected_kind) {
                history_issue(issues, 'cm_history_publications', publication_id,
                    'history_publication', 'published result_kind does not match its immutable plan');
            }
        }
        const last_error_code = nullable_string(publication.last_error_code);
        const last_error_detail = nullable_string(publication.last_error_detail);
        if ((last_error_code === null) !== (last_error_detail === null)
            || (last_error_code !== null && !nonempty_string(last_error_code))
            || (last_error_detail !== null && !nonempty_string(last_error_detail))) {
            history_issue(issues, 'cm_history_publications', publication_id,
                'history_publication', 'publication error summary is only partially populated');
        }
    }

    for (const proposal of proposals) {
        const proposal_id = String(proposal.proposal_id);
        const publication_id = String(proposal.publication_id);
        const publication = publication_by_id.get(publication_id);
        const candidate_id = String(proposal.candidate_id);
        const run_id = String(proposal.run_id);
        const run = run_by_id.get(run_id);
        if (!publication || String(publication.candidate_id) !== candidate_id
            || String(publication.run_id) !== run_id) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'hierarchy proposal is outside its publication candidate and run');
        }
        const worker_thread = thread_by_id.get(String(proposal.worker_session_id));
        if (!worker_thread || !run || String(worker_thread.project_id) !== String(run.project_id)) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'proposal worker task is outside the publication project');
        }
        const level = Number(proposal.proposed_level);
        const role_id = nullable_string(proposal.role_id);
        const role_mode = String(proposal.role_mode);
        const task_id = nullable_string(proposal.task_id);
        const task_mode = String(proposal.task_mode);
        const hierarchy_shape = (level === 1 && role_mode === 'none' && role_id === null
                && task_mode === 'none' && task_id === null)
            || (level === 2 && role_mode !== 'none' && role_id !== null
                && task_mode === 'none' && task_id === null)
            || ([3, 4].includes(level) && role_mode !== 'none' && role_id !== null
                && task_mode !== 'none' && task_id !== null);
        const role_shape = (role_mode === 'none' && role_id === null
                && proposal.role_semantic_key === null && proposal.role_name === null
                && proposal.role_responsibility === null)
            || (role_mode === 'existing' && role_id !== null
                && proposal.role_semantic_key === null && proposal.role_name === null
                && proposal.role_responsibility === null)
            || (role_mode === 'proposed' && role_id !== null
                && nonempty_string(proposal.role_semantic_key)
                && nonempty_string(proposal.role_name)
                && nonempty_string(proposal.role_responsibility));
        const task_shape = (task_mode === 'none' && task_id === null
                && proposal.task_semantic_key === null && proposal.task_title === null
                && proposal.task_objective === null)
            || (task_mode === 'existing' && task_id !== null
                && proposal.task_semantic_key === null && proposal.task_title === null
                && proposal.task_objective === null)
            || (task_mode === 'proposed' && task_id !== null
                && nonempty_string(proposal.task_semantic_key)
                && nonempty_string(proposal.task_title)
                && nonempty_string(proposal.task_objective));
        const confidence = Number(proposal.confidence);
        if (!hierarchy_shape || !role_shape || !task_shape
            || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
            || String(proposal.capability_epoch_hash).length !== 64) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'hierarchy proposal has an invalid role, task, or worker shape');
        }
        const evidence_result = parse_integrity_json(
            proposal.evidence_json, 'cm_history_hierarchy_proposals', proposal_id, 'evidence_json', issues,
        );
        if (!evidence_result.ok) continue;
        const evidence = evidence_result.value;
        if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'hierarchy proposal evidence must contain one to eight references');
        }
        const proposal_body = {
            schema: 1,
            publication_id,
            run_id,
            candidate_id,
            scope_kind: String(proposal.scope_kind),
            proposed_level: Number(proposal.proposed_level),
            role_mode: String(proposal.role_mode),
            role_id: nullable_string(proposal.role_id),
            role_semantic_key: nullable_string(proposal.role_semantic_key),
            role_name: nullable_string(proposal.role_name),
            role_responsibility: nullable_string(proposal.role_responsibility),
            task_mode: String(proposal.task_mode),
            task_id: nullable_string(proposal.task_id),
            task_semantic_key: nullable_string(proposal.task_semantic_key),
            task_title: nullable_string(proposal.task_title),
            task_objective: nullable_string(proposal.task_objective),
            confidence: Number(proposal.confidence),
            evidence,
        };
        const expected_hash = hash_canonical(proposal_body);
        if (expected_hash !== String(proposal.proposal_hash)) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'hash_mismatch', 'hierarchy proposal_hash does not verify');
        }
        const expected_id = `history-hierarchy:${hash_canonical([
            publication_id, expected_hash,
        ]).slice(0, 40)}`;
        if (proposal_id !== expected_id) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'id_mismatch', 'proposal_id is not derived from its canonical payload');
        }
        const expected_scope = level === 2 ? 'run_role' : level >= 3 ? 'candidate_task' : 'candidate_full';
        if (String(proposal.scope_kind) !== expected_scope) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'proposal scope_kind does not match its level');
        }
        const candidate_locator = candidate_evidence.get(candidate_id);
        const references = candidate_locator && typeof candidate_locator === 'object'
            && !Array.isArray(candidate_locator)
            ? (candidate_locator as integrity_row).references : undefined;
        if (references === undefined || hash_canonical(references) !== hash_canonical(evidence)) {
            history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                'history_scope', 'proposal evidence is not the candidate evidence set');
        }
        if (role_id !== null && role_mode === 'existing') {
            const role = role_by_id.get(role_id);
            if (!role || !run || String(role.project_id) !== String(run.project_id)) {
                history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                    'history_scope', 'existing proposal role is outside the publication project');
            }
        } else if (role_id !== null && role_mode === 'proposed') {
            const expected_role = `cm-role:${hash_canonical({
                schema: 1,
                project_id: run ? String(run.project_id) : '',
                semantic_key: nullable_string(proposal.role_semantic_key),
            }).slice(0, 40)}`;
            if (role_id !== expected_role) {
                history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                    'id_mismatch', 'proposed role_id is not derived from its semantic key');
            }
        }
        if (task_id !== null && task_mode === 'existing') {
            const task = task_by_id.get(task_id);
            if (!task || !run || String(task.project_id) !== String(run.project_id)
                || nullable_string(task.role_id) !== role_id) {
                history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                    'history_scope', 'existing proposal task is outside its project and role');
            }
        } else if (task_id !== null && task_mode === 'proposed') {
            const expected_task = `cm-task:${hash_canonical({
                schema: 1,
                project_id: run ? String(run.project_id) : '',
                role_id,
                semantic_key: nullable_string(proposal.task_semantic_key),
            }).slice(0, 40)}`;
            if (task_id !== expected_task) {
                history_issue(issues, 'cm_history_hierarchy_proposals', proposal_id,
                    'id_mismatch', 'proposed task_id is not derived from its semantic key');
            }
        }
    }

    for (const decision of decisions) {
        const decision_id = String(decision.decision_id);
        const publication_id = String(decision.publication_id);
        const proposal_id = nullable_string(decision.proposal_id);
        const plan_version = decision.plan_version === null ? null : Number(decision.plan_version);
        const evidence_result = parse_integrity_json(
            decision.evidence_json, 'cm_history_governance_decisions', decision_id, 'evidence_json', issues,
        );
        if (!evidence_result.ok) continue;
        const evidence_is_object = evidence_result.value !== null
            && typeof evidence_result.value === 'object'
            && !Array.isArray(evidence_result.value);
        if (!evidence_is_object || Object.keys(evidence_result.value as integrity_row).length === 0) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'history_scope', 'governance evidence must be a non-empty object');
        }
        const payload = {
            schema: 1,
            publication_id,
            proposal_id,
            plan_version,
            action: String(decision.action),
            actor_kind: String(decision.actor_kind),
            actor_id: String(decision.actor_id),
            action_id: String(decision.action_id),
            channel: String(decision.channel),
            evidence: evidence_result.value,
            note: String(decision.note),
        };
        const expected_hash = hash_canonical(payload);
        if (expected_hash !== String(decision.payload_hash)) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'hash_mismatch', 'governance payload_hash does not verify');
        }
        if (decision_id !== `history-decision:${hash_canonical([
            String(decision.action_id), expected_hash,
        ]).slice(0, 40)}`) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'id_mismatch', 'decision_id is not derived from its canonical payload');
        }
        if (!publication_by_id.has(publication_id)
            || (proposal_id !== null
                && proposal_by_id.get(proposal_id)?.publication_id !== publication_id)
            || (plan_version !== null
                && !plan_by_key.has(plan_key(publication_id, plan_version)))) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'history_scope', 'governance selectors are outside the decision publication');
        }
        const action = String(decision.action);
        const hierarchy_action = action === 'accept_hierarchy' || action === 'reject_hierarchy';
        const content_action = action === 'approve_update' || action === 'approve_conflict';
        const actor_kind = String(decision.actor_kind);
        const channel = String(decision.channel);
        const actor_shape = (actor_kind === 'user'
                && ['codex_ui', 'obsidian', 'local_cli'].includes(channel))
            || (actor_kind !== 'user' && channel === 'policy');
        if (!['accept_hierarchy', 'reject_hierarchy', 'approve_update',
            'approve_conflict', 'discard', 'retry'].includes(action)
            || !['user', 'policy', 'authorized_manifest'].includes(actor_kind)
            || (action !== 'retry' && actor_kind !== 'user')
            || !actor_shape
            || !nonempty_string(decision.actor_id)
            || !nonempty_string(decision.action_id)
            || String(decision.note).length > 2_000
            || String(decision.evidence_json).length > 16_384) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'history_scope', 'governance decision has an invalid action or actor shape');
        }
        if ((hierarchy_action && (proposal_id === null || plan_version !== null))
            || (content_action && (proposal_id !== null || plan_version === null))
            || (!hierarchy_action && !content_action && (proposal_id !== null || plan_version !== null))) {
            history_issue(issues, 'cm_history_governance_decisions', decision_id,
                'history_scope', 'governance action has invalid proposal or plan selectors');
        }
        if (content_action && plan_version !== null) {
            const plan = plan_by_key.get(plan_key(publication_id, plan_version));
            const expected_relation = action === 'approve_update' ? 'update' : 'conflict';
            if (!plan || String(plan.relation) !== expected_relation) {
                history_issue(issues, 'cm_history_governance_decisions', decision_id,
                    'history_scope', 'content approval action does not match plan relation');
            }
        }
    }

    const accepted_by_publication = new Map<string, Set<string>>();
    for (const decision of decisions.filter((row) => String(row.action) === 'accept_hierarchy')) {
        const publication_id = String(decision.publication_id);
        const accepted = accepted_by_publication.get(publication_id) ?? new Set<string>();
        accepted.add(String(decision.proposal_id));
        accepted_by_publication.set(publication_id, accepted);
    }
    for (const [publication_id, accepted] of accepted_by_publication) {
        if (accepted.size > 1) {
            history_issue(issues, 'cm_history_governance_decisions', publication_id,
                'history_scope', 'publication has accepted more than one hierarchy proposal');
        }
    }

    for (const plan of plans) {
        const publication_id = String(plan.publication_id);
        const plan_version = Number(plan.plan_version);
        const record_id = `${publication_id}@${plan_version}`;
        const publication = publication_by_id.get(publication_id);
        const proposal = proposal_by_id.get(String(plan.proposal_id));
        const run = publication ? run_by_id.get(String(publication.run_id)) : undefined;
        if (!publication || !proposal
            || String(proposal.publication_id) !== publication_id
            || String(proposal.run_id) !== String(publication.run_id)
            || String(proposal.candidate_id) !== String(publication.candidate_id)
            || !run || String(plan.project_id) !== String(run.project_id)
            || Number(plan.level) !== Number(proposal.proposed_level)
            || nullable_string(plan.role_id) !== nullable_string(proposal.role_id)
            || nullable_string(plan.task_id) !== nullable_string(proposal.task_id)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'publication plan is outside its proposal, candidate, or project hierarchy');
        }
        const plan_level = Number(plan.level);
        const plan_role_id = nullable_string(plan.role_id);
        const plan_task_id = nullable_string(plan.task_id);
        const plan_hierarchy_shape = (plan_level === 1 && plan_role_id === null && plan_task_id === null)
            || (plan_level === 2 && plan_role_id !== null && plan_task_id === null)
            || ([3, 4].includes(plan_level) && plan_role_id !== null && plan_task_id !== null);
        const expected_memory_exists_value = Number(plan.expected_memory_exists);
        const expected_memory_exists = expected_memory_exists_value === 1;
        const expected_current_version = plan.expected_current_version === null
            ? null : Number(plan.expected_current_version);
        const expected_current_status = nullable_string(plan.expected_current_status);
        const expected_current_content_hash = nullable_string(plan.expected_current_content_hash);
        const snapshot_all_null = expected_current_version === null
            && expected_current_status === null && expected_current_content_hash === null;
        const snapshot_all_present = expected_current_version !== null
            && expected_current_status !== null && expected_current_content_hash !== null;
        const relation = String(plan.relation);
        if (!Number.isInteger(plan_version) || plan_version <= 0
            || !plan_hierarchy_shape
            || ![0, 1].includes(expected_memory_exists_value)
            || (!snapshot_all_null && !snapshot_all_present)
            || (expected_current_version !== null
                && (!Number.isInteger(expected_current_version) || expected_current_version <= 0))
            || (expected_current_status !== null
                && !['active', 'superseded', 'retracted', 'pending_confirmation', 'locked']
                    .includes(expected_current_status))
            || (expected_current_content_hash !== null && expected_current_content_hash.length !== 64)
            || (!expected_memory_exists && (!snapshot_all_null || relation !== 'new'))
            || (expected_memory_exists && relation === 'new')
            || !['new', 'noop', 'update', 'conflict'].includes(relation)
            || (relation === 'noop' && (expected_current_version === null
                || expected_current_content_hash !== String(plan.publication_content_hash)))
            || ![0, 1].includes(Number(plan.is_major))
            || String(plan.candidate_finding_hash).length !== 64
            || String(plan.publication_content_hash).length !== 64
            || !nonempty_string(plan.memory_kind)
            || !nonempty_string(plan.semantic_key_normalized)
            || String(plan.capability_epoch_hash).length !== 64) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'publication plan has an invalid hierarchy, snapshot, or relation shape');
        }
        if (plan_level >= 2) {
            const role = plan_role_id === null ? undefined : role_by_id.get(plan_role_id);
            if (!role || String(role.project_id) !== String(plan.project_id)) {
                history_issue(issues, 'cm_history_publication_plans', record_id,
                    'history_scope', 'publication plan role is outside its project');
            }
        }
        if (plan_level >= 3) {
            const task = plan_task_id === null ? undefined : task_by_id.get(plan_task_id);
            if (!task || String(task.project_id) !== String(plan.project_id)
                || nullable_string(task.role_id) !== plan_role_id) {
                history_issue(issues, 'cm_history_publication_plans', record_id,
                    'history_scope', 'publication plan task is outside its project and role');
            }
        }
        const decision_id = nullable_string(plan.hierarchy_decision_id);
        if (decision_id !== null) {
            const decision = decision_by_id.get(decision_id);
            if (!decision || String(decision.action) !== 'accept_hierarchy'
                || String(decision.publication_id) !== publication_id
                || nullable_string(decision.proposal_id) !== String(plan.proposal_id)) {
                history_issue(issues, 'cm_history_publication_plans', record_id,
                    'history_scope', 'plan hierarchy decision does not accept its proposal');
            }
        }
        if (proposal && (String(proposal.role_mode) === 'proposed'
            || String(proposal.task_mode) === 'proposed') && decision_id === null) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'plan materializes proposed hierarchy without an acceptance decision');
        }
        const creator = thread_by_id.get(String(plan.created_by_session_id));
        if (!creator || String(creator.project_id) !== String(plan.project_id)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'plan creator task is outside the plan project');
        }

        const identity = {
            schema: 1,
            project_id: String(plan.project_id),
            level: Number(plan.level),
            role_id: nullable_string(plan.role_id),
            task_id: nullable_string(plan.task_id),
            memory_kind: String(plan.memory_kind),
            semantic_key: String(plan.semantic_key_normalized),
        };
        const expected_identity_hash = hash_canonical(identity);
        if (expected_identity_hash !== String(plan.semantic_identity_hash)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'semantic_identity', 'plan semantic_identity_hash does not verify');
        }
        if (String(plan.target_memory_id) !== `cm-semantic:${expected_identity_hash.slice(0, 40)}`) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'id_mismatch', 'plan target_memory_id is not derived from semantic identity');
        }
        const conflicts_result = parse_integrity_json(
            plan.conflicts_json, 'cm_history_publication_plans', record_id, 'conflicts_json', issues,
        );
        if (!conflicts_result.ok) continue;
        const conflicts = conflicts_result.value;
        if (!Array.isArray(conflicts)
            || (['new', 'noop'].includes(relation) && conflicts.length !== 0)
            || (['update', 'conflict'].includes(relation) && conflicts.length === 0)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'publication plan conflicts do not match its relation');
        }
        const candidate_id = publication ? String(publication.candidate_id) : '';
        const candidate = candidate_by_id.get(candidate_id);
        if (candidate && String(plan.candidate_finding_hash) !== String(candidate.finding_hash)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'plan candidate_finding_hash does not match its publication candidate');
        }
        const plan_body = {
            publication_id,
            proposal_id: String(plan.proposal_id),
            hierarchy_decision_id: decision_id,
            ...identity,
            semantic_key_normalized: String(plan.semantic_key_normalized),
            semantic_identity_hash: String(plan.semantic_identity_hash),
            target_memory_id: String(plan.target_memory_id),
            expected_memory_exists,
            expected_current_version,
            expected_current_status,
            expected_current_content_hash,
            relation,
            conflicts,
            candidate_finding_hash: String(plan.candidate_finding_hash),
            publication_content_hash: String(plan.publication_content_hash),
            is_major: Boolean(Number(plan.is_major)),
        };
        if (hash_canonical(plan_body) !== String(plan.plan_hash)) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'hash_mismatch', 'publication plan_hash does not verify');
        }
        if (candidate) {
            const expected_content_hash = hash_canonical({
                schema: 1,
                title: String(candidate.title),
                summary: String(candidate.summary),
                body: String(candidate.body),
                importance: Number(candidate.importance),
                is_major: Boolean(Number(plan.is_major)),
                change_reason: 'authorized historical backfill',
                metadata: {
                    origin: 'authorized_history_backfill',
                    semantic_identity_hash: String(plan.semantic_identity_hash),
                    schema_version: '1.0.0',
                },
            });
            if (expected_content_hash !== String(plan.publication_content_hash)) {
                history_issue(issues, 'cm_history_publication_plans', record_id,
                    'hash_mismatch', 'plan publication_content_hash does not match candidate content');
            }
        }
        if (expected_memory_exists && !memory_by_id.has(String(plan.target_memory_id))) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'plan expected an existing memory that is missing');
        }
        const target_memory = memory_by_id.get(String(plan.target_memory_id));
        if (target_memory && (String(target_memory.project_id) !== String(plan.project_id)
            || Number(target_memory.level) !== plan_level
            || nullable_string(target_memory.role_id) !== plan_role_id
            || nullable_string(target_memory.task_id) !== plan_task_id
            || String(target_memory.memory_kind) !== String(plan.memory_kind))) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'semantic_identity', 'plan target memory hierarchy differs from its semantic identity');
        }
        if ((Boolean(Number(candidate?.is_major)) || plan_level === 1)
            && !Boolean(Number(plan.is_major))) {
            history_issue(issues, 'cm_history_publication_plans', record_id,
                'history_scope', 'major or project-level candidate was downgraded by its publication plan');
        }
    }

    const semantic_natural_identities = new Set<string>();
    const canonical_semantic_memories = new Set<string>();
    for (const semantic of semantic_keys) {
        const record_id = String(semantic.semantic_identity_hash);
        const semantic_level = Number(semantic.level);
        const semantic_role_id = nullable_string(semantic.role_id);
        const semantic_task_id = nullable_string(semantic.task_id);
        const identity = {
            schema: 1,
            project_id: String(semantic.project_id),
            level: semantic_level,
            role_id: semantic_role_id,
            task_id: semantic_task_id,
            memory_kind: String(semantic.memory_kind),
            semantic_key: String(semantic.semantic_key_normalized),
        };
        const expected_hash = hash_canonical(identity);
        const memory_id = String(semantic.memory_id);
        const memory = memory_by_id.get(memory_id);
        const canonical = Number(semantic.is_canonical);
        const hierarchy_shape = (semantic_level === 1
                && semantic_role_id === null && semantic_task_id === null)
            || (semantic_level === 2 && semantic_role_id !== null && semantic_task_id === null)
            || ([3, 4].includes(semantic_level)
                && semantic_role_id !== null && semantic_task_id !== null);
        if (!hierarchy_shape || ![0, 1].includes(canonical)
            || !nonempty_string(semantic.memory_kind)
            || !nonempty_string(semantic.semantic_key_normalized)) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'semantic_identity', 'semantic key has an invalid hierarchy or identity shape');
        }
        if (semantic_natural_identities.has(expected_hash)) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'semantic_identity', 'semantic natural identity is bound more than once');
        }
        semantic_natural_identities.add(expected_hash);
        if (canonical === 1 && canonical_semantic_memories.has(memory_id)) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'semantic_identity', 'central memory has more than one canonical semantic key');
        }
        if (canonical === 1) canonical_semantic_memories.add(memory_id);
        if (expected_hash !== record_id) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'semantic_identity', 'semantic key hash does not verify');
        }
        if (canonical === 1
            && memory_id !== `cm-semantic:${expected_hash.slice(0, 40)}`) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'id_mismatch', 'canonical semantic memory_id is not derived from identity');
        }
        if (!memory || String(memory.project_id) !== String(semantic.project_id)
            || Number(memory.level) !== Number(semantic.level)
            || nullable_string(memory.role_id) !== nullable_string(semantic.role_id)
            || nullable_string(memory.task_id) !== nullable_string(semantic.task_id)
            || String(memory.memory_kind) !== String(semantic.memory_kind)) {
            history_issue(issues, 'cm_semantic_memory_keys', record_id,
                'semantic_identity', 'semantic key and central memory hierarchy differ');
        }
    }

    for (const attempt of attempts) {
        const attempt_id = String(attempt.attempt_id);
        const publication_id = String(attempt.publication_id);
        const plan = plan_by_key.get(plan_key(publication_id, attempt.plan_version));
        if (!plan) {
            history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                'history_scope', 'attempt does not resolve to a plan in its publication');
            continue;
        }
        const worker_thread = thread_by_id.get(String(attempt.worker_session_id));
        if (!worker_thread || String(worker_thread.project_id) !== String(plan.project_id)) {
            history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                'history_scope', 'attempt worker task is outside the plan project');
        }
        const outcome = String(attempt.outcome);
        const result_memory_id = nullable_string(attempt.result_memory_id);
        const result_version = attempt.result_version === null ? null : Number(attempt.result_version);
        const result_confirmation_id = nullable_string(attempt.result_confirmation_id);
        const error_code = nullable_string(attempt.error_code);
        const error_detail = nullable_string(attempt.error_detail);
        const successful = ['created', 'updated', 'noop'].includes(outcome);
        const pending = outcome === 'pending_confirmation';
        const failed = outcome === 'needs_review' || outcome === 'retryable';
        if ((!successful && !pending && !failed)
            || (result_version !== null && (!Number.isInteger(result_version) || result_version <= 0))
            || String(attempt.capability_epoch_hash).length !== 64
            || String(attempt.request_hash).length !== 64
            || !nonempty_string(attempt.worker_session_id)
            || !nonempty_string(attempt.worker_turn_id)
            || (successful && (result_memory_id === null || result_version === null
                || result_confirmation_id !== null || error_code !== null || error_detail !== null))
            || (pending && (result_memory_id === null || result_version === null
                || result_confirmation_id === null || error_code !== null || error_detail !== null))
            || (failed && (result_memory_id !== null || result_version !== null
                || result_confirmation_id !== null || error_code === null || error_detail === null
                || !nonempty_string(error_code) || !nonempty_string(error_detail)
                || error_detail.length > 2_000))) {
            history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                'history_attempt', 'attempt outcome has inconsistent result or error fields');
        }
        if ((successful || pending) && result_memory_id !== String(plan.target_memory_id)) {
            history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                'history_attempt', 'attempt result memory is not the plan target');
        }
        if ((successful || pending) && result_memory_id !== null && result_version !== null) {
            const version = version_by_key.get(version_key(result_memory_id, result_version));
            if (!version || String(version.content_hash) !== String(plan.publication_content_hash)) {
                history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                    'history_attempt', 'attempt result version does not match plan content');
            }
        }
        if (pending && result_confirmation_id !== null) {
            const confirmation = confirmation_by_id.get(result_confirmation_id);
            if (!confirmation || String(confirmation.memory_id) !== result_memory_id
                || Number(confirmation.proposed_version) !== result_version) {
                history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                    'history_attempt', 'attempt confirmation does not bind its result version');
            }
        }
        if ((outcome === 'created' && Boolean(Number(plan.expected_memory_exists)))
            || (outcome === 'noop' && String(plan.relation) !== 'noop')
            || (outcome === 'updated' && (!Boolean(Number(plan.expected_memory_exists))
                || !['update', 'conflict'].includes(String(plan.relation))))) {
            history_issue(issues, 'cm_history_publication_attempts', attempt_id,
                'history_attempt', 'attempt success outcome does not match its immutable plan');
        }
    }

    return publications.length;
}

function history_worker_authorization_integrity(
    db: Database.Database,
    scope: IntegrityScope,
    issues: IntegrityIssue[],
): void {
    if (!integrity_table_exists(db, 'cm_history_worker_authorizations')) return;
    const authorizations = db.prepare(`SELECT * FROM cm_history_worker_authorizations
        WHERE tenant_id=? AND user_id=? ORDER BY authorization_id`)
        .all(scope.tenant_id, scope.user_id) as integrity_row[];
    for (const authorization of authorizations) {
        const authorization_id = String(authorization.authorization_id);
        const run_id = nullable_string(authorization.run_id);
        const plan_id = nullable_string(authorization.plan_id);
        const expected_scope_hash = history_worker_scope_hash({
            tenant_id: String(authorization.tenant_id),
            user_id: String(authorization.user_id),
            project_id: String(authorization.project_id),
            worker_session_id: String(authorization.worker_session_id),
            worker_id: String(authorization.worker_id),
            run_id,
            plan_id,
        });
        if (String(authorization.scope_hash) !== expected_scope_hash) {
            history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                'hash_mismatch', 'history worker authorization scope_hash does not verify');
        }

        const thread = db.prepare(`SELECT project_id, status FROM cm_threads
            WHERE tenant_id=? AND user_id=? AND thread_id=?`)
            .get(scope.tenant_id, scope.user_id, String(authorization.worker_session_id)) as {
                project_id: string; status: string;
            } | undefined;
        if (!thread || thread.project_id !== String(authorization.project_id)
            || (authorization.status === 'active' && thread.status !== 'active')) {
            history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                'history_scope', 'history worker task is missing, inactive, or outside the authorized project');
        }

        if (run_id !== null) {
            const run = db.prepare(`SELECT project_id, plan_id FROM cm_history_backfill_runs
                WHERE tenant_id=? AND user_id=? AND run_id=?`)
                .get(scope.tenant_id, scope.user_id, run_id) as {
                    project_id: string; plan_id: string;
                } | undefined;
            if (!run || run.project_id !== String(authorization.project_id)
                || (plan_id !== null && run.plan_id !== plan_id)) {
                history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                    'history_scope', 'history worker run scope is outside its project or plan');
            }
        }
        if (plan_id !== null) {
            const plan = db.prepare(`SELECT 1 FROM cm_history_backfill_runs
                WHERE tenant_id=? AND user_id=? AND project_id=? AND plan_id=? LIMIT 1`)
                .get(scope.tenant_id, scope.user_id, String(authorization.project_id), plan_id);
            if (!plan) {
                history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                    'history_scope', 'history worker plan scope has no run in its project');
            }
        }

        const authorized_evidence = parse_integrity_json(
            authorization.authorize_evidence_json,
            'cm_history_worker_authorizations', authorization_id,
            'authorize_evidence_json', issues,
        );
        if (authorized_evidence.ok && (authorized_evidence.value === null
            || typeof authorized_evidence.value !== 'object'
            || Array.isArray(authorized_evidence.value)
            || Object.keys(authorized_evidence.value as integrity_row).length === 0)) {
            history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                'history_scope', 'history worker authorization evidence must be a non-empty object');
        }
        const active_shape = authorization.status === 'active'
            && authorization.revoked_by === null
            && authorization.revoke_action_id === null
            && authorization.revoke_evidence_json === null
            && authorization.revoked_at === null;
        const revoked_shape = authorization.status === 'revoked'
            && nonempty_string(authorization.revoked_by)
            && nonempty_string(authorization.revoke_action_id)
            && authorization.revoke_evidence_json !== null
            && authorization.revoked_at !== null;
        if (!active_shape && !revoked_shape) {
            history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                'history_scope', 'history worker authorization lifecycle fields are inconsistent');
        }
        if (authorization.revoke_evidence_json !== null) {
            const revoked_evidence = parse_integrity_json(
                authorization.revoke_evidence_json,
                'cm_history_worker_authorizations', authorization_id,
                'revoke_evidence_json', issues,
            );
            if (revoked_evidence.ok && (revoked_evidence.value === null
                || typeof revoked_evidence.value !== 'object'
                || Array.isArray(revoked_evidence.value)
                || Object.keys(revoked_evidence.value as integrity_row).length === 0)) {
                history_issue(issues, 'cm_history_worker_authorizations', authorization_id,
                    'history_scope', 'history worker revocation evidence must be a non-empty object');
            }
        }
    }
}

export function check_sqlite_integrity(
    db: Database.Database,
    scope: IntegrityScope,
): IntegrityReport {
    const issues: IntegrityIssue[] = [];
    const quick = db.pragma('quick_check') as Array<{ quick_check: string }>;
    for (const row of quick) {
        if (row.quick_check !== 'ok') {
            issues.push({ table: 'sqlite', record_id: 'database', code: 'sqlite', message: row.quick_check });
        }
    }

    const node_rows = db.prepare(`SELECT node_id, node_json, content_hash FROM hydro_nodes
        WHERE tenant_id = ? AND user_id = ?`).all(scope.tenant_id, scope.user_id) as Array<{
        node_id: string; node_json: string; content_hash: string;
    }>;
    const node_ids = new Set<string>();
    for (const row of node_rows) {
        if (decode_node_safely(row, row.node_id, issues)) node_ids.add(row.node_id);
    }

    const world_ids = new Set(
        (db.prepare('SELECT world_id FROM worlds WHERE tenant_id = ? AND user_id = ?')
            .all(scope.tenant_id, scope.user_id) as Array<{ world_id: string }>).map((row) => row.world_id),
    );
    const entity_ids = new Set(
        (db.prepare('SELECT entity_id FROM entities WHERE tenant_id = ? AND user_id = ?')
            .all(scope.tenant_id, scope.user_id) as Array<{ entity_id: string }>).map((row) => row.entity_id),
    );
    const fact_refs = new Set(
        (db.prepare('SELECT fact_ref FROM grounded_facts WHERE tenant_id = ? AND user_id = ?')
            .all(scope.tenant_id, scope.user_id) as Array<{ fact_ref: string }>).map((row) => row.fact_ref),
    );
    const endpoint_exists = (id: string): boolean => node_ids.has(id) || world_ids.has(id) || entity_ids.has(id) || fact_refs.has(id);
    const edge_rows = db.prepare(`SELECT edge_id, from_id, to_id, edge_json FROM hydro_edges
        WHERE tenant_id = ? AND user_id = ?`).all(scope.tenant_id, scope.user_id) as Array<{
        edge_id: string; from_id: string; to_id: string; edge_json: string;
    }>;
    for (const row of edge_rows) {
        try {
            const edge = JSON.parse(row.edge_json) as { id: string; from: string; to: string };
            if (edge.id !== row.edge_id || edge.from !== row.from_id || edge.to !== row.to_id) {
                issues.push({ table: 'hydro_edges', record_id: row.edge_id, code: 'id_mismatch', message: 'edge payload does not match indexed columns' });
            }
            if (!endpoint_exists(row.from_id)) {
                issues.push({ table: 'hydro_edges', record_id: row.edge_id, code: 'dangling_edge', message: `missing from endpoint ${row.from_id}` });
            }
            if (!endpoint_exists(row.to_id)) {
                issues.push({ table: 'hydro_edges', record_id: row.edge_id, code: 'dangling_edge', message: `missing to endpoint ${row.to_id}` });
            }
        } catch (error) {
            issues.push({
                table: 'hydro_edges', record_id: row.edge_id, code: 'invalid_json',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const sketch_rows = db.prepare(`SELECT sketch_key, state_json FROM sketch_states
        WHERE tenant_id = ? AND user_id = ?`).all(scope.tenant_id, scope.user_id) as Array<{
        sketch_key: string; state_json: string;
    }>;
    for (const row of sketch_rows) {
        try {
            validate_sketch(row.state_json);
        } catch (error) {
            issues.push({
                table: 'sketch_states', record_id: row.sketch_key, code: 'invalid_sketch',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    let checked_central_memories = 0;
    const central_schema = db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='cm_memories'`).get();
    if (central_schema) {
        const memory_rows = db.prepare(`SELECT m.memory_id, m.current_version,
                v.status AS current_status,
                (SELECT COUNT(*) FROM cm_memory_versions AS effective
                 WHERE effective.tenant_id=m.tenant_id AND effective.user_id=m.user_id
                   AND effective.memory_id=m.memory_id AND effective.status IN ('active', 'locked')) AS effective_count
            FROM cm_memories AS m
            LEFT JOIN cm_memory_versions AS v
              ON v.tenant_id=m.tenant_id AND v.user_id=m.user_id
             AND v.memory_id=m.memory_id AND v.version=m.current_version
            WHERE m.tenant_id=? AND m.user_id=?`)
            .all(scope.tenant_id, scope.user_id) as Array<{
                memory_id: string; current_version: number | null; current_status: string | null; effective_count: number;
            }>;
        checked_central_memories = memory_rows.length;
        for (const row of memory_rows) {
            const expected_effective = row.current_version === null ? 0 : 1;
            if (row.effective_count !== expected_effective
                || (row.current_version !== null && !['active', 'locked'].includes(String(row.current_status)))) {
                issues.push({
                    table: 'cm_memories',
                    record_id: row.memory_id,
                    code: 'central_current',
                    message: `current_version=${String(row.current_version)}, current_status=${String(row.current_status)}, effective_versions=${row.effective_count}`,
                });
            }
        }

        const version_rows = db.prepare(`SELECT memory_id, version, title, summary, body,
                importance, is_major, change_reason, metadata_json, content_hash FROM cm_memory_versions
            WHERE tenant_id=? AND user_id=?`)
            .all(scope.tenant_id, scope.user_id) as Array<{
                memory_id: string; version: number; title: string; summary: string; body: string;
                importance: number; is_major: number; change_reason: string;
                metadata_json: string; content_hash: string;
            }>;
        for (const row of version_rows) {
            const record_id = `${row.memory_id}@${row.version}`;
            try {
                const metadata = JSON.parse(row.metadata_json) as unknown;
                const expected = hash_canonical({
                    schema: 1,
                    title: row.title,
                    summary: row.summary,
                    body: row.body,
                    importance: row.importance,
                    is_major: Boolean(row.is_major),
                    change_reason: row.change_reason,
                    metadata,
                });
                if (expected !== row.content_hash) {
                    issues.push({
                        table: 'cm_memory_versions', record_id, code: 'hash_mismatch',
                        message: 'central memory content hash does not verify',
                    });
                }
            } catch (error) {
                issues.push({
                    table: 'cm_memory_versions', record_id, code: 'invalid_json',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const invalid_confirmations = db.prepare(`SELECT confirmation_id, memory_id, proposed_version
            FROM cm_confirmations AS confirmation
            WHERE confirmation.tenant_id=? AND confirmation.user_id=? AND confirmation.status='pending'
              AND NOT EXISTS (
                SELECT 1 FROM cm_memory_versions AS version
                WHERE version.tenant_id=confirmation.tenant_id AND version.user_id=confirmation.user_id
                  AND version.memory_id=confirmation.memory_id AND version.version=confirmation.proposed_version
                  AND (
                    version.status='pending_confirmation'
                    OR (
                        confirmation.proposed_version=confirmation.expected_current_version
                        AND confirmation.requested_status IN ('locked', 'retracted')
                        AND version.status IN ('active', 'locked')
                    )
                  )
              )`)
            .all(scope.tenant_id, scope.user_id) as Array<{
                confirmation_id: string; memory_id: string; proposed_version: number;
            }>;
        for (const row of invalid_confirmations) {
            issues.push({
                table: 'cm_confirmations', record_id: row.confirmation_id, code: 'central_confirmation',
                message: `pending confirmation points to non-pending ${row.memory_id}@${row.proposed_version}`,
            });
        }

        const invalid_hierarchy = db.prepare(`
            SELECT 'cm_threads' AS table_name, thread.thread_id AS record_id,
                   thread.task_id AS task_id, thread.role_id AS bound_role_id,
                   task.role_id AS task_role_id
            FROM cm_threads AS thread
            LEFT JOIN cm_tasks AS task
              ON task.tenant_id=thread.tenant_id AND task.user_id=thread.user_id
             AND task.project_id=thread.project_id AND task.task_id=thread.task_id
            WHERE thread.tenant_id=? AND thread.user_id=? AND thread.task_id IS NOT NULL
              AND (task.task_id IS NULL OR task.role_id IS NOT thread.role_id)
            UNION ALL
            SELECT 'cm_memories' AS table_name, memory.memory_id AS record_id,
                   memory.task_id AS task_id, memory.role_id AS bound_role_id,
                   task.role_id AS task_role_id
            FROM cm_memories AS memory
            LEFT JOIN cm_tasks AS task
              ON task.tenant_id=memory.tenant_id AND task.user_id=memory.user_id
             AND task.project_id=memory.project_id AND task.task_id=memory.task_id
            WHERE memory.tenant_id=? AND memory.user_id=? AND memory.task_id IS NOT NULL
              AND (task.task_id IS NULL OR task.role_id IS NOT memory.role_id)`)
            .all(scope.tenant_id, scope.user_id, scope.tenant_id, scope.user_id) as Array<{
                table_name: string; record_id: string; task_id: string;
                bound_role_id: string | null; task_role_id: string | null;
            }>;
        for (const row of invalid_hierarchy) {
            issues.push({
                table: row.table_name,
                record_id: row.record_id,
                code: 'central_hierarchy',
                message: `task ${row.task_id} belongs to role ${String(row.task_role_id)}, bound role is ${String(row.bound_role_id)}`,
            });
        }

        const foreign_keys = db.pragma('foreign_key_check') as Array<{
            table: string; rowid: number | null; parent: string; fkid: number;
        }>;
        for (const row of foreign_keys.filter((candidate) => candidate.table.startsWith('cm_'))) {
            issues.push({
                table: row.table,
                record_id: String(row.rowid ?? row.fkid),
                code: 'foreign_key',
                message: `missing parent row in ${row.parent}`,
            });
        }
    }

    const checked_project_links = central_project_link_integrity(db, scope, issues);
    const checked_history_publications = history_publication_integrity(db, scope, issues);
    history_worker_authorization_integrity(db, scope, issues);

    return {
        ok: issues.length === 0,
        checked_nodes: node_rows.length,
        checked_edges: edge_rows.length,
        checked_sketches: sketch_rows.length,
        checked_central_memories,
        checked_project_links,
        checked_history_publications,
        issues,
    };
}
