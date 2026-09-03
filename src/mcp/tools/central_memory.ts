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
 *  file  : src/mcp/tools/central_memory.ts
 *  usage : exposes the governed central-memory workflow over MCP
 */


import type { McpServer as mcp_server_sdk } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hash_canonical } from '../../core/hash/content_hash.js';
import { assert_no_obvious_credentials } from '../../core/central_memory/sensitive_content.js';
import {
    build_central_thread_context,
    type central_retraction_notice,
} from '../../core/central_memory/context.js';
import type { CentralMemoryService } from '../../core/central_memory/service.js';
import type {
    central_memory_conflict,
    central_memory_context_entry,
    central_metadata,
    central_outbox_event,
    central_thread_workset,
} from '../../core/central_memory/types.js';
import type { mcp_runtime } from '../runtime.js';
import {
    central_confirmation_schema,
    central_conflict_schema,
    central_context_schema,
    central_finalize_turn_schema,
    central_project_link_schema,
    central_publish_schema,
    central_register_thread_schema,
    central_usage_schema,
} from '../schemas/tool_schemas.js';
import { assert_write_allowed, resolve_project } from '../security/permissions.js';
import { run_audited_tool } from './common.js';

type role_row = {
    role_id: string;
    project_id: string;
    name: string;
    responsibility: string;
    status: 'active' | 'archived';
    metadata_json: string;
};

type task_row = {
    task_id: string;
    project_id: string;
    role_id: string | null;
    title: string;
    objective: string;
    status: 'active' | 'completed' | 'blocked' | 'archived';
    metadata_json: string;
};

type subscription_state_row = {
    enabled: number;
};

type dependency_identity = {
    dependency_id: string;
    subject_kind: 'task' | 'artifact' | 'decision' | 'output';
    subject_id: string;
    memory_id: string;
    memory_version: number;
    details: central_metadata;
};

type context_retraction_notice = central_retraction_notice & {
    retracted_at: number | null;
};

function apply_context_entry_limit(
    entries: central_memory_context_entry[],
    limit: number | undefined,
): central_memory_context_entry[] {
    if (limit === undefined) return entries;
    const mandatory_map = entries.filter((entry) => entry.memory.level <= 2);
    const optional_capacity = Math.max(0, limit - mandatory_map.length);
    const optional = entries.filter((entry) => entry.memory.level >= 3)
        .slice(0, optional_capacity);
    return [...mandatory_map, ...optional];
}

function parse_metadata(value: string): central_metadata {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as central_metadata
        : {};
}

function json_metadata(value: Record<string, unknown> | undefined): central_metadata {
    return parse_metadata(JSON.stringify(value ?? {}));
}

function require_central(runtime: mcp_runtime): CentralMemoryService {
    const service = runtime.memory.centralMemory();
    if (!service) {
        throw new Error('central memory governance requires a SQLite-backed MCP runtime');
    }
    return service;
}

function resolved_project(runtime: mcp_runtime, requested?: string): string {
    return runtime.resolve_project_id(resolve_project(runtime.access, requested));
}

function assert_project_access(runtime: mcp_runtime, project_id: string): void {
    resolve_project(runtime.access, project_id);
}

function assert_thread_access(runtime: mcp_runtime, thread_id: string): void {
    if (runtime.access.central_thread_id === thread_id) return;
    if (runtime.access.roles.includes('central_memory_cross_thread')) return;
    const bound = runtime.access.central_thread_id ?? 'none';
    throw new Error(`permission denied for central thread ${thread_id}; runtime is bound to ${bound}`);
}

function require_bound_central_thread(runtime: mcp_runtime, purpose: string): string {
    const thread_id = runtime.access.central_thread_id;
    if (thread_id) return thread_id;
    throw new Error(`permission denied: ${purpose} requires a trusted central_thread_id`);
}

function assert_governance_update_allowed(
    runtime: mcp_runtime,
    entity_kind: 'project' | 'role' | 'task',
    entity_id: string,
    changed: boolean,
): void {
    if (!changed || runtime.access.roles.includes('central_memory_admin')) return;
    throw new Error(`permission denied: updating central ${entity_kind} ${entity_id} requires central_memory_admin`);
}

function assert_approver(runtime: mcp_runtime): void {
    if (runtime.access.roles.includes('central_memory_approver')) return;
    throw new Error('permission denied: central-memory governance requires a trusted approver runtime');
}

type central_actor_input = {
    actor_id: string;
    actor_kind: 'user';
    action_id: string;
    channel: 'codex_ui' | 'obsidian' | 'local_cli';
    decided_at: number;
    note?: string;
    evidence: Record<string, unknown>;
};

function decision_from_actor(runtime: mcp_runtime, actor: central_actor_input, note?: string) {
    if (actor.actor_id !== runtime.access.user_id) {
        throw new Error(`permission denied for confirmation actor: ${actor.actor_id}`);
    }
    return {
        actor_id: actor.actor_id,
        actor_kind: actor.actor_kind,
        action_id: actor.action_id,
        channel: actor.channel,
        note: note ?? actor.note,
        evidence: json_metadata({ ...actor.evidence, decided_at: actor.decided_at }),
    };
}

function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`${name} is required for this central conflict action`);
    return value;
}

