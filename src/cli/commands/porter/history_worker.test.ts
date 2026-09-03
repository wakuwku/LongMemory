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
 *  file  : src/cli/commands/porter/history_worker.test.ts
 *  usage : tests the LongMemory history worker component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryBackfillService } from '../../../core/central_memory/history_backfill_service.js';
import type { history_worker_context } from '../../../core/central_memory/history_backfill_types.js';
import { codex_history_worker_id } from '../../../core/central_memory/history_worker_authorization.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import { check_sqlite_integrity } from '../../../stores/sqlite/integrity.js';
import { run_cli_app } from '../../cli_app.js';

const digest = (character: string): string => character.repeat(64);

function source_session(id: string) {
    return {
        schema_version: '1.0.0' as const,
        source_harness: 'codex' as const,
        source_session_id: id,
        source_path: `C:\\codex\\${id}.jsonl`,
        cwd: 'D:\\work\\project-a',
        title: `History ${id}`,
        created_at: 1,
        updated_at: 2,
        turns: [{ role: 'user' as const, text: `Keep the durable result for ${id}.` }],
        dropped_turns: 0,
        source_metadata: { parser: 'history-worker-cli-test' },
    };
}

function create_run(service: HistoryBackfillService, db_path: string, id: string, plan_id: string, at: number) {
    return service.create_run({
        session: source_session(id),
        evidence: {
            inventory_id: `inventory:${id}`,
            reconciliation_digest: digest('a'),
            plan_id,
            manifest_hash: digest('b'),
            target_db_path: db_path,
            target_project_id: 'project-a',
        },
        project_id: 'project-a',
        max_chunk_tokens: 256,
        at,
    });
}

async function invoke(db_path: string, args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run_cli_app(
        [...args, '--db', db_path, '--project', 'project-a', '--user', 'human', '--json'],
        { LONGMEMORY_TENANT_ID: 'tenant' },
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), terminal: false },
    );
    const output = [...stdout, ...stderr].join('\n');
    let json: Record<string, unknown> | null = null;
    if (stdout.length) {
        try { json = JSON.parse(stdout.at(-1)!) as Record<string, unknown>; } catch { /* error path */ }
    }
    return { code, output, json };
}

function worker(session_id: string, turn_id: string): history_worker_context {
    return {
        worker_id: codex_history_worker_id('tenant', 'human', session_id),
        worker_session_id: session_id,
        worker_turn_id: turn_id,
        capability_epoch_hash: digest('c'),
    };
}

test('CLI run scope excludes same-project work and revocation invalidates an existing lease', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-worker-cli-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const db_path = join(root, 'central-memory.db');
    const store = new SqliteStore(db_path, { tenant_id: 'tenant', user_id: 'human', startup_integrity_check: false });
    store.central_memory.register_project({ project_id: 'project-a', name: 'Project A', at: 1 });
    for (const thread_id of ['dedicated-worker', 'ordinary-task']) {
        store.central_memory.register_thread({ thread_id, project_id: 'project-a', responsibility: thread_id, at: 1 });
    }
    const service = new HistoryBackfillService(store.database, {
        tenant_id: 'tenant', user_id: 'human', capability_guard: () => undefined,
    });
    const excluded = create_run(service, db_path, 'excluded-first', 'plan:excluded', 10);
    const allowed = create_run(service, db_path, 'allowed-second', 'plan:allowed', 20);

    const missing_scope = await invoke(db_path, ['history', 'worker', 'authorize', 'dedicated-worker',
        '--action-id', 'authorize:missing-scope', '--confirm-human']);
    assert.notEqual(missing_scope.code, 0);
    assert.match(missing_scope.output, /run-id|plan-id|all-runs/i);
    const false_all_runs = await invoke(db_path, ['history', 'worker', 'authorize', 'dedicated-worker',
        '--all-runs=false', '--action-id', 'authorize:false-all-runs', '--confirm-human']);
    assert.notEqual(false_all_runs.code, 0);
    assert.match(false_all_runs.output, /bare explicit flag/i);

    const authorized = await invoke(db_path, ['history', 'worker', 'authorize', 'dedicated-worker',
        '--run-id', allowed.run_id, '--action-id', 'authorize:allowed-run', '--confirm-human']);
    assert.equal(authorized.code, 0, authorized.output);
    const authorization = authorized.json!.authorization as Record<string, unknown>;
    assert.equal(authorization.run_id, allowed.run_id);
    assert.throws(() => service.claim_next(worker('ordinary-task', 'ordinary-turn'), 5_000),
        /authorized dedicated history worker/i);

    const active_worker = worker('dedicated-worker', 'claim-turn');
    const claim = service.claim_next(active_worker, 5_000)!;
    assert.equal(claim.run.run_id, allowed.run_id);
    assert.notEqual(claim.run.run_id, excluded.run_id);

    const revoked = await invoke(db_path, ['history', 'worker', 'revoke', String(authorization.authorization_id),
        '--action-id', 'revoke:allowed-run', '--confirm-human']);
    assert.equal(revoked.code, 0, revoked.output);
    assert.throws(() => service.submit_chunk(active_worker, claim.lease_id, claim.chunk.chunk_hash, []),
        /authorization scope|authorized dedicated/i);

    const active_list = await invoke(db_path, ['history', 'worker', 'list']);
    assert.equal(active_list.code, 0, active_list.output);
    assert.deepEqual(active_list.json!.authorizations, []);
    const all_list = await invoke(db_path, ['history', 'worker', 'list', '--all']);
    assert.equal((all_list.json!.authorizations as unknown[]).length, 1);
    store.close();
});

