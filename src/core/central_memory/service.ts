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
 *  file  : src/core/central_memory/service.ts
 *  usage : implements the LongMemory service component
 */

import { randomUUID } from 'node:crypto';
import { hash_canonical } from '../hash/content_hash.js';
import { CentralMemoryRepository } from '../../stores/sqlite/central_memory_repository.js';
import type {
    central_confirmation,
    central_confirmation_decision,
    central_conflict_decision,
    central_dependency,
    central_effective_status,
    central_memory,
    central_memory_conflict,
    central_memory_context_entry,
    central_memory_level,
    central_memory_version,
    central_metadata,
    central_project_link,
    central_publish_result,
    central_source,
    central_subscription,
    central_thread,
    central_thread_workset,
} from './types.js';
import { central_memory_conflict_error } from './types.js';
import { assert_no_obvious_credentials } from './sensitive_content.js';
import {
    central_recall_limits,
    central_recall_terms,
    compare_central_recall_matches,
    score_central_recall_candidate,
    type central_recall_input,
    type central_recall_result,
} from './recall.js';

export type central_publish_input = {
    memory_id: string;
    project_id: string;
    role_id?: string | null;
    task_id?: string | null;
    level: central_memory_level;
    memory_kind: string;
    title: string;
    summary: string;
    body: string;
    importance?: number;
    major?: boolean;
    lock?: boolean;
    /** Adds a confirmation boundary without weakening level-one, major, or locked governance. */
    require_confirmation?: boolean;
    confirmation_kind?: 'conflict' | 'manual';
    change_reason?: string;
    metadata?: Record<string, unknown>;
    created_by: string;
    expected_current_version?: number | null;
    confirmation_prompt?: string;
    source_thread_id?: string;
    sources?: Array<{
        source: central_source;
        evidence_role?: string;
        locator?: Record<string, unknown>;
    }>;
    at?: number;
};

export type central_register_thread_input = {
    thread_id: string;
    project_id: string;
    role_id?: string | null;
    task_id?: string | null;
    responsibility?: string;
    status?: central_thread['status'];
    metadata?: Record<string, unknown>;
    subscribe_to_project?: boolean;
    at?: number;
};

export type central_status_request_input = {
    memory_id: string;
    expected_current_version: number;
    requested_by: string;
    reason: string;
    confirmation_prompt?: string;
    source_thread_id?: string;
    metadata?: Record<string, unknown>;
    at?: number;
};

export type central_conflict_report_input = {
    conflict_id?: string;
    memory_a_id: string;
    memory_a_version: number;
    memory_b_id: string;
    memory_b_version: number;
    severity: number;
    rationale: string;
    metadata?: Record<string, unknown>;
    at?: number;
};

export type central_project_link_input = {
    source_project_id: string;
    target_project_id: string;
    direction?: 'one_way' | 'two_way';
    link_id?: string;
    metadata?: Record<string, unknown>;
    decision: central_confirmation_decision;
    at?: number;
};

type normalized_source_link = {
    source: central_source;
    evidence_role: string;
    locator: central_metadata;
};

