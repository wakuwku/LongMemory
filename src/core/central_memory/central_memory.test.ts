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
 *  file  : src/core/central_memory/central_memory.test.ts
 *  usage : tests the LongMemory central memory component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { CentralMemoryService } from './service.js';
import { build_central_thread_context } from './context.js';
import type { central_memory_context_entry, central_memory_level, central_thread } from './types.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { apply_migrations, migrations } from '../../stores/sqlite/migrations.js';

function fixture() {
    const store = new SqliteStore(':memory:', {
        tenant_id: 'tenant',
        user_id: 'user',
        startup_integrity_check: false,
        now: () => 1_000,
    });
    const repository = store.central_memory;
    repository.register_project({ project_id: 'novel', name: 'Novel', at: 1_000 });
    repository.register_role({
        role_id: 'writer', project_id: 'novel', name: 'Writer', responsibility: 'Write the novel', at: 1_001,
    });
    repository.register_task({
        task_id: 'chapter', project_id: 'novel', role_id: 'writer', title: 'Write chapter', at: 1_002,
    });
    const service = new CentralMemoryService(repository);
    service.register_thread({
        thread_id: 'thread-write', project_id: 'novel', role_id: 'writer', task_id: 'chapter',
        responsibility: 'Draft chapters', at: 1_003,
    });
    return { store, repository, service };
}

const base_publish = {
    memory_id: 'memory-style',
    project_id: 'novel',
    role_id: 'writer',
    task_id: 'chapter',
    level: 4 as const,
    memory_kind: 'procedure',
    title: 'Chapter opening rule',
    summary: 'Open with a concrete conflict.',
    body: 'The first scene must introduce a visible conflict before exposition.',
    created_by: 'thread-write',
    source_thread_id: 'thread-write',
};

function user_decision(note: string, action_id = 'action-1') {
    return {
        actor_id: 'user',
        actor_kind: 'user' as const,
        action_id,
        channel: 'codex_ui' as const,
        note,
        evidence: { turn_id: `turn-${action_id}`, explicit_user_action: true },
    };
}

function context_entry(
    memory_id: string,
    level: central_memory_level,
    origin: central_memory_context_entry['workset']['origin'],
    relevance: number,
): central_memory_context_entry {
    return {
        memory: {
            memory_id, project_id: 'novel', role_id: level >= 2 ? 'writer' : null,
            task_id: level >= 3 ? 'chapter' : null, level, memory_kind: 'test',
            title: memory_id, current_version: 1, metadata: {}, created_at: 1, updated_at: 1,
        },
        version: {
            memory_id, version: 1, status: 'active', title: memory_id,
            summary: `summary for ${memory_id}`, body: `body for ${memory_id}`,
            content_hash: `hash-${memory_id}`, importance: 0.5, is_major: false,
            change_reason: '', metadata: {}, created_by: 'thread-write', created_at: 1,
            activated_at: 1, superseded_at: null, retracted_at: null,
        },
        workset: {
            thread_id: 'thread-write', memory_id, synced_version: 1, consumed_version: null,
            pending_version: null, relevance, origin, sync_state: 'current',
            last_synced_at: 1, last_consumed_at: null, updated_at: 1,
        },
    };
}

const context_thread: central_thread = {
    thread_id: 'thread-write', project_id: 'novel', role_id: 'writer', task_id: 'chapter',
    responsibility: 'Draft chapters', status: 'active', metadata: {},
    last_safe_boundary_at: 1, created_at: 1, updated_at: 1,
};

test('all current central migrations upgrade an existing v3 database without losing prior rows', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    for (const migration of migrations().filter((candidate) => candidate.version <= 3)) {
        database.transaction(() => {
            database.exec(migration.sql);
            database.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
                .run(migration.version, migration.name, 100 + migration.version);
        })();
    }
    database.prepare(`INSERT INTO cold_logs
        (tenant_id, user_id, event_id, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)`)
        .run('tenant', 'user', 'legacy', 200, '{}');

    assert.deepEqual(
        apply_migrations(database, 300),
        migrations().filter((candidate) => candidate.version > 3).map((candidate) => candidate.version),
    );
    const cold_logs = database.prepare('SELECT COUNT(*) AS count FROM cold_logs').get() as { count: number };
    const central_tables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name LIKE 'cm_%'`).get() as { count: number };
    assert.equal(cold_logs.count, 1);
    assert.ok(central_tables.count >= 14);
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='cm_history_backfill_runs'`).get()), true);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    database.close();
});

