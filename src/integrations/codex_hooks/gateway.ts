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
 *  file  : src/integrations/codex_hooks/gateway.ts
 *  usage : implements the LongMemory gateway component
 */

import { hash_canonical } from '../../core/hash/content_hash.js';
import { CentralMemoryService } from '../../core/central_memory/service.js';
import { assert_no_obvious_credentials } from '../../core/central_memory/sensitive_content.js';
import { central_recall_terms } from '../../core/central_memory/recall.js';
import type {
    central_memory_version,
    central_publish_result,
    central_thread,
} from '../../core/central_memory/types.js';
import type { CodexHookRegistry } from './registry.js';
import {
    acknowledge_codex_deliveries,
    build_codex_context,
    with_codex_central,
} from './central_runtime.js';
import type {
    codex_bind_input,
    codex_hook_session_state,
    codex_memory_candidate,
    codex_recall_input,
    codex_record_turn_input,
} from './types.js';
import { DEFAULT_CODEX_HOOK_TOKEN_BUDGET } from './types.js';

type memory_ref = {
    memory_id: string;
    version: number;
    status: central_memory_version['status'];
    effective: boolean;
    confirmation_id: string | null;
};

export type codex_record_turn_result = {
    already_finalized: boolean;
    acknowledged_delivery_ids: string[];
    memory_refs: memory_ref[];
    pending_confirmations: Array<{ confirmation_id: string; prompt: string }>;
};

export type codex_recall_result = {
    status: 'staged' | 'thread_inactive';
    candidates_considered: number;
    matches: Array<{
        memory_id: string;
        source_project_id: string;
        project_scope: 'local_project' | 'linked_project';
        version: number;
        score: number;
        matched_terms: string[];
        reasons: string[];
    }>;
    context: string;
    tokens_used: number;
};

function stable_id(prefix: string, value: unknown): string {
    return `${prefix}:${hash_canonical(value).slice(0, 24)}`;
}

function existing_or_null<T>(operation: () => T): T | null {
    try { return operation(); }
    catch (error) {
        if (error instanceof Error && /was not found/.test(error.message)) return null;
        throw error;
    }
}

function require_bounded_text(value: string, name: string, max: number): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${name} is required`);
    if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`);
    if (/data:[^;,]+;base64,/i.test(normalized)) throw new Error(`${name} must not contain a data URI`);
    return normalized;
}

function bind_role_and_task(
    service: CentralMemoryService,
    input: codex_bind_input,
): { role_id: string; task_id: string | null } {
    const repository = service.repository;
    const responsibility = require_bounded_text(input.responsibility, 'responsibility', 8_192);
    const role_id = input.role_id?.trim()
        || stable_id('role', [input.project_id, responsibility]);
    const role = repository.get_role(role_id);
    if (role && role.project_id !== input.project_id) {
        throw new Error(`central role ${role_id} belongs to another project`);
    }
    if (!role) {
        repository.register_role({
            role_id,
            project_id: input.project_id,
            name: require_bounded_text(input.role_name ?? responsibility, 'role_name', 512),
            responsibility: require_bounded_text(
                input.role_responsibility ?? responsibility,
                'role_responsibility',
                8_192,
            ),
            metadata: { source: 'codex_explicit_task_binding' },
        });
    }
    if (!input.task_id && !input.task_title) return { role_id, task_id: null };
    const task_id = input.task_id?.trim()
        || stable_id('task', [input.project_id, role_id, input.task_title]);
    const task = repository.get_task(task_id);
    if (task && (task.project_id !== input.project_id || task.role_id !== role_id)) {
        throw new Error(`central task ${task_id} belongs to another project or role`);
    }
    if (!task) {
        repository.register_task({
            task_id,
            project_id: input.project_id,
            role_id,
            title: require_bounded_text(input.task_title ?? task_id, 'task_title', 1_024),
            objective: input.task_objective?.trim() ?? '',
            metadata: { source: 'codex_explicit_task_binding' },
        });
    }
    return { role_id, task_id };
}

