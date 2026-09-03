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
 *  file  : src/integrations/codex_hooks/codex_hooks.test.ts
 *  usage : tests the LongMemory codex hooks component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hash_canonical } from '../../core/hash/content_hash.js';
import { count_tokens } from '../../core/recall/context_builder.js';
import { CentralMemoryService } from '../../core/central_memory/service.js';
import { create_longmemory_mcp } from '../../mcp/mcp_server.js';
import { mcp_audit_log } from '../../mcp/security/audit.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { bind_codex_task, recall_codex_memory, record_codex_turn } from './gateway.js';
import { handle_codex_hook } from './hook_bridge.js';
import { CodexHookRegistry } from './registry.js';
import { reconcile_registry_binding } from './central_runtime.js';
import type { codex_hook_runtime_options, codex_hook_session_state } from './types.js';

type json_object = Record<string, unknown>;

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-hooks-'));
    const plugin_data = join(root, 'plugin-data');
    const db_path = join(plugin_data, 'central-memory.db');
    const options: codex_hook_runtime_options = {
        plugin_data,
        db_path,
        tenant_id: 'tenant',
        user_id: 'user',
        project_id: 'detected-project',
        project_name: 'Detected Project',
        project_was_configured: false,
        token_budget: 1_800,
    };
    const session_start = (source: 'startup' | 'resume' | 'compact' = 'startup') => handle_codex_hook({
        session_id: 'thread-1', transcript_path: join(root, 'rollout.jsonl'), cwd: root,
        hook_event_name: 'SessionStart', source, model: 'test-model', permission_mode: 'default',
    }, options);
    const registry = new CodexHookRegistry(plugin_data);
    const state = () => registry.load('thread-1')!;
    const bind = (extra: Partial<Parameters<typeof bind_codex_task>[2]> = {}) => {
        const turn_id = extra.turn_id ?? 'binding-turn';
        const current = registry.activate_turn('thread-1', turn_id);
        return bind_codex_task(registry, current, {
            session_id: current.session_id,
            capability: current.capability,
            turn_id,
            project_id: 'novel',
            project_name: 'Novel',
            responsibility: 'Write and maintain story continuity.',
            ...extra,
        });
    };
    return {
        root, plugin_data, db_path, options, session_start, registry, state, bind,
        close: () => rmSync(root, { recursive: true, force: true }),
    };
}

function additional_context(output: ReturnType<typeof handle_codex_hook>): string {
    return output.hookSpecificOutput?.additionalContext ?? '';
}

function delivery_ids(text: string): string[] {
    return [...text.matchAll(/delivery_id="([^"]+)"/g)].map((match) => match[1]!);
}

function with_service<T>(state: codex_hook_session_state, operation: (service: CentralMemoryService) => T): T {
    const store = new SqliteStore(state.db_path, {
        tenant_id: state.tenant_id,
        user_id: state.user_id,
        startup_integrity_check: false,
    });
    try { return operation(new CentralMemoryService(store.central_memory)); }
    finally { store.close(); }
}

test('Codex capabilities are turn-scoped, stable within one turn, and invalidated at each boundary', () => {
    const value = fixture();
    try {
        const output = value.session_start();
        assert.match(additional_context(output), /尚未绑定/);
        assert.match(additional_context(output), /不得.*擅自猜测/);
        assert.match(additional_context(output), /longmemory_codex_memory/);
        assert.equal(value.state().bound, false);
        assert.doesNotMatch(additional_context(output), /capability=/,
            'SessionStart must not inject an unscoped bearer token');
        const session_capability = value.state().capability;
        assert.equal(value.state().capability_turn_id, null);
        assert.throws(() => value.registry.require_capability(
            'thread-1', session_capability, 'turn-1'), /invalid Codex turn capability/);
        const first_prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Set up this task.',
            permission_mode: 'default',
        }, value.options);
        const first_capability = value.state().capability;
        assert.notEqual(first_capability, session_capability);
        assert.equal(value.state().capability_turn_id, 'turn-1');
        assert.match(additional_context(first_prompt), new RegExp(first_capability));
        assert.equal(value.registry.require_capability(
            'thread-1', first_capability, 'turn-1').session_id, 'thread-1');
        handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Retry setup.',
            permission_mode: 'default',
        }, value.options);
        assert.equal(value.state().capability, first_capability,
            'a duplicate hook invocation for the same turn must preserve retry credentials');
        const path = value.registry.state_path('thread-1');
        assert.doesNotMatch(path, /thread-1/);
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).session_id, 'thread-1');
        handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'A new turn.',
            permission_mode: 'default',
        }, value.options);
        assert.notEqual(value.state().capability, first_capability);
        assert.throws(() => value.registry.require_capability(
            'thread-1', first_capability, 'turn-1'), /invalid Codex turn capability/);
        const second_capability = value.state().capability;
        value.session_start('compact');
        assert.notEqual(value.state().capability, second_capability);
        assert.equal(value.state().capability_turn_id, null);
        assert.throws(() => value.registry.require_capability(
            'thread-1', second_capability, 'turn-2'), /invalid Codex turn capability/);
    } finally { value.close(); }
});