test('all later migrations restore hardened triggers for databases that already recorded migration 4', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    for (const migration of migrations().filter((candidate) => candidate.version <= 4)) {
        database.transaction(() => {
            database.exec(migration.sql);
            database.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
                .run(migration.version, migration.name, 400 + migration.version);
        })();
    }
    const migration_4_triggers = database.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'cm_%' ORDER BY name`).all() as Array<{ name: string; sql: string }>;
    database.exec(`
        DROP TRIGGER cm_sources_immutable;
        DROP TRIGGER cm_effective_retraction_requires_confirmation;
    `);

    assert.deepEqual(
        apply_migrations(database, 500),
        migrations().filter((candidate) => candidate.version > 4).map((candidate) => candidate.version),
    );
    const trigger_rows = database.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'cm_%'`,
    ).all() as Array<{ name: string }>;
    const trigger_names = new Set(trigger_rows.map((row) => row.name));
    assert.equal(trigger_names.has('cm_sources_immutable'), true);
    assert.equal(trigger_names.has('cm_effective_retraction_requires_confirmation'), true);
    assert.equal(trigger_names.has('cm_confirmations_insert_pending'), true);
    assert.equal(trigger_names.has('cm_tombstone_revival_requires_confirmation'), true);
    const hardened_triggers = new Map((database.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'cm_%' ORDER BY name`).all() as Array<{
        name: string; sql: string;
    }>).map((trigger) => [trigger.name, trigger.sql]));
    for (const trigger of migration_4_triggers) {
        assert.equal(hardened_triggers.get(trigger.name), trigger.sql,
            `migration 4 trigger ${trigger.name} must be restored byte-for-byte`);
    }
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    database.close();
});

test('migration 6 and all later migrations upgrade databases that already recorded migration 5', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    for (const migration of migrations().filter((candidate) => candidate.version <= 5)) {
        database.transaction(() => {
            database.exec(migration.sql);
            database.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
                .run(migration.version, migration.name, 600 + migration.version);
        })();
    }
    database.prepare(`INSERT INTO cold_logs
        (tenant_id, user_id, event_id, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)`)
        .run('tenant', 'user', 'pre-v6', 700, '{}');

    assert.deepEqual(
        apply_migrations(database, 800),
        migrations().filter((candidate) => candidate.version > 5).map((candidate) => candidate.version),
    );
    const trigger = database.prepare(`SELECT name FROM sqlite_master
        WHERE type='trigger' AND name='cm_tombstone_revival_requires_confirmation'`).get() as
        { name: string } | undefined;
    const cold_logs = database.prepare(`SELECT COUNT(*) AS count FROM cold_logs
        WHERE event_id='pre-v6'`).get() as { count: number };
    assert.equal(trigger?.name, 'cm_tombstone_revival_requires_confirmation');
    assert.equal(cold_logs.count, 1);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    database.close();
});

test('concurrent first startup serializes and rechecks the complete migration set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-migration-race-'));
    const database_path = join(root, 'central.db');
    const migration_module = new URL('../../stores/sqlite/migrations.ts', import.meta.url).href;
    const worker_source = `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
            const { register } = await import('tsx/esm/api');
            register();
            const Database = (await import('better-sqlite3')).default;
            const { apply_migrations } = await import(workerData.migration_module);
            parentPort.postMessage({ type: 'ready' });
            await new Promise((resolve) => parentPort.once('message', resolve));
            const database = new Database(workerData.database_path);
            database.pragma('busy_timeout = 15000');
            try {
                const completed = apply_migrations(database, workerData.now);
                parentPort.postMessage({ type: 'done', completed });
            } finally {
                database.close();
            }
        })().catch((error) => parentPort.postMessage({
            type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error),
        }));
    `;
    const workers = Array.from({ length: 6 }, (_, index) => new Worker(worker_source, {
        eval: true,
        workerData: { database_path, migration_module, now: 1_000 + index },
    }));
    const ready = workers.map((worker) => new Promise<void>((resolve, reject) => {
        const on_message = (message: { type?: string; message?: string }) => {
            if (message.type === 'ready') {
                worker.off('message', on_message);
                resolve();
            } else if (message.type === 'error') {
                worker.off('message', on_message);
                reject(new Error(message.message));
            }
        };
        worker.on('message', on_message);
        worker.once('error', reject);
    }));
    try {
        await Promise.all(ready);
        const completed = workers.map((worker) => new Promise<number[]>((resolve, reject) => {
            const on_message = (message: { type?: string; completed?: number[]; message?: string }) => {
                if (message.type === 'done') {
                    worker.off('message', on_message);
                    resolve(message.completed ?? []);
                } else if (message.type === 'error') {
                    worker.off('message', on_message);
                    reject(new Error(message.message));
                }
            };
            worker.on('message', on_message);
            worker.once('error', reject);
        }));
        for (const worker of workers) worker.postMessage('go');
        const results = await Promise.all(completed);
        const expected_versions = migrations().map((migration) => migration.version);
        assert.deepEqual(results.flat().sort((left, right) => left - right), expected_versions);

        const database = new Database(database_path, { readonly: true });
        try {
            const applied = database.prepare('SELECT version FROM migrations ORDER BY version')
                .all() as Array<{ version: number }>;
            assert.deepEqual(applied.map((row) => row.version), expected_versions);
            assert.deepEqual(database.pragma('foreign_key_check'), []);
        } finally {
            database.close();
        }
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        rmSync(root, { recursive: true, force: true });
    }
});

test('project, role, task, and thread registration reject credentials before hierarchy writes', () => {
    const { store, repository, service } = fixture();
    try {
        const credential = 'unsafe-hierarchy-value-123456';
        const attempts = [
            () => repository.register_project({
                project_id: 'unsafe-project', name: 'Unsafe project', description: `password=${credential}`,
            }),
            () => repository.register_role({
                role_id: 'unsafe-role', project_id: 'novel', name: `password=${credential}`,
            }),
            () => repository.register_task({
                task_id: 'unsafe-task', project_id: 'novel', role_id: 'writer',
                title: 'Unsafe task', objective: `password=${credential}`,
            }),
            () => repository.register_thread({
                thread_id: 'unsafe-repository-thread', project_id: 'novel',
                metadata: { nested: { credential: `password=${credential}` } },
            }),
            () => service.register_thread({
                thread_id: 'unsafe-service-thread', project_id: 'novel',
                responsibility: `password=${credential}`,
            }),
        ];
        for (const attempt of attempts) {
            let failure: Error | null = null;
            try { attempt(); } catch (error) { failure = error as Error; }
            assert.ok(failure);
            assert.match(failure.message, /prohibited credential material/i);
            assert.doesNotMatch(failure.message, new RegExp(credential));
        }
        assert.throws(() => repository.require_project('unsafe-project'), /was not found/);
        assert.equal(repository.get_role('unsafe-role'), null);
        assert.equal(repository.get_task('unsafe-task'), null);
        assert.equal(repository.get_thread('unsafe-repository-thread'), null);
        assert.equal(repository.get_thread('unsafe-service-thread'), null);
    } finally {
        store.close();
    }
});

test('auxiliary service and repository writes reject credentials without partial mutation', () => {
    const { store, repository, service } = fixture();
    try {
        const credential = 'unsafe-auxiliary-value-123456';
        const reject_without_echo = (operation: () => unknown): void => {
            let failure: Error | null = null;
            try { operation(); } catch (error) { failure = error as Error; }
            assert.ok(failure);
            assert.match(failure.message, /prohibited credential material/i);
            assert.doesNotMatch(failure.message, new RegExp(credential));
        };

        const subscription_count = (repository.database.prepare(
            'SELECT COUNT(*) AS count FROM cm_subscriptions',
        ).get() as { count: number }).count;
        reject_without_echo(() => service.subscribe({
            thread_id: 'thread-write', selector_kind: 'topic',
            selector_value: `password=${credential}`,
        }));
        assert.equal((repository.database.prepare(
            'SELECT COUNT(*) AS count FROM cm_subscriptions',
        ).get() as { count: number }).count, subscription_count);

        reject_without_echo(() => service.publish({
            ...base_publish,
            memory_id: 'unsafe-confirmation-prompt',
            major: true,
            confirmation_prompt: `password=${credential}`,
        }));
        assert.equal(repository.get_memory('unsafe-confirmation-prompt'), null);

        service.publish(base_publish);
        service.publish({
            ...base_publish,
            memory_id: 'memory-other',
            title: 'Other memory',
            summary: 'A second safe memory.',
            body: 'A second safe body for conflict tests.',
        });
        reject_without_echo(() => service.add_dependency({
            subject_kind: 'artifact', subject_id: `password=${credential}`,
            memory_id: base_publish.memory_id, memory_version: 1, details: {},
        }));
        assert.equal((repository.database.prepare(
            'SELECT COUNT(*) AS count FROM cm_dependencies',
        ).get() as { count: number }).count, 0);

        reject_without_echo(() => service.report_conflict({
            memory_a_id: base_publish.memory_id, memory_a_version: 1,
            memory_b_id: 'memory-other', memory_b_version: 1,
            severity: 0.5, rationale: `password=${credential}`,
        }));
        assert.equal(repository.list_conflicts().length, 0);

        reject_without_echo(() => service.request_retraction({
            memory_id: base_publish.memory_id, expected_current_version: 1,
            requested_by: 'thread-write', reason: `password=${credential}`,
        }));
        assert.equal(repository.list_pending_confirmations(base_publish.memory_id).length, 0);

        repository.enqueue({
            event_id: 'safe-event', aggregate_kind: 'test', aggregate_id: 'safe',
            event_type: 'test.safe', payload: { safe: true }, at: 2_000,
        });
        reject_without_echo(() => repository.mark_outbox_failed(
            'safe-event', `password=${credential}`, 3_000,
        ));
        const unchanged_event = repository.require_outbox('safe-event');
        assert.equal(unchanged_event.attempts, 0);
        assert.equal(unchanged_event.last_error, null);

        reject_without_echo(() => repository.enqueue({
            event_id: 'unsafe-event', aggregate_kind: 'test', aggregate_id: 'unsafe',
            event_type: 'test.unsafe', payload: { note: `password=${credential}` },
        }));
        assert.equal(repository.get_outbox('unsafe-event'), null);
    } finally {
        store.close();
    }
});

test('formal memory rejects obvious credentials at the authoritative service boundary', () => {
    const { store, repository, service } = fixture();
    try {
        const prohibited = [
            'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
            'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
            'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345',
            'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
            'password=correct-horse-battery-staple',
            'password=<ActualPassword123>',
            '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
        ];
        for (const body of prohibited) {
            let failure: Error | null = null;
            try { service.publish({ ...base_publish, body }); }
            catch (error) { failure = error as Error; }
            assert.ok(failure);
            assert.match(failure.message, /prohibited credential material/);
            assert.equal(failure.message.includes(body), false, 'the rejected credential must not be echoed');
            assert.equal(repository.get_memory(base_publish.memory_id), null);
        }

        const secret_key_name = `sk-proj-${'z'.repeat(28)}`;
        let key_failure: Error | null = null;
        try {
            service.publish({
                ...base_publish,
                metadata: { [secret_key_name]: 'credential accidentally used as a JSON key' },
            });
        } catch (error) {
            key_failure = error as Error;
        }
        assert.ok(key_failure);
        assert.match(key_failure.message, /prohibited credential material/);
        assert.equal(key_failure.message.includes(secret_key_name), false, 'credential-like object keys must not be echoed');
        assert.equal(repository.get_memory(base_publish.memory_id), null);

        const deep_secret = 'unsafe-deep-service-value-123456';
        let nested: unknown = `password=${deep_secret}`;
        for (let depth = 0; depth < 32; depth += 1) nested = { nested };
        let deep_failure: Error | null = null;
        try {
            service.publish({ ...base_publish, metadata: { nested } });
        } catch (error) {
            deep_failure = error as Error;
        }
        assert.ok(deep_failure, 'credential scanning must not stop at a fixed nesting depth');
        assert.match(deep_failure.message, /prohibited credential material/);
        assert.equal(deep_failure.message.includes(deep_secret), false);
        assert.equal(repository.get_memory(base_publish.memory_id), null);

        const accepted = service.publish({
            ...base_publish,
            body: 'Use seed 42, token_budget=1800, and API_KEY=<redacted> for the reproducible run.',
            metadata: { credential_policy: 'Store only placeholders such as password=${PASSWORD}.' },
        });
        assert.equal(accepted.effective, true);
    } finally {
        store.close();
    }
});

test('central confirmation decisions reject credentials without echoing or mutation', () => {
    const { store, repository, service } = fixture();
    try {
        const pending = service.publish({ ...base_publish, major: true, at: 1_500 });
        const confirmation_id = pending.confirmation!.confirmation_id;
        const credential = 'unsafe-confirmation-value-123456';
        const api_credential = `sk-proj-${'z'.repeat(28)}`;
        const decisions = [
            { ...user_decision('safe note', 'safe-action'), note: `password=${credential}` },
            { ...user_decision('safe note', 'safe-action'), actor_id: `password=${credential}` },
            { ...user_decision('safe note', `password=${credential}`) },
            {
                ...user_decision('safe note', 'safe-action'),
                evidence: { explicit_user_action: true, api_key: api_credential },
            },
        ];
        for (const decision of decisions) {
            let failure: Error | null = null;
            try { service.approve(confirmation_id, decision, 1_510); }
            catch (error) { failure = error as Error; }
            assert.ok(failure);
            assert.match(failure.message, /prohibited credential material/i);
            assert.doesNotMatch(failure.message, new RegExp(credential));
            assert.doesNotMatch(failure.message, new RegExp(api_credential));
            const unchanged = repository.require_confirmation(confirmation_id);
            assert.equal(unchanged.status, 'pending');
            assert.equal(unchanged.decision_note, '');
            assert.deepEqual(unchanged.decision_metadata, {});
        }
    } finally {
        store.close();
    }
});

test('versions are immutable, optimistic and confirmation-gated', () => {
    const { store, repository, service } = fixture();
    try {
        const first = service.publish({ ...base_publish, at: 2_000 });
        assert.equal(first.effective, true);
        assert.equal(first.version.version, 1);
        assert.equal(first.version.status, 'active');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 1);

        assert.throws(
            () => service.publish({ ...base_publish, body: 'Changed without a compare token.', at: 2_100 }),
            /expected_current_version is required/,
        );
        assert.throws(
            () => service.publish({ ...base_publish, expected_current_version: 0, body: 'Stale update.', at: 2_101 }),
            /expected current version 0, actual 1/,
        );

        service.add_dependency({
            dependency_id: 'dep-1', subject_kind: 'artifact', subject_id: 'chapter-1',
            memory_id: base_publish.memory_id, memory_version: 1, details: {}, at: 2_110,
        });
        const second = service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'The first scene must introduce a visible conflict in its first three paragraphs.',
            change_reason: 'Make the rule measurable.',
            at: 2_200,
        });
        assert.equal(second.version.version, 2);
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'superseded');
        assert.equal(repository.require_dependency('dep-1').status, 'needs_review');

        const major = service.publish({
            ...base_publish,
            expected_current_version: 2,
            body: 'Every opening must start in medias res; no exceptions.',
            major: true,
            at: 2_300,
        });
        assert.equal(major.effective, false);
        assert.equal(major.version.status, 'pending_confirmation');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 2);
        assert.equal(major.confirmation?.status, 'pending');

        const approved = service.approve(
            major.confirmation!.confirmation_id,
            user_decision('User approved the rule.', 'approve-major'),
            2_400,
        );
        assert.equal(approved.version.status, 'active');
        assert.equal(approved.memory.current_version, 3);
        assert.equal(approved.confirmation?.status, 'approved');

        const lock_request = service.request_lock({
            memory_id: base_publish.memory_id,
            expected_current_version: 3,
            requested_by: 'thread-write',
            reason: 'Protect the approved rule.',
            at: 2_500,
        });
        assert.equal(lock_request.effective, false);
        assert.equal(repository.require_version(base_publish.memory_id, 3).status, 'active');
        const locked = service.approve(
            lock_request.confirmation!.confirmation_id,
            user_decision('Lock the approved rule.', 'approve-lock'),
            2_550,
        );
        assert.equal(locked.version.status, 'locked');
        const locked_override = service.publish({
            ...base_publish,
            expected_current_version: 3,
            body: 'Open in medias res unless a quiet opening creates stronger suspense.',
            at: 2_600,
        });
        assert.equal(locked_override.effective, false);
        assert.equal(locked_override.confirmation?.confirmation_kind, 'locked_override');
        assert.throws(() => store.database.prepare(`UPDATE cm_memory_versions SET status='superseded'
            WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style' AND version=3`).run());

        const override = service.approve(
            locked_override.confirmation!.confirmation_id,
            user_decision('Unlock and replace.', 'approve-override'),
            2_700,
        );
        assert.equal(override.memory.current_version, 4);
        assert.equal(repository.require_version(base_publish.memory_id, 3).status, 'superseded');
        assert.throws(() => store.database.prepare(`UPDATE cm_memory_versions SET body='tampered'
            WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style' AND version=4`).run(),
            /payloads are immutable/);
    } finally {
        store.close();
    }
});

