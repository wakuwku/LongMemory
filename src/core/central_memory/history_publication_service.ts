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
 *  file  : src/core/central_memory/history_publication_service.ts
 *  usage : implements the LongMemory history publication service component
 */

import type Database from 'better-sqlite3';
import { hash_canonical, sha256_hex } from '../hash/content_hash.js';
import { canonicalize } from '../hash/canonical_json.js';
import { CentralMemoryRepository } from '../../stores/sqlite/central_memory_repository.js';
import { CentralMemoryService } from './service.js';
import { central_memory_conflict_error, type central_metadata } from './types.js';
import { assert_no_obvious_credentials } from './sensitive_content.js';
import type { history_worker_context } from './history_backfill_types.js';
import { has_active_history_worker_authorization } from './history_worker_authorization.js';
import type {
    history_governance_decision,
    history_governance_decision_input,
    history_hierarchy_proposal,
    history_hierarchy_proposal_input,
    history_publication,
    history_publication_attempt,
    history_publication_execute_input,
    history_publication_execute_result,
    history_publication_plan,
    history_publication_plan_input,
    history_publication_result_kind,
    history_publication_service_options,
} from './history_publication_types.js';
import { history_publication_conflict_error } from './history_publication_types.js';

type row = Record<string, unknown>;

type publication_context = {
    publication: history_publication;
    project_id: string;
    source_harness: string;
    source_session_id: string;
    source_revision: string;
    candidate: {
        candidate_id: string;
        run_id: string;
        reduction_id: string;
        title: string;
        summary: string;
        body: string;
        importance: number;
        is_major: boolean;
        finding_kind: string;
        finding_hash: string;
        evidence: {
            source_harness: string;
            source_session_id: string;
            source_revision: string;
            references: Array<{
                chunk_index: number;
                turn_index: number;
                part_index: number;
                quote?: string;
            }>;
        };
        created_at: number;
    };
};

function string_or_null(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}

function number_or_null(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
}

function json_object(value: unknown, label: string): central_metadata {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch (error) {
        throw new Error(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return JSON.parse(serialized) as central_metadata;
}

function bounded(value: unknown, label: string, maximum = 1_024): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maximum) {
        throw new Error(`${label} must contain between 1 and ${maximum} characters`);
    }
    return normalized;
}

function integer(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new Error(`${label} must be a safe integer >= ${minimum}`);
    }
    return Number(value);
}

function normalize_semantic_key(value: unknown, label: string): string {
    return bounded(value, label, 512).normalize('NFKC').toLowerCase()
        .replace(/\s+/gu, ' ').trim();
}

function normalize_worker(value: history_worker_context): history_worker_context {
    const worker_id = bounded(value?.worker_id, 'worker_id', 256);
    const worker_session_id = bounded(value?.worker_session_id, 'worker_session_id');
    const worker_turn_id = bounded(value?.worker_turn_id, 'worker_turn_id');
    const capability_epoch_hash = bounded(value?.capability_epoch_hash, 'capability_epoch_hash', 64);
    if (!/^[a-f0-9]{64}$/iu.test(capability_epoch_hash)) {
        throw new Error('capability_epoch_hash must be a SHA-256 hex digest');
    }
    return { worker_id, worker_session_id, worker_turn_id, capability_epoch_hash };
}

function map_publication(value: row): history_publication {
    return {
        publication_id: String(value.publication_id),
        run_id: String(value.run_id),
        candidate_id: String(value.candidate_id),
        status: value.status as history_publication['status'],
        current_plan_version: number_or_null(value.current_plan_version),
        result_kind: value.result_kind as history_publication['result_kind'],
        result_memory_id: string_or_null(value.result_memory_id),
        result_version: number_or_null(value.result_version),
        result_confirmation_id: string_or_null(value.result_confirmation_id),
        attempt_count: Number(value.attempt_count),
        last_attempt_id: string_or_null(value.last_attempt_id),
        last_error_code: string_or_null(value.last_error_code),
        last_error_detail: string_or_null(value.last_error_detail),
        available_at: Number(value.available_at),
        created_at: Number(value.created_at),
        updated_at: Number(value.updated_at),
        terminal_at: number_or_null(value.terminal_at),
    };
}

function map_proposal(value: row): history_hierarchy_proposal {
    return {
        proposal_id: String(value.proposal_id),
        publication_id: String(value.publication_id),
        run_id: String(value.run_id),
        candidate_id: String(value.candidate_id),
        scope_kind: value.scope_kind as history_hierarchy_proposal['scope_kind'],
        proposed_level: Number(value.proposed_level) as history_hierarchy_proposal['proposed_level'],
        role_mode: value.role_mode as history_hierarchy_proposal['role_mode'],
        role_id: string_or_null(value.role_id),
        role_semantic_key: string_or_null(value.role_semantic_key),
        role_name: string_or_null(value.role_name),
        role_responsibility: string_or_null(value.role_responsibility),
        task_mode: value.task_mode as history_hierarchy_proposal['task_mode'],
        task_id: string_or_null(value.task_id),
        task_semantic_key: string_or_null(value.task_semantic_key),
        task_title: string_or_null(value.task_title),
        task_objective: string_or_null(value.task_objective),
        confidence: Number(value.confidence),
        evidence: JSON.parse(String(value.evidence_json)) as unknown[],
        proposal_hash: String(value.proposal_hash),
        worker_session_id: String(value.worker_session_id),
        worker_turn_id: String(value.worker_turn_id),
        capability_epoch_hash: String(value.capability_epoch_hash),
        created_at: Number(value.created_at),
    };
}

function map_decision(value: row): history_governance_decision {
    return {
        decision_id: String(value.decision_id),
        publication_id: String(value.publication_id),
        proposal_id: string_or_null(value.proposal_id),
        plan_version: number_or_null(value.plan_version),
        action: value.action as history_governance_decision['action'],
        actor_kind: value.actor_kind as history_governance_decision['actor_kind'],
        actor_id: String(value.actor_id),
        action_id: String(value.action_id),
        channel: value.channel as history_governance_decision['channel'],
        evidence: JSON.parse(String(value.evidence_json)) as Record<string, unknown>,
        note: String(value.note),
        payload_hash: String(value.payload_hash),
        created_at: Number(value.created_at),
    };
}

function map_plan(value: row): history_publication_plan {
    return {
        publication_id: String(value.publication_id),
        plan_version: Number(value.plan_version),
        project_id: String(value.project_id),
        proposal_id: String(value.proposal_id),
        hierarchy_decision_id: string_or_null(value.hierarchy_decision_id),
        level: Number(value.level) as history_publication_plan['level'],
        role_id: string_or_null(value.role_id),
        task_id: string_or_null(value.task_id),
        memory_kind: String(value.memory_kind),
        semantic_key_normalized: String(value.semantic_key_normalized),
        semantic_identity_hash: String(value.semantic_identity_hash),
        target_memory_id: String(value.target_memory_id),
        expected_memory_exists: Boolean(value.expected_memory_exists),
        expected_current_version: number_or_null(value.expected_current_version),
        expected_current_status: string_or_null(value.expected_current_status),
        expected_current_content_hash: string_or_null(value.expected_current_content_hash),
        relation: value.relation as history_publication_plan['relation'],
        conflicts: JSON.parse(String(value.conflicts_json)) as unknown[],
        candidate_finding_hash: String(value.candidate_finding_hash),
        publication_content_hash: String(value.publication_content_hash),
        is_major: Boolean(value.is_major),
        plan_hash: String(value.plan_hash),
        created_by_session_id: String(value.created_by_session_id),
        created_by_turn_id: String(value.created_by_turn_id),
        capability_epoch_hash: String(value.capability_epoch_hash),
        created_at: Number(value.created_at),
    };
}