function same_conflict_report(
    conflict: central_memory_conflict,
    expected: Pick<central_memory_conflict,
        'memory_a_id' | 'memory_a_version' | 'memory_b_id' | 'memory_b_version' | 'severity' | 'rationale' | 'metadata'>,
): boolean {
    return conflict.memory_a_id === expected.memory_a_id
        && conflict.memory_a_version === expected.memory_a_version
        && conflict.memory_b_id === expected.memory_b_id
        && conflict.memory_b_version === expected.memory_b_version
        && conflict.severity === expected.severity
        && conflict.rationale === expected.rationale
        && same_payload(conflict.metadata, expected.metadata);
}

function role_by_id(service: CentralMemoryService, role_id: string): role_row | null {
    return service.repository.database.prepare(`SELECT role_id, project_id, name, responsibility, status, metadata_json
        FROM cm_roles WHERE tenant_id=? AND user_id=? AND role_id=?`)
        .get(service.repository.tenant_id, service.repository.user_id, role_id) as role_row | undefined ?? null;
}

function task_by_id(service: CentralMemoryService, task_id: string): task_row | null {
    return service.repository.database.prepare(`SELECT task_id, project_id, role_id, title, objective, status, metadata_json
        FROM cm_tasks WHERE tenant_id=? AND user_id=? AND task_id=?`)
        .get(service.repository.tenant_id, service.repository.user_id, task_id) as task_row | undefined ?? null;
}

function subscription_enabled(
    service: CentralMemoryService,
    subscription_id: string,
    thread_id: string,
    selector_kind: 'project' | 'role' | 'task',
    selector_value: string,
): boolean | null {
    const value = service.repository.database.prepare(`SELECT enabled FROM cm_subscriptions
        WHERE tenant_id=? AND user_id=? AND subscription_id=? AND thread_id=?
          AND selector_kind=? AND selector_value=?`)
        .get(service.repository.tenant_id, service.repository.user_id, subscription_id,
            thread_id, selector_kind, selector_value) as subscription_state_row | undefined;
    return value ? Boolean(value.enabled) : null;
}

function same_payload(left: central_metadata, right: central_metadata): boolean {
    return hash_canonical(left) === hash_canonical(right);
}

function assert_turn_finalization_event(
    event: central_outbox_event,
    event_id: string,
    thread_id: string,
    payload: central_metadata,
): void {
    const expected = {
        event_id,
        aggregate_kind: 'thread',
        aggregate_id: thread_id,
        aggregate_version: null,
        event_type: 'central_memory.turn_finalized',
        payload,
    };
    const actual = {
        event_id: event.event_id,
        aggregate_kind: event.aggregate_kind,
        aggregate_id: event.aggregate_id,
        aggregate_version: event.aggregate_version,
        event_type: event.event_type,
        payload: event.payload,
    };
    if (hash_canonical(expected) !== hash_canonical(actual)) {
        throw new Error(`turn ${thread_id}/${String(payload.turn_id)} was already finalized with a different result`);
    }
}

function immediate_transaction<T>(service: CentralMemoryService, operation: () => T): T {
    if (service.repository.database.inTransaction) return operation();
    return service.repository.database.transaction(operation).immediate();
}

function dependency_id_by_primary(service: CentralMemoryService, dependency_id: string): string | null {
    const value = service.repository.database.prepare(`SELECT dependency_id FROM cm_dependencies
        WHERE tenant_id=? AND user_id=? AND dependency_id=?`)
        .get(service.repository.tenant_id, service.repository.user_id, dependency_id) as { dependency_id: string } | undefined;
    return value?.dependency_id ?? null;
}

function dependency_id_by_logical_identity(service: CentralMemoryService, expected: dependency_identity): string | null {
    const value = service.repository.database.prepare(`SELECT dependency_id FROM cm_dependencies
        WHERE tenant_id=? AND user_id=? AND subject_kind=? AND subject_id=?
          AND memory_id=? AND memory_version=?`)
        .get(service.repository.tenant_id, service.repository.user_id, expected.subject_kind,
            expected.subject_id, expected.memory_id, expected.memory_version) as { dependency_id: string } | undefined;
    return value?.dependency_id ?? null;
}

function require_matching_dependency(service: CentralMemoryService, expected: dependency_identity, dependency_id: string) {
    const existing = service.repository.require_dependency(dependency_id);
    const matches = existing.subject_kind === expected.subject_kind
        && existing.subject_id === expected.subject_id
        && existing.memory_id === expected.memory_id
        && existing.memory_version === expected.memory_version
        && same_payload(existing.details, expected.details);
    if (!matches) throw new Error(`central dependency idempotency conflict for ${dependency_id}`);
    return existing;
}

function build_retraction_notice(
    service: CentralMemoryService,
    workset: central_thread_workset,
): context_retraction_notice {
    const memory = service.repository.require_memory(workset.memory_id);
    const retracted_row = service.repository.database.prepare(`SELECT version FROM cm_memory_versions
        WHERE tenant_id=? AND user_id=? AND memory_id=? AND status='retracted'
          AND activated_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`)
        .get(service.repository.tenant_id, service.repository.user_id,
            workset.memory_id) as { version: number } | undefined;
    const retracted_version_number = retracted_row?.version ?? workset.synced_version;
    const version = retracted_version_number === null
        ? null
        : service.repository.require_version(workset.memory_id, retracted_version_number);
    const event = retracted_version_number === null
        ? null
        : service.repository.get_outbox(`memory:${workset.memory_id}:${retracted_version_number}:retracted`);
    return {
        memory_id: workset.memory_id,
        synced_version: workset.synced_version,
        consumed_version: workset.consumed_version,
        title: version?.title ?? memory.title,
        reason: typeof event?.payload.reason === 'string' ? event.payload.reason : '',
        retracted_at: version?.retracted_at ?? null,
    };
}

