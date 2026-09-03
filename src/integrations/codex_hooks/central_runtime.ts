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
 *  file  : src/integrations/codex_hooks/central_runtime.ts
 *  usage : implements the LongMemory central runtime component
 */

import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { hash_canonical } from '../../core/hash/content_hash.js';
import { count_tokens } from '../../core/recall/context_builder.js';
import {
    build_central_thread_context,
    type central_context_packet,
    type central_retraction_notice,
} from '../../core/central_memory/context.js';
import { CentralMemoryService } from '../../core/central_memory/service.js';
import type {
    central_memory_context_entry,
    central_outbox_event,
    central_thread_workset,
} from '../../core/central_memory/types.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import type { CodexHookRegistry } from './registry.js';
import type {
    codex_delivery_receipt,
    codex_hook_event_name,
    codex_hook_session_state,
} from './types.js';

export type codex_central_runtime = {
    store: SqliteStore;
    service: CentralMemoryService;
};

export type codex_context_result = {
    text: string;
    packet: central_context_packet;
    delivery: codex_delivery_receipt | null;
};

const CODEX_DELIVERY_STAGED = 'central_memory.context_delivery_staged';
const CODEX_DELIVERY_ACKNOWLEDGED = 'central_memory.context_delivery_acknowledged';
const CODEX_DELIVERY_SUPERSEDED = 'central_memory.context_delivery_superseded';
const MAX_DELIVERY_ACKS_PER_TURN = 100;

export function open_codex_central(state: codex_hook_session_state): codex_central_runtime {
    if (state.db_path !== ':memory:') mkdirSync(dirname(state.db_path), { recursive: true });
    const store = new SqliteStore(state.db_path, {
        tenant_id: state.tenant_id,
        user_id: state.user_id,
        startup_integrity_check: false,
    });
    return { store, service: new CentralMemoryService(store.central_memory) };
}

export function with_codex_central<T>(
    state: codex_hook_session_state,
    operation: (runtime: codex_central_runtime) => T,
): T {
    const runtime = open_codex_central(state);
    try { return operation(runtime); } finally { runtime.store.close(); }
}

function retraction_key(memory_id: string, version: number | null): string {
    return `${memory_id}@${version === null ? '?' : String(version)}`;
}

function retraction_notice(
    service: CentralMemoryService,
    workset: central_thread_workset,
): central_retraction_notice {
    const memory = service.repository.require_memory(workset.memory_id);
    const version_number = workset.synced_version ?? workset.consumed_version;
    const version = version_number === null ? null : service.repository.get_version(memory.memory_id, version_number);
    const event = version_number === null
        ? null
        : service.repository.get_outbox(`memory:${memory.memory_id}:${version_number}:retracted`);
    return {
        memory_id: memory.memory_id,
        synced_version: workset.synced_version,
        consumed_version: workset.consumed_version,
        title: version?.title ?? memory.title,
        reason: typeof event?.payload.reason === 'string' ? event.payload.reason : '',
    };
}

export function reconcile_registry_binding(
    registry: CodexHookRegistry,
    state: codex_hook_session_state,
): codex_hook_session_state {
    return with_codex_central(state, ({ service }) => {
        if (state.project_was_configured && !state.configured_project_id) {
            throw new Error('configured Codex project anchor is missing; restart the task before binding memory');
        }
        const thread = service.repository.get_thread(state.session_id);
        if (!thread) {
            const next = {
                ...state,
                ...(state.configured_project_id ? { project_id: state.configured_project_id } : {}),
                bound: false,
                responsibility: '',
                role_id: null,
                task_id: null,
            };
            registry.save(next);
            return next;
        }
        if (state.configured_project_id && thread.project_id !== state.configured_project_id) {
            throw new Error(
                `central thread ${state.session_id} belongs to ${thread.project_id}, `
                + `but this task is configured for ${state.configured_project_id}`,
            );
        }
        const project = service.repository.require_project(thread.project_id);
        const semantically_bound = Boolean(thread.responsibility.trim()) && thread.role_id !== null;
        const next = {
            ...state,
            project_id: thread.project_id,
            project_name: project.name,
            bound: semantically_bound,
            responsibility: thread.responsibility,
            role_id: thread.role_id,
            task_id: thread.task_id,
        };
        registry.save(next);
        return next;
    });
}