function map_attempt(value: row): history_publication_attempt {
    return {
        attempt_id: String(value.attempt_id),
        publication_id: String(value.publication_id),
        plan_version: Number(value.plan_version),
        worker_session_id: String(value.worker_session_id),
        worker_turn_id: String(value.worker_turn_id),
        capability_epoch_hash: String(value.capability_epoch_hash),
        request_hash: String(value.request_hash),
        outcome: value.outcome as history_publication_attempt['outcome'],
        result_memory_id: string_or_null(value.result_memory_id),
        result_version: number_or_null(value.result_version),
        result_confirmation_id: string_or_null(value.result_confirmation_id),
        error_code: string_or_null(value.error_code),
        error_detail: string_or_null(value.error_detail),
        created_at: Number(value.created_at),
    };
}

function stable_metadata(semantic_identity_hash: string): central_metadata {
    return {
        origin: 'authorized_history_backfill',
        semantic_identity_hash,
        schema_version: '1.0.0',
    };
}

function version_content_hash(input: {
    title: string;
    summary: string;
    body: string;
    importance: number;
    is_major: boolean;
    semantic_identity_hash: string;
}): string {
    return hash_canonical({
        schema: 1,
        title: input.title,
        summary: input.summary,
        body: input.body,
        importance: input.importance,
        is_major: input.is_major,
        change_reason: 'authorized historical backfill',
        metadata: stable_metadata(input.semantic_identity_hash),
    });
}

function error_detail(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    try {
        assert_no_obvious_credentials({ history_publication_error: detail });
        return detail.slice(0, 2_000);
    } catch {
        return 'publication operation failed; sensitive error detail omitted';
    }
}

export class HistoryPublicationService {
    readonly tenant_id: string;
    readonly user_id: string;
    private readonly now: () => number;
    private readonly capability_guard: (worker: history_worker_context) => void;
    private readonly repository: CentralMemoryRepository;
    private readonly central: CentralMemoryService;

    constructor(readonly database: Database.Database, options: history_publication_service_options) {
        this.tenant_id = bounded(options.tenant_id, 'tenant_id');
        this.user_id = bounded(options.user_id, 'user_id');
        this.now = options.now ?? (() => Date.now());
        if (typeof options.capability_guard !== 'function') {
            throw new Error('HistoryPublicationService requires a synchronous capability_guard');
        }
        this.capability_guard = options.capability_guard;
        this.repository = new CentralMemoryRepository(database, {
            tenant_id: this.tenant_id,
            user_id: this.user_id,
            now: this.now,
        });
        this.central = new CentralMemoryService(this.repository);
    }

    private write<T>(operation: () => T): T {
        if (this.database.inTransaction) {
            throw new Error('history publication mutations require their own BEGIN IMMEDIATE transaction');
        }
        return this.database.transaction(operation).immediate();
    }

    private require_active_worker(
        worker: history_worker_context,
        run_id?: string,
    ): { project_id: string } {
        const result = this.capability_guard(worker) as unknown;
        if (result !== undefined && result !== null && typeof result === 'object'
            && 'then' in result && typeof result.then === 'function') {
            throw new Error('history publication capability_guard must be synchronous and held through commit');
        }
        const value = this.database.prepare(`SELECT project_id FROM cm_threads
            WHERE tenant_id=? AND user_id=? AND thread_id=? AND status='active'`)
            .get(this.tenant_id, this.user_id, worker.worker_session_id) as { project_id: string } | undefined;
        if (!value) throw new Error(`history publication worker task ${worker.worker_session_id} is not actively bound`);
        const project_id = String(value.project_id);
        if (!has_active_history_worker_authorization(this.database, {
            tenant_id: this.tenant_id,
            user_id: this.user_id,
            project_id,
            worker_session_id: worker.worker_session_id,
            worker_id: worker.worker_id,
            ...(run_id === undefined ? {} : { run_id }),
        })) {
            throw new Error(run_id === undefined
                ? 'permission denied: this task is not an authorized dedicated history worker'
                : `permission denied: history run ${run_id} is outside the active worker authorization scope`);
        }
        return { project_id };
    }

    private require_publication(publication_id: string): history_publication {
        const value = this.database.prepare(`SELECT * FROM cm_history_publications
            WHERE tenant_id=? AND user_id=? AND publication_id=?`)
            .get(this.tenant_id, this.user_id, publication_id) as row | undefined;
        if (!value) throw new Error(`history publication ${publication_id} was not found`);
        return map_publication(value);
    }

    private require_context(publication_id: string): publication_context {
        const value = this.database.prepare(`SELECT publication.*,
                run.project_id, run.source_harness, run.source_session_id, run.source_revision,
                candidate.reduction_id, candidate.title AS candidate_title,
                candidate.summary AS candidate_summary, candidate.body AS candidate_body,
                candidate.importance AS candidate_importance, candidate.is_major AS candidate_is_major,
                candidate.finding_kind, candidate.finding_hash, candidate.evidence_json,
                candidate.created_at AS candidate_created_at, candidate.stage AS candidate_stage,
                candidate.receipt_id AS candidate_receipt_id, run.status AS run_status,
                run.consolidation_receipt_id
            FROM cm_history_publications AS publication
            JOIN cm_history_backfill_runs AS run
              ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
             AND run.run_id=publication.run_id
            JOIN cm_history_backfill_candidates AS candidate
              ON candidate.tenant_id=publication.tenant_id AND candidate.user_id=publication.user_id
             AND candidate.candidate_id=publication.candidate_id AND candidate.run_id=publication.run_id
            WHERE publication.tenant_id=? AND publication.user_id=? AND publication.publication_id=?`)
            .get(this.tenant_id, this.user_id, publication_id) as row | undefined;
        if (!value) throw new Error(`history publication ${publication_id} was not found`);
        if (value.candidate_stage !== 'consolidated' || value.run_status !== 'candidates_ready'
            || value.candidate_receipt_id !== value.consolidation_receipt_id) {
            throw new Error(`history publication ${publication_id} no longer has a final authorized candidate`);
        }
        const evidence = JSON.parse(String(value.evidence_json)) as publication_context['candidate']['evidence'];
        return {
            publication: map_publication(value),
            project_id: String(value.project_id),
            source_harness: String(value.source_harness),
            source_session_id: String(value.source_session_id),
            source_revision: String(value.source_revision),
            candidate: {
                candidate_id: String(value.candidate_id),
                run_id: String(value.run_id),
                reduction_id: String(value.reduction_id),
                title: String(value.candidate_title),
                summary: String(value.candidate_summary),
                body: String(value.candidate_body),
                importance: Number(value.candidate_importance),
                is_major: Boolean(value.candidate_is_major),
                finding_kind: String(value.finding_kind),
                finding_hash: String(value.finding_hash),
                evidence,
                created_at: Number(value.candidate_created_at),
            },
        };
    }

    private require_proposal(proposal_id: string): history_hierarchy_proposal {
        const value = this.database.prepare(`SELECT * FROM cm_history_hierarchy_proposals
            WHERE tenant_id=? AND user_id=? AND proposal_id=?`)
            .get(this.tenant_id, this.user_id, proposal_id) as row | undefined;
        if (!value) throw new Error(`history hierarchy proposal ${proposal_id} was not found`);
        return map_proposal(value);
    }

    private require_plan(publication_id: string, plan_version: number): history_publication_plan {
        const value = this.database.prepare(`SELECT * FROM cm_history_publication_plans
            WHERE tenant_id=? AND user_id=? AND publication_id=? AND plan_version=?`)
            .get(this.tenant_id, this.user_id, publication_id, plan_version) as row | undefined;
        if (!value) throw new Error(`history publication plan ${publication_id}@${plan_version} was not found`);
        return map_plan(value);
    }

