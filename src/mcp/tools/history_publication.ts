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
 *  file  : src/mcp/tools/history_publication.ts
 *  usage : implements the LongMemory history publication component
 */

import { createHash } from 'node:crypto';
import type { McpServer as mcp_server_sdk } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HistoryPublicationService } from '../../core/central_memory/history_publication_service.js';
import type {
    history_governance_action,
    history_hierarchy_proposal,
    history_hierarchy_role_input,
    history_hierarchy_task_input,
    history_publication,
    history_publication_attempt,
    history_publication_plan,
} from '../../core/central_memory/history_publication_types.js';
import type { history_worker_context } from '../../core/central_memory/history_backfill_types.js';
import {
    codex_history_worker_id,
    has_active_history_worker_authorization,
} from '../../core/central_memory/history_worker_authorization.js';
import { count_tokens } from '../../core/recall/context_builder.js';
import { CodexHookRegistry } from '../../integrations/codex_hooks/registry.js';
import type { codex_hook_session_state } from '../../integrations/codex_hooks/types.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import type { mcp_runtime } from '../runtime.js';
import {
    history_governance_schema,
    history_publication_schema,
} from '../schemas/history_publication_schema.js';
import { assert_write_allowed } from '../security/permissions.js';
import { run_audited_tool } from './common.js';

const history_output_token_budget = 1_800;
const default_list_limit = 10;
const maximum_governance_evidence_bytes = 16_384;

type publication_action =
    | 'get'
    | 'list'
    | 'propose_hierarchy'
    | 'create_plan'
    | 'execute'
    | 'reconcile_confirmation';

type publication_tool_input = {
    action: publication_action;
    session_id: string;
    capability: string;
    turn_id: string;
    publication_id?: string;
    limit?: number;
    offset?: number;
    level?: 1 | 2 | 3 | 4;
    role?: history_hierarchy_role_input;
    task?: history_hierarchy_task_input;
    confidence?: number;
    proposal_id?: string;
    memory_kind?: string;
    semantic_key?: string;
    plan_version?: number;
    attempt_id?: string;
};

type governance_tool_input = {
    action: history_governance_action;
    publication_id: string;
    proposal_id?: string | null;
    plan_version?: number | null;
    action_id: string;
    channel: 'codex_ui' | 'obsidian' | 'local_cli';
    evidence: Record<string, unknown>;
    note?: string;
};

type project_row = { project_id: string };

function plugin_data(runtime: mcp_runtime): string {
    const value = runtime.env.PLUGIN_DATA?.trim()
        || runtime.env.CLAUDE_PLUGIN_DATA?.trim()
        || runtime.env.LONGMEMORY_PLUGIN_DATA?.trim();
    if (!value) throw new Error('permission denied: history publication gateway requires PLUGIN_DATA');
    return value;
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function worker_from_state(state: codex_hook_session_state): history_worker_context {
    if (!state.capability_turn_id) throw new Error('permission denied: history publication requires an active Codex turn');
    return {
        worker_id: codex_history_worker_id(state.tenant_id, state.user_id, state.session_id),
        worker_session_id: state.session_id,
        worker_turn_id: state.capability_turn_id,
        capability_epoch_hash: sha256(`codex-history-capability\0${state.capability}`),
    };
}

function same_worker(left: history_worker_context, right: history_worker_context): boolean {
    return left.worker_id === right.worker_id
        && left.worker_session_id === right.worker_session_id
        && left.worker_turn_id === right.worker_turn_id
        && left.capability_epoch_hash === right.capability_epoch_hash;
}

function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`${name} is required for this history publication action`);
    return value;
}

function bounded_output<T>(value: T): T {
    const tokens = count_tokens(JSON.stringify(value));
    if (tokens > history_output_token_budget) {
        throw new Error(`history publication output exceeds the ${history_output_token_budget}-token transport budget`);
    }
    return value;
}

function publication_dto(publication: history_publication) {
    return {
        publication_id: publication.publication_id,
        run_id: publication.run_id,
        candidate_id: publication.candidate_id,
        status: publication.status,
        current_plan_version: publication.current_plan_version,
        result_kind: publication.result_kind,
        result_memory_id: publication.result_memory_id,
        result_version: publication.result_version,
        result_confirmation_id: publication.result_confirmation_id,
        attempt_count: publication.attempt_count,
        last_attempt_id: publication.last_attempt_id,
        last_error_code: publication.last_error_code,
        available_at: publication.available_at,
        updated_at: publication.updated_at,
        terminal_at: publication.terminal_at,
    };
}

function publication_summary_dto(publication: history_publication) {
    return {
        publication_id: publication.publication_id,
        run_id: publication.run_id,
        candidate_id: publication.candidate_id,
        status: publication.status,
        current_plan_version: publication.current_plan_version,
        result_kind: publication.result_kind,
        attempt_count: publication.attempt_count,
        last_error_code: publication.last_error_code,
        updated_at: publication.updated_at,
    };
}