export function bind_codex_task(
    registry: CodexHookRegistry,
    state: codex_hook_session_state,
    input: codex_bind_input,
    save_state: (next: codex_hook_session_state) => void = (next) => registry.save(next),
): { state: codex_hook_session_state; context: string; tokens_used: number } {
    const project_id = require_bounded_text(input.project_id, 'project_id', 1_024);
    const responsibility = require_bounded_text(input.responsibility, 'responsibility', 8_192);
    const initial_query = input.initial_query === undefined
        ? null
        : require_bounded_text(input.initial_query, 'initial_query', 2_048);
    // Validate every value that this bind can persist before deriving role or
    // task ids, opening the central database, or updating the local registry.
    assert_no_obvious_credentials({
        codex_task_binding: {
            session_id: state.session_id,
            cwd: state.cwd,
            project_id,
            project_name: input.project_name,
            project_description: input.project_description,
            responsibility,
            role_id: input.role_id,
            role_name: input.role_name,
            role_responsibility: input.role_responsibility,
            task_id: input.task_id,
            task_title: input.task_title,
            task_objective: input.task_objective,
        },
    });
    if (state.project_was_configured && !state.configured_project_id) {
        throw new Error('configured Codex project anchor is missing; restart the task before binding memory');
    }
    if (state.configured_project_id && project_id !== state.configured_project_id) {
        throw new Error(
            `Codex task is configured for project ${state.configured_project_id}; `
            + `binding to ${project_id} is not allowed`,
        );
    }
    const binding = with_codex_central(state, ({ service }) => service.repository.transaction(() => {
        const repository = service.repository;
        const existing_thread = repository.get_thread(state.session_id);
        if (existing_thread && existing_thread.project_id !== project_id) {
            throw new Error(`central thread ${state.session_id} cannot move between projects`);
        }
        const project = existing_or_null(() => repository.require_project(project_id));
        if (!project) {
            repository.register_project({
                project_id,
                name: require_bounded_text(input.project_name ?? project_id, 'project_name', 1_024),
                description: input.project_description?.trim() ?? '',
                metadata: { source: 'codex_explicit_task_binding' },
            });
        }
        const { role_id, task_id } = bind_role_and_task(service, { ...input, project_id });
        const existing_is_bound = Boolean(existing_thread?.responsibility.trim())
            || existing_thread?.role_id !== null || existing_thread?.task_id !== null;
        if (existing_thread && existing_is_bound
            && (existing_thread.role_id !== role_id || existing_thread.task_id !== task_id
                || existing_thread.responsibility !== responsibility)) {
            throw new Error('an already-bound Codex task cannot be silently rebound; use the governance layer');
        }
        const thread = existing_thread && existing_is_bound ? existing_thread : service.register_thread({
            thread_id: state.session_id,
            project_id,
            role_id,
            task_id,
            responsibility,
            status: 'active',
            metadata: {
                source: 'codex_hook',
                cwd: state.cwd,
                transcript_available: state.transcript_path !== null,
            },
            subscribe_to_project: true,
        });
        if (initial_query !== null && central_recall_terms(initial_query).length > 0) {
            service.recall_and_stage({
                thread_id: thread.thread_id,
                query: initial_query,
                limit: 8,
            });
        }
        return {
            thread,
            role_id,
            task_id,
            project_name: repository.require_project(project_id).name,
        };
    }));
    const next: codex_hook_session_state = {
        ...state,
        project_id,
        project_name: binding.project_name,
        bound: true,
        responsibility,
        role_id: binding.role_id,
        task_id: binding.task_id,
    };
    save_state(next);
    const loaded = build_codex_context(next, {
        event_name: 'UserPromptSubmit',
        turn_id: input.turn_id ?? null,
        token_budget: DEFAULT_CODEX_HOOK_TOKEN_BUDGET,
        include_consumed: true,
        reset_retraction_receipts: true,
    });
    return { state: next, context: loaded.text, tokens_used: loaded.packet.tokens_used };
}

export function recall_codex_memory(
    registry: CodexHookRegistry,
    state: codex_hook_session_state,
    input: codex_recall_input,
): codex_recall_result {
    if (!state.bound) throw new Error('Codex task must be explicitly bound before recalling memory');
    const query = require_bounded_text(input.query, 'recall query', 2_048);
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 24) {
        throw new Error('recall limit must be an integer between 1 and 24');
    }
    const token_budget = input.token_budget ?? DEFAULT_CODEX_HOOK_TOKEN_BUDGET;
    if (!Number.isInteger(token_budget) || token_budget < 256
        || token_budget > DEFAULT_CODEX_HOOK_TOKEN_BUDGET) {
        throw new Error(`recall token_budget must be between 256 and ${DEFAULT_CODEX_HOOK_TOKEN_BUDGET}`);
    }
    const recalled = with_codex_central(state, ({ service }) => service.recall_and_stage({
        thread_id: state.session_id,
        query,
        limit,
    }));
    const ids = new Set(recalled.matches.map((match) => match.memory.memory_id));
    const loaded = build_codex_context(state, {
        event_name: 'UserPromptSubmit',
        turn_id: input.turn_id ?? null,
        token_budget,
        include_consumed: true,
        recalled_memory_ids: ids,
    });
    return {
        status: recalled.status,
        candidates_considered: recalled.candidates_considered,
        matches: recalled.matches.map((match) => ({
            memory_id: match.memory.memory_id,
            source_project_id: match.memory.project_id,
            project_scope: match.project_scope,
            version: match.version.version,
            score: match.score,
            matched_terms: match.matched_terms,
            reasons: match.reasons,
        })),
        context: loaded.text,
        tokens_used: loaded.packet.tokens_used,
    };
}