test('legacy registry state without capability_turn_id loads safely but cannot authenticate', () => {
    const value = fixture();
    try {
        value.session_start();
        const path = value.registry.state_path('thread-1');
        const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const legacy_capability = String(legacy.capability);
        delete legacy.capability_turn_id;
        writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
        assert.equal(value.state().capability_turn_id, null);
        assert.throws(() => value.registry.require_capability(
            'thread-1', legacy_capability, 'legacy-turn'), /invalid Codex turn capability/);
        handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'migrated-turn', prompt: 'Continue.',
            permission_mode: 'default',
        }, value.options);
        assert.equal(value.state().capability_turn_id, 'migrated-turn');
        assert.notEqual(value.state().capability, legacy_capability);
    } finally { value.close(); }
});

test('capability-scoped operations keep authorization and registry mutation in one lock scope', () => {
    const value = fixture();
    try {
        value.session_start();
        const current = value.registry.activate_turn('thread-1', 'atomic-turn');
        let captured_save: ((next: codex_hook_session_state) => void) | null = null;
        const result = value.registry.with_capability(
            current.session_id,
            current.capability,
            'atomic-turn',
            (state, save) => {
                captured_save = save;
                save({ ...state, responsibility: 'Saved inside capability scope.' });
                return state.session_id;
            },
        );
        assert.equal(result, 'thread-1');
        assert.equal(value.state().responsibility, 'Saved inside capability scope.');
        assert.throws(
            () => captured_save!({ ...value.state(), responsibility: 'Too late.' }),
            /save scope has expired/,
        );
        const stale = current.capability;
        value.registry.activate_turn('thread-1', 'next-turn');
        assert.throws(() => value.registry.with_capability(
            'thread-1', stale, 'atomic-turn', () => undefined,
        ), /invalid Codex turn capability/);
        assert.throws(() => value.registry.with_capability(
            'thread-1', value.state().capability, 'next-turn',
            () => Promise.resolve('not allowed'),
        ), /must be synchronous/);
    } finally { value.close(); }
});

test('task binding creates the role from explicit responsibility and cannot silently rebind it', () => {
    const value = fixture();
    try {
        value.session_start();
        const bound = value.bind();
        assert.equal(bound.state.bound, true);
        assert.match(bound.state.role_id ?? '', /^role:/);
        assert.equal(bound.state.task_id, null);
        assert.throws(() => bind_codex_task(value.registry, value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: value.state().capability_turn_id!,
            project_id: 'novel', responsibility: 'Analyze sales data instead.',
        }), /cannot be silently rebound/);
        with_service(value.state(), (service) => {
            const thread = service.repository.require_thread('thread-1');
            assert.equal(thread.project_id, 'novel');
            assert.equal(thread.responsibility, 'Write and maintain story continuity.');
        });
    } finally { value.close(); }
});

test('task binding rejects credentials before central writes or local registry updates', () => {
    const value = fixture();
    try {
        value.session_start();
        const current = value.registry.activate_turn('thread-1', 'credential-bind-turn');
        const before = structuredClone(value.state());
        const credential = 'unsafe-bind-value-123456';
        let failure: Error | null = null;
        try {
            bind_codex_task(value.registry, current, {
                session_id: current.session_id,
                capability: current.capability,
                turn_id: 'credential-bind-turn',
                project_id: 'novel',
                project_name: 'Novel',
                project_description: `password=${credential}`,
                responsibility: 'Write and maintain story continuity.',
            });
        } catch (error) {
            failure = error as Error;
        }
        assert.ok(failure);
        assert.match(failure.message, /prohibited credential material/i);
        assert.doesNotMatch(failure.message, new RegExp(credential));
        assert.deepEqual(value.state(), before);
        const store = new SqliteStore(value.db_path, {
            tenant_id: 'tenant', user_id: 'user', startup_integrity_check: false,
        });
        try {
            const projects = store.database.prepare('SELECT COUNT(*) AS count FROM cm_projects')
                .get() as { count: number };
            const threads = store.database.prepare('SELECT COUNT(*) AS count FROM cm_threads')
                .get() as { count: number };
            assert.equal(projects.count, 0);
            assert.equal(threads.count, 0);
        } finally {
            store.close();
        }
    } finally { value.close(); }
});