test('thread worksets update at safe boundaries without rewriting consumed history', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 3_000 });
        let workset = repository.require_workset('thread-write', base_publish.memory_id);
        assert.equal(workset.sync_state, 'pending');
        assert.equal(workset.pending_version, 1);
        assert.equal(workset.origin, 'own_thread');

        service.sync_at_safe_boundary('thread-write', 3_100);
        workset = service.consume('thread-write', base_publish.memory_id, 1, 3_110);
        assert.equal(workset.synced_version, 1);
        assert.equal(workset.consumed_version, 1);

        service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'Introduce the concrete conflict in the first three paragraphs.',
            at: 3_200,
        });
        workset = repository.require_workset('thread-write', base_publish.memory_id);
        assert.equal(workset.sync_state, 'pending');
        assert.equal(workset.pending_version, 2);
        assert.equal(workset.synced_version, 1);
        assert.equal(workset.consumed_version, 1);
        assert.equal(service.context('thread-write')[0]?.version.version, 1);

        service.sync_at_safe_boundary('thread-write', 3_300);
        workset = repository.require_workset('thread-write', base_publish.memory_id);
        assert.equal(workset.synced_version, 2);
        assert.equal(workset.consumed_version, 1);
        assert.equal(service.context('thread-write')[0]?.version.version, 2);

        const retract_request = service.request_retraction({
            memory_id: base_publish.memory_id,
            expected_current_version: 2,
            requested_by: 'thread-write',
            reason: 'Rule was invalidated by later evidence.',
            at: 3_400,
        });
        assert.equal(retract_request.effective, false);
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 2);
        service.approve(
            retract_request.confirmation!.confirmation_id,
            user_decision('Retract the invalid rule.', 'approve-retract'),
            3_410,
        );
        workset = repository.require_workset('thread-write', base_publish.memory_id);
        assert.equal(workset.sync_state, 'retracted');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);
        assert.ok(repository.pending_outbox(100, 4_000).some((event) => event.event_type === 'central_memory.version_retracted'));
    } finally {
        store.close();
    }
});

test('new threads bootstrap broad maps but only relevant level-four memories', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 4_000 });
        repository.register_role({
            role_id: 'artist', project_id: 'novel', name: 'Artist', responsibility: 'Illustrate scenes', at: 4_010,
        });
        repository.register_task({
            task_id: 'illustration', project_id: 'novel', role_id: 'artist', title: 'Draw illustration', at: 4_020,
        });
        service.register_thread({
            thread_id: 'thread-art', project_id: 'novel', role_id: 'artist', task_id: 'illustration', at: 4_030,
        });
        assert.throws(() => repository.require_workset('thread-art', base_publish.memory_id), /was not found/);

        service.publish({
            memory_id: 'memory-role-map', project_id: 'novel', role_id: 'writer', level: 2,
            memory_kind: 'role_summary', title: 'Writing responsibility',
            summary: 'The writing role owns prose continuity.',
            body: 'The writing role owns prose continuity and communicates scene requirements to illustration.',
            created_by: 'thread-write', source_thread_id: 'thread-write', at: 4_100,
        });
        const map = repository.require_workset('thread-art', 'memory-role-map');
        assert.equal(map.sync_state, 'pending');
        assert.equal(map.origin, 'subscription');
    } finally {
        store.close();
    }
});

test('context hierarchy outranks own-thread relevance and lower levels cannot consume an overflowing L1/L2 budget', () => {
    const ordered = build_central_thread_context(context_thread, [
        context_entry('l4-own', 4, 'own_thread', 1),
        context_entry('l2-shared', 2, 'shared', 1),
        context_entry('l3-own', 3, 'own_thread', 1),
        context_entry('l2-own', 2, 'own_thread', 0.1),
        context_entry('l1-project', 1, 'project_map', 0.1),
    ], {
        token_budget: 1_000,
        include_consumed: true,
        retractions: [{
            memory_id: 'retired', synced_version: 7, consumed_version: 7,
            title: 'Retired rule', reason: 'Superseded by the user.',
        }],
    });
    assert.ok(ordered.text.indexOf('RETRACTED retired@v7') < ordered.text.indexOf('l1-project'));
    assert.ok(ordered.text.indexOf('l1-project') < ordered.text.indexOf('l2-own'));
    assert.ok(ordered.text.indexOf('l2-own') < ordered.text.indexOf('l2-shared'));
    assert.ok(ordered.text.indexOf('l2-shared') < ordered.text.indexOf('l3-own'));
    assert.ok(ordered.text.indexOf('l3-own') < ordered.text.indexOf('l4-own'));

    const mandatory = Array.from({ length: 24 }, (_, index) => context_entry(
        `mandatory-${String(index).padStart(2, '0')}`,
        index < 12 ? 1 : 2,
        'project_map',
        0.01,
    ));
    const lower = [
        ...Array.from({ length: 12 }, (_, index) => context_entry(`lower-l3-${index}`, 3, 'own_thread', 1)),
        context_entry('lower-l4', 4, 'own_thread', 1),
    ];
    const constrained = build_central_thread_context(context_thread, [...lower, ...mandatory], {
        token_budget: 64,
        include_consumed: true,
    });
    assert.equal(constrained.within_budget, true);
    assert.ok(constrained.omitted.some((entry) => entry.memory_id.startsWith('mandatory-')
        && entry.reason === 'token_budget'));
    assert.ok(constrained.omitted.filter((entry) => entry.memory_id.startsWith('lower-'))
        .every((entry) => entry.reason === 'higher_level_priority'));
    assert.doesNotMatch(constrained.text, /lower-l3|lower-l4/);
    assert.equal(constrained.included.some((entry) => entry.memory_id.startsWith('lower-')), false);
});