export function register_central_register_thread_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_register_thread', {
        description: 'Register or update a Codex thread, its responsibility, and its project/role/task binding.',
        inputSchema: central_register_thread_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_register_thread', input, async () => {
        // Run before access checks that may mention caller-supplied ids and
        // before the hierarchy transaction can persist any subset of input.
        assert_no_obvious_credentials({ central_thread_registration: input });
        assert_write_allowed(runtime.access, 'longmemory_central_register_thread');
        assert_thread_access(runtime, input.thread_id);
        const service = require_central(runtime);
        const project_id = resolved_project(runtime, input.project_id);
        const repository = service.repository;
        const at = Date.now();

        return repository.transaction(() => {
            let prior_project = null;
            try {
                prior_project = repository.require_project(project_id);
            } catch (error) {
                if (!(error instanceof Error) || !/was not found/.test(error.message)) throw error;
            }
            const project_changed = Boolean(prior_project) && Boolean(
                (input.project_name !== undefined && input.project_name !== prior_project?.name)
                || (input.project_description !== undefined && input.project_description !== prior_project?.description)
                || (input.project_status !== undefined && input.project_status !== prior_project?.status)
                || (input.project_metadata !== undefined
                    && !same_payload(json_metadata(input.project_metadata), prior_project?.metadata ?? {})),
            );
            assert_governance_update_allowed(runtime, 'project', project_id, project_changed);
            const project = !prior_project || project_changed ? repository.register_project({
                project_id,
                name: input.project_name ?? prior_project?.name ?? project_id,
                description: input.project_description ?? prior_project?.description ?? '',
                status: input.project_status ?? prior_project?.status ?? 'active',
                metadata: input.project_metadata ? json_metadata(input.project_metadata) : prior_project?.metadata ?? {},
                at,
            }) : prior_project;

            let prior_thread = null;
            try {
                prior_thread = repository.require_thread(input.thread_id);
            } catch (error) {
                if (!(error instanceof Error) || !/was not found/.test(error.message)) throw error;
            }
            if (prior_thread && prior_thread.project_id !== project_id) {
                throw new Error(`central thread ${input.thread_id} cannot move from project ${prior_thread.project_id} to ${project_id}`);
            }

            const requested_task_id = input.task_id === undefined ? prior_thread?.task_id ?? null : input.task_id;
            const prior_task = requested_task_id ? task_by_id(service, requested_task_id) : null;
            if (prior_task && prior_task.project_id !== project_id) {
                throw new Error(`central task ${requested_task_id} belongs to project ${prior_task.project_id}, not ${project_id}`);
            }
            const requested_role_id = input.role_id === undefined
                ? prior_task?.role_id ?? prior_thread?.role_id ?? null
                : input.role_id;
            if (prior_task && prior_task.role_id !== requested_role_id) {
                throw new Error(`central task ${prior_task.task_id} is bound to role ${String(prior_task.role_id)}, not ${String(requested_role_id)}`);
            }

            if (!requested_role_id && (input.role_name || input.role_responsibility || input.role_status || input.role_metadata)) {
                throw new Error('role_id is required when role details are supplied');
            }
            const prior_role = requested_role_id ? role_by_id(service, requested_role_id) : null;
            if (prior_role && prior_role.project_id !== project_id) {
                throw new Error(`central role ${requested_role_id} belongs to project ${prior_role.project_id}, not ${project_id}`);
            }
            const role_changed = Boolean(prior_role) && Boolean(
                (input.role_name !== undefined && input.role_name !== prior_role?.name)
                || (input.role_responsibility !== undefined && input.role_responsibility !== prior_role?.responsibility)
                || (input.role_status !== undefined && input.role_status !== prior_role?.status)
                || (input.role_metadata !== undefined
                    && !same_payload(json_metadata(input.role_metadata), parse_metadata(prior_role?.metadata_json ?? '{}'))),
            );
            assert_governance_update_allowed(runtime, 'role', requested_role_id ?? '', role_changed);
            const role = requested_role_id
                ? !prior_role || role_changed
                    ? repository.register_role({
                        role_id: requested_role_id,
                        project_id,
                        name: input.role_name ?? prior_role?.name ?? requested_role_id,
                        responsibility: input.role_responsibility ?? prior_role?.responsibility ?? '',
                        status: input.role_status ?? prior_role?.status ?? 'active',
                        metadata: input.role_metadata ? json_metadata(input.role_metadata)
                            : prior_role ? parse_metadata(prior_role.metadata_json) : {},
                        at,
                    })
                    : repository.require_role(requested_role_id)
                : null;

            if (!requested_task_id && (input.task_title || input.task_objective || input.task_status || input.task_metadata)) {
                throw new Error('task_id is required when task details are supplied');
            }
            const task_changed = Boolean(prior_task) && Boolean(
                (input.task_title !== undefined && input.task_title !== prior_task?.title)
                || (input.task_objective !== undefined && input.task_objective !== prior_task?.objective)
                || (input.task_status !== undefined && input.task_status !== prior_task?.status)
                || (input.task_metadata !== undefined
                    && !same_payload(json_metadata(input.task_metadata), parse_metadata(prior_task?.metadata_json ?? '{}'))),
            );
            assert_governance_update_allowed(runtime, 'task', requested_task_id ?? '', task_changed);
            const task = requested_task_id
                ? !prior_task || task_changed
                    ? repository.register_task({
                        task_id: requested_task_id,
                        project_id,
                        role_id: requested_role_id,
                        title: input.task_title ?? prior_task?.title ?? requested_task_id,
                        objective: input.task_objective ?? prior_task?.objective ?? '',
                        status: input.task_status ?? prior_task?.status ?? 'active',
                        metadata: input.task_metadata ? json_metadata(input.task_metadata)
                            : prior_task ? parse_metadata(prior_task.metadata_json) : {},
                        at,
                    })
                    : repository.require_task(requested_task_id)
                : null;

            const desired_responsibility = input.responsibility ?? prior_thread?.responsibility ?? '';
            const desired_thread_status = input.thread_status ?? prior_thread?.status ?? 'active';
            const desired_thread_metadata = input.thread_metadata
                ? json_metadata(input.thread_metadata)
                : prior_thread?.metadata ?? {};
            const project_subscription_id = `thread:${input.thread_id}:project:${project_id}`;
            const prior_project_subscription = prior_thread
                ? subscription_enabled(service, project_subscription_id, input.thread_id, 'project', project_id)
                : null;
            const desired_project_subscription = input.subscribe_to_project
                ?? (prior_thread ? prior_project_subscription ?? false : true);
            const role_binding_changed = (prior_thread?.role_id ?? null) !== requested_role_id;
            const task_binding_changed = (prior_thread?.task_id ?? null) !== requested_task_id;
            const thread_changed = prior_thread !== null && Boolean(
                role_binding_changed
                || task_binding_changed
                || prior_thread.responsibility !== desired_responsibility
                || prior_thread.status !== desired_thread_status
                || !same_payload(prior_thread.metadata, desired_thread_metadata),
            );
            const thread = !prior_thread || thread_changed ? repository.register_thread({
                thread_id: input.thread_id,
                project_id,
                role_id: requested_role_id,
                task_id: requested_task_id,
                responsibility: desired_responsibility,
                status: desired_thread_status,
                metadata: desired_thread_metadata,
                at,
            }) : prior_thread;

            if (prior_thread?.role_id && prior_thread.role_id !== requested_role_id) {
                const subscription_id = `thread:${input.thread_id}:role:${prior_thread.role_id}`;
                if (subscription_enabled(service, subscription_id, input.thread_id,
                    'role', prior_thread.role_id) === true) {
                    service.subscribe({
                        subscription_id,
                        thread_id: input.thread_id,
                        selector_kind: 'role',
                        selector_value: prior_thread.role_id,
                        min_relevance: 0.6,
                        enabled: false,
                        at,
                    });
                }
            }
            if (prior_thread?.task_id && prior_thread.task_id !== requested_task_id) {
                const subscription_id = `thread:${input.thread_id}:task:${prior_thread.task_id}`;
                if (subscription_enabled(service, subscription_id, input.thread_id,
                    'task', prior_thread.task_id) === true) {
                    service.subscribe({
                        subscription_id,
                        thread_id: input.thread_id,
                        selector_kind: 'task',
                        selector_value: prior_thread.task_id,
                        min_relevance: 0.8,
                        enabled: false,
                        at,
                    });
                }
            }

            let should_stage_context = !prior_thread
                || Boolean(prior_thread && prior_thread.status !== desired_thread_status
                    && (desired_thread_status === 'active' || desired_thread_status === 'idle'));
            if (desired_project_subscription !== (prior_project_subscription ?? false)) {
                service.subscribe({
                    subscription_id: project_subscription_id,
                    thread_id: input.thread_id,
                    selector_kind: 'project',
                    selector_value: project_id,
                    min_relevance: 0.2,
                    enabled: desired_project_subscription,
                    at,
                });
                if (desired_project_subscription) should_stage_context = true;
            }
            if (requested_role_id) {
                const subscription_id = `thread:${input.thread_id}:role:${requested_role_id}`;
                if (subscription_enabled(service, subscription_id, input.thread_id,
                    'role', requested_role_id) !== true) {
                    service.subscribe({
                        subscription_id,
                        thread_id: input.thread_id,
                        selector_kind: 'role',
                        selector_value: requested_role_id,
                        min_relevance: 0.6,
                        enabled: true,
                        at,
                    });
                    should_stage_context = true;
                }
            }
            if (requested_task_id) {
                const subscription_id = `thread:${input.thread_id}:task:${requested_task_id}`;
                if (subscription_enabled(service, subscription_id, input.thread_id,
                    'task', requested_task_id) !== true) {
                    service.subscribe({
                        subscription_id,
                        thread_id: input.thread_id,
                        selector_kind: 'task',
                        selector_value: requested_task_id,
                        min_relevance: 0.8,
                        enabled: true,
                        at,
                    });
                    should_stage_context = true;
                }
            }
            if ((thread.status === 'active' || thread.status === 'idle') && should_stage_context) {
                for (const memory of repository.list_effective_memories(project_id)) {
                    const matches = repository.list_matching_subscriptions(memory)
                        .filter((subscription) => subscription.thread_id === input.thread_id);
                    if (matches.length === 0 || memory.current_version === null) continue;
                    const base_relevance = memory.level === 1 ? 1
                        : memory.level === 2 ? 0.8
                            : memory.level === 3 ? 0.35 : 0.5;
                    repository.stage_workset({
                        thread_id: input.thread_id,
                        memory_id: memory.memory_id,
                        pending_version: memory.current_version,
                        relevance: Math.max(base_relevance, ...matches.map((match) => match.min_relevance)),
                        origin: memory.level <= 2 ? 'project_map' : 'subscription',
                        at,
                    });
                }
            }
            let reconciled_retractions = 0;
            if (thread.status === 'active' || thread.status === 'idle') {
                for (const workset of repository.list_worksets(input.thread_id)) {
                    if (workset.sync_state === 'retracted') continue;
                    const memory = repository.require_memory(workset.memory_id);
                    if (memory.current_version !== null) continue;
                    reconciled_retractions += repository.database.prepare(`UPDATE cm_thread_worksets SET
                        pending_version=NULL, sync_state='retracted', updated_at=?
                        WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?
                          AND sync_state<>'retracted'`)
                        .run(at, repository.tenant_id, repository.user_id,
                            input.thread_id, workset.memory_id).changes;
                }
            }
            let removed_worksets = 0;
            for (const workset of repository.list_worksets(input.thread_id)) {
                if (workset.sync_state === 'retracted') continue;
                if (workset.origin === 'own_thread' || workset.origin === 'manual') continue;
                const memory = repository.require_memory(workset.memory_id);
                const still_matches = repository.list_matching_subscriptions(memory)
                    .some((subscription) => subscription.thread_id === input.thread_id);
                if (still_matches) continue;
                if (workset.consumed_version !== null) continue;
                removed_worksets += repository.database.prepare(`DELETE FROM cm_thread_worksets
                    WHERE tenant_id=? AND user_id=? AND thread_id=? AND memory_id=?`)
                    .run(repository.tenant_id, repository.user_id, input.thread_id, workset.memory_id).changes;
            }
            return { project, role, task, thread, removed_worksets, reconciled_retractions };
        });
    }));
}