function proposal_dto(proposal: history_hierarchy_proposal) {
    return {
        proposal_id: proposal.proposal_id,
        publication_id: proposal.publication_id,
        scope_kind: proposal.scope_kind,
        proposed_level: proposal.proposed_level,
        role: {
            mode: proposal.role_mode,
            role_id: proposal.role_id,
            semantic_key: proposal.role_semantic_key?.slice(0, 256) ?? null,
        },
        task: {
            mode: proposal.task_mode,
            task_id: proposal.task_id,
            semantic_key: proposal.task_semantic_key?.slice(0, 256) ?? null,
        },
        confidence: proposal.confidence,
        proposal_hash: proposal.proposal_hash,
        created_at: proposal.created_at,
    };
}

function plan_dto(plan: history_publication_plan) {
    return {
        publication_id: plan.publication_id,
        plan_version: plan.plan_version,
        proposal_id: plan.proposal_id,
        level: plan.level,
        role_id: plan.role_id,
        task_id: plan.task_id,
        memory_kind: plan.memory_kind.slice(0, 256),
        semantic_key: plan.semantic_key_normalized.slice(0, 256),
        target_memory_id: plan.target_memory_id,
        expected_current_version: plan.expected_current_version,
        relation: plan.relation,
        conflict_count: plan.conflicts.length,
        is_major: plan.is_major,
        plan_hash: plan.plan_hash,
        created_at: plan.created_at,
    };
}

function attempt_dto(attempt: history_publication_attempt) {
    return {
        attempt_id: attempt.attempt_id,
        publication_id: attempt.publication_id,
        plan_version: attempt.plan_version,
        outcome: attempt.outcome,
        result_memory_id: attempt.result_memory_id,
        result_version: attempt.result_version,
        result_confirmation_id: attempt.result_confirmation_id,
        error_code: attempt.error_code,
        error_detail: attempt.error_detail?.slice(0, 500) ?? null,
        created_at: attempt.created_at,
    };
}

function require_publication_project(
    service: HistoryPublicationService,
    publication_id: string,
    expected_project_id: string,
): void {
    const row = service.database.prepare(`SELECT run.project_id
        FROM cm_history_publications AS publication
        JOIN cm_history_backfill_runs AS run
          ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
         AND run.run_id=publication.run_id
        WHERE publication.tenant_id=? AND publication.user_id=? AND publication.publication_id=?`)
        .get(service.tenant_id, service.user_id, publication_id) as project_row | undefined;
    if (!row) throw new Error(`history publication ${publication_id} was not found`);
    if (row.project_id !== expected_project_id) {
        throw new Error(`permission denied: history publication ${publication_id} is outside project ${expected_project_id}`);
    }
}

function list_publications(
    service: HistoryPublicationService,
    worker: history_worker_context,
    project_id: string,
    input: publication_tool_input,
) {
    const requested = input.limit ?? default_list_limit;
    const offset = input.offset ?? 0;
    const rows = service.list_for_worker(project_id, worker, { limit: requested + 1, offset });
    const items = rows.slice(0, requested).map(publication_summary_dto);
    let has_more = rows.length > requested;
    const envelope = () => ({
        action: 'list' as const,
        project_id,
        items,
        next_offset: has_more ? offset + items.length : null,
    });
    while (items.length > 1 && count_tokens(JSON.stringify(envelope())) > history_output_token_budget) {
        items.pop();
        has_more = true;
    }
    return envelope();
}

function run_publication_action(
    service: HistoryPublicationService,
    worker: history_worker_context,
    project_id: string,
    input: publication_tool_input,
): unknown {
    switch (input.action) {
        case 'get': {
            const publication_id = required(input.publication_id, 'publication_id');
            return {
                action: input.action,
                publication: publication_dto(service.get_for_worker(publication_id, worker)),
            };
        }
        case 'list':
            return list_publications(service, worker, project_id, input);
        case 'propose_hierarchy': {
            const proposal = service.propose_hierarchy({
                publication_id: required(input.publication_id, 'publication_id'),
                level: required(input.level, 'level'),
                role: required(input.role, 'role'),
                task: required(input.task, 'task'),
                confidence: required(input.confidence, 'confidence'),
            }, worker);
            return { action: input.action, proposal: proposal_dto(proposal) };
        }
        case 'create_plan': {
            const plan = service.create_plan({
                publication_id: required(input.publication_id, 'publication_id'),
                proposal_id: required(input.proposal_id, 'proposal_id'),
                memory_kind: required(input.memory_kind, 'memory_kind'),
                semantic_key: required(input.semantic_key, 'semantic_key'),
            }, worker);
            return { action: input.action, plan: plan_dto(plan) };
        }
        case 'execute': {
            const result = service.execute({
                publication_id: required(input.publication_id, 'publication_id'),
                plan_version: required(input.plan_version, 'plan_version'),
                attempt_id: required(input.attempt_id, 'attempt_id'),
            }, worker);
            return {
                action: input.action,
                publication: publication_dto(result.publication),
                attempt: attempt_dto(result.attempt),
            };
        }
        case 'reconcile_confirmation': {
            const publication_id = required(input.publication_id, 'publication_id');
            return {
                action: input.action,
                publication: publication_dto(service.reconcile_confirmation(publication_id, worker)),
            };
        }
    }
}