test('thread context reads the complete staged map before applying the render budget', () => {
    const { store, service } = fixture();
    try {
        for (let index = 0; index < 125; index++) {
            service.publish({
                memory_id: `task-map-${String(index).padStart(3, '0')}`,
                project_id: 'novel', role_id: 'writer', task_id: 'chapter', level: 3,
                memory_kind: 'task_summary', title: `Task map ${index}`,
                summary: `Compact task map ${index}.`, body: `Task map body ${index}.`,
                created_by: 'thread-write', source_thread_id: 'thread-write', at: 4_000 + index,
            });
        }
        service.sync_at_safe_boundary('thread-write', 4_200);
        const entries = service.context('thread-write');
        assert.equal(entries.length, 125);
        assert.equal(entries[0]?.memory.level, 3);
        assert.equal(entries.at(-1)?.memory.memory_id, 'task-map-124');
    } finally {
        store.close();
    }
});

test('context packets keep initial maps compact and expand changed or level-four memories', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({
            memory_id: 'memory-role-map', project_id: 'novel', role_id: 'writer', level: 2,
            memory_kind: 'role_summary', title: 'Writing responsibility',
            summary: 'The writer maintains prose continuity.',
            body: 'LEVEL_TWO_INITIAL_BODY should stay out of the initial compact map.',
            created_by: 'thread-write', source_thread_id: 'thread-write', at: 4_200,
        });
        service.publish({
            ...base_publish,
            memory_id: 'memory-detailed-procedure',
            body: 'LEVEL_FOUR_BODY must be present when the detailed memory is first loaded.',
            at: 4_210,
        });
        service.sync_at_safe_boundary('thread-write', 4_220);

        const initial = build_central_thread_context(
            repository.require_thread('thread-write'),
            service.context('thread-write'),
            { token_budget: 1_000 },
        );
        assert.equal(initial.within_budget, true);
        assert.match(initial.text, /The writer maintains prose continuity/);
        assert.doesNotMatch(initial.text, /LEVEL_TWO_INITIAL_BODY/);
        assert.match(initial.text, /LEVEL_FOUR_BODY/);
        for (const entry of service.context('thread-write')) {
            service.consume('thread-write', entry.memory.memory_id, entry.version.version, 4_230);
        }

        service.publish({
            memory_id: 'memory-role-map', project_id: 'novel', role_id: 'writer', level: 2,
            memory_kind: 'role_summary', title: 'Writing responsibility',
            summary: 'The writer now also owns scene handoff.',
            body: 'LEVEL_TWO_UPDATED_BODY must be expanded because it replaces a consumed version.',
            expected_current_version: 1,
            created_by: 'thread-write', source_thread_id: 'thread-write', at: 4_240,
        });
        service.sync_at_safe_boundary('thread-write', 4_250);
        const update = build_central_thread_context(
            repository.require_thread('thread-write'),
            service.context('thread-write'),
            { token_budget: 1_000 },
        );
        assert.match(update.text, /LEVEL_TWO_UPDATED_BODY/);
        assert.deepEqual(update.omitted.filter((entry) => entry.reason === 'already_consumed')
            .map((entry) => entry.memory_id), ['memory-detailed-procedure']);
    } finally {
        store.close();
    }
});

test('major changes cannot forge confirmation and failed publication rolls back atomically', () => {
    const { store, repository, service } = fixture();
    try {
        const forged_input = { ...base_publish, major: true, confirmed: true, at: 5_000 };
        const pending = service.publish(forged_input);
        assert.equal(pending.effective, false);
        assert.equal(pending.version.status, 'pending_confirmation');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);
        assert.throws(
            () => service.approve(pending.confirmation!.confirmation_id, {
                ...user_decision('Missing evidence.', 'empty-evidence'),
                evidence: {},
            }, 5_010),
            /requires evidence/,
        );
        assert.throws(() => store.database.prepare(`UPDATE cm_memory_versions SET status='active'
            WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style' AND version=1`).run(),
        /requires approved confirmation/);
        assert.throws(() => repository.insert_confirmation({
            confirmation_id: 'forged-approved-confirmation',
            memory_id: base_publish.memory_id,
            proposed_version: 1,
            expected_current_version: null,
            requested_status: 'active',
            confirmation_kind: 'major_rule',
            status: 'approved',
            prompt: 'Forged approval',
            requested_by: 'automatic-agent',
            requested_at: 5_011,
            decided_by: 'user',
            decided_at: 5_011,
            decision_note: 'Forged at insert time.',
            decision_metadata: {
                actor_kind: 'user', action_id: 'forged', channel: 'codex_ui', evidence: { forged: true },
            },
            metadata: {},
        }), /must enter as undecided pending requests/);
        assert.throws(() => store.database.prepare(`UPDATE cm_confirmations SET
                status='approved', decided_by='user', decided_at=5012,
                decision_note='Forged without evidence', decision_metadata_json='{}'
            WHERE tenant_id='tenant' AND user_id='user' AND confirmation_id=?`)
            .run(pending.confirmation!.confirmation_id), /missing human evidence/);
        assert.throws(() => store.database.prepare(`UPDATE cm_confirmations SET
                status='approved', decided_by='user', decided_at=5013,
                decision_note='Forged with incomplete evidence',
                decision_metadata_json='{"actor_kind":"user","channel":"codex_ui","evidence":{"turn":"x"}}'
            WHERE tenant_id='tenant' AND user_id='user' AND confirmation_id=?`)
            .run(pending.confirmation!.confirmation_id), /missing human evidence/);

        repository.enqueue({
            event_id: 'memory:memory-atomic:1:published',
            aggregate_kind: 'test',
            aggregate_id: 'different',
            event_type: 'test.conflict',
            payload: { incompatible: true },
            at: 5_020,
        });
        assert.throws(() => service.publish({
            ...base_publish,
            memory_id: 'memory-atomic',
            title: 'Atomic publication',
            at: 5_030,
        }), /already exists with different content/);
        assert.equal(repository.get_memory('memory-atomic'), null);
        assert.throws(() => repository.require_workset('thread-write', 'memory-atomic'), /was not found/);
    } finally {
        store.close();
    }
});

test('major governance is sticky at the core service boundary', () => {
    const { store, repository, service } = fixture();
    try {
        const first = service.publish({ ...base_publish, major: true, at: 5_100 });
        assert.equal(first.effective, false);
        service.approve(
            first.confirmation!.confirmation_id,
            user_decision('Approve the foundational rule.', 'approve-sticky-major'),
            5_110,
        );

        repository.insert_version({
            memory_id: base_publish.memory_id,
            version: 2,
            status: 'pending_confirmation',
            title: base_publish.title,
            summary: base_publish.summary,
            body: 'A raw repository candidate that attempts to drop major governance.',
            content_hash: 'raw-downgrade-attempt',
            importance: 0.5,
            is_major: false,
            change_reason: '',
            metadata: {},
            created_by: 'untrusted-internal-caller',
            created_at: 5_115,
        });
        assert.throws(
            () => repository.activate_candidate(base_publish.memory_id, 1, 2, 'active', 5_116),
            /requires approved confirmation/,
        );
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 1);
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'active');
        assert.equal(repository.require_version(base_publish.memory_id, 2).status, 'pending_confirmation');

        const attempted_downgrade = service.publish({
            ...base_publish,
            expected_current_version: 1,
            major: false,
            body: 'A changed version that tries to omit major governance.',
            at: 5_120,
        });
        assert.equal(attempted_downgrade.effective, false);
        assert.equal(attempted_downgrade.version.version, 3);
        assert.equal(attempted_downgrade.version.is_major, true);
        assert.equal(attempted_downgrade.version.status, 'pending_confirmation');
        assert.equal(attempted_downgrade.confirmation?.confirmation_kind, 'major_rule');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 1);

        const project_rule = service.publish({
            ...base_publish,
            memory_id: 'project-rule',
            role_id: null,
            task_id: null,
            level: 1,
            major: false,
            at: 5_130,
        });
        assert.equal(project_rule.effective, false);
        assert.equal(project_rule.version.is_major, true);
        assert.equal(project_rule.confirmation?.confirmation_kind, 'major_rule');
    } finally {
        store.close();
    }
});