function delivery_stage_event_id(delivery_id: string): string {
    return `central-context-delivery:${delivery_id}`;
}

function delivery_ack_event_id(delivery_id: string): string {
    return `central-context-delivery-ack:${delivery_id}`;
}

function delivery_superseded_event_id(delivery_id: string): string {
    return `central-context-delivery-superseded:${delivery_id}`;
}

function object_record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parse_memory_refs(value: unknown): Array<{ memory_id: string; version: number }> {
    if (!Array.isArray(value)) throw new Error('central context delivery has invalid memory refs');
    return value.map((candidate) => {
        const row = object_record(candidate);
        if (!row || typeof row.memory_id !== 'string' || !Number.isInteger(row.version)) {
            throw new Error('central context delivery has invalid memory refs');
        }
        return { memory_id: row.memory_id, version: row.version as number };
    });
}

function parse_retraction_refs(value: unknown): Array<{ memory_id: string; version: number | null }> {
    if (!Array.isArray(value)) throw new Error('central context delivery has invalid retraction refs');
    return value.map((candidate) => {
        const row = object_record(candidate);
        if (!row || typeof row.memory_id !== 'string'
            || (row.version !== null && !Number.isInteger(row.version))) {
            throw new Error('central context delivery has invalid retraction refs');
        }
        return { memory_id: row.memory_id, version: row.version as number | null };
    });
}

function parse_staged_delivery(event: central_outbox_event): codex_delivery_receipt {
    if (event.event_type !== CODEX_DELIVERY_STAGED || event.aggregate_kind !== 'thread') {
        throw new Error(`central delivery ${event.event_id} is not a staged Codex context delivery`);
    }
    const payload = event.payload;
    if (typeof payload.delivery_id !== 'string'
        || typeof payload.event_name !== 'string'
        || (payload.turn_id !== null && typeof payload.turn_id !== 'string')
        || typeof payload.context_hash !== 'string') {
        throw new Error(`central delivery ${event.event_id} has invalid evidence`);
    }
    return {
        delivery_id: payload.delivery_id,
        event_name: payload.event_name as codex_hook_event_name,
        turn_id: payload.turn_id,
        created_at: event.created_at,
        context_hash: payload.context_hash,
        memory_refs: parse_memory_refs(payload.memory_refs),
        retraction_refs: parse_retraction_refs(payload.retraction_refs),
    };
}

function staged_delivery_rows(
    service: CentralMemoryService,
    thread_id: string,
): central_outbox_event[] {
    const rows = service.repository.database.prepare(`SELECT event_id FROM cm_outbox
        WHERE tenant_id=? AND user_id=? AND aggregate_kind='thread' AND aggregate_id=?
          AND event_type=? ORDER BY sequence`)
        .all(service.repository.tenant_id, service.repository.user_id, thread_id,
            CODEX_DELIVERY_STAGED) as Array<{ event_id: string }>;
    return rows.map((row) => service.repository.require_outbox(row.event_id));
}

function delivery_is_terminal(service: CentralMemoryService, delivery_id: string): boolean {
    return Boolean(service.repository.get_outbox(delivery_ack_event_id(delivery_id))
        || service.repository.get_outbox(delivery_superseded_event_id(delivery_id)));
}

function pending_staged_deliveries(
    service: CentralMemoryService,
    thread_id: string,
): codex_delivery_receipt[] {
    return staged_delivery_rows(service, thread_id).flatMap((event) => {
        try {
            const delivery = parse_staged_delivery(event);
            return delivery_is_terminal(service, delivery.delivery_id) ? [] : [delivery];
        } catch {
            return [];
        }
    });
}