test('turn recording rejects credential notes and delivery ids before hashing or outbox writes', () => {
    const value = fixture();
    try {
        value.session_start();
        const bound = value.bind({ turn_id: 'safe-bind-turn' });
        const credential = 'unsafe-turn-record-value-123456';
        for (const input of [
            { note: `password=${credential}`, acknowledged_delivery_ids: [] },
            { note: '', acknowledged_delivery_ids: [`password=${credential}`] },
        ]) {
            let failure: Error | null = null;
            try {
                record_codex_turn(bound.state, {
                    session_id: bound.state.session_id,
                    capability: bound.state.capability,
                    turn_id: 'unsafe-record-turn',
                    memories: [],
                    ...input,
                });
            } catch (error) {
                failure = error as Error;
            }
            assert.ok(failure);
            assert.match(failure.message, /prohibited credential material/i);
            assert.doesNotMatch(failure.message, new RegExp(credential));
        }
        with_service(bound.state, (service) => {
            const rows = service.repository.database.prepare(`SELECT COUNT(*) AS count FROM cm_outbox
                WHERE tenant_id=? AND user_id=? AND event_type='central_memory.turn_finalized'`)
                .get(service.repository.tenant_id, service.repository.user_id) as { count: number };
            assert.equal(rows.count, 0);
        });
    } finally { value.close(); }
});

test('initial bind recall stages only relevant cross-role L4 memory without widening project subscriptions', () => {
    const value = fixture();
    const activate_unbound_turn = (session_id: string, turn_id: string): codex_hook_session_state => {
        handle_codex_hook({
            session_id, transcript_path: null, cwd: value.root,
            hook_event_name: 'SessionStart', source: 'startup', permission_mode: 'default',
        }, value.options);
        handle_codex_hook({
            session_id, transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id, prompt: 'Bind this task.',
            permission_mode: 'default',
        }, value.options);
        return value.registry.load(session_id)!;
    };
    try {
        value.session_start();
        const producer = value.bind({
            turn_id: 'producer-bind',
            responsibility: 'Study illustration techniques and record reusable findings.',
        });
        record_codex_turn(producer.state, {
            session_id: producer.state.session_id,
            capability: producer.state.capability,
            turn_id: 'producer-bind',
            memories: [{
                memory_id: 'producer-expression-l4', level: 4, memory_kind: 'technique',
                title: 'Character expression geometry',
                summary: 'Coordinate eyelids, eyebrows, and mouth corners for an expressive face.',
                body: 'CROSS_ROLE_EXPRESSION_BODY: shape the upper eyelid arc before adjusting eyebrow distance and mouth-corner tension.',
            }, {
                memory_id: 'producer-landscape-l4', level: 4, memory_kind: 'technique',
                title: 'Landscape color palette',
                summary: 'Balance distant mountains with a muted cyan palette.',
                body: 'UNRELATED_LANDSCAPE_BODY: reserve warm saturation for the foreground.',
            }],
        });

        const no_query_state = activate_unbound_turn('thread-no-query', 'no-query-bind');
        const no_query = bind_codex_task(value.registry, no_query_state, {
            session_id: no_query_state.session_id,
            capability: no_query_state.capability,
            turn_id: 'no-query-bind',
            project_id: 'novel',
            project_name: 'Novel',
            responsibility: 'Create finished character illustrations.',
        });
        assert.notEqual(no_query.state.role_id, producer.state.role_id,
            'different explicit responsibilities must keep their auto-derived roles separate');
        assert.doesNotMatch(no_query.context, /CROSS_ROLE_EXPRESSION_BODY|UNRELATED_LANDSCAPE_BODY/);

        const consumer_state = activate_unbound_turn('thread-consumer', 'consumer-bind');
        const consumer = bind_codex_task(value.registry, consumer_state, {
            session_id: consumer_state.session_id,
            capability: consumer_state.capability,
            turn_id: 'consumer-bind',
            project_id: 'novel',
            project_name: 'Novel',
            responsibility: 'Review and direct character-expression artwork.',
            initial_query: 'character expression upper eyelid arc and eyebrow distance',
        });
        assert.match(consumer.state.role_id ?? '', /^role:/);
        assert.notEqual(consumer.state.role_id, producer.state.role_id);
        assert.match(consumer.context, /CROSS_ROLE_EXPRESSION_BODY/);
        assert.doesNotMatch(consumer.context, /UNRELATED_LANDSCAPE_BODY/);

        with_service(consumer.state, (service) => {
            assert.throws(
                () => service.repository.require_workset('thread-no-query', 'producer-expression-l4'),
                /was not found/,
            );
            const recalled = service.repository.require_workset(
                'thread-consumer',
                'producer-expression-l4',
            );
            assert.equal(recalled.origin, 'shared');
            assert.throws(
                () => service.repository.require_workset('thread-consumer', 'producer-landscape-l4'),
                /was not found/,
            );
            assert.deepEqual(
                service.repository.list_thread_subscriptions('thread-consumer')
                    .map((subscription) => subscription.selector_kind)
                    .sort(),
                ['project', 'role'],
                'one-shot initial recall must not create a broad or permanent L4 subscription',
            );
        });
    } finally { value.close(); }
});