test('only previously activated major rules make later revivals major', () => {
    {
        const { store, repository, service } = fixture();
        try {
            const rejected_major = service.publish({ ...base_publish, major: true, at: 5_200 });
            service.reject(
                rejected_major.confirmation!.confirmation_id,
                user_decision('Reject this proposed major rule.', 'reject-never-activated-major'),
                5_210,
            );
            assert.equal(repository.require_version(base_publish.memory_id, 1).activated_at, null);
            const ordinary = service.publish({
                ...base_publish,
                expected_current_version: null,
                major: false,
                body: 'An ordinary replacement after the proposed major rule was rejected.',
                at: 5_220,
            });
            assert.equal(ordinary.effective, true);
            assert.equal(ordinary.version.is_major, false);
        } finally {
            store.close();
        }
    }

    {
        const { store, repository, service } = fixture();
        try {
            const major = service.publish({ ...base_publish, major: true, at: 5_230 });
            service.approve(
                major.confirmation!.confirmation_id,
                user_decision('Approve this major rule.', 'approve-activated-major'),
                5_240,
            );
            const retraction = service.request_retraction({
                memory_id: base_publish.memory_id,
                expected_current_version: 1,
                requested_by: 'thread-write',
                reason: 'The rule is temporarily invalid.',
                at: 5_250,
            });
            service.approve(
                retraction.confirmation!.confirmation_id,
                user_decision('Retract the major rule.', 'retract-activated-major'),
                5_260,
            );
            assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);

            const revival = service.publish({
                ...base_publish,
                expected_current_version: null,
                major: false,
                body: 'A proposed revival after an activated major rule was retracted.',
                at: 5_270,
            });
            assert.equal(revival.effective, false);
            assert.equal(revival.version.is_major, true);
            assert.equal(revival.confirmation?.confirmation_kind, 'major_rule');
        } finally {
            store.close();
        }
    }
});

test('ordinary tombstone revival requires confirmation at service and SQLite boundaries', () => {
    const { store, repository, service } = fixture();
    try {
        const first = service.publish({ ...base_publish, at: 5_300 });
        assert.equal(first.effective, true);
        assert.equal(first.version.is_major, false);

        const retraction = service.request_retraction({
            memory_id: base_publish.memory_id,
            expected_current_version: 1,
            requested_by: 'thread-write',
            reason: 'Withdraw the ordinary procedure.',
            at: 5_310,
        });
        service.approve(
            retraction.confirmation!.confirmation_id,
            user_decision('Approve the ordinary retraction.', 'retract-ordinary'),
            5_320,
        );
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);

        const revival = service.publish({
            ...base_publish,
            expected_current_version: null,
            body: 'A proposed revival of the withdrawn ordinary procedure.',
            at: 5_330,
        });
        assert.equal(revival.effective, false);
        assert.equal(revival.version.status, 'pending_confirmation');
        assert.equal(revival.version.is_major, false);
        assert.equal(revival.confirmation?.confirmation_kind, 'manual');
        assert.equal(revival.confirmation?.expected_current_version, null);

        assert.throws(
            () => repository.activate_candidate(base_publish.memory_id, null, 2, 'active', 5_340),
            /reviving retracted central memory requires approved confirmation/,
        );
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);
        assert.equal(repository.require_version(base_publish.memory_id, 2).status, 'pending_confirmation');

        const approved = service.approve(
            revival.confirmation!.confirmation_id,
            user_decision('Explicitly restore the withdrawn procedure.', 'revive-ordinary'),
            5_350,
        );
        assert.equal(approved.effective, true);
        assert.equal(approved.version.status, 'active');
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 2);

        const ordinary_replacement = service.publish({
            ...base_publish,
            expected_current_version: 2,
            body: 'A normal replacement after the explicitly approved revival.',
            at: 5_360,
        });
        assert.equal(ordinary_replacement.effective, true,
            'an approved revival must not permanently turn ordinary replacements into governed revivals');
        assert.equal(ordinary_replacement.confirmation, null);
    } finally {
        store.close();
    }
});

test('locked memory cannot be retracted without a separate user confirmation', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 6_000 });
        const lock_request = service.request_lock({
            memory_id: base_publish.memory_id,
            expected_current_version: 1,
            requested_by: 'thread-write',
            reason: 'This rule is foundational.',
            at: 6_010,
        });
        service.approve(
            lock_request.confirmation!.confirmation_id,
            user_decision('Lock it.', 'lock-foundational'),
            6_020,
        );

        const bypass = store.database.transaction(() => {
            store.database.prepare(`UPDATE cm_memories SET current_version=NULL
                WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style'`).run();
            store.database.prepare(`UPDATE cm_memory_versions SET status='retracted'
                WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style' AND version=1`).run();
        });
        assert.throws(() => bypass.immediate(), /requires approved confirmation/);
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 1);
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'locked');

        const retract_request = service.request_retraction({
            memory_id: base_publish.memory_id,
            expected_current_version: 1,
            requested_by: 'thread-write',
            reason: 'New evidence disproves it.',
            at: 6_030,
        });
        assert.equal(retract_request.confirmation?.requested_status, 'retracted');
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'locked');
        service.approve(
            retract_request.confirmation!.confirmation_id,
            user_decision('Retract after review.', 'retract-locked'),
            6_040,
        );
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, null);
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'retracted');
    } finally {
        store.close();
    }
});

test('locking cancels stale replacement approvals and requires a fresh locked override', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 6_100 });
        const stale_replacement = service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'A major replacement proposed before the current version is locked.',
            major: true,
            at: 6_110,
        });
        assert.equal(stale_replacement.version.status, 'pending_confirmation');

        const lock_request = service.request_lock({
            memory_id: base_publish.memory_id,
            expected_current_version: 1,
            requested_by: 'thread-write',
            reason: 'Protect the current rule before considering replacements.',
            at: 6_120,
        });
        service.approve(
            lock_request.confirmation!.confirmation_id,
            user_decision('Lock the current rule.', 'lock-before-replacement'),
            6_130,
        );

        assert.equal(
            repository.require_confirmation(stale_replacement.confirmation!.confirmation_id).status,
            'cancelled',
        );
        assert.equal(repository.require_version(base_publish.memory_id, 2).status, 'retracted');
        assert.throws(() => service.approve(
            stale_replacement.confirmation!.confirmation_id,
            user_decision('This old approval must no longer work.', 'approve-stale-replacement'),
            6_140,
        ), /is not pending/);

        const fresh_override = service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'A major replacement proposed before the current version is locked.',
            major: true,
            at: 6_150,
        });
        assert.equal(fresh_override.version.version, 3);
        assert.equal(fresh_override.confirmation?.confirmation_kind, 'locked_override');
        service.approve(
            fresh_override.confirmation!.confirmation_id,
            user_decision('Replace the locked rule after fresh review.', 'approve-fresh-override'),
            6_160,
        );
        assert.equal(repository.require_memory(base_publish.memory_id).current_version, 3);
        assert.equal(repository.require_version(base_publish.memory_id, 1).status, 'superseded');
    } finally {
        store.close();
    }
});