function with_publication_service(
    state: codex_hook_session_state,
    input: publication_tool_input,
): unknown {
    if (!state.bound) throw new Error('permission denied: Codex task must be bound before history publication');
    const store = new SqliteStore(state.db_path, {
        tenant_id: state.tenant_id,
        user_id: state.user_id,
        startup_integrity_check: false,
    });
    try {
        const worker = worker_from_state(state);
        if (!has_active_history_worker_authorization(store.database, {
            tenant_id: state.tenant_id,
            user_id: state.user_id,
            project_id: state.project_id,
            worker_session_id: state.session_id,
            worker_id: worker.worker_id,
        })) {
            throw new Error('permission denied: this Codex task is not an authorized dedicated history worker');
        }
        const capability_guard = (candidate: history_worker_context): void => {
            if (!same_worker(candidate, worker)) {
                throw new Error('permission denied: history publication worker is outside the locked capability scope');
            }
            const thread = store.database.prepare(`SELECT project_id, status
                FROM cm_threads WHERE tenant_id=? AND user_id=? AND thread_id=?`)
                .get(state.tenant_id, state.user_id, state.session_id) as {
                    project_id: string;
                    status: string;
                } | undefined;
            if (!thread || thread.status !== 'active' || thread.project_id !== state.project_id) {
                throw new Error('permission denied: history publication task binding is stale or mismatched');
            }
        };
        const service = new HistoryPublicationService(store.database, {
            tenant_id: state.tenant_id,
            user_id: state.user_id,
            capability_guard,
        });
        const execute = () => {
            capability_guard(worker);
            return bounded_output(run_publication_action(service, worker, state.project_id, input));
        };
        return input.action === 'get' || input.action === 'list'
            ? store.database.transaction(execute)()
            : execute();
    } finally {
        store.close();
    }
}

function assert_approver(runtime: mcp_runtime): void {
    if (runtime.access.roles.includes('central_memory_approver')) return;
    throw new Error('permission denied: history governance requires a trusted central_memory_approver runtime');
}

function history_service_from_runtime(runtime: mcp_runtime): HistoryPublicationService {
    const central = runtime.memory.centralMemory();
    if (!central) throw new Error('history governance requires a SQLite-backed MCP runtime');
    return new HistoryPublicationService(central.repository.database, {
        tenant_id: central.repository.tenant_id,
        user_id: central.repository.user_id,
        capability_guard: () => {
            throw new Error('permission denied: the manual governance tool has no worker capability');
        },
    });
}

function governance_decision_dto(decision: ReturnType<HistoryPublicationService['decide']>) {
    return {
        decision_id: decision.decision_id,
        publication_id: decision.publication_id,
        proposal_id: decision.proposal_id,
        plan_version: decision.plan_version,
        action: decision.action,
        actor_kind: decision.actor_kind,
        actor_id: decision.actor_id,
        action_id: decision.action_id,
        channel: decision.channel,
        payload_hash: decision.payload_hash,
        created_at: decision.created_at,
    };
}

export function register_history_publication_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_history_publication', {
        description: 'Capability-gated bridge for inspecting, classifying, planning, executing, and reconciling authorized historical candidates. It exposes no human governance action.',
        inputSchema: history_publication_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async (raw_input) => run_audited_tool(
        runtime,
        'longmemory_history_publication',
        raw_input,
        async () => {
            assert_write_allowed(runtime.access, 'longmemory_history_publication');
            const input = raw_input as publication_tool_input;
            const registry = new CodexHookRegistry(plugin_data(runtime));
            return registry.with_capability(
                input.session_id,
                input.capability,
                input.turn_id,
                (state) => with_publication_service(state, input),
            );
        },
    ));
}

export function register_history_governance_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_history_governance', {
        description: 'Manual human governance for historical publication proposals and plans. Requires a trusted central-memory approver runtime; actor identity is server-derived.',
        inputSchema: history_governance_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (raw_input) => run_audited_tool(
        runtime,
        'longmemory_history_governance',
        raw_input,
        async () => {
            assert_write_allowed(runtime.access, 'longmemory_history_governance');
            assert_approver(runtime);
            const input = raw_input as governance_tool_input;
            if (Buffer.byteLength(JSON.stringify(input.evidence), 'utf8') > maximum_governance_evidence_bytes) {
                throw new Error(`history governance evidence exceeds ${maximum_governance_evidence_bytes} bytes`);
            }
            const service = history_service_from_runtime(runtime);
            const project_id = runtime.resolve_project_id(runtime.access.project_id);
            require_publication_project(service, input.publication_id, project_id);
            const decision = service.decide({
                publication_id: input.publication_id,
                proposal_id: input.proposal_id,
                plan_version: input.plan_version,
                action: input.action,
                actor_id: runtime.access.user_id,
                actor_kind: 'user',
                action_id: input.action_id,
                channel: input.channel,
                evidence: input.evidence,
                note: input.note,
            });
            return bounded_output({
                action: 'govern' as const,
                project_id,
                decision: governance_decision_dto(decision),
            });
        },
    ));
}