test('an explicitly configured project cannot be replaced during task binding', () => {
    const value = fixture();
    try {
        value.options.project_id = 'configured-project';
        value.options.project_name = 'Configured Project';
        value.options.project_was_configured = true;
        value.session_start();
        assert.match(additional_context(value.session_start('resume')), /configured-project/);
        assert.throws(() => value.bind({
            project_id: 'other-project',
            project_name: 'Other Project',
        }), /configured for project configured-project/);
        assert.equal(value.state().bound, false);
        assert.equal(value.state().project_id, 'configured-project');
        assert.equal(value.state().configured_project_id, 'configured-project');
        value.bind({
            project_id: 'configured-project',
            project_name: 'Configured Project',
        });
        assert.equal(value.state().bound, true);
        assert.equal(value.state().project_id, 'configured-project');
    } finally { value.close(); }
});

test('a configured project anchor survives a conflicting pre-existing central thread', () => {
    const value = fixture();
    try {
        value.options.project_id = 'configured-project';
        value.options.project_name = 'Configured Project';
        value.options.project_was_configured = true;
        value.session_start();
        const anchored = value.state();
        with_service(anchored, (service) => {
            service.repository.register_project({ project_id: 'other-project', name: 'Other Project' });
            service.repository.register_role({
                role_id: 'other-role',
                project_id: 'other-project',
                name: 'Other Role',
                responsibility: 'Unrelated work',
            });
            service.register_thread({
                thread_id: anchored.session_id,
                project_id: 'other-project',
                role_id: 'other-role',
                responsibility: 'Unrelated work',
            });
        });
        assert.throws(
            () => reconcile_registry_binding(value.registry, value.state()),
            /belongs to other-project, but this task is configured for configured-project/,
        );
        assert.equal(value.state().configured_project_id, 'configured-project');
        assert.equal(value.state().project_id, 'configured-project');
        assert.throws(() => value.registry.save({
            ...value.state(),
            configured_project_id: 'other-project',
        }), /configured project anchor is immutable/);
    } finally { value.close(); }
});

test('record_turn atomically writes zero-to-many memories, finalizes once, and gates major/conflict conclusions', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        let state = value.state();
        const before = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false,
            last_assistant_message: 'done', permission_mode: 'default',
        }, value.options);
        assert.equal(before.decision, 'block');
        assert.match(before.reason ?? '', /memories=\[\]/);
        assert.match(before.reason ?? '', /pending_confirmation/);
        assert.equal(value.state().capability_turn_id, 'turn-1');
        assert.notEqual(value.state().capability, state.capability,
            'Stop fallback must rotate a stale turn capability before requesting continuation');
        assert.match(before.reason ?? '', new RegExp(value.state().capability));
        state = value.state();

        const recorded = record_codex_turn(state, {
            session_id: state.session_id,
            capability: state.capability,
            turn_id: 'turn-1',
            note: 'Two validated outcomes.',
            memories: [{
                memory_id: 'verified-solution', level: 4, memory_kind: 'solution',
                title: 'Verified rendering fix', summary: 'Use the validated rendering path.',
                body: 'Set renderer version 3.2, seed 42, 25 Euler steps, and dependency X 1.4 because this exact combination reproduced the accepted image.',
            }, {
                memory_id: 'major-style-rule', level: 2, memory_kind: 'conflict_conclusion',
                title: 'Proposed style rule', summary: 'A proposed long-term rule needs confirmation.',
                body: 'All future covers must use the approved palette unless the user explicitly changes the rule.',
                conflict_with: [{
                    memory_id: 'verified-solution', version: 1, severity: 0.9,
                    rationale: 'The proposed global palette conflicts with the previously validated rendering conditions.',
                }],
            }],
        });
        assert.equal(recorded.already_finalized, false);
        assert.equal(recorded.memory_refs.length, 2);
        assert.equal(recorded.memory_refs[0]?.status, 'active');
        assert.equal(recorded.memory_refs[1]?.status, 'pending_confirmation');
        assert.equal(recorded.pending_confirmations.length, 1);

        const repeated = record_codex_turn(state, {
            session_id: state.session_id,
            capability: state.capability,
            turn_id: 'turn-1',
            note: 'Two validated outcomes.',
            memories: [{
                memory_id: 'verified-solution', level: 4, memory_kind: 'solution',
                title: 'Verified rendering fix', summary: 'Use the validated rendering path.',
                body: 'Set renderer version 3.2, seed 42, 25 Euler steps, and dependency X 1.4 because this exact combination reproduced the accepted image.',
            }, {
                memory_id: 'major-style-rule', level: 2, memory_kind: 'conflict_conclusion',
                title: 'Proposed style rule', summary: 'A proposed long-term rule needs confirmation.',
                body: 'All future covers must use the approved palette unless the user explicitly changes the rule.',
                conflict_with: [{
                    memory_id: 'verified-solution', version: 1, severity: 0.9,
                    rationale: 'The proposed global palette conflicts with the previously validated rendering conditions.',
                }],
            }],
        });
        assert.equal(repeated.already_finalized, true);
        assert.throws(() => record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability,
            turn_id: 'turn-1', memories: [], note: 'Different retry.',
        }), /already finalized with a different result/);

        const after = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false,
            last_assistant_message: 'done', permission_mode: 'default',
        }, value.options);
        assert.equal(after.decision, undefined);
        with_service(state, (service) => {
            assert.equal(service.repository.list_conflicts('open').length, 1);
            const event = service.repository.pending_outbox(100)
                .find((candidate) => candidate.event_type === 'central_memory.turn_finalized');
            assert.equal(Array.isArray(event?.payload.memory_refs), true);
            assert.equal((event?.payload.memory_refs as unknown[]).length, 2);
        });
    } finally { value.close(); }
});