    private attempt(attempt_id: string): history_publication_attempt | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_publication_attempts
            WHERE tenant_id=? AND user_id=? AND attempt_id=?`)
            .get(this.tenant_id, this.user_id, attempt_id) as row | undefined;
        return value ? map_attempt(value) : null;
    }

    get(publication_id: string): history_publication {
        return this.require_publication(bounded(publication_id, 'publication_id'));
    }

    get_for_worker(
        publication_id: string,
        worker_context: history_worker_context,
    ): history_publication {
        const worker = normalize_worker(worker_context);
        const publication = this.require_publication(bounded(publication_id, 'publication_id'));
        this.require_active_worker(worker, publication.run_id);
        return publication;
    }

    list(project_id: string, options: { limit?: number; offset?: number } = {}): history_publication[] {
        const project = bounded(project_id, 'project_id');
        const limit = integer(options.limit ?? 100, 'publication limit', 1);
        const offset = integer(options.offset ?? 0, 'publication offset');
        if (limit > 500) throw new Error('publication limit cannot exceed 500');
        return (this.database.prepare(`SELECT publication.*
            FROM cm_history_publications AS publication
            JOIN cm_history_backfill_runs AS run
              ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
             AND run.run_id=publication.run_id
            WHERE publication.tenant_id=? AND publication.user_id=? AND run.project_id=?
            ORDER BY publication.created_at, publication.publication_id LIMIT ? OFFSET ?`)
            .all(this.tenant_id, this.user_id, project, limit, offset) as row[]).map(map_publication);
    }

    list_for_worker(
        project_id: string,
        worker_context: history_worker_context,
        options: { limit?: number; offset?: number } = {},
    ): history_publication[] {
        const worker = normalize_worker(worker_context);
        const project = bounded(project_id, 'project_id');
        const active = this.require_active_worker(worker);
        if (active.project_id !== project) {
            throw new Error(`permission denied: history publications are outside project ${project}`);
        }
        const limit = integer(options.limit ?? 100, 'publication limit', 1);
        const offset = integer(options.offset ?? 0, 'publication offset');
        if (limit > 500) throw new Error('publication limit cannot exceed 500');
        const scoped = (this.database.prepare(`SELECT publication.*
            FROM cm_history_publications AS publication
            JOIN cm_history_backfill_runs AS run
              ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
             AND run.run_id=publication.run_id
            WHERE publication.tenant_id=? AND publication.user_id=? AND run.project_id=?
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
            ORDER BY publication.created_at, publication.publication_id`)
            .all(this.tenant_id, this.user_id, project,
                worker.worker_session_id, worker.worker_id) as row[])
            .map(map_publication)
            .filter((publication) => has_active_history_worker_authorization(this.database, {
                tenant_id: this.tenant_id,
                user_id: this.user_id,
                project_id: project,
                worker_session_id: worker.worker_session_id,
                worker_id: worker.worker_id,
                run_id: publication.run_id,
            }));
        return scoped.slice(offset, offset + limit);
    }

    propose_hierarchy(
        raw_input: history_hierarchy_proposal_input,
        worker_context: history_worker_context,
    ): history_hierarchy_proposal {
        const worker = normalize_worker(worker_context);
        const publication_id = bounded(raw_input.publication_id, 'publication_id');
        const level = integer(raw_input.level, 'proposed level', 1) as 1 | 2 | 3 | 4;
        if (level > 4) throw new Error('proposed level must be between 1 and 4');
        const confidence = Number(raw_input.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            throw new Error('hierarchy confidence must be between 0 and 1');
        }
        assert_no_obvious_credentials({ hierarchy_proposal: raw_input });
        const at = this.now();

        return this.write(() => {
            const { project_id: worker_project } = this.require_active_worker(worker);
            const context = this.require_context(publication_id);
            this.require_active_worker(worker, context.publication.run_id);
            if (worker_project !== context.project_id) {
                throw new Error(`history publication ${publication_id} is outside the worker project`);
            }
            if (['published', 'discarded', 'superseded', 'pending_confirmation'].includes(context.publication.status)) {
                throw new Error(`history publication ${publication_id} cannot accept hierarchy proposals in ${context.publication.status}`);
            }

            let role_mode: history_hierarchy_proposal['role_mode'] = 'none';
            let role_id: string | null = null;
            let role_semantic_key: string | null = null;
            let role_name: string | null = null;
            let role_responsibility: string | null = null;
            if (level === 1) {
                if (raw_input.role.mode !== 'none' || raw_input.task.mode !== 'none') {
                    throw new Error('level-one history hierarchy cannot include a role or task');
                }
            } else {
                if (raw_input.role.mode === 'none') throw new Error('level two through four require a role');
                role_mode = raw_input.role.mode;
                if (raw_input.role.mode === 'existing') {
                    role_id = bounded(raw_input.role.role_id, 'role_id');
                    const role = this.repository.require_role(role_id);
                    if (role.project_id !== context.project_id || role.status !== 'active') {
                        throw new Error(`central role ${role_id} is not active in project ${context.project_id}`);
                    }
                } else {
                    role_semantic_key = normalize_semantic_key(raw_input.role.semantic_key, 'role semantic_key');
                    role_name = bounded(raw_input.role.name, 'role name', 160);
                    role_responsibility = bounded(raw_input.role.responsibility, 'role responsibility', 1_200);
                    role_id = `cm-role:${hash_canonical({
                        schema: 1,
                        project_id: context.project_id,
                        semantic_key: role_semantic_key,
                    }).slice(0, 40)}`;
                }
            }

            let task_mode: history_hierarchy_proposal['task_mode'] = 'none';
            let task_id: string | null = null;
            let task_semantic_key: string | null = null;
            let task_title: string | null = null;
            let task_objective: string | null = null;
            if (level <= 2) {
                if (raw_input.task.mode !== 'none') throw new Error('level one and two cannot include a task');
            } else {
                if (raw_input.task.mode === 'none' || role_id === null) {
                    throw new Error('level three and four require a role-bound task');
                }
                task_mode = raw_input.task.mode;
                if (raw_input.task.mode === 'existing') {
                    task_id = bounded(raw_input.task.task_id, 'task_id');
                    const task = this.repository.require_task(task_id);
                    if (task.project_id !== context.project_id || task.role_id !== role_id
                        || !['active', 'completed'].includes(task.status)) {
                        throw new Error(`central task ${task_id} is not bound to the proposed project and role`);
                    }
                } else {
                    task_semantic_key = normalize_semantic_key(raw_input.task.semantic_key, 'task semantic_key');
                    task_title = bounded(raw_input.task.title, 'task title', 200);
                    task_objective = bounded(raw_input.task.objective, 'task objective', 2_000);
                    task_id = `cm-task:${hash_canonical({
                        schema: 1,
                        project_id: context.project_id,
                        role_id,
                        semantic_key: task_semantic_key,
                    }).slice(0, 40)}`;
                }
            }

            const scope_kind: history_hierarchy_proposal['scope_kind'] = level === 2
                ? 'run_role'
                : level >= 3 ? 'candidate_task' : 'candidate_full';
            const evidence = context.candidate.evidence.references;
            const proposal_body = {
                schema: 1,
                publication_id,
                run_id: context.publication.run_id,
                candidate_id: context.candidate.candidate_id,
                scope_kind,
                proposed_level: level,
                role_mode,
                role_id,
                role_semantic_key,
                role_name,
                role_responsibility,
                task_mode,
                task_id,
                task_semantic_key,
                task_title,
                task_objective,
                confidence,
                evidence,
            };
            const proposal_hash = hash_canonical(proposal_body);
            const existing = this.database.prepare(`SELECT * FROM cm_history_hierarchy_proposals
                WHERE tenant_id=? AND user_id=? AND publication_id=? AND proposal_hash=?`)
                .get(this.tenant_id, this.user_id, publication_id, proposal_hash) as row | undefined;
            if (existing) return map_proposal(existing);
            const proposal_id = `history-hierarchy:${hash_canonical([
                publication_id, proposal_hash,
            ]).slice(0, 40)}`;
            this.database.prepare(`INSERT INTO cm_history_hierarchy_proposals (
                tenant_id, user_id, proposal_id, publication_id, run_id, candidate_id,
                scope_kind, proposed_level, role_mode, role_id, role_semantic_key,
                role_name, role_responsibility, task_mode, task_id, task_semantic_key,
                task_title, task_objective, confidence, evidence_json, proposal_hash,
                worker_session_id, worker_turn_id, capability_epoch_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenant_id, this.user_id, proposal_id, publication_id,
                    context.publication.run_id, context.candidate.candidate_id, scope_kind, level,
                    role_mode, role_id, role_semantic_key, role_name, role_responsibility,
                    task_mode, task_id, task_semantic_key, task_title, task_objective,
                    confidence, canonicalize(evidence), proposal_hash, worker.worker_session_id,
                    worker.worker_turn_id, worker.capability_epoch_hash, at);