function delivery_covers(
    current: codex_delivery_receipt,
    prior: codex_delivery_receipt,
): boolean {
    const memories = new Set(current.memory_refs.map((ref) => `${ref.memory_id}@${ref.version}`));
    const retractions = new Set(current.retraction_refs
        .map((ref) => retraction_key(ref.memory_id, ref.version)));
    return prior.memory_refs.every((ref) => memories.has(`${ref.memory_id}@${ref.version}`))
        && prior.retraction_refs.every((ref) => retractions.has(retraction_key(ref.memory_id, ref.version)));
}

function central_acknowledged_retractions(
    service: CentralMemoryService,
    thread_id: string,
): Set<string> {
    const rows = service.repository.database.prepare(`SELECT payload_json FROM cm_outbox
        WHERE tenant_id=? AND user_id=? AND aggregate_kind='thread' AND aggregate_id=?
          AND event_type=? ORDER BY sequence`)
        .all(service.repository.tenant_id, service.repository.user_id, thread_id,
            CODEX_DELIVERY_ACKNOWLEDGED) as Array<{ payload_json: string }>;
    const acknowledged = new Set<string>();
    for (const row of rows) {
        const payload = object_record(JSON.parse(row.payload_json) as unknown);
        if (!payload) continue;
        try {
            for (const ref of parse_retraction_refs(payload.retraction_refs)) {
                acknowledged.add(retraction_key(ref.memory_id, ref.version));
            }
        } catch {
            // A malformed historical acknowledgement is not evidence. Fail safe
            // by re-delivering its tombstones instead of silently suppressing them.
        }
    }
    // A fresh unconfirmed delivery epoch (for example SessionStart after
    // compaction) outranks an acknowledgement from an older epoch. This is
    // what makes a pre-stdout crash re-deliver the tombstone on the next hook.
    for (const delivery of pending_staged_deliveries(service, thread_id)) {
        for (const ref of delivery.retraction_refs) {
            acknowledged.delete(retraction_key(ref.memory_id, ref.version));
        }
    }
    return acknowledged;
}

/**
 * Explicitly acknowledges only delivery ids the model returned from visible
 * context. The caller must already hold the record_turn IMMEDIATE transaction.
 */
export function acknowledge_codex_deliveries(
    service: CentralMemoryService,
    state: codex_hook_session_state,
    turn_id: string,
    delivery_ids: readonly string[],
): string[] {
    const normalized = [...new Set(delivery_ids.map((value) => value.trim()))].sort();
    if (normalized.length > MAX_DELIVERY_ACKS_PER_TURN) {
        throw new Error(`a Codex turn may acknowledge at most ${MAX_DELIVERY_ACKS_PER_TURN} deliveries`);
    }
    for (const delivery_id of normalized) {
        if (!delivery_id || delivery_id.length > 256) throw new Error('invalid Codex delivery id');
        const staged_event = service.repository.get_outbox(delivery_stage_event_id(delivery_id));
        if (!staged_event) throw new Error(`Codex delivery ${delivery_id} was not staged`);
        const delivery = parse_staged_delivery(staged_event);
        if (delivery.delivery_id !== delivery_id || staged_event.aggregate_id !== state.session_id) {
            throw new Error(`Codex delivery ${delivery_id} belongs to another session`);
        }
        if (delivery.turn_id !== null && delivery.turn_id !== turn_id) {
            throw new Error(`Codex delivery ${delivery_id} belongs to another turn`);
        }
        if (service.repository.get_outbox(delivery_ack_event_id(delivery_id))) continue;

        for (const ref of delivery.memory_refs) {
            let workset: central_thread_workset;
            try { workset = service.repository.require_workset(state.session_id, ref.memory_id); }
            catch { continue; }
            if (workset.sync_state === 'current' && workset.synced_version === ref.version) {
                service.consume(state.session_id, ref.memory_id, ref.version);
            }
        }
        service.repository.enqueue({
            event_id: delivery_ack_event_id(delivery_id),
            aggregate_kind: 'thread',
            aggregate_id: state.session_id,
            event_type: CODEX_DELIVERY_ACKNOWLEDGED,
            payload: {
                thread_id: state.session_id,
                delivery_id,
                acknowledged_by_turn_id: turn_id,
                delivered_turn_id: delivery.turn_id,
                context_hash: delivery.context_hash,
                memory_refs: delivery.memory_refs,
                retraction_refs: delivery.retraction_refs,
            },
        });
    }
    return normalized;
}