function hierarchy_for(thread: central_thread, candidate: codex_memory_candidate): {
    role_id: string | null;
    task_id: string | null;
} {
    if (candidate.level === 1) return { role_id: null, task_id: null };
    if (!thread.role_id) throw new Error(`level ${candidate.level} memory requires a bound role`);
    if (candidate.level === 2) return { role_id: thread.role_id, task_id: null };
    if (candidate.level === 3 && !thread.task_id) throw new Error('level 3 memory requires a bound task');
    return { role_id: thread.role_id, task_id: thread.task_id };
}

function publish_candidate(
    service: CentralMemoryService,
    state: codex_hook_session_state,
    turn_id: string,
    candidate: codex_memory_candidate,
    index: number,
): central_publish_result {
    const thread = service.repository.require_thread(state.session_id);
    const title = require_bounded_text(candidate.title, 'memory title', 1_024);
    const summary = require_bounded_text(candidate.summary, 'memory summary', 8_192);
    const body = require_bounded_text(candidate.body, 'memory body', 64_000);
    const memory_kind = require_bounded_text(candidate.memory_kind, 'memory_kind', 256);
    const memory_id = candidate.memory_id?.trim()
        || stable_id('memory', [state.project_id, state.session_id, turn_id, index, title]);
    const prior = service.repository.get_memory(memory_id);
    if (prior && candidate.expected_current_version === undefined) {
        throw new Error(`expected_current_version is required when updating ${memory_id}`);
    }
    const hierarchy = hierarchy_for(thread, candidate);
    const governed_conflict = memory_kind.toLocaleLowerCase().includes('conflict')
        || (candidate.conflict_with?.length ?? 0) > 0;
    const source_id = stable_id('source', [state.session_id, turn_id, index]);
    return service.publish({
        memory_id,
        project_id: state.project_id,
        ...hierarchy,
        level: candidate.level,
        memory_kind,
        title,
        summary,
        body,
        importance: candidate.importance,
        major: Boolean(candidate.major) || governed_conflict,
        lock: candidate.lock,
        change_reason: candidate.change_reason,
        metadata: {
            ...(candidate.metadata ?? {}),
            extraction: 'codex_stop_semantic_review',
            source_turn_id: turn_id,
        },
        created_by: state.session_id,
        expected_current_version: candidate.expected_current_version,
        source_thread_id: state.session_id,
        sources: [{
            source: {
                source_id,
                source_kind: 'codex_turn',
                uri: `codex://threads/${state.session_id}#${turn_id}`,
                thread_id: state.session_id,
                turn_id,
                locator: { transcript_path_recorded: state.transcript_path !== null },
                excerpt_hash: hash_canonical([title, summary, body]),
                metadata: { model_extracted: true },
                recorded_at: Date.now(),
            },
            evidence_role: 'support',
        }],
    });
}

function finalization_event_id(session_id: string, turn_id: string): string {
    return `central-turn-finalized:${hash_canonical([session_id, turn_id])}`;
}

function refs_from_event(payload: Record<string, unknown>): memory_ref[] {
    if (!Array.isArray(payload.memory_refs)) return [];
    return payload.memory_refs.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.memory_id !== 'string' || !Number.isInteger(row.version)
            || typeof row.status !== 'string' || typeof row.effective !== 'boolean') return [];
        return [{
            memory_id: row.memory_id,
            version: row.version as number,
            status: row.status as central_memory_version['status'],
            effective: row.effective,
            confirmation_id: typeof row.confirmation_id === 'string' ? row.confirmation_id : null,
        }];
    });
}