export function register_central_context_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_context', {
        description: 'Read a thread working set, optionally first synchronizing pending versions at a safe boundary.',
        inputSchema: central_context_schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_context', input, async () => {
        assert_thread_access(runtime, input.thread_id);
        const service = require_central(runtime);
        const thread = service.repository.require_thread(input.thread_id);
        assert_project_access(runtime, thread.project_id);
        if (thread.project_id !== input.project_id) {
            throw new Error(`central thread ${input.thread_id} belongs to project ${thread.project_id}, not ${input.project_id}`);
        }
        const before = new Map(service.repository.list_worksets(input.thread_id)
            .map((workset) => [workset.memory_id, workset.synced_version]));
        if (input.action === 'sync') {
            assert_write_allowed(runtime.access, 'longmemory_central_context');
            service.sync_at_safe_boundary(input.thread_id);
        }
        const worksets = service.repository.list_worksets(input.thread_id);
        const in_scope_memory_ids = new Set(worksets.filter((workset) => {
            if (workset.origin === 'linked_project') return true;
            if (workset.origin === 'own_thread' || workset.origin === 'manual'
                || workset.consumed_version !== null) return true;
            const memory = service.repository.require_memory(workset.memory_id);
            return service.repository.list_matching_subscriptions(memory)
                .some((subscription) => subscription.thread_id === input.thread_id);
        }).map((workset) => workset.memory_id));
        const scoped_worksets = worksets.filter((workset) => in_scope_memory_ids.has(workset.memory_id));
        const retracted = scoped_worksets.filter((workset) => {
            const memory = service.repository.require_memory(workset.memory_id);
            return workset.sync_state === 'retracted' || memory.current_version === null;
        }).map((workset) => build_retraction_notice(service, workset));
        const synchronized = input.action === 'sync'
            ? scoped_worksets.filter((workset) => before.get(workset.memory_id) !== workset.synced_version)
                .map((workset) => ({ memory_id: workset.memory_id, synced_version: workset.synced_version }))
            : [];
        const active_entries = apply_context_entry_limit(service.context(input.thread_id)
            .filter((entry) => in_scope_memory_ids.has(entry.memory.memory_id))
            .filter((entry) => entry.version.status === 'active' || entry.version.status === 'locked'),
        input.limit);
        const packet = build_central_thread_context(
            service.repository.require_thread(input.thread_id),
            active_entries,
            {
                token_budget: input.token_budget,
                include_consumed: input.include_consumed,
                retractions: retracted,
            },
        );
        const included_versions = new Set(packet.included
            .map((entry) => `${entry.memory_id}@${entry.version}`));
        const included = active_entries
            .filter((entry) => included_versions.has(`${entry.memory.memory_id}@${entry.version.version}`))
            .map((entry) => ({
                memory_id: entry.memory.memory_id,
                version: entry.version.version,
                level: entry.memory.level,
                source_project_id: entry.memory.project_id,
                project_scope: entry.workset.origin === 'linked_project' ? 'linked_project' : 'local_project',
                status: entry.version.status,
                origin: entry.workset.origin,
                relevance: entry.workset.relevance,
                consumed_version: entry.workset.consumed_version,
            }));
        return {
            thread: service.repository.require_thread(input.thread_id),
            synchronized,
            pending_count: scoped_worksets.filter((workset) => workset.sync_state === 'pending').length,
            retracted_count: retracted.length,
            retracted,
            packet,
            included,
        };
    }));
}