test('plan scope, explicit all-runs choice, and hostile selectors cannot widen authorization', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-worker-scope-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const db_path = join(root, 'central-memory.db');
    const store = new SqliteStore(db_path, { tenant_id: 'tenant', user_id: 'human', startup_integrity_check: false });
    store.central_memory.register_project({ project_id: 'project-a', name: 'A', at: 1 });
    store.central_memory.register_project({ project_id: 'project-b', name: 'B', at: 1 });
    store.central_memory.register_thread({ thread_id: 'plan-worker', project_id: 'project-a', responsibility: 'worker', at: 1 });
    const service = new HistoryBackfillService(store.database, {
        tenant_id: 'tenant', user_id: 'human', capability_guard: () => undefined,
    });
    const plan_run = create_run(service, db_path, 'plan-run', 'plan:target', 10);
    const other_run = create_run(service, db_path, 'other-run', 'plan:other', 20);

    const hostile = await invoke(db_path, ['history', 'worker', 'authorize', "plan-worker' OR 1=1 --",
        '--all-runs', '--action-id', 'authorize:hostile-session', '--confirm-human']);
    assert.notEqual(hostile.code, 0);
    assert.equal((store.database.prepare('SELECT count(*) AS count FROM cm_history_worker_authorizations')
        .get() as { count: number }).count, 0);

    const plan_authorized = await invoke(db_path, ['history', 'worker', 'authorize', 'plan-worker',
        '--plan-id', 'plan:target', '--action-id', 'authorize:target-plan', '--confirm-human']);
    assert.equal(plan_authorized.code, 0, plan_authorized.output);
    const claim = service.claim_next(worker('plan-worker', 'plan-turn'), 5_000)!;
    assert.equal(claim.run.run_id, plan_run.run_id);
    assert.notEqual(claim.run.run_id, other_run.run_id);

    const reused = await invoke(db_path, ['history', 'worker', 'authorize', 'plan-worker',
        '--run-id', other_run.run_id, '--action-id', 'authorize:target-plan', '--confirm-human']);
    assert.notEqual(reused.code, 0);
    assert.match(reused.output, /already used with different content/i);
    const combined = await invoke(db_path, ['history', 'worker', 'authorize', 'plan-worker', '--all-runs',
        '--run-id', other_run.run_id, '--action-id', 'authorize:combined', '--confirm-human']);
    assert.notEqual(combined.code, 0);
    assert.match(combined.output, /cannot be combined/i);

    assert.throws(() => store.database.prepare(`UPDATE cm_history_worker_authorizations
        SET project_id='project-b' WHERE tenant_id='tenant' AND user_id='human'`).run(), /scope is immutable/i);
    store.database.exec('DROP TRIGGER cm_history_worker_authorizations_scope_immutable');
    store.database.prepare(`UPDATE cm_history_worker_authorizations SET scope_hash=?
        WHERE tenant_id='tenant' AND user_id='human'`).run(digest('0'));
    assert.throws(() => service.claim_next(worker('plan-worker', 'tampered-scope-turn'), 5_000),
        /authorized dedicated history worker/i,
    'runtime checks must reject a grant whose persisted scope hash was forged');
    const report = check_sqlite_integrity(store.database, { tenant_id: 'tenant', user_id: 'human' });
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.table === 'cm_history_worker_authorizations'
        && issue.code === 'hash_mismatch'));
    store.close();
});