function normalize_metadata(value: Record<string, unknown> | central_metadata | undefined): central_metadata {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value ?? {});
    } catch (error) {
        throw new Error(`central metadata must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (serialized === undefined) throw new Error('central metadata must be a JSON object');
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('central metadata must be a JSON object');
    }
    return parsed as central_metadata;
}

function normalize_source_links(input: central_publish_input['sources']): normalized_source_link[] {
    return (input ?? []).map((link) => ({
        source: {
            ...link.source,
            locator: normalize_metadata(link.source.locator),
            metadata: normalize_metadata(link.source.metadata),
        },
        evidence_role: link.evidence_role ?? 'support',
        locator: normalize_metadata(link.locator),
    }));
}

function same_identity(memory: central_memory, input: central_publish_input): boolean {
    return memory.project_id === input.project_id
        && memory.role_id === (input.role_id ?? null)
        && memory.task_id === (input.task_id ?? null)
        && memory.level === input.level
        && memory.memory_kind === input.memory_kind;
}

function confirmation_kind(
    current: central_memory_version | null,
    input: central_publish_input,
    governed_major: boolean,
): central_confirmation['confirmation_kind'] {
    if (current?.status === 'locked') return 'locked_override';
    if (governed_major || input.lock) return 'major_rule';
    return input.confirmation_kind ?? 'manual';
}

function version_content_hash(input: {
    title: string;
    summary: string;
    body: string;
    importance: number;
    is_major: boolean;
    change_reason: string;
    metadata: central_metadata;
}): string {
    return hash_canonical({ schema: 1, ...input });
}

function validate_decision(decision: central_confirmation_decision): {
    actor_id: string;
    note: string;
    evidence: central_metadata;
} {
    if (decision.actor_kind !== 'user') throw new Error('central confirmation decisions require a human user actor');
    if (!decision.actor_id.trim()) throw new Error('central confirmation actor_id is required');
    if (!decision.action_id.trim()) throw new Error('central confirmation action_id is required');
    if (!['codex_ui', 'obsidian', 'local_cli'].includes(decision.channel)) {
        throw new Error(`unsupported central confirmation channel: ${String(decision.channel)}`);
    }
    const supplied_evidence = normalize_metadata(decision.evidence);
    if (Object.keys(supplied_evidence).length === 0) {
        throw new Error('central confirmation requires evidence of the user action');
    }
    // Confirmation and conflict decisions are immutable audit records too.
    // Apply the same no-credential boundary as formal-memory publication so
    // notes, actor/action identifiers, or UI evidence cannot become a bypass.
    assert_no_obvious_credentials({
        central_confirmation_decision: {
            actor_id: decision.actor_id,
            actor_kind: decision.actor_kind,
            action_id: decision.action_id,
            channel: decision.channel,
            note: decision.note ?? '',
            evidence: supplied_evidence,
        },
    });
    return {
        actor_id: decision.actor_id,
        note: decision.note ?? '',
        evidence: {
            actor_kind: decision.actor_kind,
            action_id: decision.action_id,
            channel: decision.channel,
            evidence: supplied_evidence,
        },
    };
}

export class CentralMemoryService {
    private readonly readonly_mode: boolean;

    constructor(
        readonly repository: CentralMemoryRepository,
        options: { readonly?: boolean } = {},
    ) {
        this.readonly_mode = options.readonly ?? false;
    }

    private assert_writable(): void {
        if (this.readonly_mode) throw new Error('central memory mutations are unavailable in readonly mode');
    }

    register_thread(input: central_register_thread_input): central_thread {
        this.assert_writable();
        const metadata = normalize_metadata(input.metadata);
        assert_no_obvious_credentials({
            central_thread_registration: { ...input, metadata },
        });
        return this.repository.transaction(() => {
            const thread = this.repository.register_thread({ ...input, metadata });
            const at = input.at ?? Date.now();
            if (input.subscribe_to_project !== false) {
                this.subscribe({
                    subscription_id: `thread:${input.thread_id}:project:${input.project_id}`,
                    thread_id: input.thread_id,
                    selector_kind: 'project',
                    selector_value: input.project_id,
                    min_relevance: 0.2,
                    at,
                });
            }
            if (input.role_id) {
                this.subscribe({
                    subscription_id: `thread:${input.thread_id}:role:${input.role_id}`,
                    thread_id: input.thread_id,
                    selector_kind: 'role',
                    selector_value: input.role_id,
                    min_relevance: 0.6,
                    at,
                });
            }
            if (input.task_id) {
                this.subscribe({
                    subscription_id: `thread:${input.thread_id}:task:${input.task_id}`,
                    thread_id: input.thread_id,
                    selector_kind: 'task',
                    selector_value: input.task_id,
                    min_relevance: 0.8,
                    at,
                });
            }
            if (thread.status !== 'active' && thread.status !== 'idle') return thread;
            for (const memory of this.repository.list_effective_memories(input.project_id)) {
                const matches = this.repository.list_matching_subscriptions(memory)
                    .filter((subscription) => subscription.thread_id === input.thread_id);
                if (matches.length === 0 || memory.current_version === null) continue;
                const base_relevance = memory.level === 1 ? 1 : memory.level === 2 ? 0.8 : memory.level === 3 ? 0.35 : 0.5;
                this.repository.stage_workset({
                    thread_id: input.thread_id,
                    memory_id: memory.memory_id,
                    pending_version: memory.current_version,
                    relevance: Math.max(base_relevance, ...matches.map((match) => match.min_relevance)),
                    origin: memory.level <= 2 ? 'project_map' : 'subscription',
                    at,
                });
            }
            return thread;
        });
    }

    subscribe(input: {
        subscription_id?: string;
        thread_id: string;
        selector_kind: central_subscription['selector_kind'];
        selector_value: string;
        min_relevance?: number;
        enabled?: boolean;
        at?: number;
    }): central_subscription {
        this.assert_writable();
        assert_no_obvious_credentials({ central_subscription: input });
        const at = input.at ?? Date.now();
        return this.repository.upsert_subscription({
            subscription_id: input.subscription_id ?? randomUUID(),
            thread_id: input.thread_id,
            selector_kind: input.selector_kind,
            selector_value: input.selector_value,
            min_relevance: input.min_relevance ?? 0,
            enabled: input.enabled ?? true,
            cursor_version: null,
            created_at: at,
            updated_at: at,
        });
    }

    link_projects(input: central_project_link_input): central_project_link[] {
        this.assert_writable();
        if (!input.source_project_id.trim() || !input.target_project_id.trim()) {
            throw new Error('central project link source and target are required');
        }
        if (input.source_project_id === input.target_project_id) {
            throw new Error('a central project cannot link to itself');
        }
        const decision = validate_decision(input.decision);
        const metadata = normalize_metadata(input.metadata);
        assert_no_obvious_credentials({ central_project_link: { ...input, metadata } });
        const at = input.at ?? Date.now();
        const direction = input.direction ?? 'one_way';
        const pairs = direction === 'two_way'
            ? [
                [input.source_project_id, input.target_project_id],
                [input.target_project_id, input.source_project_id],
            ] as const
            : [[input.source_project_id, input.target_project_id]] as const;
        const base_id = input.link_id ?? randomUUID();

        return this.repository.transaction(() => pairs.map(([source_project_id, target_project_id], index) => {
            const source = this.repository.require_project(source_project_id);
            const target = this.repository.require_project(target_project_id);
            if (source.status !== 'active' || target.status !== 'active') {
                throw new Error('central project links require two active projects');
            }
            const existing = this.repository.find_active_project_link(source_project_id, target_project_id);
            if (existing) return existing;
            const link = this.repository.create_project_link({
                link_id: direction === 'two_way' ? `${base_id}:${index + 1}` : base_id,
                source_project_id,
                target_project_id,
                metadata,
                created_by: decision.actor_id,
                created_action_id: input.decision.action_id,
                created_channel: input.decision.channel,
                created_evidence: decision.evidence,
                at,
            });
            this.repository.enqueue({
                event_id: `project-link:${link.link_id}:created`,
                aggregate_kind: 'project_link',
                aggregate_id: link.link_id,
                event_type: 'central_memory.project_link_created',
                payload: {
                    source_project_id,
                    target_project_id,
                    memory_level: 4,
                },
                at,
            });
            return link;
        }));
    }

    revoke_project_link(
        link_id: string,
        decision_input: central_confirmation_decision,
        at = Date.now(),
    ): { link: central_project_link; retracted_worksets: number } {
        this.assert_writable();
        if (!link_id.trim()) throw new Error('central project link_id is required');
        const decision = validate_decision(decision_input);
        return this.repository.transaction(() => {
            const prior = this.repository.require_project_link(link_id);
            if (prior.status === 'revoked') {
                if (prior.revoked_action_id === decision_input.action_id) {
                    return { link: prior, retracted_worksets: 0 };
                }
                throw new Error(`central project link ${link_id} is not active`);
            }
            const link = this.repository.revoke_project_link({
                link_id,
                revoked_by: decision.actor_id,
                revoked_action_id: decision_input.action_id,
                revoked_channel: decision_input.channel,
                revoked_evidence: decision.evidence,
                at,
            });
            const retracted_worksets = this.repository.retract_linked_project_worksets(
                link.source_project_id,
                link.target_project_id,
                at,
            );
            this.repository.enqueue({
                event_id: `project-link:${link.link_id}:revoked`,
                aggregate_kind: 'project_link',
                aggregate_id: link.link_id,
                event_type: 'central_memory.project_link_revoked',
                payload: {
                    source_project_id: link.source_project_id,
                    target_project_id: link.target_project_id,
                    retracted_worksets,
                },
                at,
            });
            return { link, retracted_worksets };
        });
    }

    publish(input: central_publish_input): central_publish_result {
        this.assert_writable();
        const at = input.at ?? Date.now();
        if (!input.memory_id.trim() || !input.project_id.trim() || !input.created_by.trim()) {
            throw new Error('central memory identity, project and creator are required');
        }
        if (!input.title.trim() || !input.summary.trim() || !input.body.trim()) {
            throw new Error('central memory title, summary and body must be non-empty');
        }
        const importance = input.importance ?? 0.5;
        if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
            throw new Error('central memory importance must be between 0 and 1');
        }
        const metadata = normalize_metadata(input.metadata);
        const source_links = normalize_source_links(input.sources);
        const change_reason = input.change_reason ?? '';
        assert_no_obvious_credentials({
            memory_id: input.memory_id,
            project_id: input.project_id,
            role_id: input.role_id,
            task_id: input.task_id,
            created_by: input.created_by,
            source_thread_id: input.source_thread_id,
            title: input.title,
            summary: input.summary,
            body: input.body,
            change_reason,
            confirmation_prompt: input.confirmation_prompt,
            metadata,
            sources: source_links,
        });
        const target_status: central_effective_status = input.lock ? 'locked' : 'active';

        return this.repository.transaction(() => {
            let memory = this.repository.get_memory(input.memory_id);
            if (memory) {
                if (!same_identity(memory, input)) {
                    throw new Error(`central memory ${input.memory_id} hierarchy and kind are immutable`);
                }
                if (input.expected_current_version === undefined) {
                    throw new Error(`expected_current_version is required when updating central memory ${input.memory_id}`);
                }
                if (memory.current_version !== input.expected_current_version) {
                    throw new central_memory_conflict_error(
                        input.memory_id,
                        input.expected_current_version,
                        memory.current_version,
                    );
                }
            } else {
                const expected = input.expected_current_version ?? null;
                if (expected !== null) throw new central_memory_conflict_error(input.memory_id, expected, null);
                memory = this.repository.insert_memory({
                    memory_id: input.memory_id,
                    project_id: input.project_id,
                    role_id: input.role_id,
                    task_id: input.task_id,
                    level: input.level,
                    memory_kind: input.memory_kind,
                    title: input.title,
                    metadata,
                    at,
                });
            }

            const current = memory.current_version === null
                ? null
                : this.repository.require_version(memory.memory_id, memory.current_version);
            // Major governance is intentionally sticky.  A caller cannot turn a
            // major rule into an ordinary update merely by omitting `major` on
            // the next version; level-one project rules are governed as major
            // at the authoritative service boundary as well as at MCP.
            const has_activated_major = this.repository.list_versions(memory.memory_id)
                .some((version) => version.is_major && version.activated_at !== null);
            const revives_retracted_memory = memory.current_version === null
                && this.repository.list_versions(memory.memory_id)
                    .some((version) => version.status === 'retracted' && version.activated_at !== null);
            const is_major = Boolean(input.major) || input.level === 1
                || Boolean(current?.is_major) || has_activated_major;
            const content_hash = version_content_hash({
                title: input.title,
                summary: input.summary,
                body: input.body,
                importance,
                is_major,
                change_reason,
                metadata,
            });
            const status_is_noop = current?.status === 'locked' || current?.status === target_status;
            if (current?.content_hash === content_hash && status_is_noop) {
                this.attach_sources(memory.memory_id, current.version, source_links);
                return { memory, version: current, confirmation: null, effective: true };
            }

            // A tombstone is a user-approved safety boundary.  Once an
            // effective version for this stable memory id has been retracted,
            // its next effective version must be an explicit human-approved
            // revival.  Normal replacements after that revival remain under
            // their ordinary governance rules.
            const requires_confirmation = is_major || Boolean(input.lock) || Boolean(input.require_confirmation)
                || current?.status === 'locked' || revives_retracted_memory;
            if (requires_confirmation) {
                const reusable = this.repository.list_versions(memory.memory_id)
                    .filter((version) => version.status === 'pending_confirmation' && version.content_hash === content_hash)
                    .reverse()
                    .find((version) => {
                        const confirmation = this.repository.pending_confirmation_for(
                            memory!.memory_id,
                            version.version,
                            target_status,
                        );
                        return confirmation?.expected_current_version === memory!.current_version
                            && confirmation.confirmation_kind === confirmation_kind(current, input, is_major);
                    });
                if (reusable) {
                    this.attach_sources(memory.memory_id, reusable.version, source_links);
                    return {
                        memory,
                        version: reusable,
                        confirmation: this.repository.pending_confirmation_for(memory.memory_id, reusable.version, target_status),
                        effective: false,
                    };
                }
            }

            const version_number = this.repository.next_version(memory.memory_id);
            const version = this.repository.insert_version({
                memory_id: memory.memory_id,
                version: version_number,
                status: 'pending_confirmation',
                title: input.title,
                summary: input.summary,
                body: input.body,
                content_hash,
                importance,
                is_major,
                change_reason,
                metadata,
                created_by: input.created_by,
                created_at: at,
            });
            this.attach_sources(memory.memory_id, version_number, source_links);

            if (requires_confirmation) {
                const confirmation = this.create_confirmation({
                    confirmation_id: `confirmation:${memory.memory_id}:${version_number}:${target_status}`,
                    memory_id: memory.memory_id,
                    proposed_version: version_number,
                    expected_current_version: memory.current_version,
                    requested_status: target_status,
                    confirmation_kind: confirmation_kind(current, input, is_major),
                    prompt: input.confirmation_prompt
                        ?? `是否确认将“${input.title}”作为中央记忆 ${memory.memory_id}@${version_number}？`,
                    requested_by: input.created_by,
                    metadata: input.source_thread_id ? { source_thread_id: input.source_thread_id } : {},
                    at,
                });
                return { memory, version, confirmation, effective: false };
            }

            const activated = this.activate_candidate(memory, version, target_status, at, input.source_thread_id);
            memory = this.repository.require_memory(memory.memory_id);
            return { memory, version: activated, confirmation: null, effective: true };
        });
    }

    request_lock(input: central_status_request_input): central_publish_result {
        return this.request_status_change(input, 'locked');
    }

    request_retraction(input: central_status_request_input): central_publish_result {
        return this.request_status_change(input, 'retracted');
    }

    approve(
        confirmation_id: string,
        decision: central_confirmation_decision,
        at = Date.now(),
    ): central_publish_result {
        this.assert_writable();
        const audited_decision = validate_decision(decision);
        return this.repository.transaction(() => {
            const pending = this.repository.require_confirmation(confirmation_id);
            if (pending.status !== 'pending') throw new Error(`central confirmation ${confirmation_id} is not pending`);
            const memory = this.repository.require_memory(pending.memory_id);
            if (memory.current_version !== pending.expected_current_version) {
                throw new central_memory_conflict_error(
                    memory.memory_id,
                    pending.expected_current_version,
                    memory.current_version,
                );
            }
            const candidate = this.repository.require_version(memory.memory_id, pending.proposed_version);
            this.repository.decide_confirmation(confirmation_id, 'approved', audited_decision, at);

            let version: central_memory_version;
            if (pending.requested_status === 'retracted') {
                if (candidate.version !== memory.current_version) {
                    throw new Error(`retraction confirmation ${confirmation_id} does not target the current version`);
                }
                version = this.retract_effective(memory, candidate, at, pending.metadata.reason);
            } else if (pending.requested_status === 'locked'
                && candidate.version === memory.current_version
                && candidate.status === 'active') {
                version = this.lock_effective(memory, candidate, at);
            } else {
                if (candidate.status !== 'pending_confirmation') {
                    throw new Error(`central memory ${memory.memory_id}@${candidate.version} is not pending confirmation`);
                }
                const source_thread_id = typeof pending.metadata.source_thread_id === 'string'
                    ? pending.metadata.source_thread_id
                    : undefined;
                version = this.activate_candidate(memory, candidate, pending.requested_status, at, source_thread_id);
            }

            this.repository.enqueue({
                event_id: `confirmation:${confirmation_id}:approved`,
                aggregate_kind: 'confirmation',
                aggregate_id: confirmation_id,
                aggregate_version: candidate.version,
                event_type: 'central_memory.confirmation_approved',
                payload: { memory_id: memory.memory_id, requested_status: pending.requested_status },
                at,
            });
            return {
                memory: this.repository.require_memory(memory.memory_id),
                version,
                confirmation: this.repository.require_confirmation(confirmation_id),
                effective: true,
            };
        });
    }

    reject(
        confirmation_id: string,
        decision: central_confirmation_decision,
        at = Date.now(),
    ): central_publish_result {
        this.assert_writable();
        const audited_decision = validate_decision(decision);
        return this.repository.transaction(() => {
            const confirmation = this.repository.require_confirmation(confirmation_id);
            if (confirmation.status !== 'pending') throw new Error(`central confirmation ${confirmation_id} is not pending`);
            const version = this.repository.require_version(confirmation.memory_id, confirmation.proposed_version);
            this.repository.decide_confirmation(confirmation_id, 'rejected', audited_decision, at);
            const resulting_version = version.status === 'pending_confirmation'
                ? this.repository.reject_candidate(version.memory_id, version.version, at)
                : version;
            this.repository.enqueue({
                event_id: `confirmation:${confirmation_id}:rejected`,
                aggregate_kind: 'confirmation',
                aggregate_id: confirmation_id,
                aggregate_version: version.version,
                event_type: 'central_memory.confirmation_rejected',
                payload: { memory_id: version.memory_id, requested_status: confirmation.requested_status },
                at,
            });
            return {
                memory: this.repository.require_memory(version.memory_id),
                version: resulting_version,
                confirmation: this.repository.require_confirmation(confirmation_id),
                effective: false,
            };
        });
    }

    cancel(
        confirmation_id: string,
        decision: central_confirmation_decision,
        at = Date.now(),
    ): central_publish_result {
        this.assert_writable();
        const audited_decision = validate_decision(decision);
        return this.repository.transaction(() => {
            const confirmation = this.repository.require_confirmation(confirmation_id);
            if (confirmation.status !== 'pending') throw new Error(`central confirmation ${confirmation_id} is not pending`);
            const version = this.repository.require_version(confirmation.memory_id, confirmation.proposed_version);
            this.repository.decide_confirmation(confirmation_id, 'cancelled', audited_decision, at);
            const resulting_version = version.status === 'pending_confirmation'
                ? this.repository.reject_candidate(version.memory_id, version.version, at)
                : version;
            this.repository.enqueue({
                event_id: `confirmation:${confirmation_id}:cancelled`,
                aggregate_kind: 'confirmation',
                aggregate_id: confirmation_id,
                aggregate_version: version.version,
                event_type: 'central_memory.confirmation_cancelled',
                payload: { memory_id: version.memory_id, requested_status: confirmation.requested_status },
                at,
            });
            return {
                memory: this.repository.require_memory(version.memory_id),
                version: resulting_version,
                confirmation: this.repository.require_confirmation(confirmation_id),
                effective: false,
            };
        });
    }

    sync_at_safe_boundary(thread_id: string, at = Date.now()): central_thread_workset[] {
        this.assert_writable();
        return this.repository.transaction(() => {
            const thread = this.repository.require_thread(thread_id);
            if (thread.status !== 'active' && thread.status !== 'idle') {
                return this.repository.list_worksets(thread_id);
            }
            this.repository.touch_safe_boundary(thread_id, at);
            return this.repository.list_worksets(thread_id).map((workset) =>
                workset.sync_state === 'pending' && workset.pending_version !== null
                    ? this.repository.sync_workset(thread_id, workset.memory_id, workset.pending_version, at)
                    : workset,
            );
        });
    }

    consume(
        thread_id: string,
        memory_id: string,
        expected_synced_version: number,
        at = Date.now(),
    ): central_thread_workset {
        this.assert_writable();
        return this.repository.consume_workset(thread_id, memory_id, expected_synced_version, at);
    }

    context(thread_id: string): central_memory_context_entry[] {
        return this.repository.thread_context(thread_id);
    }

    recall_and_stage(input: central_recall_input): central_recall_result {
        this.assert_writable();
        if (!input.thread_id.trim()) throw new Error('central recall thread_id is required');
        if (!input.query.trim()) throw new Error('central recall query must be non-empty');
        if (input.query.length > central_recall_limits.max_query_characters) {
            throw new Error(`central recall query cannot exceed ${central_recall_limits.max_query_characters} characters`);
        }
        const limit = input.limit ?? central_recall_limits.default_results;
        if (!Number.isInteger(limit) || limit < 1 || limit > central_recall_limits.max_results) {
            throw new Error(`central recall limit must be an integer between 1 and ${central_recall_limits.max_results}`);
        }
        const terms = central_recall_terms(input.query);
        if (terms.length === 0) throw new Error('central recall query must contain a searchable word or character');
        const at = input.at ?? Date.now();

        return this.repository.transaction(() => {
            const thread = this.repository.require_thread(input.thread_id);
            if (thread.status !== 'active' && thread.status !== 'idle') {
                return {
                    thread_id: thread.thread_id,
                    query: input.query,
                    status: 'thread_inactive',
                    candidates_considered: 0,
                    matches: [],
                };
            }
            const candidate_limit = Math.min(
                central_recall_limits.max_candidate_count,
                Math.max(64, limit * 16),
            );
            const candidates = this.repository.recall_candidates(thread.thread_id, terms, candidate_limit);
            const subscriptions = this.repository.list_thread_subscriptions(
                thread.thread_id,
                central_recall_limits.max_subscriptions,
            );
            const ranked = candidates.flatMap((candidate) => {
                const score = score_central_recall_candidate({
                    thread,
                    candidate,
                    query: input.query,
                    terms,
                    subscriptions,
                });
                return score ? [{ ...candidate, ...score }] : [];
            }).sort(compare_central_recall_matches).slice(0, limit);
            const matches = ranked.flatMap((match) => {
                const workset = this.repository.stage_recalled_workset({
                    thread_id: thread.thread_id,
                    memory_id: match.memory.memory_id,
                    version: match.version.version,
                    relevance: match.score,
                    origin: match.stage_origin,
                    at,
                });
                return workset ? [{ ...match, workset }] : [];
            });
            return {
                thread_id: thread.thread_id,
                query: input.query,
                status: 'staged',
                candidates_considered: candidates.length,
                matches,
            };
        });
    }

    add_dependency(input: Omit<central_dependency, 'dependency_id' | 'status' | 'created_at' | 'updated_at'> & {
        dependency_id?: string;
        at?: number;
    }): central_dependency {
        this.assert_writable();
        const at = input.at ?? Date.now();
        const details = normalize_metadata(input.details);
        assert_no_obvious_credentials({ central_dependency: { ...input, details } });
        const version = this.repository.require_version(input.memory_id, input.memory_version);
        if (version.status !== 'active' && version.status !== 'locked') {
            throw new Error('dependencies can only consume active or locked memory versions');
        }
        return this.repository.insert_dependency({
            dependency_id: input.dependency_id ?? randomUUID(),
            subject_kind: input.subject_kind,
            subject_id: input.subject_id,
            memory_id: input.memory_id,
            memory_version: input.memory_version,
            status: 'current',
            details,
            created_at: at,
            updated_at: at,
        });
    }

    report_conflict(input: central_conflict_report_input): central_memory_conflict {
        this.assert_writable();
        const metadata = normalize_metadata(input.metadata);
        assert_no_obvious_credentials({ central_memory_conflict: { ...input, metadata } });
        if (!Number.isFinite(input.severity) || input.severity < 0 || input.severity > 1) {
            throw new Error('central conflict severity must be between 0 and 1');
        }
        if (!input.rationale.trim()) throw new Error('central conflict rationale is required');
        if (input.memory_a_id === input.memory_b_id && input.memory_a_version === input.memory_b_version) {
            throw new Error('a central memory version cannot conflict with itself');
        }
        const at = input.at ?? Date.now();
        return this.repository.transaction(() => {
            this.repository.require_version(input.memory_a_id, input.memory_a_version);
            this.repository.require_version(input.memory_b_id, input.memory_b_version);
            const memory_a = this.repository.require_memory(input.memory_a_id);
            const memory_b = this.repository.require_memory(input.memory_b_id);
            if (memory_a.project_id !== memory_b.project_id) {
                throw new Error('central memory conflicts must stay within one project');
            }
            const conflict = this.repository.insert_conflict({
                conflict_id: input.conflict_id ?? randomUUID(),
                memory_a_id: input.memory_a_id,
                memory_a_version: input.memory_a_version,
                memory_b_id: input.memory_b_id,
                memory_b_version: input.memory_b_version,
                severity: input.severity,
                status: 'open',
                rationale: input.rationale,
                resolution_memory_id: null,
                resolution_version: null,
                created_at: at,
                resolved_at: null,
                metadata,
            });
            this.repository.enqueue({
                event_id: `conflict:${conflict.conflict_id}:reported`,
                aggregate_kind: 'conflict',
                aggregate_id: conflict.conflict_id,
                event_type: 'central_memory.conflict_reported',
                payload: { severity: conflict.severity, project_id: memory_a.project_id },
                at,
            });
            return conflict;
        });
    }

    decide_conflict(conflict_id: string, decision: central_conflict_decision, at = Date.now()): central_memory_conflict {
        this.assert_writable();
        const audited_decision = validate_decision(decision);
        return this.repository.transaction(() => {
            const conflict = this.repository.require_conflict(conflict_id);
            if (conflict.status !== 'open') throw new Error(`central memory conflict ${conflict_id} is not open`);
            let resolution_memory_id: string | null = null;
            let resolution_version: number | null = null;
            if (decision.status === 'resolved') {
                if (!decision.resolution_memory_id || decision.resolution_version === undefined
                    || decision.resolution_version === null) {
                    throw new Error('resolved central conflicts require a resolution memory and version');
                }
                const resolution = this.repository.require_version(
                    decision.resolution_memory_id,
                    decision.resolution_version,
                );
                if (resolution.status !== 'active' && resolution.status !== 'locked') {
                    throw new Error('central conflict resolutions must reference an effective memory version');
                }
                const source_project = this.repository.require_memory(conflict.memory_a_id).project_id;
                const resolution_project = this.repository.require_memory(decision.resolution_memory_id).project_id;
                if (source_project !== resolution_project) {
                    throw new Error('central conflict resolutions must stay within one project');
                }
                resolution_memory_id = decision.resolution_memory_id;
                resolution_version = decision.resolution_version;
            }
            const decided = this.repository.decide_conflict({
                conflict_id,
                status: decision.status,
                resolution_memory_id,
                resolution_version,
                metadata: {
                    ...conflict.metadata,
                    decision: {
                        actor_id: audited_decision.actor_id,
                        note: audited_decision.note,
                        ...audited_decision.evidence,
                    },
                },
                at,
            });
            this.repository.enqueue({
                event_id: `conflict:${conflict_id}:${decision.status}`,
                aggregate_kind: 'conflict',
                aggregate_id: conflict_id,
                aggregate_version: resolution_version,
                event_type: `central_memory.conflict_${decision.status}`,
                payload: { resolution_memory_id, resolution_version },
                at,
            });
            return decided;
        });
    }

    private attach_sources(memory_id: string, version: number, source_links: normalized_source_link[]): void {
        for (const source_link of source_links) {
            this.repository.upsert_source(source_link.source);
            this.repository.link_source(
                memory_id,
                version,
                source_link.source.source_id,
                source_link.evidence_role,
                source_link.locator,
            );
        }
    }

    private create_confirmation(input: {
        confirmation_id?: string;
        memory_id: string;
        proposed_version: number;
        expected_current_version: number | null;
        requested_status: central_confirmation['requested_status'];
        confirmation_kind: central_confirmation['confirmation_kind'];
        prompt: string;
        requested_by: string;
        metadata?: central_metadata;
        at: number;
    }): central_confirmation {
        assert_no_obvious_credentials({ central_confirmation: input });
        if (!input.requested_by.trim()) throw new Error('central confirmation requested_by is required');
        const existing = this.repository.pending_confirmation_for(
            input.memory_id,
            input.proposed_version,
            input.requested_status,
        );
        if (existing) return existing;
        const confirmation = this.repository.insert_confirmation({
            confirmation_id: input.confirmation_id ?? `confirmation:${randomUUID()}`,
            memory_id: input.memory_id,
            proposed_version: input.proposed_version,
            expected_current_version: input.expected_current_version,
            requested_status: input.requested_status,
            confirmation_kind: input.confirmation_kind,
            status: 'pending',
            prompt: input.prompt,
            requested_by: input.requested_by,
            requested_at: input.at,
            decided_by: null,
            decided_at: null,
            decision_note: '',
            decision_metadata: {},
            metadata: input.metadata ?? {},
        });
        this.repository.enqueue({
            event_id: `confirmation:${confirmation.confirmation_id}:requested`,
            aggregate_kind: 'confirmation',
            aggregate_id: confirmation.confirmation_id,
            aggregate_version: input.proposed_version,
            event_type: 'central_memory.confirmation_requested',
            payload: {
                memory_id: input.memory_id,
                requested_status: input.requested_status,
                confirmation_kind: input.confirmation_kind,
            },
            at: input.at,
        });
        return confirmation;
    }

    private request_status_change(
        input: central_status_request_input,
        requested_status: Extract<central_confirmation['requested_status'], 'locked' | 'retracted'>,
    ): central_publish_result {
        this.assert_writable();
        if (!input.reason.trim()) throw new Error('central memory status changes require a reason');
        const metadata = normalize_metadata(input.metadata);
        assert_no_obvious_credentials({
            central_status_change: { ...input, metadata, requested_status },
        });
        const at = input.at ?? Date.now();
        return this.repository.transaction(() => {
            const memory = this.repository.require_memory(input.memory_id);
            if (memory.current_version !== input.expected_current_version) {
                throw new central_memory_conflict_error(
                    input.memory_id,
                    input.expected_current_version,
                    memory.current_version,
                );
            }
            const current = this.repository.require_version(input.memory_id, input.expected_current_version);
            if (current.status !== 'active' && current.status !== 'locked') {
                throw new Error(`central memory ${input.memory_id}@${current.version} is not effective`);
            }
            if (requested_status === 'locked' && current.status === 'locked') {
                return { memory, version: current, confirmation: null, effective: true };
            }
            const confirmation = this.create_confirmation({
                memory_id: memory.memory_id,
                proposed_version: current.version,
                expected_current_version: current.version,
                requested_status,
                confirmation_kind: current.status === 'locked' ? 'locked_override' : requested_status === 'locked' ? 'major_rule' : 'manual',
                prompt: input.confirmation_prompt
                    ?? (requested_status === 'locked'
                        ? `是否锁定中央记忆“${current.title}”(${memory.memory_id}@${current.version})？`
                        : `是否撤回中央记忆“${current.title}”(${memory.memory_id}@${current.version})？`),
                requested_by: input.requested_by,
                metadata: {
                    ...metadata,
                    reason: input.reason,
                    ...(input.source_thread_id ? { source_thread_id: input.source_thread_id } : {}),
                },
                at,
            });
            return { memory, version: current, confirmation, effective: false };
        });
    }

    private activate_candidate(
        memory: central_memory,
        candidate: central_memory_version,
        target_status: central_effective_status,
        at: number,
        source_thread_id?: string,
    ): central_memory_version {
        const version = this.repository.activate_candidate(
            memory.memory_id,
            memory.current_version,
            candidate.version,
            target_status,
            at,
        );
        this.cancel_stale_confirmations(memory.memory_id, candidate.version, at);
        const affected_dependencies = this.repository.invalidate_prior_dependencies(
            memory.memory_id,
            candidate.version,
            at,
        );
        const affected_threads = this.repository.stage_matching_worksets(memory.memory_id, candidate.version, at);
        if (source_thread_id) {
            const source_thread = this.repository.require_thread(source_thread_id);
            if (source_thread.status === 'active' || source_thread.status === 'idle') {
                this.repository.stage_workset({
                    thread_id: source_thread_id,
                    memory_id: memory.memory_id,
                    pending_version: candidate.version,
                    relevance: 1,
                    origin: 'own_thread',
                    at,
                });
            }
        }
        this.repository.enqueue({
            event_id: `memory:${memory.memory_id}:${candidate.version}:published`,
            aggregate_kind: 'memory',
            aggregate_id: memory.memory_id,
            aggregate_version: candidate.version,
            event_type: 'central_memory.version_published',
            payload: {
                status: target_status,
                supersedes: memory.current_version,
                affected_dependencies,
                affected_threads,
            },
            at,
        });
        return version;
    }

    private lock_effective(
        memory: central_memory,
        current: central_memory_version,
        at: number,
    ): central_memory_version {
        const locked = this.repository.lock_current_version(memory.memory_id, current.version, at);
        // A replacement or retraction approved while the version was merely
        // active cannot be carried across the stronger locked boundary.  The
        // user must review a fresh locked_override operation instead.
        this.cancel_pending_confirmations(memory.memory_id, current.version, at, true);
        this.repository.enqueue({
            event_id: `memory:${memory.memory_id}:${current.version}:locked`,
            aggregate_kind: 'memory',
            aggregate_id: memory.memory_id,
            aggregate_version: current.version,
            event_type: 'central_memory.version_locked',
            payload: {},
            at,
        });
        return locked;
    }

    private retract_effective(
        memory: central_memory,
        current: central_memory_version,
        at: number,
        reason: unknown,
    ): central_memory_version {
        const retracted = this.repository.retract_current_version(memory.memory_id, current.version, at);
        this.cancel_stale_confirmations(memory.memory_id, null, at);
        const affected_threads = this.repository.mark_worksets_retracted(memory.memory_id, at);
        const invalidated_dependencies = this.repository.invalidate_dependencies(memory.memory_id, current.version, at);
        this.repository.enqueue({
            event_id: `memory:${memory.memory_id}:${current.version}:retracted`,
            aggregate_kind: 'memory',
            aggregate_id: memory.memory_id,
            aggregate_version: current.version,
            event_type: 'central_memory.version_retracted',
            payload: {
                reason: typeof reason === 'string' ? reason : '',
                affected_threads,
                invalidated_dependencies,
            },
            at,
        });
        return retracted;
    }

    private cancel_stale_confirmations(memory_id: string, new_current_version: number | null, at: number): void {
        this.cancel_pending_confirmations(memory_id, new_current_version, at, false);
    }

    private cancel_pending_confirmations(
        memory_id: string,
        new_current_version: number | null,
        at: number,
        cancel_matching_current: boolean,
    ): void {
        for (const confirmation of this.repository.list_pending_confirmations(memory_id)) {
            if (!cancel_matching_current && confirmation.expected_current_version === new_current_version) continue;
            this.repository.decide_confirmation(confirmation.confirmation_id, 'cancelled', {
                actor_id: 'system:central-memory-version-advanced',
                note: cancel_matching_current
                    ? `governance state changed for current version ${String(new_current_version)}`
                    : `current version changed to ${String(new_current_version)}`,
                evidence: { new_current_version, governance_state_changed: cancel_matching_current },
            }, at);
            const candidate = this.repository.require_version(memory_id, confirmation.proposed_version);
            if (candidate.status === 'pending_confirmation') {
                this.repository.reject_candidate(memory_id, candidate.version, at);
            }
            this.repository.enqueue({
                event_id: `confirmation:${confirmation.confirmation_id}:cancelled`,
                aggregate_kind: 'confirmation',
                aggregate_id: confirmation.confirmation_id,
                aggregate_version: confirmation.proposed_version,
                event_type: 'central_memory.confirmation_cancelled',
                payload: { memory_id, new_current_version },
                at,
            });
        }
    }
}