test('no-op publications append immutable evidence and governance fields create new versions', () => {
    const { store, repository, service } = fixture();
    const source = (source_id: string, uri: string, locator: Record<string, unknown> = {}) => ({
        source: {
            source_id,
            source_kind: 'codex_turn',
            uri,
            thread_id: 'thread-write',
            turn_id: source_id,
            locator: {},
            excerpt_hash: null,
            metadata: {},
            recorded_at: 7_000,
        },
        evidence_role: 'support',
        locator,
    });
    try {
        const first = service.publish({
            ...base_publish,
            importance: 0.5,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            sources: [source('source-1', 'codex://turn/1')],
            at: 7_000,
        });
        const noop = service.publish({
            ...base_publish,
            expected_current_version: 1,
            importance: 0.5,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            sources: [source('source-2', 'codex://turn/2')],
            at: 7_010,
        });
        assert.equal(noop.version.version, first.version.version);
        const links = store.database.prepare(`SELECT COUNT(*) AS count FROM cm_memory_version_sources
            WHERE tenant_id='tenant' AND user_id='user' AND memory_id='memory-style' AND version=1`)
            .get() as { count: number };
        assert.equal(links.count, 2);
        assert.equal(first.version.metadata.observed_at, '2026-01-02T03:04:05.000Z');
        assert.equal(store.check_integrity().issues.filter((issue) => issue.code === 'hash_mismatch').length, 0);

        assert.throws(() => service.publish({
            ...base_publish,
            expected_current_version: 1,
            importance: 0.5,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            sources: [source('source-1', 'codex://turn/tampered')],
            at: 7_020,
        }), /source source-1 is immutable/);
        assert.throws(() => service.publish({
            ...base_publish,
            expected_current_version: 1,
            importance: 0.5,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            sources: [source('source-1', 'codex://turn/1', { changed: true })],
            at: 7_021,
        }), /source link .* is immutable/);

        const changed_importance = service.publish({
            ...base_publish,
            expected_current_version: 1,
            importance: 0.7,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            at: 7_030,
        });
        assert.equal(changed_importance.version.version, 2);
        const changed_major = service.publish({
            ...base_publish,
            expected_current_version: 2,
            importance: 0.7,
            major: true,
            metadata: { observed_at: new Date('2026-01-02T03:04:05.000Z') },
            at: 7_040,
        });
        assert.equal(changed_major.version.version, 3);
        assert.equal(changed_major.version.status, 'pending_confirmation');
    } finally {
        store.close();
    }
});

test('workset synchronization uses exact versions and preserves manual origin', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 8_000 });
        repository.stage_workset({
            thread_id: 'thread-write', memory_id: base_publish.memory_id,
            pending_version: 1, origin: 'manual', relevance: 0.9, at: 8_005,
        });
        repository.stage_workset({
            thread_id: 'thread-write', memory_id: base_publish.memory_id,
            pending_version: 1, origin: 'subscription', relevance: 0.2, at: 8_006,
        });
        assert.equal(repository.require_workset('thread-write', base_publish.memory_id).origin, 'own_thread');
        service.sync_at_safe_boundary('thread-write', 8_010);
        service.consume('thread-write', base_publish.memory_id, 1, 8_011);
        service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'A newer exact version.',
            at: 8_020,
        });
        const stale_sync = repository.sync_workset('thread-write', base_publish.memory_id, 1, 8_021);
        assert.equal(stale_sync.synced_version, 1);
        assert.equal(stale_sync.pending_version, 2);
        assert.throws(() => service.consume('thread-write', base_publish.memory_id, 2, 8_022), /not synced to version 2/);
        service.sync_at_safe_boundary('thread-write', 8_030);
        assert.throws(() => service.consume('thread-write', base_publish.memory_id, 1, 8_031), /not synced to version 1/);
        assert.equal(service.consume('thread-write', base_publish.memory_id, 2, 8_032).consumed_version, 2);
    } finally {
        store.close();
    }
});

test('completed threads are audited but not refreshed or injected', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 9_000 });
        service.sync_at_safe_boundary('thread-write', 9_010);
        repository.register_thread({
            thread_id: 'thread-write', project_id: 'novel', role_id: 'writer', task_id: 'chapter',
            responsibility: 'Draft chapters', status: 'completed', at: 9_020,
        });
        service.publish({
            ...base_publish,
            expected_current_version: 1,
            body: 'A version published after the task completed.',
            at: 9_030,
        });
        const workset = repository.require_workset('thread-write', base_publish.memory_id);
        assert.equal(workset.synced_version, 1);
        assert.equal(workset.pending_version, null);
        assert.deepEqual(service.context('thread-write'), []);
        service.sync_at_safe_boundary('thread-write', 9_040);
        assert.equal(repository.require_workset('thread-write', base_publish.memory_id).synced_version, 1);
    } finally {
        store.close();
    }
});

test('hierarchy constraints and explicit conflict decisions are enforced', () => {
    const { store, repository, service } = fixture();
    try {
        assert.throws(() => service.register_thread({
            thread_id: 'thread-missing-task-role', project_id: 'novel', role_id: null, task_id: 'chapter', at: 9_990,
        }), /task and role bindings must match/);
        assert.throws(() => service.publish({
            ...base_publish,
            memory_id: 'memory-missing-task-role',
            role_id: null,
            task_id: 'chapter',
            at: 9_991,
        }), /task and role bindings must match/);

        repository.register_project({ project_id: 'other', name: 'Other', at: 10_000 });
        repository.register_role({ role_id: 'other-role', project_id: 'other', name: 'Other role', at: 10_001 });
        repository.register_task({
            task_id: 'other-task', project_id: 'other', role_id: 'other-role', title: 'Other task', at: 10_002,
        });
        repository.register_role({ role_id: 'unreferenced-role', project_id: 'novel', name: 'Unreferenced', at: 10_002 });
        repository.register_task({
            task_id: 'unreferenced-task', project_id: 'novel', role_id: 'unreferenced-role', title: 'Unreferenced', at: 10_002,
        });
        assert.throws(() => store.database.prepare(`UPDATE cm_roles SET project_id='other'
            WHERE tenant_id='tenant' AND user_id='user' AND role_id='unreferenced-role'`).run(),
        /project binding is immutable/);
        assert.throws(() => store.database.prepare(`UPDATE cm_tasks SET role_id=NULL
            WHERE tenant_id='tenant' AND user_id='user' AND task_id='unreferenced-task'`).run(),
        /task hierarchy is immutable/);
        assert.throws(() => store.database.prepare(`UPDATE cm_threads SET project_id='other', role_id=NULL, task_id=NULL
            WHERE tenant_id='tenant' AND user_id='user' AND thread_id='thread-write'`).run(),
        /thread project binding is immutable/);
        assert.throws(() => repository.register_role({
            role_id: 'writer', project_id: 'other', name: 'Wrong project', at: 10_003,
        }), /belongs to project novel/);
        assert.throws(() => service.publish({
            ...base_publish,
            memory_id: 'cross-project',
            role_id: 'other-role',
            at: 10_004,
        }), /task and role bindings must match|FOREIGN KEY constraint failed/);

        service.publish({ ...base_publish, memory_id: 'memory-a', at: 10_010 });
        service.publish({
            ...base_publish,
            memory_id: 'memory-b',
            title: 'Contradictory opening rule',
            summary: 'Always begin with exposition.',
            body: 'The first scene must begin with exposition before any conflict.',
            at: 10_020,
        });
        const conflict = service.report_conflict({
            conflict_id: 'conflict-1',
            memory_a_id: 'memory-a', memory_a_version: 1,
            memory_b_id: 'memory-b', memory_b_version: 1,
            severity: 0.95,
            rationale: 'The two opening rules cannot both govern the same chapter.',
            at: 10_030,
        });
        assert.equal(conflict.status, 'open');
        assert.equal(repository.list_conflicts('open').length, 1);
        assert.throws(() => store.database.prepare(`UPDATE cm_memory_conflicts SET
                status='dismissed', resolved_at=10035, metadata_json='{}'
            WHERE tenant_id='tenant' AND user_id='user' AND conflict_id='conflict-1'`).run(),
        /missing human evidence/);
        assert.throws(() => store.database.prepare(`UPDATE cm_memory_conflicts SET
                status='dismissed', resolved_at=10036,
                metadata_json='{"decision":{"actor_kind":"user","channel":"codex_ui","evidence":{"turn":"x"}}}'
            WHERE tenant_id='tenant' AND user_id='user' AND conflict_id='conflict-1'`).run(),
        /missing human evidence/);
        assert.throws(() => service.decide_conflict('conflict-1', {
            ...user_decision('Resolve it.', 'resolve-empty'),
            evidence: {},
            status: 'resolved',
            resolution_memory_id: 'memory-a',
            resolution_version: 1,
        }, 10_040), /requires evidence/);
        const resolved = service.decide_conflict('conflict-1', {
            ...user_decision('Keep the conflict-first rule.', 'resolve-conflict'),
            status: 'resolved',
            resolution_memory_id: 'memory-a',
            resolution_version: 1,
        }, 10_050);
        assert.equal(resolved.status, 'resolved');
        assert.equal(resolved.resolution_memory_id, 'memory-a');
        assert.throws(() => service.decide_conflict('conflict-1', {
            ...user_decision('Try again.', 'resolve-twice'),
            status: 'dismissed',
        }, 10_060), /is not open/);
    } finally {
        store.close();
    }
});

test('readonly central services expose reads but reject mutations explicitly', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({ ...base_publish, at: 11_000 });
        service.sync_at_safe_boundary('thread-write', 11_010);
        const readonly_service = new CentralMemoryService(repository, { readonly: true });
        assert.equal(readonly_service.context('thread-write').length, 1);
        assert.throws(() => readonly_service.publish({ ...base_publish, expected_current_version: 1 }),
            /unavailable in readonly mode/);
        assert.throws(() => readonly_service.sync_at_safe_boundary('thread-write'),
            /unavailable in readonly mode/);
    } finally {
        store.close();
    }
});