export function record_codex_turn(
    state: codex_hook_session_state,
    input: codex_record_turn_input,
): codex_record_turn_result {
    if (!state.bound) throw new Error('Codex task must be explicitly bound before recording memory');
    const turn_id = require_bounded_text(input.turn_id, 'turn_id', 1_024);
    if (input.memories.length > 20) throw new Error('a Codex turn may publish at most 20 formal memories');
    const normalized_note = input.note?.trim().slice(0, 8_192) ?? '';
    const requested_delivery_ids = input.acknowledged_delivery_ids ?? [];
    if (!Array.isArray(requested_delivery_ids)
        || requested_delivery_ids.some((value) => typeof value !== 'string')) {
        throw new Error('acknowledged_delivery_ids must be an array of visible delivery ids');
    }
    assert_no_obvious_credentials({
        codex_turn_record: {
            session_id: state.session_id,
            project_id: state.project_id,
            turn_id,
            memories: input.memories,
            acknowledged_delivery_ids: requested_delivery_ids,
            note: normalized_note,
        },
    });
    const request_hash = hash_canonical({
        session_id: state.session_id,
        turn_id,
        memories: input.memories,
        note: normalized_note,
    });
    return with_codex_central(state, ({ service }) => {
        const repository = service.repository;
        const transaction = repository.database.transaction((): codex_record_turn_result => {
            const thread = repository.require_thread(state.session_id);
            if (thread.project_id !== state.project_id) throw new Error('Codex capability project binding mismatch');
            if (input.memories.length > 0) {
                const history_usage = repository.database.prepare(`SELECT status
                    FROM cm_history_backfill_turn_usage
                    WHERE tenant_id=? AND user_id=?
                      AND worker_session_id=? AND worker_turn_id=?
                    LIMIT 1`)
                    .get(repository.tenant_id, repository.user_id, state.session_id, turn_id) as {
                        status: string;
                    } | undefined;
                if (history_usage) {
                    throw new Error(
                        `turn ${state.session_id}/${turn_id} is reserved for the history workflow (${history_usage.status})`,
                    );
                }
            }
            const acknowledged_delivery_ids = acknowledge_codex_deliveries(
                service,
                state,
                turn_id,
                requested_delivery_ids,
            );
            const event_id = finalization_event_id(state.session_id, turn_id);
            const existing = repository.get_outbox(event_id);
            if (existing) {
                if (existing.payload.request_hash !== request_hash) {
                    throw new Error(`turn ${state.session_id}/${turn_id} was already finalized with a different result`);
                }
                const memory_refs = refs_from_event(existing.payload);
                return {
                    already_finalized: true,
                    acknowledged_delivery_ids,
                    memory_refs,
                    pending_confirmations: memory_refs.flatMap((ref) => ref.confirmation_id
                        ? [{ confirmation_id: ref.confirmation_id, prompt: '' }] : []),
                };
            }
            const results = input.memories.map((candidate, index) => {
                const published = publish_candidate(service, state, turn_id, candidate, index);
                for (const conflict of candidate.conflict_with ?? []) {
                    service.report_conflict({
                        conflict_id: stable_id('conflict', [state.session_id, turn_id, index,
                            conflict.memory_id, conflict.version]),
                        memory_a_id: published.memory.memory_id,
                        memory_a_version: published.version.version,
                        memory_b_id: conflict.memory_id,
                        memory_b_version: conflict.version,
                        severity: conflict.severity,
                        rationale: require_bounded_text(conflict.rationale, 'conflict rationale', 8_192),
                        metadata: { source_thread_id: state.session_id, source_turn_id: turn_id },
                    });
                }
                return published;
            });
            const memory_refs: memory_ref[] = results.map((result) => ({
                memory_id: result.memory.memory_id,
                version: result.version.version,
                status: result.version.status,
                effective: result.effective,
                confirmation_id: result.confirmation?.confirmation_id ?? null,
            }));
            repository.enqueue({
                event_id,
                aggregate_kind: 'thread',
                aggregate_id: state.session_id,
                event_type: 'central_memory.turn_finalized',
                payload: {
                    thread_id: state.session_id,
                    turn_id,
                    memory_extracted: memory_refs.length > 0,
                    memory_id: memory_refs[0]?.memory_id ?? null,
                    memory_version: memory_refs[0]?.version ?? null,
                    memory_refs,
                    note: normalized_note,
                    request_hash,
                },
            });
            return {
                already_finalized: false,
                acknowledged_delivery_ids,
                memory_refs,
                pending_confirmations: results.flatMap((result) => result.confirmation
                    ? [{
                        confirmation_id: result.confirmation.confirmation_id,
                        prompt: result.confirmation.prompt,
                    }] : []),
            };
        });
        return transaction.immediate();
    });
}