export function register_central_publish_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_publish', {
        description: 'Publish an immutable central-memory version with optimistic concurrency and governed confirmation for major or locked changes.',
        inputSchema: central_publish_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_publish', input, async () => {
        assert_write_allowed(runtime.access, 'longmemory_central_publish');
        const service = require_central(runtime);
        const project_id = resolved_project(runtime, input.project_id);
        if (input.role_id) {
            const role = role_by_id(service, input.role_id);
            if (!role || role.project_id !== project_id) throw new Error(`central role ${input.role_id} was not found in project ${project_id}`);
        }
        if (input.task_id) {
            const task = task_by_id(service, input.task_id);
            if (!task || task.project_id !== project_id) throw new Error(`central task ${input.task_id} was not found in project ${project_id}`);
        }
        assert_thread_access(runtime, input.source_thread_id);
        const source_thread = service.repository.require_thread(input.source_thread_id);
        if (source_thread.project_id !== project_id) {
            throw new Error(`source thread ${input.source_thread_id} belongs to project ${source_thread.project_id}, not ${project_id}`);
        }
        for (const link of input.sources ?? []) {
            if (/^codex(?:_|$)/i.test(link.source_kind) && !link.thread_id) {
                throw new Error(`Codex source ${link.source_id} requires an attested thread_id`);
            }
            if (!link.thread_id) continue;
            assert_thread_access(runtime, link.thread_id);
            const source_thread = service.repository.require_thread(link.thread_id);
            if (source_thread.project_id !== project_id) {
                throw new Error(`source thread ${link.thread_id} belongs to project ${source_thread.project_id}, not ${project_id}`);
            }
        }
        const now = Date.now();
        const current_memory = service.repository.get_memory(input.memory_id);
        const current_version = current_memory?.current_version === null || current_memory === null
            ? null
            : service.repository.require_version(current_memory.memory_id, current_memory.current_version);
        const governed_major = Boolean(input.major) || input.level === 1 || Boolean(current_version?.is_major);
        return service.publish({
            memory_id: input.memory_id,
            project_id,
            role_id: input.role_id,
            task_id: input.task_id,
            level: input.level,
            memory_kind: input.memory_kind,
            title: input.title,
            summary: input.summary,
            body: input.body,
            importance: input.importance,
            major: governed_major,
            lock: input.lock,
            change_reason: input.change_reason,
            metadata: input.metadata ? json_metadata(input.metadata) : undefined,
            created_by: input.source_thread_id,
            expected_current_version: input.expected_current_version,
            confirmation_prompt: input.confirmation_prompt,
            source_thread_id: input.source_thread_id,
            sources: input.sources?.map((link) => ({
                source: {
                    source_id: link.source_id,
                    source_kind: link.source_kind,
                    uri: link.uri,
                    thread_id: link.thread_id ?? null,
                    turn_id: link.turn_id ?? null,
                    locator: json_metadata(link.locator),
                    excerpt_hash: link.excerpt_hash ?? null,
                    metadata: json_metadata(link.metadata),
                    recorded_at: link.recorded_at ?? now,
                },
                evidence_role: link.evidence_role,
                locator: link.link_locator,
            })),
            at: now,
        });
    }));
}