            const needs_human_hierarchy = role_mode === 'proposed' || task_mode === 'proposed';
            const desired_status = needs_human_hierarchy ? 'awaiting_hierarchy' : 'ready';
            let current_status = context.publication.status;
            if (desired_status === 'awaiting_hierarchy' && ['ready', 'retryable'].includes(current_status)) {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='needs_review', current_plan_version=NULL, result_kind=NULL,
                        result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                        updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, this.tenant_id, this.user_id, publication_id);
                current_status = 'needs_review';
            }
            if (current_status !== desired_status) {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status=?, current_plan_version=NULL, result_kind=NULL,
                        result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                        last_error_code=NULL,
                        last_error_detail=NULL, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(desired_status, at, this.tenant_id, this.user_id, publication_id);
            }
            return this.require_proposal(proposal_id);
        });
    }

    private materialize_accepted_hierarchy(
        context: publication_context,
        proposal: history_hierarchy_proposal,
        at: number,
    ): void {
        if (proposal.role_mode === 'proposed') {
            const role_id = proposal.role_id!;
            const existing = this.repository.get_role(role_id);
            if (existing) {
                if (existing.project_id !== context.project_id
                    || existing.metadata.history_semantic_key !== proposal.role_semantic_key) {
                    throw new history_publication_conflict_error(`proposed role id ${role_id} is already used by another hierarchy`);
                }
            } else {
                this.repository.register_role({
                    role_id,
                    project_id: context.project_id,
                    name: proposal.role_name!,
                    responsibility: proposal.role_responsibility!,
                    metadata: {
                        origin: 'authorized_history_hierarchy',
                        history_semantic_key: proposal.role_semantic_key!,
                        proposal_id: proposal.proposal_id,
                    },
                    at,
                });
            }
        } else if (proposal.role_mode === 'existing') {
            const role = this.repository.require_role(proposal.role_id!);
            if (role.project_id !== context.project_id) throw new Error('accepted role is outside the publication project');
        }

        if (proposal.task_mode === 'proposed') {
            const task_id = proposal.task_id!;
            const existing = this.repository.get_task(task_id);
            if (existing) {
                if (existing.project_id !== context.project_id || existing.role_id !== proposal.role_id
                    || existing.metadata.history_semantic_key !== proposal.task_semantic_key) {
                    throw new history_publication_conflict_error(`proposed task id ${task_id} is already used by another hierarchy`);
                }
            } else {
                this.repository.register_task({
                    task_id,
                    project_id: context.project_id,
                    role_id: proposal.role_id,
                    title: proposal.task_title!,
                    objective: proposal.task_objective!,
                    metadata: {
                        origin: 'authorized_history_hierarchy',
                        history_semantic_key: proposal.task_semantic_key!,
                        proposal_id: proposal.proposal_id,
                    },
                    at,
                });
            }
        } else if (proposal.task_mode === 'existing') {
            const task = this.repository.require_task(proposal.task_id!);
            if (task.project_id !== context.project_id || task.role_id !== proposal.role_id) {
                throw new Error('accepted task is outside the publication project and role');
            }
        }
    }

    decide(raw_input: history_governance_decision_input): history_governance_decision {
        const publication_id = bounded(raw_input.publication_id, 'publication_id');
        const actor_id = bounded(raw_input.actor_id, 'actor_id', 256);
        const action_id = bounded(raw_input.action_id, 'action_id', 512);
        const note = raw_input.note === undefined ? '' : String(raw_input.note).slice(0, 2_000);
        const evidence = json_object(raw_input.evidence, 'governance evidence');
        if (raw_input.actor_kind !== 'user') throw new Error('history governance decisions require a human user actor');
        if (!['codex_ui', 'obsidian', 'local_cli'].includes(raw_input.channel)) {
            throw new Error('history governance decision channel is invalid');
        }
        if (Object.keys(evidence).length === 0) throw new Error('history governance decisions require user-action evidence');
        const allowed_actions = new Set([
            'accept_hierarchy', 'reject_hierarchy', 'approve_update',
            'approve_conflict', 'discard', 'retry',
        ]);
        if (!allowed_actions.has(raw_input.action)) throw new Error('history governance action is invalid');
        const proposal_id = raw_input.proposal_id === null || raw_input.proposal_id === undefined
            ? null : bounded(raw_input.proposal_id, 'proposal_id');
        const plan_version = raw_input.plan_version === null || raw_input.plan_version === undefined
            ? null : integer(raw_input.plan_version, 'plan_version', 1);
        const payload = {
            schema: 1,
            publication_id,
            proposal_id,
            plan_version,
            action: raw_input.action,
            actor_kind: raw_input.actor_kind,
            actor_id,
            action_id,
            channel: raw_input.channel,
            evidence,
            note,
        };
        assert_no_obvious_credentials({ history_governance_decision: payload });
        const payload_hash = hash_canonical(payload);
        const at = this.now();

        return this.write(() => {
            const prior = this.database.prepare(`SELECT * FROM cm_history_governance_decisions
                WHERE tenant_id=? AND user_id=? AND action_id=?`)
                .get(this.tenant_id, this.user_id, action_id) as row | undefined;
            if (prior) {
                if (String(prior.payload_hash) !== payload_hash) {
                    throw new history_publication_conflict_error(`governance action ${action_id} was already used with different content`);
                }
                return map_decision(prior);
            }
            const context = this.require_context(publication_id);
            if (['published', 'discarded', 'superseded'].includes(context.publication.status)) {
                throw new Error(`history publication ${publication_id} is terminal`);
            }
            let proposal: history_hierarchy_proposal | null = null;
            let plan: history_publication_plan | null = null;
            if (proposal_id) {
                proposal = this.require_proposal(proposal_id);
                if (proposal.publication_id !== publication_id) throw new Error('governance proposal is outside the publication');
            }
            if (plan_version !== null) plan = this.require_plan(publication_id, plan_version);

            if (raw_input.action === 'accept_hierarchy' || raw_input.action === 'reject_hierarchy') {
                if (!proposal || plan_version !== null) throw new Error('hierarchy decisions require only a scoped proposal');
                if (!['awaiting_hierarchy', 'needs_review', 'ready'].includes(context.publication.status)) {
                    throw new Error(`hierarchy cannot be decided in ${context.publication.status}`);
                }
            } else if (raw_input.action === 'approve_update' || raw_input.action === 'approve_conflict') {
                if (!plan || proposal_id !== null || context.publication.current_plan_version !== plan.plan_version) {
                    throw new Error('content decisions require the current scoped publication plan');
                }
                if (context.publication.status !== 'needs_review') {
                    throw new Error(`content cannot be approved in ${context.publication.status}`);
                }
                const expected_relation = raw_input.action === 'approve_update' ? 'update' : 'conflict';
                if (plan.relation !== expected_relation) throw new Error(`${raw_input.action} does not match plan relation ${plan.relation}`);
            } else if (proposal_id !== null || plan_version !== null) {
                throw new Error(`${raw_input.action} does not accept proposal or plan selectors`);
            }
            if (raw_input.action === 'retry' && context.publication.status !== 'retryable') {
                throw new Error(`history publication can retry only from retryable, not ${context.publication.status}`);
            }

            const decision_id = `history-decision:${hash_canonical([action_id, payload_hash]).slice(0, 40)}`;
            this.database.prepare(`INSERT INTO cm_history_governance_decisions (
                tenant_id, user_id, decision_id, publication_id, proposal_id, plan_version,
                action, actor_kind, actor_id, action_id, channel, evidence_json, note,
                payload_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenant_id, this.user_id, decision_id, publication_id, proposal_id,
                    plan_version, raw_input.action, actor_id, action_id, raw_input.channel,
                    canonicalize(evidence), note, payload_hash, at);

            if (raw_input.action === 'accept_hierarchy') {
                const other = this.database.prepare(`SELECT proposal_id FROM cm_history_governance_decisions
                    WHERE tenant_id=? AND user_id=? AND publication_id=?
                      AND action='accept_hierarchy' AND decision_id<>? LIMIT 1`)
                    .get(this.tenant_id, this.user_id, publication_id, decision_id) as { proposal_id: string } | undefined;
                if (other && other.proposal_id !== proposal!.proposal_id) {
                    throw new history_publication_conflict_error('another hierarchy proposal was already accepted');
                }
                this.materialize_accepted_hierarchy(context, proposal!, at);
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='ready', current_plan_version=NULL, result_kind=NULL,
                        result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                        last_error_code=NULL,
                        last_error_detail=NULL, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, this.tenant_id, this.user_id, publication_id);
            } else if (raw_input.action === 'reject_hierarchy') {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='needs_review', current_plan_version=NULL, result_kind=NULL,
                        result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                        last_error_code='HIERARCHY_REJECTED', last_error_detail=?, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(note, at, this.tenant_id, this.user_id, publication_id);
            } else if (raw_input.action === 'approve_update' || raw_input.action === 'approve_conflict'
                || raw_input.action === 'retry') {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='ready', result_kind=NULL, result_memory_id=NULL,
                        result_version=NULL, result_confirmation_id=NULL,
                        last_error_code=NULL, last_error_detail=NULL,
                        available_at=?, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, at, this.tenant_id, this.user_id, publication_id);
            } else if (raw_input.action === 'discard') {
                if (context.publication.status === 'pending_confirmation') {
                    if (!context.publication.result_confirmation_id) throw new Error('pending publication has no central confirmation');
                    this.central.reject(context.publication.result_confirmation_id, {
                        actor_id,
                        actor_kind: 'user',
                        action_id: `history-discard:${action_id}`,
                        channel: raw_input.channel,
                        note,
                        evidence,
                    }, at);
                }
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='discarded', result_kind=NULL, result_memory_id=NULL,
                        result_version=NULL, result_confirmation_id=NULL,
                        terminal_at=?, last_error_code='USER_DISCARDED',
                        last_error_detail=?, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, note, at, this.tenant_id, this.user_id, publication_id);
            }
            return map_decision(this.database.prepare(`SELECT * FROM cm_history_governance_decisions
                WHERE tenant_id=? AND user_id=? AND decision_id=?`)
                .get(this.tenant_id, this.user_id, decision_id) as row);
        });
    }

    create_plan(
        raw_input: history_publication_plan_input,
        worker_context: history_worker_context,
    ): history_publication_plan {
        const worker = normalize_worker(worker_context);
        const publication_id = bounded(raw_input.publication_id, 'publication_id');
        const proposal_id = bounded(raw_input.proposal_id, 'proposal_id');
        const memory_kind = bounded(raw_input.memory_kind, 'memory_kind', 128);
        const semantic_key_normalized = normalize_semantic_key(raw_input.semantic_key, 'semantic_key');
        assert_no_obvious_credentials({ memory_kind, semantic_key_normalized });
        const at = this.now();

        return this.write(() => {
            const { project_id: worker_project } = this.require_active_worker(worker);
            const context = this.require_context(publication_id);
            this.require_active_worker(worker, context.publication.run_id);
            if (worker_project !== context.project_id) {
                throw new Error(`history publication ${publication_id} is outside the worker project`);
            }
            if (!['ready', 'retryable', 'needs_review'].includes(context.publication.status)) {
                throw new Error(`history publication ${publication_id} cannot be planned in ${context.publication.status}`);
            }
            const proposal = this.require_proposal(proposal_id);
            if (proposal.publication_id !== publication_id
                || proposal.run_id !== context.publication.run_id
                || proposal.candidate_id !== context.candidate.candidate_id) {
                throw new Error('history hierarchy proposal is outside the candidate publication scope');
            }

            const accepted = this.database.prepare(`SELECT * FROM cm_history_governance_decisions
                WHERE tenant_id=? AND user_id=? AND publication_id=? AND proposal_id=?
                  AND action='accept_hierarchy'
                ORDER BY created_at DESC, decision_id DESC LIMIT 1`)
                .get(this.tenant_id, this.user_id, publication_id, proposal_id) as row | undefined;
            const needs_hierarchy_acceptance = proposal.role_mode === 'proposed' || proposal.task_mode === 'proposed';
            if (needs_hierarchy_acceptance && !accepted) {
                throw new Error('proposed history roles and tasks require a human hierarchy decision');
            }
            if (accepted) this.materialize_accepted_hierarchy(context, proposal, at);

            if (proposal.proposed_level === 1) {
                if (proposal.role_id !== null || proposal.task_id !== null) throw new Error('invalid level-one hierarchy proposal');
            } else {
                const role = this.repository.require_role(proposal.role_id!);
                if (role.project_id !== context.project_id || role.status !== 'active') {
                    throw new Error('history hierarchy role is no longer active in the publication project');
                }
                if (proposal.proposed_level >= 3) {
                    const task = this.repository.require_task(proposal.task_id!);
                    if (task.project_id !== context.project_id || task.role_id !== proposal.role_id) {
                        throw new Error('history hierarchy task is no longer bound to the publication role');
                    }
                } else if (proposal.task_id !== null) {
                    throw new Error('invalid level-two hierarchy proposal');
                }
            }

            const identity = {
                schema: 1,
                project_id: context.project_id,
                level: proposal.proposed_level,
                role_id: proposal.role_id,
                task_id: proposal.task_id,
                memory_kind,
                semantic_key: semantic_key_normalized,
            };
            const semantic_identity_hash = hash_canonical(identity);
            const target_memory_id = `cm-semantic:${semantic_identity_hash.slice(0, 40)}`;
            const semantic_row = this.database.prepare(`SELECT * FROM cm_semantic_memory_keys
                WHERE tenant_id=? AND user_id=? AND semantic_identity_hash=?`)
                .get(this.tenant_id, this.user_id, semantic_identity_hash) as row | undefined;
            if (semantic_row) {
                const scope_matches = String(semantic_row.project_id) === context.project_id
                    && Number(semantic_row.level) === proposal.proposed_level
                    && string_or_null(semantic_row.role_id) === proposal.role_id
                    && string_or_null(semantic_row.task_id) === proposal.task_id
                    && String(semantic_row.memory_kind) === memory_kind
                    && String(semantic_row.semantic_key_normalized) === semantic_key_normalized
                    && String(semantic_row.memory_id) === target_memory_id;
                if (!scope_matches) throw new Error('semantic memory key identity is corrupt or collided');
            }

            const memory = this.repository.get_memory(target_memory_id);
            if (memory && (memory.project_id !== context.project_id
                || memory.level !== proposal.proposed_level
                || memory.role_id !== proposal.role_id
                || memory.task_id !== proposal.task_id
                || memory.memory_kind !== memory_kind)) {
                throw new history_publication_conflict_error(`stable memory id ${target_memory_id} belongs to another hierarchy`);
            }
            if (semantic_row && !memory) throw new Error('semantic memory key references a missing central memory');
            const current = memory?.current_version === null || memory === null
                ? null
                : this.repository.require_version(target_memory_id, memory.current_version);
            const has_activated_major = memory
                ? Boolean(this.database.prepare(`SELECT 1 FROM cm_memory_versions
                    WHERE tenant_id=? AND user_id=? AND memory_id=?
                      AND is_major=1 AND activated_at IS NOT NULL LIMIT 1`)
                    .get(this.tenant_id, this.user_id, target_memory_id))
                : false;
            const is_major = context.candidate.is_major || proposal.proposed_level === 1
                || Boolean(current?.is_major) || has_activated_major;
            const publication_content_hash = version_content_hash({
                title: context.candidate.title,
                summary: context.candidate.summary,
                body: context.candidate.body,
                importance: context.candidate.importance,
                is_major,
                semantic_identity_hash,
            });

            let relation: history_publication_plan['relation'];
            if (!memory) relation = 'new';
            else if (current && current.content_hash === publication_content_hash
                && ['active', 'locked'].includes(current.status)) relation = 'noop';
            else if (current?.status === 'locked' || Boolean(current?.is_major)
                || context.candidate.is_major || proposal.proposed_level === 1) relation = 'conflict';
            else relation = 'update';
            const conflicts = relation === 'update' || relation === 'conflict'
                ? [{
                    kind: relation === 'conflict' ? 'governed_content_conflict' : 'content_changed',
                    memory_id: target_memory_id,
                    expected_version: memory?.current_version ?? null,
                    expected_status: current?.status ?? null,
                    expected_content_hash: current?.content_hash ?? null,
                }]
                : [];
            const plan_body = {
                publication_id,
                proposal_id,
                hierarchy_decision_id: accepted ? String(accepted.decision_id) : null,
                ...identity,
                semantic_key_normalized,
                semantic_identity_hash,
                target_memory_id,
                expected_memory_exists: Boolean(memory),
                expected_current_version: memory?.current_version ?? null,
                expected_current_status: current?.status ?? null,
                expected_current_content_hash: current?.content_hash ?? null,
                relation,
                conflicts,
                candidate_finding_hash: context.candidate.finding_hash,
                publication_content_hash,
                is_major,
            };
            const plan_hash = hash_canonical(plan_body);
            const existing = this.database.prepare(`SELECT * FROM cm_history_publication_plans
                WHERE tenant_id=? AND user_id=? AND publication_id=? AND plan_hash=?`)
                .get(this.tenant_id, this.user_id, publication_id, plan_hash) as row | undefined;
            const desired_status = relation === 'new' || relation === 'noop' ? 'ready' : 'needs_review';
            if (existing) {
                const plan = map_plan(existing);
                this.database.prepare(`UPDATE cm_history_publications
                    SET status=?, current_plan_version=?, result_kind=NULL,
                        result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                        last_error_code=?, last_error_detail=?, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(desired_status, plan.plan_version,
                        desired_status === 'needs_review' ? 'CONTENT_REVIEW_REQUIRED' : null,
                        desired_status === 'needs_review' ? `candidate is a ${relation} of current memory` : null,
                        at, this.tenant_id, this.user_id, publication_id);
                return plan;
            }

            const next = this.database.prepare(`SELECT COALESCE(MAX(plan_version), 0) + 1 AS version
                FROM cm_history_publication_plans
                WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .get(this.tenant_id, this.user_id, publication_id) as { version: number };
            const plan_version = Number(next.version);
            this.database.prepare(`INSERT INTO cm_history_publication_plans (
                tenant_id, user_id, publication_id, plan_version, project_id, proposal_id,
                hierarchy_decision_id, level, role_id, task_id, memory_kind,
                semantic_key_normalized, semantic_identity_hash, target_memory_id,
                expected_memory_exists, expected_current_version, expected_current_status,
                expected_current_content_hash, relation, conflicts_json, candidate_finding_hash,
                publication_content_hash, is_major, plan_hash, created_by_session_id,
                created_by_turn_id, capability_epoch_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenant_id, this.user_id, publication_id, plan_version,
                    context.project_id, proposal_id, accepted ? String(accepted.decision_id) : null,
                    proposal.proposed_level, proposal.role_id, proposal.task_id, memory_kind,
                    semantic_key_normalized, semantic_identity_hash, target_memory_id,
                    Number(Boolean(memory)), memory?.current_version ?? null, current?.status ?? null,
                    current?.content_hash ?? null, relation, canonicalize(conflicts),
                    context.candidate.finding_hash, publication_content_hash, Number(is_major),
                    plan_hash, worker.worker_session_id, worker.worker_turn_id,
                    worker.capability_epoch_hash, at);
            this.database.prepare(`UPDATE cm_history_publications
                SET status=?, current_plan_version=?, result_kind=NULL,
                    result_memory_id=NULL, result_version=NULL, result_confirmation_id=NULL,
                    last_error_code=?, last_error_detail=?, updated_at=?
                WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .run(desired_status, plan_version,
                    desired_status === 'needs_review' ? 'CONTENT_REVIEW_REQUIRED' : null,
                    desired_status === 'needs_review' ? `candidate is a ${relation} of current memory` : null,
                    at, this.tenant_id, this.user_id, publication_id);
            return this.require_plan(publication_id, plan_version);
        });
    }

    private source_links(context: publication_context): Array<{
        source: {
            source_id: string;
            source_kind: string;
            uri: string;
            thread_id: string;
            turn_id: string;
            locator: central_metadata;
            excerpt_hash: string;
            metadata: central_metadata;
            recorded_at: number;
        };
        evidence_role: string;
        locator: central_metadata;
    }> {
        const evidence = context.candidate.evidence;
        if (evidence.source_harness !== context.source_harness
            || evidence.source_session_id !== context.source_session_id
            || evidence.source_revision !== context.source_revision) {
            throw new Error('history candidate source locator does not match its immutable run');
        }
        const chunks = new Map<number, { parts: Array<{
            turn_index: number;
            part_index: number;
            text: string;
        }> }>();
        return evidence.references.map((reference) => {
            let payload = chunks.get(reference.chunk_index);
            if (!payload) {
                const chunk = this.database.prepare(`SELECT payload_json FROM cm_history_backfill_chunks
                    WHERE tenant_id=? AND user_id=? AND run_id=? AND chunk_index=?`)
                    .get(this.tenant_id, this.user_id, context.publication.run_id,
                        reference.chunk_index) as { payload_json: string } | undefined;
                if (!chunk) throw new Error('history evidence references a missing immutable chunk');
                const parsed = JSON.parse(String(chunk.payload_json)) as {
                    parts: Array<{ turn_index: number; part_index: number; text: string }>;
                };
                chunks.set(reference.chunk_index, parsed);
                payload = parsed;
            }
            const part = payload.parts.find((item) => item.turn_index === reference.turn_index
                && item.part_index === reference.part_index);
            if (!part) throw new Error('history evidence references a missing immutable source part');
            if (reference.quote !== undefined && !part.text.includes(reference.quote)) {
                throw new Error('history evidence quote is not present in its immutable source part');
            }
            const source_identity = {
                schema: 1,
                source_harness: context.source_harness,
                source_session_id: context.source_session_id,
                source_revision: context.source_revision,
                chunk_index: reference.chunk_index,
                turn_index: reference.turn_index,
                part_index: reference.part_index,
            };
            const source_id = `history-source:${hash_canonical(source_identity).slice(0, 40)}`;
            const locator = {
                run_id: context.publication.run_id,
                source_revision: context.source_revision,
                chunk_index: reference.chunk_index,
                turn_index: reference.turn_index,
                part_index: reference.part_index,
                ...(reference.quote === undefined ? {} : { quote_hash: sha256_hex(reference.quote) }),
            };
            return {
                source: {
                    source_id,
                    source_kind: `${context.source_harness}_history`,
                    uri: context.source_harness === 'codex'
                        ? `codex://threads/${context.source_session_id}`
                        : `history://${context.source_harness}/${encodeURIComponent(context.source_session_id)}`,
                    thread_id: context.source_session_id,
                    turn_id: String(reference.turn_index),
                    locator,
                    excerpt_hash: sha256_hex(reference.quote ?? part.text),
                    metadata: {
                        source_revision: context.source_revision,
                        authorized_backfill_run_id: context.publication.run_id,
                    },
                    recorded_at: context.candidate.created_at,
                },
                evidence_role: 'support',
                locator,
            };
        });
    }

    private insert_attempt(input: {
        attempt_id: string;
        publication_id: string;
        plan_version: number;
        worker: history_worker_context;
        request_hash: string;
        outcome: history_publication_attempt['outcome'];
        result_memory_id?: string | null;
        result_version?: number | null;
        result_confirmation_id?: string | null;
        error_code?: string | null;
        error_detail?: string | null;
        at: number;
    }): history_publication_attempt {
        this.database.prepare(`INSERT INTO cm_history_publication_attempts (
            tenant_id, user_id, attempt_id, publication_id, plan_version,
            worker_session_id, worker_turn_id, capability_epoch_hash, request_hash,
            outcome, result_memory_id, result_version, result_confirmation_id,
            error_code, error_detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenant_id, this.user_id, input.attempt_id, input.publication_id,
                input.plan_version, input.worker.worker_session_id, input.worker.worker_turn_id,
                input.worker.capability_epoch_hash, input.request_hash, input.outcome,
                input.result_memory_id ?? null, input.result_version ?? null,
                input.result_confirmation_id ?? null, input.error_code ?? null,
                input.error_detail ?? null, input.at);
        return this.attempt(input.attempt_id)!;
    }

    private record_failed_attempt(input: {
        publication: history_publication;
        plan: history_publication_plan;
        worker: history_worker_context;
        attempt_id: string;
        request_hash: string;
        outcome: 'needs_review' | 'retryable';
        code: string;
        detail: string;
        at: number;
    }): history_publication_execute_result {
        const attempt = this.insert_attempt({
            attempt_id: input.attempt_id,
            publication_id: input.publication.publication_id,
            plan_version: input.plan.plan_version,
            worker: input.worker,
            request_hash: input.request_hash,
            outcome: input.outcome,
            error_code: input.code,
            error_detail: input.detail,
            at: input.at,
        });
        this.database.prepare(`UPDATE cm_history_publications
            SET status=?, result_kind=NULL, result_memory_id=NULL, result_version=NULL,
                result_confirmation_id=NULL, attempt_count=attempt_count+1, last_attempt_id=?,
                last_error_code=?, last_error_detail=?, available_at=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND publication_id=?`)
            .run(input.outcome, input.attempt_id, input.code, input.detail,
                input.at, input.at, this.tenant_id, this.user_id,
                input.publication.publication_id);
        return { publication: this.require_publication(input.publication.publication_id), attempt };
    }

    private cas_mismatch(plan: history_publication_plan): string | null {
        const semantic = this.database.prepare(`SELECT memory_id FROM cm_semantic_memory_keys
            WHERE tenant_id=? AND user_id=? AND semantic_identity_hash=?`)
            .get(this.tenant_id, this.user_id, plan.semantic_identity_hash) as { memory_id: string } | undefined;
        if (semantic && semantic.memory_id !== plan.target_memory_id) return 'semantic identity now resolves to another memory';
        const memory = this.repository.get_memory(plan.target_memory_id);
        if (!plan.expected_memory_exists) {
            if (semantic || memory) return 'planned new semantic memory now exists';
            return null;
        }
        if (!memory) return 'planned target memory no longer exists';
        if (memory.current_version !== plan.expected_current_version) {
            return `target current version changed from ${String(plan.expected_current_version)} to ${String(memory.current_version)}`;
        }
        if (memory.current_version === null) {
            if (plan.expected_current_status !== null || plan.expected_current_content_hash !== null) {
                return 'target tombstone state differs from the publication plan';
            }
            return null;
        }
        const current = this.repository.require_version(memory.memory_id, memory.current_version);
        if (current.status !== plan.expected_current_status
            || current.content_hash !== plan.expected_current_content_hash) {
            return 'target current status or content changed after planning';
        }
        return null;
    }

    execute(
        raw_input: history_publication_execute_input,
        worker_context: history_worker_context,
    ): history_publication_execute_result {
        const worker = normalize_worker(worker_context);
        const publication_id = bounded(raw_input.publication_id, 'publication_id');
        const plan_version = integer(raw_input.plan_version, 'plan_version', 1);
        const attempt_id = bounded(raw_input.attempt_id, 'attempt_id', 512);
        const request_hash = hash_canonical({
            schema: 1,
            publication_id,
            plan_version,
            attempt_id,
            worker,
        });
        const at = this.now();

        return this.write(() => {
            const { project_id: worker_project } = this.require_active_worker(worker);
            const prior = this.attempt(attempt_id);
            if (prior) {
                this.require_active_worker(worker, this.require_publication(prior.publication_id).run_id);
                if (prior.request_hash !== request_hash) {
                    throw new history_publication_conflict_error(`publication attempt ${attempt_id} was replayed with different content`);
                }
                return { publication: this.require_publication(prior.publication_id), attempt: prior };
            }
            const context = this.require_context(publication_id);
            this.require_active_worker(worker, context.publication.run_id);
            const publication = context.publication;
            if (worker_project !== context.project_id) {
                throw new Error(`history publication ${publication_id} is outside the worker project`);
            }
            if (!['ready', 'retryable'].includes(publication.status)) {
                throw new Error(`history publication ${publication_id} cannot execute in ${publication.status}`);
            }
            if (publication.current_plan_version !== plan_version) {
                throw new history_publication_conflict_error('publication attempt does not target the current plan');
            }
            const plan = this.require_plan(publication_id, plan_version);
            if (plan.project_id !== context.project_id
                || plan.candidate_finding_hash !== context.candidate.finding_hash) {
                throw new Error('publication plan no longer matches its immutable candidate scope');
            }
            if (plan.relation === 'update' || plan.relation === 'conflict') {
                const action = plan.relation === 'update' ? 'approve_update' : 'approve_conflict';
                const approved = this.database.prepare(`SELECT 1 FROM cm_history_governance_decisions
                    WHERE tenant_id=? AND user_id=? AND publication_id=? AND plan_version=?
                      AND action=? LIMIT 1`)
                    .get(this.tenant_id, this.user_id, publication_id, plan_version, action);
                if (!approved) throw new Error(`${plan.relation} publication requires an explicit human decision`);
            }
            const mismatch = this.cas_mismatch(plan);
            if (mismatch) {
                return this.record_failed_attempt({
                    publication,
                    plan,
                    worker,
                    attempt_id,
                    request_hash,
                    outcome: 'needs_review',
                    code: 'PUBLICATION_CAS_MISMATCH',
                    detail: mismatch,
                    at,
                });
            }

            try {
                const savepoint = this.database.transaction(() => {
                    const result = this.central.publish({
                        memory_id: plan.target_memory_id,
                        project_id: plan.project_id,
                        role_id: plan.role_id,
                        task_id: plan.task_id,
                        level: plan.level,
                        memory_kind: plan.memory_kind,
                        title: context.candidate.title,
                        summary: context.candidate.summary,
                        body: context.candidate.body,
                        importance: context.candidate.importance,
                        major: plan.is_major,
                        require_confirmation: plan.relation === 'conflict',
                        ...(plan.relation === 'conflict' ? { confirmation_kind: 'conflict' as const } : {}),
                        change_reason: 'authorized historical backfill',
                        metadata: stable_metadata(plan.semantic_identity_hash),
                        created_by: `history-publication:${worker.worker_session_id}`,
                        expected_current_version: plan.expected_current_version,
                        confirmation_prompt: plan.relation === 'conflict'
                            ? `历史候选与当前记忆“${context.candidate.title}”冲突，是否确认发布精确版本？`
                            : `是否确认将历史候选“${context.candidate.title}”写入中央记忆？`,
                        sources: this.source_links(context),
                        at,
                    });
                    if (result.version.content_hash !== plan.publication_content_hash) {
                        throw new Error('authoritative central-memory content hash differs from the immutable publication plan');
                    }
                    const semantic = this.database.prepare(`SELECT memory_id FROM cm_semantic_memory_keys
                        WHERE tenant_id=? AND user_id=? AND semantic_identity_hash=?`)
                        .get(this.tenant_id, this.user_id, plan.semantic_identity_hash) as { memory_id: string } | undefined;
                    if (semantic && semantic.memory_id !== result.memory.memory_id) {
                        throw new history_publication_conflict_error('semantic identity was concurrently assigned to another memory');
                    }
                    if (!semantic) {
                        this.database.prepare(`INSERT INTO cm_semantic_memory_keys (
                            tenant_id, user_id, project_id, semantic_identity_hash, level,
                            role_id, task_id, memory_kind, semantic_key_normalized,
                            memory_id, is_canonical, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
                            .run(this.tenant_id, this.user_id, plan.project_id,
                                plan.semantic_identity_hash, plan.level, plan.role_id,
                                plan.task_id, plan.memory_kind, plan.semantic_key_normalized,
                                result.memory.memory_id, at);
                    }
                    if (!result.effective) {
                        if (!result.confirmation) throw new Error('non-effective central publication has no confirmation');
                        const attempt = this.insert_attempt({
                            attempt_id,
                            publication_id,
                            plan_version,
                            worker,
                            request_hash,
                            outcome: 'pending_confirmation',
                            result_memory_id: result.memory.memory_id,
                            result_version: result.version.version,
                            result_confirmation_id: result.confirmation.confirmation_id,
                            at,
                        });
                        this.database.prepare(`UPDATE cm_history_publications
                            SET status='pending_confirmation', result_kind=NULL, result_memory_id=?,
                                result_version=?, result_confirmation_id=?, attempt_count=attempt_count+1,
                                last_attempt_id=?, last_error_code=NULL, last_error_detail=NULL, updated_at=?
                            WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                            .run(result.memory.memory_id, result.version.version,
                                result.confirmation.confirmation_id, attempt_id, at,
                                this.tenant_id, this.user_id, publication_id);
                        return { publication: this.require_publication(publication_id), attempt };
                    }

                    const result_kind: history_publication_result_kind = plan.relation === 'noop'
                        ? 'noop' : plan.expected_memory_exists ? 'updated' : 'created';
                    const attempt = this.insert_attempt({
                        attempt_id,
                        publication_id,
                        plan_version,
                        worker,
                        request_hash,
                        outcome: result_kind,
                        result_memory_id: result.memory.memory_id,
                        result_version: result.version.version,
                        at,
                    });
                    this.database.prepare(`UPDATE cm_history_publications
                        SET status='published', result_kind=?, result_memory_id=?, result_version=?,
                            result_confirmation_id=NULL, attempt_count=attempt_count+1,
                            last_attempt_id=?, last_error_code=NULL, last_error_detail=NULL,
                            terminal_at=?, updated_at=?
                        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                        .run(result_kind, result.memory.memory_id, result.version.version,
                            attempt_id, at, at, this.tenant_id, this.user_id, publication_id);
                    return { publication: this.require_publication(publication_id), attempt };
                });
                return savepoint();
            } catch (error) {
                const needs_review = error instanceof central_memory_conflict_error
                    || error instanceof history_publication_conflict_error;
                const code = typeof error === 'object' && error !== null && 'code' in error
                    ? String(error.code) : needs_review ? 'PUBLICATION_CONFLICT' : 'PUBLICATION_RETRYABLE';
                return this.record_failed_attempt({
                    publication,
                    plan,
                    worker,
                    attempt_id,
                    request_hash,
                    outcome: needs_review ? 'needs_review' : 'retryable',
                    code,
                    detail: error_detail(error),
                    at,
                });
            }
        });
    }

    reconcile_confirmation(
        publication_id_value: string,
        worker_context?: history_worker_context,
    ): history_publication {
        const publication_id = bounded(publication_id_value, 'publication_id');
        const worker = worker_context === undefined ? null : normalize_worker(worker_context);
        const at = this.now();
        return this.write(() => {
            const publication = this.require_publication(publication_id);
            if (worker) this.require_active_worker(worker, publication.run_id);
            if (publication.status !== 'pending_confirmation') return publication;
            if (!publication.result_confirmation_id || !publication.result_memory_id
                || publication.result_version === null || publication.current_plan_version === null) {
                throw new Error('pending history publication has incomplete confirmation state');
            }
            const confirmation = this.repository.require_confirmation(publication.result_confirmation_id);
            if (confirmation.status === 'pending') return publication;
            if (confirmation.status === 'rejected') {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='discarded', result_kind=NULL, result_memory_id=NULL,
                        result_version=NULL, result_confirmation_id=NULL,
                        last_error_code='CENTRAL_CONFIRMATION_REJECTED',
                        last_error_detail='central confirmation was rejected',
                        terminal_at=?, updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, at, this.tenant_id, this.user_id, publication_id);
                return this.require_publication(publication_id);
            }
            if (confirmation.status === 'cancelled') {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='needs_review', result_kind=NULL, result_memory_id=NULL,
                        result_version=NULL, result_confirmation_id=NULL,
                        last_error_code='CENTRAL_CONFIRMATION_CANCELLED',
                        last_error_detail='central confirmation was cancelled by a newer state', updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, this.tenant_id, this.user_id, publication_id);
                return this.require_publication(publication_id);
            }
            const memory = this.repository.require_memory(publication.result_memory_id);
            if (memory.current_version !== publication.result_version) {
                this.database.prepare(`UPDATE cm_history_publications
                    SET status='needs_review', result_kind=NULL, result_memory_id=NULL,
                        result_version=NULL, result_confirmation_id=NULL,
                        last_error_code='CONFIRMED_VERSION_NOT_CURRENT',
                        last_error_detail='confirmed history version is no longer current', updated_at=?
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .run(at, this.tenant_id, this.user_id, publication_id);
                return this.require_publication(publication_id);
            }
            const plan = this.require_plan(publication_id, publication.current_plan_version);
            const result_kind: history_publication_result_kind = plan.relation === 'noop'
                ? 'noop' : plan.expected_memory_exists ? 'updated' : 'created';
            this.database.prepare(`UPDATE cm_history_publications
                SET status='published', result_kind=?, terminal_at=?, updated_at=?,
                    last_error_code=NULL, last_error_detail=NULL
                WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .run(result_kind, at, at, this.tenant_id, this.user_id, publication_id);
            return this.require_publication(publication_id);
        });
    }
}