test('record_turn rolls all candidate writes back when one candidate is invalid', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const state = value.state();
        record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability, turn_id: 'rollback-seed',
            memories: [{
                memory_id: 'rollback-delivery', level: 4, memory_kind: 'fact', title: 'Rollback delivery',
                summary: 'Delivery acknowledgement participates in the turn transaction.',
                body: 'A failed candidate write must roll back both acknowledgement and work-set consumption.',
            }],
        });
        const prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'turn-rollback',
            prompt: 'Use the rollback delivery.', permission_mode: 'default',
        }, value.options);
        const receipt = delivery_ids(additional_context(prompt))[0]!;
        assert.throws(() => record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability, turn_id: 'turn-rollback',
            acknowledged_delivery_ids: [receipt],
            memories: [{
                memory_id: 'rollback-first', level: 4, memory_kind: 'fact', title: 'First',
                summary: 'Would be valid alone.', body: 'This must roll back with the second candidate.',
            }, {
                memory_id: 'rollback-second', level: 3, memory_kind: 'task', title: 'Second',
                summary: 'Invalid without a bound task.', body: 'This requires a task binding that does not exist.',
            }],
        }), /level 3 memory requires a bound task/);
        with_service(state, (service) => {
            assert.equal(service.repository.get_memory('rollback-first'), null);
            assert.equal(service.repository.require_workset('thread-1', 'rollback-delivery').consumed_version, null);
            assert.equal(service.repository.get_outbox(`central-context-delivery-ack:${receipt}`), null);
            assert.equal(service.repository.get_outbox(`central-turn-finalized:${'missing'}`), null);
        });
    } finally { value.close(); }
});

test('visible delivery ids are acknowledged by record_turn while unconfirmed context repeats safely', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const state = value.state();
        record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability, turn_id: 'seed-turn', memories: [{
                memory_id: 'painting-seed', level: 4, memory_kind: 'technique',
                title: 'Anime edge treatment', summary: 'Use soft inner edges and crisp silhouettes for anime painting.',
                body: 'For anime painting, keep the outer silhouette crisp while softening internal material transitions.',
            }, {
                memory_id: 'database-seed', level: 4, memory_kind: 'technique',
                title: 'SQLite checkpoint', summary: 'Checkpoint WAL during maintenance.',
                body: 'Run a WAL checkpoint only at a safe maintenance boundary.',
            }],
        });
        const resume = value.session_start('resume');
        assert.ok(count_tokens(additional_context(resume)) <= 1_800);
        const resume_ids = delivery_ids(additional_context(resume));
        assert.equal(resume_ids.length, 1);

        const prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'prompt-turn',
            prompt: '请继续研究 anime painting 的 edge treatment 和轮廓。', permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(prompt), /Anime edge treatment/);
        assert.match(additional_context(prompt), /SQLite checkpoint/,
            'unacknowledged SessionStart content must repeat instead of being lost in a crash window');
        assert.match(additional_context(prompt), /本回合正式记忆提交契约/);
        assert.match(additional_context(prompt), /turn_id="prompt-turn"/);
        assert.match(additional_context(prompt), /memories=\[\]/);
        assert.match(additional_context(prompt), /acknowledged_delivery_ids/);
        assert.ok(count_tokens(additional_context(prompt)) <= 1_800);
        const prompt_ids = delivery_ids(additional_context(prompt));
        assert.equal(prompt_ids.length, 1);
        with_service(value.state(), (service) => {
            assert.equal(service.repository.require_workset('thread-1', 'painting-seed').consumed_version, null);
            assert.equal(service.repository.require_workset('thread-1', 'database-seed').consumed_version, null);
        });

        const acknowledged = record_codex_turn(value.state(), {
            session_id: value.state().session_id,
            capability: value.state().capability,
            turn_id: 'prompt-turn',
            memories: [],
            acknowledged_delivery_ids: [...resume_ids, ...prompt_ids],
        });
        assert.deepEqual(acknowledged.acknowledged_delivery_ids.sort(),
            [...resume_ids, ...prompt_ids].sort());
        with_service(value.state(), (service) => {
            assert.equal(service.repository.require_workset('thread-1', 'painting-seed').consumed_version, 1);
            assert.equal(service.repository.require_workset('thread-1', 'database-seed').consumed_version, 1);
        });

        const related = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'related-turn',
            prompt: '请继续研究 anime painting 的 edge treatment 和轮廓。', permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(related), /Anime edge treatment/);
        assert.doesNotMatch(additional_context(related), /SQLite checkpoint/);
        record_codex_turn(value.state(), {
            session_id: value.state().session_id,
            capability: value.state().capability,
            turn_id: 'related-turn',
            memories: [],
            acknowledged_delivery_ids: delivery_ids(additional_context(related)),
        });

        const expanded = recall_codex_memory(value.registry, value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: 'expanded-turn', query: 'SQLite WAL checkpoint maintenance', limit: 4, token_budget: 900,
        });
        assert.match(expanded.context, /SQLite checkpoint/);
        assert.doesNotMatch(expanded.context, /Anime edge treatment/);
        assert.equal(expanded.matches[0]?.memory_id, 'database-seed');
        assert.ok(count_tokens(expanded.context) <= 900);
    } finally { value.close(); }
});