export function register_central_confirmation_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_confirmation', {
        description: 'Approve or reject a pending central-memory confirmation using explicit evidence of a human user action.',
        inputSchema: central_confirmation_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_confirmation', input, async () => {
        assert_write_allowed(runtime.access, 'longmemory_central_confirmation');
        assert_approver(runtime);
        const service = require_central(runtime);
        const confirmation = service.repository.require_confirmation(input.confirmation_id);
        const memory = service.repository.require_memory(confirmation.memory_id);
        assert_project_access(runtime, memory.project_id);
        if (memory.project_id !== input.project_id) {
            throw new Error(`central memory ${memory.memory_id} belongs to project ${memory.project_id}, not ${input.project_id}`);
        }
        const decision = decision_from_actor(runtime, input.actor, input.decision_note);
        return input.action === 'approve'
            ? service.approve(input.confirmation_id, decision)
            : service.reject(input.confirmation_id, decision);
    }));
}

export function register_central_conflict_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_conflict', {
        description: 'List, report, resolve or dismiss governed central-memory conflicts in a project.',
        inputSchema: central_conflict_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_conflict', input, async () => {
        const service = require_central(runtime);
        const project_id = resolved_project(runtime, input.project_id);

        if (input.action === 'list') {
            const limit = input.limit ?? 100;
            const conflicts = service.repository.list_conflicts(input.status, 10_000)
                .filter((conflict) => service.repository.require_memory(conflict.memory_a_id).project_id === project_id)
                .slice(0, limit);
            return { project_id, conflicts, count: conflicts.length };
        }

        assert_write_allowed(runtime.access, 'longmemory_central_conflict');
        if (input.action === 'report') {
            const source_thread_id = require_bound_central_thread(runtime, 'central conflict reporting');
            const source_thread = service.repository.require_thread(source_thread_id);
            if (source_thread.project_id !== project_id) {
                throw new Error(`source thread ${source_thread_id} belongs to project ${source_thread.project_id}, not ${project_id}`);
            }
            if (input.metadata && Object.hasOwn(input.metadata, 'source_thread_id')) {
                throw new Error('metadata.source_thread_id is reserved and cannot be supplied by the caller');
            }
            const left = {
                memory_id: required(input.memory_a_id, 'memory_a_id'),
                version: required(input.memory_a_version, 'memory_a_version'),
            };
            const right = {
                memory_id: required(input.memory_b_id, 'memory_b_id'),
                version: required(input.memory_b_version, 'memory_b_version'),
            };
            const [memory_a, memory_b] = [left, right].sort((a, b) =>
                `${a.memory_id}@${a.version}`.localeCompare(`${b.memory_id}@${b.version}`));
            for (const reference of [memory_a, memory_b]) {
                const memory = service.repository.require_memory(reference.memory_id);
                if (memory.project_id !== project_id) {
                    throw new Error(`central memory ${reference.memory_id} belongs to project ${memory.project_id}, not ${project_id}`);
                }
            }
            const severity = required(input.severity, 'severity');
            const rationale = required(input.rationale, 'rationale');
            const metadata = json_metadata({ ...(input.metadata ?? {}), source_thread_id });
            const conflict_id = input.conflict_id ?? `central-conflict:${hash_canonical({
                project_id, memory_a, memory_b, severity, rationale, metadata,
            })}`;
            const expected = {
                memory_a_id: memory_a.memory_id,
                memory_a_version: memory_a.version,
                memory_b_id: memory_b.memory_id,
                memory_b_version: memory_b.version,
                severity,
                rationale,
                metadata,
            };
            return immediate_transaction(service, () => {
                const existing = service.repository.get_conflict(conflict_id);
                if (existing) {
                    if (!same_conflict_report(existing, expected)) {
                        throw new Error(`central memory conflict ${conflict_id} already exists with different content`);
                    }
                    return { project_id, source_thread_id, conflict: existing, already_reported: true };
                }
                const conflict = service.report_conflict({ conflict_id, ...expected });
                return { project_id, source_thread_id, conflict, already_reported: false };
            });
        }

        assert_approver(runtime);
        const conflict_id = required(input.conflict_id, 'conflict_id');
        const conflict = service.repository.require_conflict(conflict_id);
        const conflict_project_id = service.repository.require_memory(conflict.memory_a_id).project_id;
        if (conflict_project_id !== project_id) {
            throw new Error(`central memory conflict ${conflict_id} belongs to project ${conflict_project_id}, not ${project_id}`);
        }
        const actor = required(input.actor, 'actor');
        const decision = decision_from_actor(runtime, actor, input.decision_note);
        if (input.action === 'resolve') {
            const resolution_memory_id = required(input.resolution_memory_id, 'resolution_memory_id');
            const resolution_version = required(input.resolution_version, 'resolution_version');
            const resolution_memory = service.repository.require_memory(resolution_memory_id);
            if (resolution_memory.project_id !== project_id) {
                throw new Error(`central memory ${resolution_memory_id} belongs to project ${resolution_memory.project_id}, not ${project_id}`);
            }
            return {
                project_id,
                conflict: service.decide_conflict(conflict_id, {
                    ...decision,
                    status: 'resolved',
                    resolution_memory_id,
                    resolution_version,
                }),
            };
        }
        if (input.resolution_memory_id !== undefined || input.resolution_version !== undefined) {
            throw new Error('dismissed central conflicts cannot specify a resolution memory');
        }
        return {
            project_id,
            conflict: service.decide_conflict(conflict_id, { ...decision, status: 'dismissed' }),
        };
    }));
}