test('recall and stage retrieves explainable Chinese and English memories with stable ranking', () => {
    const { store, repository, service } = fixture();
    try {
        service.subscribe({
            subscription_id: 'thread-write:tag:drawing',
            thread_id: 'thread-write', selector_kind: 'tag', selector_value: '作画', min_relevance: 0.8, at: 12_000,
        });
        service.publish({
            ...base_publish,
            memory_id: 'memory-cn-drawing', role_id: null, task_id: null,
            title: '人物表情作画规范',
            summary: '作画时先确定人物的情绪张力。',
            body: '人物表情要通过眼睑弧度、嘴角和眉间距离一起表达，不要只改嘴型。',
            metadata: { tags: ['作画', '人物'], topics: ['表情设计'] },
            importance: 0.92, source_thread_id: undefined, at: 12_010,
        });
        service.publish({
            ...base_publish,
            memory_id: 'memory-en-cadence', role_id: null, task_id: null,
            title: 'Foreshadowing cadence',
            summary: 'Space foreshadowing beats across the chapter.',
            body: 'Use one subtle foreshadowing cue before each major reveal.',
            importance: 0.75, source_thread_id: undefined, at: 12_020,
        });
        for (const memory_id of ['memory-sort-b', 'memory-sort-a']) {
            service.publish({
                ...base_publish,
                memory_id, role_id: null, task_id: null,
                title: 'Stable lantern ordering',
                summary: 'Use the lantern motif as a stable ordering test.',
                body: 'Repeat the lantern motif at the same narrative boundary.',
                importance: 0.5, source_thread_id: undefined, at: 12_030,
            });
        }

        const chinese = service.recall_and_stage({
            thread_id: 'thread-write', query: '人物表情作画', limit: 3, at: 12_100,
        });
        assert.equal(chinese.status, 'staged');
        assert.equal(chinese.matches[0]?.memory.memory_id, 'memory-cn-drawing');
        assert.equal(chinese.matches[0]?.version.status, 'active');
        assert.equal(chinese.matches[0]?.workset.pending_version, 1);
        assert.equal(chinese.matches[0]?.workset.origin, 'subscription');
        assert.equal(chinese.matches[0]?.reasons.some((reason) => reason.startsWith('lexical:')), true);
        assert.equal(chinese.matches[0]?.reasons.some((reason) => reason.includes('subscription:tag')), true);
        assert.equal(chinese.matches[0]?.matched_terms.includes('作画'), true);

        const english = service.recall_and_stage({
            thread_id: 'thread-write', query: 'foreshadowing cadence', limit: 2, at: 12_110,
        });
        assert.equal(english.matches[0]?.memory.memory_id, 'memory-en-cadence');
        assert.deepEqual(english.matches[0]?.matched_terms, ['foreshadowing', 'cadence']);

        const stable = service.recall_and_stage({
            thread_id: 'thread-write', query: 'stable lantern ordering', limit: 2, at: 12_120,
        });
        assert.deepEqual(stable.matches.map((match) => match.memory.memory_id), ['memory-sort-a', 'memory-sort-b']);
        assert.ok(stable.matches[0]!.score >= stable.matches[1]!.score);
        assert.ok(chinese.candidates_considered <= 64);
    } finally {
        store.close();
    }
});

test('governed project links expose only relevant L4 memory and remain directional', () => {
    const { store, repository, service } = fixture();
    try {
        repository.register_project({ project_id: 'painting-lab', name: 'Painting lab', at: 12_200 });
        repository.register_role({
            role_id: 'artist', project_id: 'painting-lab', name: 'Artist',
            responsibility: 'Create novel artwork', at: 12_201,
        });
        repository.register_task({
            task_id: 'paint-scene', project_id: 'painting-lab', role_id: 'artist',
            title: 'Paint scene', at: 12_202,
        });
        service.register_thread({
            thread_id: 'thread-paint', project_id: 'painting-lab', role_id: 'artist',
            task_id: 'paint-scene', responsibility: 'Render novel scenes', at: 12_203,
        });
        for (const level of [1, 2, 3, 4] as const) {
            const published = service.publish({
                ...base_publish,
                memory_id: `painting-link-L${level}`,
                project_id: 'painting-lab', role_id: level >= 2 ? 'artist' : null,
                task_id: level >= 3 ? 'paint-scene' : null, level,
                title: `雾港灯光 L${level}`,
                summary: `雾港灯光的第 ${level} 层信息。`,
                body: `雾港灯光测试正文，第 ${level} 层。`,
                major: false,
                source_thread_id: undefined,
                at: 12_210 + level,
            });
            if (level === 1) {
                service.approve(published.confirmation!.confirmation_id,
                    user_decision('确认绘画项目规则。', 'approve-paint-l1'), 12_220);
            }
        }
        service.publish({
            ...base_publish,
            memory_id: 'novel-local-lighting', role_id: null, task_id: null,
            title: '雾港灯光写作经验', summary: '小说项目自己的雾港灯光经验。',
            body: '本项目记忆应始终排在关联项目记忆之前。', source_thread_id: undefined, at: 12_230,
        });

        const links = service.link_projects({
            source_project_id: 'painting-lab', target_project_id: 'novel',
            decision: user_decision('允许绘画经验供小说相关任务检索。', 'link-paint-to-novel'),
            metadata: { purpose: 'novel-art coordination', l4_only: true },
            at: 12_240,
        });
        assert.equal(links.length, 1);
        assert.equal(links[0]?.status, 'active');
        const insert_cross_workset = repository.database.prepare(`INSERT INTO cm_thread_worksets
            (tenant_id, user_id, thread_id, memory_id, synced_version, consumed_version,
             pending_version, relevance, origin, sync_state, last_synced_at, last_consumed_at, updated_at)
            VALUES ('tenant', 'user', 'thread-write', ?, NULL, NULL, 1, 0.5, ?, 'pending', NULL, NULL, 12241)`);
        assert.throws(() => insert_cross_workset.run('painting-link-L3', 'linked_project'),
            /project scope is not authorized/);
        assert.throws(() => insert_cross_workset.run('painting-link-L4', 'shared'),
            /project scope is not authorized/);

        const recalled = service.recall_and_stage({
            thread_id: 'thread-write', query: '雾港灯光', limit: 10, at: 12_250,
        });
        assert.equal(recalled.matches[0]?.memory.memory_id, 'novel-local-lighting');
        const linked = recalled.matches.filter((match) => match.memory.project_id === 'painting-lab');
        assert.deepEqual(linked.map((match) => match.memory.memory_id), ['painting-link-L4']);
        assert.equal(linked[0]?.project_scope, 'linked_project');
        assert.equal(linked[0]?.workset.origin, 'linked_project');
        assert.equal(linked[0]?.reasons.includes('linked_project:painting-lab->novel'), true);

        const reverse = service.recall_and_stage({
            thread_id: 'thread-paint', query: '本项目记忆', limit: 10, at: 12_251,
        });
        assert.equal(reverse.matches.some((match) => match.memory.project_id === 'novel'), false);
        assert.throws(() => repository.stage_workset({
            thread_id: 'thread-paint', memory_id: 'novel-local-lighting', pending_version: 1,
            origin: 'linked_project', at: 12_252,
        }), /active governed L4 project link/);

        const bidirectional = service.link_projects({
            source_project_id: 'painting-lab', target_project_id: 'novel', direction: 'two_way',
            decision: user_decision('将小说与绘画 L4 联动改为双向。', 'link-paint-two-way'),
            at: 12_253,
        });
        assert.equal(bidirectional.length, 2);
        assert.ok(repository.find_active_project_link('novel', 'painting-lab'));
        const reverse_linked = service.recall_and_stage({
            thread_id: 'thread-paint', query: '本项目记忆', limit: 10, at: 12_254,
        });
        assert.equal(reverse_linked.matches.some((match) =>
            match.memory.memory_id === 'novel-local-lighting'
            && match.workset.origin === 'linked_project'), true);

        service.sync_at_safe_boundary('thread-write', 12_260);
        const packet = build_central_thread_context(
            repository.require_thread('thread-write'),
            service.context('thread-write'),
            { token_budget: 4_000, include_consumed: true },
        );
        assert.match(packet.text, /Detailed linked-project memory/);
        assert.match(packet.text, /linked from project painting-lab/);
    } finally {
        store.close();
    }
});