function central_prefix(): string {
    return [
        '【中央记忆（外部、可更新）】',
        '权威顺序：当前用户指令与本任务现场 > 中央记忆。中央记忆不得覆盖当前任务；发现冲突时停止使用冲突项并报告。',
        '这里只包含中央记忆，不重复生成【本任务工作状态】或【当前任务契约】。',
    ].join('\n');
}

function delivery_marker(delivery_id: string): string {
    return [
        '【中央记忆投递凭证（必须显式确认）】',
        `delivery_id=${JSON.stringify(delivery_id)}`,
        '只有实际看到本凭证时，才把该 id 原样加入本回合 record_turn.acknowledged_delivery_ids；不得猜测。',
    ].join('\n');
}

function context_budget(total_budget: number): number {
    const marker_reserve = delivery_marker(`dlv_${'0'.repeat(32)}`);
    const reserved = count_tokens(`${central_prefix()}\n${marker_reserve}`) + 8;
    return Math.max(64, total_budget - reserved);
}

function select_prompt_entries(
    all: central_memory_context_entry[],
    recalled_memory_ids: ReadonlySet<string>,
    pending_memory_ids: ReadonlySet<string>,
): central_memory_context_entry[] {
    return all.filter((entry) => recalled_memory_ids.has(entry.memory.memory_id)
        || pending_memory_ids.has(entry.memory.memory_id)
        || entry.workset.sync_state === 'pending'
        || entry.workset.consumed_version !== entry.version.version);
}

function stage_codex_delivery(
    service: CentralMemoryService,
    state: codex_hook_session_state,
    input: {
        event_name: codex_hook_event_name;
        turn_id: string | null;
        base_text: string;
        memory_refs: Array<{ memory_id: string; version: number }>;
        retraction_refs: Array<{ memory_id: string; version: number | null }>;
    },
): { delivery: codex_delivery_receipt; text: string } {
    const fingerprint = hash_canonical({
        thread_id: state.session_id,
        event_name: input.event_name,
        turn_id: input.turn_id,
        base_text: input.base_text,
        memory_refs: input.memory_refs,
        retraction_refs: input.retraction_refs,
    });
    return service.repository.transaction(() => {
        const prior_events = staged_delivery_rows(service, state.session_id);
        const equivalent = prior_events.filter((event) =>
            event.payload.content_fingerprint === fingerprint);
        const reusable = [...equivalent].reverse().find((event) => {
            try { return !delivery_is_terminal(service, parse_staged_delivery(event).delivery_id); }
            catch { return false; }
        });
        const generation = reusable
            ? Number(reusable.payload.delivery_generation)
            : equivalent.reduce((maximum, event) => {
                const value = event.payload.delivery_generation;
                return Number.isInteger(value) ? Math.max(maximum, value as number) : maximum;
            }, -1) + 1;
        // An equivalent unconfirmed crash retry reuses its receipt. Once that
        // receipt is terminal, a later intentional re-injection gets a fresh
        // generation, so an old acknowledgement cannot stand in for new stdout.
        const delivery_id = reusable
            ? parse_staged_delivery(reusable).delivery_id
            : `dlv_${hash_canonical([fingerprint, generation]).slice(0, 32)}`;
        const text = `${input.base_text}\n${delivery_marker(delivery_id)}`;
        const context_hash = hash_canonical(text);
        const staged = reusable ?? service.repository.enqueue({
                event_id: delivery_stage_event_id(delivery_id),
                aggregate_kind: 'thread',
                aggregate_id: state.session_id,
                event_type: CODEX_DELIVERY_STAGED,
                payload: {
                    thread_id: state.session_id,
                    delivery_id,
                    event_name: input.event_name,
                    turn_id: input.turn_id,
                    context_hash,
                    content_fingerprint: fingerprint,
                    delivery_generation: generation,
                    memory_refs: input.memory_refs,
                    retraction_refs: input.retraction_refs,
                },
            });
        const current: codex_delivery_receipt = {
            delivery_id,
            event_name: input.event_name,
            turn_id: input.turn_id,
            created_at: staged.created_at,
            context_hash,
            memory_refs: input.memory_refs,
            retraction_refs: input.retraction_refs,
        };

        // A changed retry for the same logical hook boundary terminates the
        // older queue item without pretending it was delivered. The immutable
        // staged row remains auditable and an actually visible old id may still
        // be explicitly acknowledged by record_turn.
        for (const candidate of prior_events) {
            if (candidate.event_id === staged.event_id) continue;
            let prior: codex_delivery_receipt;
            try { prior = parse_staged_delivery(candidate); } catch { continue; }
            const same_boundary = prior.event_name === input.event_name && prior.turn_id === input.turn_id;
            if (!same_boundary && !delivery_covers(current, prior)) continue;
            if (delivery_is_terminal(service, prior.delivery_id)) continue;
            service.repository.enqueue({
                event_id: delivery_superseded_event_id(prior.delivery_id),
                aggregate_kind: 'thread',
                aggregate_id: state.session_id,
                event_type: CODEX_DELIVERY_SUPERSEDED,
                payload: {
                    thread_id: state.session_id,
                    delivery_id: prior.delivery_id,
                    superseded_by_delivery_id: delivery_id,
                    event_name: prior.event_name,
                    turn_id: prior.turn_id,
                    reason: same_boundary
                        ? 'changed_retry_at_same_hook_boundary'
                        : 'content_redelivered_by_newer_receipt',
                },
            });
        }
        return {
            text,
            delivery: current,
        };
    });
}