export function register_central_project_link_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_project_link', {
        description: 'List, create, or revoke human-governed L4-only recall links between otherwise isolated projects.',
        inputSchema: central_project_link_schema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_project_link', input, async () => {
        const service = require_central(runtime);
        const project_id = resolved_project(runtime, input.project_id);
        if (input.action === 'list') {
            const links = service.repository.list_project_links({ project_id, status: input.status });
            return { project_id, links, count: links.length };
        }

        assert_write_allowed(runtime.access, 'longmemory_central_project_link');
        assert_approver(runtime);
        if (!runtime.access.roles.includes('central_memory_admin')) {
            throw new Error('permission denied: project link governance requires central_memory_admin');
        }
        const actor = required(input.actor, 'actor');
        const decision = decision_from_actor(runtime, actor);
        if (input.action === 'create') {
            const source_project_id = required(input.source_project_id, 'source_project_id');
            const target_project_id = required(input.target_project_id, 'target_project_id');
            if (project_id !== source_project_id && project_id !== target_project_id) {
                throw new Error(`central project link must include the authorized project ${project_id}`);
            }
            const links = service.link_projects({
                source_project_id,
                target_project_id,
                direction: input.direction,
                link_id: input.link_id,
                metadata: input.metadata,
                decision,
            });
            return { project_id, links, count: links.length };
        }

        const link_id = required(input.link_id, 'link_id');
        const existing = service.repository.require_project_link(link_id);
        if (project_id !== existing.source_project_id && project_id !== existing.target_project_id) {
            throw new Error(`central project link ${link_id} does not include project ${project_id}`);
        }
        return { project_id, ...service.revoke_project_link(link_id, decision) };
    }));
}