test('delivery retries are content-addressed, idempotent, and reject forged or cross-scope ids', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const seeded_state = value.state();
        record_codex_turn(seeded_state, {
            session_id: seeded_state.session_id,
            capability: seeded_state.capability,
            turn_id: 'receipt-seed',
            memories: [{
                memory_id: 'receipt-memory', level: 4, memory_kind: 'fact',
                title: 'Receipt memory', summary: 'This memory exercises reliable delivery.',
                body: 'The durable receipt must be explicitly acknowledged before this version is consumed.',
            }],
        });

        const first_resume = value.session_start('resume');
        const second_resume = value.session_start('resume');
        const resume_id = delivery_ids(additional_context(first_resume))[0]!;
        assert.equal(delivery_ids(additional_context(second_resume))[0], resume_id,
            'an equivalent pre-stdout crash retry must reuse its staged receipt');

        const first_prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'receipt-turn',
            prompt: 'Use the receipt memory.', permission_mode: 'default',
        }, value.options);
        const second_prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'receipt-turn',
            prompt: 'Use the receipt memory.', permission_mode: 'default',
        }, value.options);
        const prompt_id = delivery_ids(additional_context(first_prompt))[0]!;
        assert.equal(delivery_ids(additional_context(second_prompt))[0], prompt_id);

        with_service(value.state(), (service) => {
            const stages = service.repository.pending_outbox(10_000)
                .filter((event) => event.event_type === 'central_memory.context_delivery_staged');
            assert.equal(stages.length, 2, 'equivalent retries do not grow the staged-delivery ledger');
            assert.equal(service.repository.require_workset('thread-1', 'receipt-memory').consumed_version, null);
        });

        assert.throws(() => record_codex_turn(value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: 'wrong-turn', memories: [], acknowledged_delivery_ids: [prompt_id],
        }), /belongs to another turn/);
        assert.throws(() => record_codex_turn(value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: 'receipt-turn', memories: [], acknowledged_delivery_ids: ['dlv_forged'],
        }), /was not staged/);

        const state = value.state();
        const other_state: codex_hook_session_state = {
            ...state,
            session_id: 'thread-2',
            capability: 'other-session-capability'.padEnd(43, 'x'),
        };
        with_service(state, (service) => {
            service.register_thread({
                thread_id: 'thread-2', project_id: 'novel', role_id: state.role_id,
                responsibility: 'A second explicitly bound task.', subscribe_to_project: true,
            });
        });
        assert.throws(() => record_codex_turn(other_state, {
            session_id: 'thread-2', capability: other_state.capability,
            turn_id: 'other-turn', memories: [], acknowledged_delivery_ids: [resume_id],
        }), /belongs to another session/);

        const accepted = record_codex_turn(value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: 'receipt-turn', memories: [],
            acknowledged_delivery_ids: [resume_id, prompt_id, prompt_id],
        });
        assert.deepEqual(accepted.acknowledged_delivery_ids.sort(), [resume_id, prompt_id].sort());
        const repeated = record_codex_turn(value.state(), {
            session_id: 'thread-1', capability: value.state().capability,
            turn_id: 'receipt-turn', memories: [],
            acknowledged_delivery_ids: [resume_id, prompt_id],
        });
        assert.equal(repeated.already_finalized, true);
        with_service(value.state(), (service) => {
            assert.equal(service.repository.require_workset('thread-1', 'receipt-memory').consumed_version, 1);
            const acknowledgements = service.repository.pending_outbox(10_000)
                .filter((event) => event.event_type === 'central_memory.context_delivery_acknowledged');
            assert.equal(acknowledgements.length, 2);
        });
    } finally { value.close(); }
});

test('UserPromptSubmit provides the write contract up front and Stop is only a fallback', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const prompt = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'no-memory-turn',
            prompt: '继续当前工作。', permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(prompt), /action=record_turn/);
        assert.ok(count_tokens(additional_context(prompt)) <= 1_800);

        const state = value.state();
        record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability,
            turn_id: 'no-memory-turn', memories: [],
            acknowledged_delivery_ids: delivery_ids(additional_context(prompt)),
        });
        const stop = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'Stop', turn_id: 'no-memory-turn', stop_hook_active: false,
            last_assistant_message: 'done', permission_mode: 'default',
        }, value.options);
        assert.deepEqual(stop, { continue: true });
    } finally { value.close(); }
});