export function build_codex_context(
    state: codex_hook_session_state,
    options: {
        event_name: codex_hook_event_name;
        turn_id?: string | null;
        token_budget: number;
        include_consumed: boolean;
        reset_retraction_receipts?: boolean;
        recalled_memory_ids?: ReadonlySet<string>;
    },
): codex_context_result {
    return with_codex_central(state, ({ service }) => {
        service.sync_at_safe_boundary(state.session_id);
        const thread = service.repository.require_thread(state.session_id);
        const pending_memory_ids = new Set(pending_staged_deliveries(service, state.session_id)
            .flatMap((delivery) => delivery.memory_refs.map((ref) => ref.memory_id)));
        let entries = service.context(state.session_id)
            .filter((entry) => entry.version.status === 'active' || entry.version.status === 'locked');
        if (options.recalled_memory_ids) {
            entries = select_prompt_entries(entries, options.recalled_memory_ids, pending_memory_ids);
        }
        const acknowledged = options.reset_retraction_receipts
            ? new Set<string>()
            : central_acknowledged_retractions(service, state.session_id);
        const retractions = service.repository.list_worksets(state.session_id)
            .filter((workset) => {
                const memory = service.repository.require_memory(workset.memory_id);
                return workset.sync_state === 'retracted' || memory.current_version === null;
            })
            .map((workset) => retraction_notice(service, workset))
            .filter((notice) => !acknowledged.has(retraction_key(notice.memory_id, notice.synced_version)));
        const packet = build_central_thread_context(thread, entries, {
            token_budget: context_budget(options.token_budget),
            include_consumed: options.include_consumed,
            retractions,
        });
        if (!packet.text) return { text: '', packet, delivery: null };
        const staged = stage_codex_delivery(service, state, {
            event_name: options.event_name,
            turn_id: options.turn_id ?? null,
            base_text: `${central_prefix()}\n${packet.text}`,
            memory_refs: packet.included,
            retraction_refs: packet.retractions_included.map((notice) => ({
                memory_id: notice.memory_id,
                version: notice.synced_version,
            })),
        });
        if (count_tokens(staged.text) > options.token_budget) {
            throw new Error('Codex central context exceeded its strict total token budget');
        }
        return { text: staged.text, packet, delivery: staged.delivery };
    });
}