export function register_central_usage_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_usage', {
        description: 'Record that a thread consumed an exact memory version, or that a task/artifact/decision/output depends on it.',
        inputSchema: central_usage_schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_usage', input, async () => {
        assert_write_allowed(runtime.access, 'longmemory_central_usage');
        const service = require_central(runtime);
        assert_thread_access(runtime, input.thread_id);
        return immediate_transaction(service, () => {
            const thread = service.repository.require_thread(input.thread_id);
            const memory = service.repository.require_memory(input.memory_id);
            assert_project_access(runtime, thread.project_id);
            if (thread.project_id !== input.project_id) {
                throw new Error(`central thread ${input.thread_id} belongs to project ${thread.project_id}, not ${input.project_id}`);
            }
            if (memory.project_id !== thread.project_id) {
                const linked_workset = service.repository.require_workset(input.thread_id, input.memory_id);
                if (memory.level !== 4 || linked_workset.origin !== 'linked_project'
                    || service.repository.find_active_project_link(memory.project_id, thread.project_id) === null) {
                    throw new Error(`central memory ${input.memory_id} is not linked to thread project ${thread.project_id}`);
                }
            }
            service.repository.require_version(input.memory_id, input.memory_version);

            if (input.action === 'consume') {
                const workset = service.repository.require_workset(input.thread_id, input.memory_id);
                if (workset.sync_state !== 'current' || workset.synced_version !== input.memory_version) {
                    throw new Error(`central workset ${input.thread_id}/${input.memory_id} is not synced to version ${input.memory_version}`);
                }
                return {
                    action: input.action,
                    workset: service.consume(input.thread_id, input.memory_id, input.memory_version),
                };
            }

            if (!input.subject_kind || !input.subject_id) {
                throw new Error('subject_kind and subject_id are required for dependency usage');
            }
            if (input.details && Object.hasOwn(input.details, 'source_thread_id')) {
                throw new Error('details.source_thread_id is reserved and cannot be supplied by the caller');
            }
            const dependency_id = input.dependency_id ?? `central-dependency:${hash_canonical({
                subject_kind: input.subject_kind,
                subject_id: input.subject_id,
                memory_id: input.memory_id,
                memory_version: input.memory_version,
            })}`;
            const expected: dependency_identity = {
                dependency_id,
                subject_kind: input.subject_kind,
                subject_id: input.subject_id,
                memory_id: input.memory_id,
                memory_version: input.memory_version,
                details: json_metadata({ ...(input.details ?? {}), source_thread_id: input.thread_id }),
            };
            const by_primary = dependency_id_by_primary(service, dependency_id);
            if (by_primary) {
                return {
                    action: input.action,
                    dependency: require_matching_dependency(service, expected, by_primary),
                    already_recorded: true,
                };
            }
            const by_identity = dependency_id_by_logical_identity(service, expected);
            if (by_identity) {
                if (input.dependency_id && by_identity !== input.dependency_id) {
                    throw new Error(`central dependency is already recorded as ${by_identity}, not ${input.dependency_id}`);
                }
                return {
                    action: input.action,
                    dependency: require_matching_dependency(service, expected, by_identity),
                    already_recorded: true,
                };
            }
            return {
                action: input.action,
                dependency: service.add_dependency({
                    dependency_id,
                    subject_kind: expected.subject_kind,
                    subject_id: expected.subject_id,
                    memory_id: expected.memory_id,
                    memory_version: expected.memory_version,
                    details: expected.details,
                }),
                already_recorded: false,
            };
        });
    }));
}

export function register_central_finalize_turn_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_central_finalize_turn', {
        description: 'Idempotently mark that a turn completed its formal-memory decision so Stop hooks need no continuation turn.',
        inputSchema: central_finalize_turn_schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async (input) => run_audited_tool(runtime, 'longmemory_central_finalize_turn', input, async () => {
        assert_write_allowed(runtime.access, 'longmemory_central_finalize_turn');
        const service = require_central(runtime);
        assert_thread_access(runtime, input.thread_id);
        const thread = service.repository.require_thread(input.thread_id);
        assert_project_access(runtime, thread.project_id);
        if (thread.project_id !== input.project_id) {
            throw new Error(`central thread ${input.thread_id} belongs to project ${thread.project_id}, not ${input.project_id}`);
        }
        if ((input.memory_id === undefined) !== (input.memory_version === undefined)) {
            throw new Error('memory_id and memory_version must be supplied together');
        }
        if (!input.memory_extracted && input.memory_id !== undefined) {
            throw new Error('a turn without extracted memory cannot reference memory_id or memory_version');
        }
        if (input.memory_id !== undefined && input.memory_version !== undefined) {
            const memory = service.repository.require_memory(input.memory_id);
            if (memory.project_id !== thread.project_id) {
                throw new Error(`central memory ${input.memory_id} belongs to project ${memory.project_id}, not thread project ${thread.project_id}`);
            }
            service.repository.require_version(input.memory_id, input.memory_version);
        }

        const payload: central_metadata = {
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            memory_extracted: input.memory_extracted,
            memory_id: input.memory_id ?? null,
            memory_version: input.memory_version ?? null,
            note: input.note ?? '',
        };
        const event_id = `central-turn-finalized:${hash_canonical([input.thread_id, input.turn_id])}`;
        return immediate_transaction(service, () => {
            const existing = service.repository.get_outbox(event_id);
            if (existing) {
                assert_turn_finalization_event(existing, event_id, input.thread_id, payload);
                return { event: existing, already_finalized: true };
            }
            const event = service.repository.enqueue({
                event_id,
                aggregate_kind: 'thread',
                aggregate_id: input.thread_id,
                event_type: 'central_memory.turn_finalized',
                payload,
            });
            return { event, already_finalized: false };
        });
    }));
}