test('retraction remains visible until explicit record_turn acknowledgement and compact re-injects it', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const state = value.state();
        record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability, turn_id: 'retract-seed', memories: [{
                memory_id: 'retired-memory', level: 4, memory_kind: 'fact', title: 'Retired memory',
                summary: 'This memory will be withdrawn.', body: 'RETRACTED_SECRET_BODY must not appear after withdrawal.',
            }],
        });
        with_service(state, (service) => {
            service.sync_at_safe_boundary('thread-1');
            const request = service.request_retraction({
                memory_id: 'retired-memory', expected_current_version: 1,
                requested_by: 'thread-1', reason: 'Validated later evidence disproved it.',
            });
            assert.ok(request.confirmation);
            service.approve(request.confirmation.confirmation_id, {
                actor_id: 'user', actor_kind: 'user', action_id: 'retract-action', channel: 'codex_ui',
                note: 'Explicitly approved withdrawal.', evidence: { user_turn_id: 'approval-turn' },
            });
        });
        const resume = value.session_start('resume');
        assert.match(additional_context(resume), /MUST NOT USE/);
        assert.doesNotMatch(additional_context(resume), /RETRACTED_SECRET_BODY/);
        const resume_ids = delivery_ids(additional_context(resume));
        assert.equal(resume_ids.length, 1);
        const ordinary = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'after-retract', prompt: '继续当前任务。',
            permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(ordinary), /retired-memory@v1.*MUST NOT USE/s,
            'an arbitrary next hook is not delivery evidence');
        const ordinary_ids = delivery_ids(additional_context(ordinary));
        record_codex_turn(value.state(), {
            session_id: value.state().session_id,
            capability: value.state().capability,
            turn_id: 'after-retract',
            memories: [],
            acknowledged_delivery_ids: [...resume_ids, ...ordinary_ids],
        });
        const after_ack = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'after-retract-ack', prompt: '继续当前任务。',
            permission_mode: 'default',
        }, value.options);
        assert.doesNotMatch(additional_context(after_ack), /retired-memory/);
        const compact = value.session_start('compact');
        assert.match(additional_context(compact), /retired-memory@v1.*MUST NOT USE/s);
        const compact_id = delivery_ids(additional_context(compact))[0]!;
        assert.notEqual(compact_id, resume_ids[0],
            'an acknowledged prior epoch cannot stand in for a fresh compact re-injection');
        const after_compact_crash = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'after-compact-crash', prompt: '继续当前任务。',
            permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(after_compact_crash), /retired-memory@v1.*MUST NOT USE/s,
            'a staged compact receipt that never reached stdout must keep the tombstone pending');
    } finally { value.close(); }
});

test('withdrawing a memory between staging and acknowledgement cannot consume or hide the tombstone', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const state = value.state();
        record_codex_turn(state, {
            session_id: state.session_id, capability: state.capability,
            turn_id: 'withdrawal-seed', memories: [{
                memory_id: 'withdrawal-race', level: 4, memory_kind: 'fact', title: 'Withdrawal race',
                summary: 'This active version will be withdrawn after its context is staged.',
                body: 'WITHDRAWN_BODY must not be restored by a delayed delivery acknowledgement.',
            }],
        });
        const staged = value.session_start('resume');
        const active_delivery_id = delivery_ids(additional_context(staged))[0]!;
        assert.match(additional_context(staged), /WITHDRAWN_BODY/);

        with_service(value.state(), (service) => {
            const requested = service.request_retraction({
                memory_id: 'withdrawal-race', expected_current_version: 1,
                requested_by: 'thread-1', reason: 'New verified evidence invalidated this version.',
            });
            service.approve(requested.confirmation!.confirmation_id, {
                actor_id: 'user', actor_kind: 'user', action_id: 'withdraw-race-action', channel: 'codex_ui',
                note: 'Approved after delivery staging.', evidence: { user_turn_id: 'withdraw-race-approval' },
            });
        });
        record_codex_turn(value.state(), {
            session_id: value.state().session_id, capability: value.state().capability,
            turn_id: 'ack-after-withdrawal', memories: [],
            acknowledged_delivery_ids: [active_delivery_id],
        });
        with_service(value.state(), (service) => {
            const workset = service.repository.require_workset('thread-1', 'withdrawal-race');
            assert.equal(workset.sync_state, 'retracted');
            assert.equal(workset.consumed_version, null,
                'an old active delivery cannot consume a version after its withdrawal');
        });
        const next = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'withdrawal-notice', prompt: 'Continue safely.',
            permission_mode: 'default',
        }, value.options);
        assert.match(additional_context(next), /withdrawal-race@v1.*MUST NOT USE/s);
        assert.doesNotMatch(additional_context(next), /WITHDRAWN_BODY/);
    } finally { value.close(); }
});