test('linked L4 updates refresh safely and revocation removes future access', () => {
    const { store, repository, service } = fixture();
    try {
        repository.register_project({ project_id: 'painting-lab', name: 'Painting lab', at: 12_300 });
        service.publish({
            ...base_publish,
            memory_id: 'painting-linked-update', project_id: 'painting-lab', role_id: null, task_id: null,
            title: '人物表情联动', summary: '眼睑与眉间距必须协同。',
            body: '第一版绘画经验。', source_thread_id: undefined, at: 12_310,
        });
        const [link] = service.link_projects({
            source_project_id: 'painting-lab', target_project_id: 'novel',
            decision: user_decision('允许单向 L4 联动。', 'link-update-test'), at: 12_320,
        });
        service.recall_and_stage({
            thread_id: 'thread-write', query: '人物表情联动', limit: 4, at: 12_330,
        });
        service.sync_at_safe_boundary('thread-write', 12_340);
        service.consume('thread-write', 'painting-linked-update', 1, 12_350);

        service.publish({
            ...base_publish,
            memory_id: 'painting-linked-update', project_id: 'painting-lab', role_id: null, task_id: null,
            title: '人物表情联动', summary: '眼睑、眉间距与嘴角必须协同。',
            body: '第二版补充嘴角控制，替代第一版经验。', expected_current_version: 1,
            source_thread_id: undefined, at: 12_360,
        });
        const pending = repository.require_workset('thread-write', 'painting-linked-update');
        assert.equal(pending.pending_version, 2);
        assert.equal(pending.consumed_version, 1);
        assert.equal(pending.origin, 'linked_project');

        const revoked = service.revoke_project_link(
            link!.link_id,
            user_decision('停止小说读取绘画项目记忆。', 'revoke-update-test'),
            12_370,
        );
        assert.equal(revoked.link.status, 'revoked');
        assert.equal(revoked.retracted_worksets, 1);
        assert.equal(repository.require_workset('thread-write', 'painting-linked-update').sync_state, 'retracted');
        assert.equal(service.context('thread-write')
            .some((entry) => entry.memory.memory_id === 'painting-linked-update'), false);

        const after_revoke = service.recall_and_stage({
            thread_id: 'thread-write', query: '人物表情联动', limit: 4, at: 12_380,
        });
        assert.equal(after_revoke.matches.some((match) => match.memory.project_id === 'painting-lab'), false);
        assert.throws(() => service.consume('thread-write', 'painting-linked-update', 1, 12_390),
            /no longer authorized/);
    } finally {
        store.close();
    }
});

test('project link governance requires human evidence and keeps its audit record immutable', () => {
    const { store, repository, service } = fixture();
    try {
        repository.register_project({ project_id: 'painting-lab', name: 'Painting lab', at: 12_400 });
        assert.throws(() => service.link_projects({
            source_project_id: 'painting-lab', target_project_id: 'novel',
            decision: { ...user_decision('缺少证据。', 'link-empty-evidence'), evidence: {} },
            at: 12_410,
        }), /requires evidence/);
        assert.deepEqual(repository.list_project_links(), []);

        const [link] = service.link_projects({
            source_project_id: 'painting-lab', target_project_id: 'novel',
            decision: user_decision('确认建立联动。', 'link-audit-record'), at: 12_420,
        });
        assert.throws(() => repository.database.prepare(`UPDATE cm_project_links
            SET metadata_json='{"tampered":true}'
            WHERE tenant_id='tenant' AND user_id='user' AND link_id=?`).run(link!.link_id),
        /invalid central project link revocation/);
        assert.throws(() => repository.database.prepare(`DELETE FROM cm_project_links
            WHERE tenant_id='tenant' AND user_id='user' AND link_id=?`).run(link!.link_id),
        /cannot be deleted/);
        assert.equal(repository.require_project_link(link!.link_id).status, 'active');
    } finally {
        store.close();
    }
});

test('recall excludes pending, retracted and cross-project versions and refuses inactive threads', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({
            ...base_publish,
            memory_id: 'memory-retracted-recall', role_id: null, task_id: null,
            title: '星河色板作画', summary: '星河色板已经失效。', body: '不应再召回这条规则。',
            source_thread_id: undefined, at: 13_000,
        });
        const retraction = service.request_retraction({
            memory_id: 'memory-retracted-recall', expected_current_version: 1,
            requested_by: 'thread-write', reason: '规则已撤回', at: 13_010,
        });
        service.approve(
            retraction.confirmation!.confirmation_id,
            user_decision('确认撤回。', 'recall-retract'),
            13_020,
        );
        const pending = service.publish({
            ...base_publish,
            memory_id: 'memory-pending-recall', role_id: null, task_id: null,
            title: '星河色板待确认', summary: '仍在待确认状态。', body: '尚未经过用户确认。',
            major: true, source_thread_id: undefined, at: 13_030,
        });
        assert.equal(pending.version.status, 'pending_confirmation');
        service.publish({
            ...base_publish,
            memory_id: 'memory-superseded-recall', role_id: null, task_id: null,
            title: '旧版琥珀构图', summary: '旧版琥珀构图仅用于试验。', body: '这是即将被取代的旧版正文。',
            source_thread_id: undefined, at: 13_035,
        });
        service.publish({
            ...base_publish,
            memory_id: 'memory-superseded-recall', role_id: null, task_id: null,
            title: '当前冷色布局', summary: '现在改用冷色的画面布局。', body: '当前有效正文只描述新的视觉方案。',
            expected_current_version: 1, source_thread_id: undefined, at: 13_036,
        });
        const superseded = service.recall_and_stage({
            thread_id: 'thread-write', query: '旧版琥珀构图', limit: 5, at: 13_037,
        });
        assert.equal(superseded.matches.some((match) => match.memory.memory_id === 'memory-superseded-recall'), false);

        repository.register_project({ project_id: 'painting-lab', name: 'Painting lab', at: 13_040 });
        service.publish({
            ...base_publish,
            memory_id: 'memory-cross-project-recall', project_id: 'painting-lab', role_id: null, task_id: null,
            title: '星河色板跨项目', summary: '另一个项目的色板。', body: '这条记忆不属于小说项目。',
            source_thread_id: undefined, at: 13_050,
        });
        const filtered = service.recall_and_stage({
            thread_id: 'thread-write', query: '星河色板', limit: 10, at: 13_060,
        });
        assert.deepEqual(filtered.matches, []);
        assert.throws(() => repository.require_workset('thread-write', 'memory-cross-project-recall'), /was not found/);

        service.register_thread({
            thread_id: 'thread-finished', project_id: 'novel', role_id: 'writer', task_id: 'chapter',
            responsibility: 'Finished task', status: 'completed', at: 13_070,
        });
        const inactive = service.recall_and_stage({
            thread_id: 'thread-finished', query: 'foreshadowing', limit: 3, at: 13_080,
        });
        assert.equal(inactive.status, 'thread_inactive');
        assert.equal(inactive.candidates_considered, 0);
        assert.deepEqual(inactive.matches, []);
    } finally {
        store.close();
    }
});

test('recall staging is idempotent, preserves manual origin and enforces hard bounds', () => {
    const { store, repository, service } = fixture();
    try {
        service.publish({
            ...base_publish,
            memory_id: 'memory-manual-recall', role_id: null, task_id: null,
            title: 'Camera blocking checklist',
            summary: 'Check camera blocking before rendering.',
            body: 'Keep the camera axis stable and verify foreground silhouettes.',
            importance: 0.8, source_thread_id: undefined, at: 14_000,
        });
        repository.stage_workset({
            thread_id: 'thread-write', memory_id: 'memory-manual-recall', pending_version: 1,
            relevance: 0.2, origin: 'manual', at: 14_010,
        });

        const first = service.recall_and_stage({
            thread_id: 'thread-write', query: 'camera blocking', limit: 1, at: 14_020,
        });
        assert.equal(first.matches[0]?.memory.memory_id, 'memory-manual-recall');
        assert.equal(first.matches[0]?.workset.origin, 'manual');
        const first_workset = repository.require_workset('thread-write', 'memory-manual-recall');
        assert.equal(first_workset.updated_at, 14_020);

        const second = service.recall_and_stage({
            thread_id: 'thread-write', query: 'camera blocking', limit: 1, at: 14_999,
        });
        const second_workset = repository.require_workset('thread-write', 'memory-manual-recall');
        assert.equal(second.matches[0]?.score, first.matches[0]?.score);
        assert.deepEqual(second_workset, first_workset);
        assert.equal(repository.list_worksets('thread-write')
            .filter((workset) => workset.memory_id === 'memory-manual-recall').length, 1);

        assert.throws(() => service.recall_and_stage({
            thread_id: 'thread-write', query: 'x'.repeat(2_049), limit: 1,
        }), /cannot exceed 2048/);
        assert.throws(() => service.recall_and_stage({
            thread_id: 'thread-write', query: 'camera', limit: 33,
        }), /between 1 and 32/);
        const readonly_service = new CentralMemoryService(repository, { readonly: true });
        assert.throws(() => readonly_service.recall_and_stage({
            thread_id: 'thread-write', query: 'camera', limit: 1,
        }), /unavailable in readonly mode/);
    } finally {
        store.close();
    }
});