test('Stop never loops and persists an unfinalized recovery record without fabricating memories', () => {
    const value = fixture();
    try {
        value.session_start();
        value.bind();
        const output = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'Stop', turn_id: 'not-finalized', stop_hook_active: true,
            last_assistant_message: 'still not finalized', permission_mode: 'default',
        }, value.options);
        assert.deepEqual(output, { continue: true });
        const repeated = handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'Stop', turn_id: 'not-finalized', stop_hook_active: true,
            last_assistant_message: 'still not finalized', permission_mode: 'default',
        }, value.options);
        assert.deepEqual(repeated, { continue: true });
        with_service(value.state(), (service) => {
            const events = service.repository.pending_outbox(10_000)
                .filter((candidate) => candidate.event_type === 'central_memory.turn_unfinalized');
            assert.equal(events.length, 1, 'the same recovery observation is idempotent');
            assert.deepEqual(events[0]?.payload, {
                thread_id: 'thread-1',
                turn_id: 'not-finalized',
                assistant_message_hash: hash_canonical('still not finalized'),
                reason: 'stop_hook_active_without_record_turn_finalization',
                stop_hook_active: true,
                recovery_required: 'post_hoc_formal_memory_review',
            });
            assert.equal('memories' in (events[0]?.payload ?? {}), false);
            assert.equal(events.some((candidate) =>
                candidate.event_type === 'central_memory.turn_finalized'), false);
        });
    } finally { value.close(); }
});

test('the MCP gateway rejects cross-turn replay and preserves same-turn recall/finalize retries', async () => {
    const value = fixture();
    value.session_start();
    handle_codex_hook({
        session_id: 'thread-1', transcript_path: null, cwd: value.root,
        hook_event_name: 'UserPromptSubmit', turn_id: 'gateway-turn', prompt: 'Bind this task.',
        permission_mode: 'default',
    }, value.options);
    const gateway_capability = value.state().capability;
    const mcp = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'runtime', user_id: 'runtime', project_id: 'runtime',
        env: { ...process.env, PLUGIN_DATA: value.plugin_data },
        audit: new mcp_audit_log(),
    });
    const client = new Client({ name: 'codex-hook-gateway-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(server_transport);
    await client.connect(client_transport);
    try {
        const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
        assert.equal(tools.has('longmemory_codex_memory'), true);
        assert.equal(tools.has('longmemory_central_publish'), false);
        const denied = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'bind', session_id: 'thread-1', capability: 'x'.repeat(43),
                turn_id: 'gateway-turn',
                project_id: 'novel', responsibility: 'Write the novel.',
            },
        });
        assert.equal(denied.isError, true);
        const accepted = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'bind', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn',
                project_id: 'novel', project_name: 'Novel',
                responsibility: 'Write and maintain story continuity.',
                initial_query: 'story continuity',
            },
        });
        assert.notEqual(accepted.isError, true, JSON.stringify(accepted.content));
        assert.equal(value.state().bound, true);
        const recalled = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'recall', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn',
                query: 'story continuity', limit: 4, token_budget: 512,
            },
        });
        assert.notEqual(recalled.isError, true, JSON.stringify(recalled.content));
        const recalled_retry = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'recall', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn',
                query: 'story continuity', limit: 4, token_budget: 512,
            },
        });
        assert.notEqual(recalled_retry.isError, true, JSON.stringify(recalled_retry.content));
        const finalized = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'record_turn', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn', memories: [], acknowledged_delivery_ids: [],
            },
        });
        assert.notEqual(finalized.isError, true, JSON.stringify(finalized.content));
        const finalized_retry = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'record_turn', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn', memories: [], acknowledged_delivery_ids: [],
            },
        });
        assert.notEqual(finalized_retry.isError, true, JSON.stringify(finalized_retry.content));

        handle_codex_hook({
            session_id: 'thread-1', transcript_path: null, cwd: value.root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'gateway-next-turn', prompt: 'Continue.',
            permission_mode: 'default',
        }, value.options);
        assert.notEqual(value.state().capability, gateway_capability);
        const replayed = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'recall', session_id: 'thread-1', capability: gateway_capability,
                turn_id: 'gateway-turn', query: 'story continuity', limit: 4, token_budget: 512,
            },
        });
        assert.equal(replayed.isError, true, 'a capability from the preceding turn must be rejected');
        const current = await client.callTool({
            name: 'longmemory_codex_memory',
            arguments: {
                action: 'recall', session_id: 'thread-1', capability: value.state().capability,
                turn_id: 'gateway-next-turn', query: 'story continuity', limit: 4, token_budget: 512,
            },
        });
        assert.notEqual(current.isError, true, JSON.stringify(current.content));
    } finally {
        await client.close();
        await mcp.server.close();
        await mcp.runtime.close();
        value.close();
    }
});
