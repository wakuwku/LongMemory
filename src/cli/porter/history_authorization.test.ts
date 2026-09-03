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
 *  file  : src/cli/porter/history_authorization.test.ts
 *  usage : tests the LongMemory history authorization component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { project_memory } from '../../core/project/project_memory.js';
import { assert_issued_history_authorization, authorize_codex_history_import } from './history_authorization.js';
import { build_history_inventory, history_override_schema, type history_override_manifest } from './history_plan.js';
import { port_preparsed_sessions, port_sessions } from './orchestrator.js';
import type { history_inventory_load } from './history_source.js';
import { load_history_inventory } from './history_source.js';
import type { portable_session, source_reconciliation } from './types.js';
import { run_cli_app } from '../cli_app.js';
import {
    CODEX_HISTORY_CHUNK_TOKENS,
    stage_authorized_codex_history,
} from './history_backfill.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import {
    history_credential_preflight_error,
    inspect_history_credentials,
} from './history_safety.js';

const make_session = (id: string, cwd = 'D:\\work\\novel', text = `work ${id}`): portable_session => ({
    schema_version: '1.0.0', source_harness: 'codex', source_session_id: id,
    source_path: `C:\\codex\\${id}.jsonl`, cwd, title: `Task ${id}`,
    created_at: 1, updated_at: 2,
    turns: [{ role: 'user', text, timestamp: 1 }, { role: 'assistant', text: `done ${id}`, timestamp: 2 }],
    dropped_turns: 0, source_metadata: { thread_source: 'cli', parser: 'test' },
});

const reconciliation_for = (sessions: portable_session[]): source_reconciliation => ({
    source_files: sessions.length,
    importable_tasks: sessions.length,
    empty_tasks: 0,
    parse_failures: 0,
    excluded_tasks: 0,
    partial_tasks: 0,
    empty: [], failures: [], excluded: [], partial: [],
});

const complete_load = (sessions: portable_session[]): history_inventory_load => {
    const reconciliation = reconciliation_for(sessions);
    return {
    inventory: build_history_inventory(sessions, 'codex', reconciliation),
    discovered: sessions.length,
    selected: sessions.length,
    complete_source_scan: true,
    parse_failures: [],
    reconciliation,
    sessions,
    deferred_source_files: 0,
    };
};

const manifest_for = (
    loaded: history_inventory_load,
    cwd_overrides: history_override_manifest['cwd_overrides'] = [],
    session_overrides: history_override_manifest['session_overrides'] = [],
): history_override_manifest => ({
    schema_version: history_override_schema,
    source_harness: 'codex',
    inventory_id: loaded.inventory.inventory_id,
    ...(loaded.source_snapshot ? { source_snapshot: loaded.source_snapshot } : {}),
    cwd_overrides,
    session_overrides,
});

const write_codex_history = (path: string, id: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:\\work\\novel' } }),
        JSON.stringify({
            type: 'response_item', timestamp: '2026-09-01T00:00:00.000Z',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }),
    ].join('\n') + '\n', 'utf8');
};

const project_stub = () => {
    const imports: Array<Record<string, any>> = [];
    const project = {
        getAsset: async () => null,
        governAsset: async () => ({ version: 2 }),
        importSession: async (_project_id: string, input: Record<string, any>) => { imports.push(input); },
    } as unknown as project_memory;
    return { project, imports };
};

test('blocks direct Codex porter calls that bypass history authorization', async () => {
    const { project } = project_stub();
    const value = make_session('one');
    await assert.rejects(() => port_sessions(project, 'novel', 'codex', { ids: ['one'] }), /history-manifest/i);
    await assert.rejects(() => port_preparsed_sessions(project, 'novel', 'codex', [value]), /validated history-manifest authorization/i);
});

test('CLI requires explicit Codex project, persistent database, and history manifest before source access', async () => {
    const invoke = async (args: string[]) => {
        const output: string[] = [];
        const code = await run_cli_app(args, {}, { stdout: (value) => output.push(value), stderr: (value) => output.push(value), terminal: false });
        return { code, text: output.join('\n') };
    };
    const base = ['port', '--from', 'codex', '--to', 'longmemory', '--id', 'one'];
    const project = await invoke(base);
    assert.notEqual(project.code, 0);
    assert.match(project.text, /explicit --project/i);
    const database = await invoke([...base, '--project', 'novel']);
    assert.notEqual(database.code, 0);
    assert.match(database.text, /explicit persistent --db/i);
    const manifest = await invoke([...base, '--project', 'novel', '--db', 'D:\\memory\\central.db']);
    assert.notEqual(manifest.code, 0);
    assert.match(manifest.text, /--history-manifest/i);
});

test('rejects a confirmed session assigned to a different target project', () => {
    const loaded = complete_load([make_session('one')]);
    const manifest = manifest_for(loaded, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, manifest, ['one'], 'painting', 'D:\\memory\\central.db'),
        /confirmed for project novel, not target painting/i,
    );
});

test('rejects stale authorization when portable session content changes', () => {
    const planned = complete_load([make_session('one', 'D:\\work\\novel', 'original content')]);
    const manifest = manifest_for(planned, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    const current = complete_load([make_session('one', 'D:\\work\\novel', 'changed content')]);
    assert.notEqual(planned.inventory.sessions[0]?.source_revision, current.inventory.sessions[0]?.source_revision);
    assert.throws(
        () => authorize_codex_history_import(current, manifest, ['one'], 'novel', 'D:\\memory\\central.db'),
        /does not match current inventory/i,
    );
});

test('frozen Codex snapshot ignores later appends and new files without splitting a UTF-8 record', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-frozen-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source_path = join(root, 'sessions', 'active.jsonl');
    write_codex_history(source_path, 'active', 'original task');

    const completed_record = Buffer.from(`${JSON.stringify({
        type: 'response_item', timestamp: '2026-09-01T00:00:01.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '后来完成' }] },
    })}\n`, 'utf8');
    const character = Buffer.from('后', 'utf8');
    const character_offset = completed_record.indexOf(character);
    assert.ok(character_offset > 0);
    const interrupted_at = character_offset + 2;
    appendFileSync(source_path, completed_record.subarray(0, interrupted_at));

    const planned = await load_history_inventory('codex', { env: { CODEX_HOME: root } });
    assert.ok(planned.source_snapshot);
    const descriptor = planned.source_snapshot.files.find((file) => file.source_session_id === 'active');
    assert.ok(descriptor?.cutoff_bytes !== null && descriptor?.cutoff_bytes !== undefined);
    assert.ok(descriptor.cutoff_bytes < statSync(source_path).size, 'the partial UTF-8/JSONL tail must be outside the cutoff');
    assert.equal(planned.sessions[0]?.turns.length, 1);

    appendFileSync(source_path, completed_record.subarray(interrupted_at));
    write_codex_history(join(root, 'sessions', 'new-task.jsonl'), 'new-task', 'created after review');

    const frozen = await load_history_inventory('codex', {
        env: { CODEX_HOME: root },
        source_snapshot: planned.source_snapshot,
    });
    assert.equal(frozen.inventory.inventory_id, planned.inventory.inventory_id);
    assert.equal(frozen.inventory.source_scan.reconciliation_digest, planned.inventory.source_scan.reconciliation_digest);
    assert.deepEqual(frozen.sessions.map((session) => session.source_session_id), ['active']);
    assert.equal(frozen.sessions[0]?.turns.length, 1);
    assert.equal(frozen.deferred_source_files, 1);

    const manifest = manifest_for(planned, [{
        cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true,
    }]);
    const authorized = authorize_codex_history_import(frozen, manifest, ['active'], 'novel', 'D:\\memory\\central.db');
    assert.equal(authorized.sessions[0]?.turns.length, 1);

    const next_batch = await load_history_inventory('codex', { env: { CODEX_HOME: root } });
    assert.notEqual(next_batch.inventory.inventory_id, planned.inventory.inventory_id);
    assert.deepEqual(next_batch.sessions.map((session) => session.source_session_id).sort(), ['active', 'new-task']);
    assert.equal(next_batch.sessions.find((session) => session.source_session_id === 'active')?.turns.length, 2);
});

test('frozen Codex snapshot fails closed when bytes before an approved cutoff change', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-prefix-change-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source_path = join(root, 'sessions', 'active.jsonl');
    write_codex_history(source_path, 'active', 'alpha');
    const planned = await load_history_inventory('codex', { env: { CODEX_HOME: root } });
    assert.ok(planned.source_snapshot);

    write_codex_history(source_path, 'active', 'omega');
    await assert.rejects(
        () => load_history_inventory('codex', {
            env: { CODEX_HOME: root },
            source_snapshot: planned.source_snapshot,
        }),
        /changed before its approved cutoff/i,
    );
});

test('frozen Codex snapshot follows an active session into the archive only by exact prefix', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-relocated-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source_path = join(root, 'sessions', 'relocated.jsonl');
    const archived_path = join(root, 'archived_sessions', 'relocated.jsonl');
    write_codex_history(source_path, 'relocated', 'archive me');
    const planned = await load_history_inventory('codex', { env: { CODEX_HOME: root } });
    assert.ok(planned.source_snapshot);

    mkdirSync(dirname(archived_path), { recursive: true });
    renameSync(source_path, archived_path);
    const frozen = await load_history_inventory('codex', {
        env: { CODEX_HOME: root },
        source_snapshot: planned.source_snapshot,
    });

    assert.equal(frozen.inventory.inventory_id, planned.inventory.inventory_id);
    assert.equal(frozen.sessions[0]?.source_path, source_path, 'approved provenance remains the original path');
    assert.equal(frozen.deferred_source_files, 0);
});

test('complete Codex authorization rejects a malformed JSONL silently omitted by discovery', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-authorization-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const valid_path = join(root, 'sessions', 'valid.jsonl');
    mkdirSync(dirname(valid_path), { recursive: true });
    writeFileSync(valid_path, [
        JSON.stringify({ type: 'session_meta', payload: { id: 'valid', cwd: 'D:\\work\\novel' } }),
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write the chapter.' }] },
        }),
    ].join('\n') + '\n', 'utf8');
    writeFileSync(join(root, 'sessions', 'malformed.jsonl'), '{not-json}\n', 'utf8');

    const loaded = await load_history_inventory('codex', { env: { CODEX_HOME: root } });
    assert.equal(loaded.complete_source_scan, true);
    assert.equal(loaded.reconciliation?.source_files, 2);
    assert.equal(loaded.reconciliation?.parse_failures, 1);
    assert.equal(loaded.inventory.source_scan.parse_failures, 1);
    const manifest = manifest_for(loaded, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, manifest, ['valid'], 'novel', 'D:\\memory\\central.db'),
        /malformed or unreadable session file/i,
    );
});

test('complete Codex authorization rejects an otherwise importable session with skipped malformed lines', () => {
    const sessions = [make_session('partial')];
    const reconciliation: source_reconciliation = {
        ...reconciliation_for(sessions),
        partial_tasks: 1,
        partial: [{
            source_session_id: 'partial',
            source_path: sessions[0]!.source_path,
            skipped_line_count: 1,
        }],
    };
    const loaded: history_inventory_load = {
        inventory: build_history_inventory(sessions, 'codex', reconciliation),
        discovered: 1,
        selected: 1,
        complete_source_scan: true,
        parse_failures: [],
        reconciliation,
        sessions,
        deferred_source_files: 0,
    };
    const manifest = manifest_for(loaded, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, manifest, ['partial'], 'novel', 'D:\\memory\\central.db'),
        /skipped malformed lines/i,
    );
});

test('authorization rechecks the parsed snapshot for partial lines and inventory tampering', () => {
    const partial = make_session('partial-after-scan');
    partial.source_metadata.skipped_line_count = 1;
    const loaded = complete_load([partial]);
    const manifest = manifest_for(loaded, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, manifest, ['partial-after-scan'], 'novel', 'D:\\memory\\central.db'),
        /parsed snapshot is incomplete/i,
    );

    const clean = complete_load([make_session('clean')]);
    const clean_manifest = manifest_for(clean, [{ cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true }]);
    clean.inventory.sessions[0]!.source_revision = 'tampered';
    assert.throws(
        () => authorize_codex_history_import(clean, clean_manifest, ['clean'], 'novel', 'D:\\memory\\central.db'),
        /does not match the exact parsed session snapshot/i,
    );
});

test('rejects excluded, unresolved, unconfirmed, and duplicate selected sessions', () => {
    const loaded = complete_load([make_session('excluded'), make_session('proposal', 'D:\\work\\painting'), make_session('unresolved', '')]);
    const excluded = manifest_for(loaded, [], [{ source_session_id: 'excluded', action: 'exclude', confirmed: true }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, excluded, ['excluded'], 'novel', 'D:\\memory\\central.db'),
        /explicitly excluded/i,
    );
    assert.throws(
        () => authorize_codex_history_import(loaded, excluded, ['proposal'], 'painting', 'D:\\memory\\central.db'),
        /not confirmed/i,
    );
    assert.throws(
        () => authorize_codex_history_import(loaded, excluded, ['unresolved'], 'novel', 'D:\\memory\\central.db'),
        /no resolved project assignment/i,
    );
    assert.throws(
        () => authorize_codex_history_import(loaded, excluded, ['proposal', 'proposal'], 'painting', 'D:\\memory\\central.db'),
        /duplicate --id/i,
    );
});

test('imports one authorized project batch from the exact parsed snapshot and records its receipt', async () => {
    const loaded = complete_load([
        make_session('one'), make_session('two'),
        make_session('other', 'D:\\work\\painting'),
    ]);
    const manifest = manifest_for(loaded, [{ cwd: 'D:\\work\\novel', project_id: 'novel', project_name: 'Novel', confirmed: true }]);
    const authorized = authorize_codex_history_import(loaded, manifest, ['one', 'two'], 'novel', 'D:\\memory\\central.db');
    assert.equal(authorized.plan.safe_to_import, false, 'the unrelated painting proposal may remain unconfirmed');
    assert.deepEqual(authorized.sessions.map((item) => item.source_session_id), ['one', 'two']);

    const { project, imports } = project_stub();
    await assert.rejects(
        () => port_preparsed_sessions(project, 'novel', 'codex', [...authorized.sessions], { history_authorization: authorized }),
        /exact parsed session snapshot/i,
    );
    const outcomes = await port_preparsed_sessions(project, 'novel', 'codex', authorized.sessions, { history_authorization: authorized });
    assert.deepEqual(outcomes.map((item) => item.status), ['created', 'created']);
    assert.equal(imports.length, 2);
    for (const imported of imports) assert.deepEqual({
        inventory_id: imported.metadata.inventory_id,
        reconciliation_digest: imported.metadata.reconciliation_digest,
        plan_id: imported.metadata.plan_id,
        manifest_hash: imported.metadata.manifest_hash,
        target_db_path: imported.metadata.target_db_path,
        target_project_id: imported.metadata.target_project_id,
        source_revision: imported.metadata.source_revision,
        history_authorized: imported.metadata.history_authorized,
    }, {
        ...authorized.evidence,
        source_revision: loaded.inventory.sessions.find((item) => item.source_session_id === imported.metadata.source_session_id)?.source_revision,
        history_authorized: true,
    });
});

test('issued authorization is a detached immutable snapshot and rejects forged mutations', () => {
    const loaded = complete_load([make_session('one')]);
    const manifest = manifest_for(loaded, [{
        cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true,
    }]);
    const authorized = authorize_codex_history_import(
        loaded, manifest, ['one'], 'novel', 'D:\\memory\\central.db',
    );

    assert.notStrictEqual(authorized.sessions[0], loaded.sessions[0]);
    assert.ok(Object.isFrozen(authorized));
    assert.ok(Object.isFrozen(authorized.sessions));
    assert.ok(Object.isFrozen(authorized.sessions[0]?.turns));
    assert.ok(Object.isFrozen(authorized.plan.assignments));
    assert.ok(Object.isFrozen(authorized.evidence));

    loaded.sessions[0]!.turns[0]!.text = 'mutation outside the issued snapshot';
    assert.equal(authorized.sessions[0]?.turns[0]?.text, 'work one');
    assert.throws(
        () => { authorized.sessions[0]!.turns[0]!.text = 'mutated session'; },
        TypeError,
    );
    assert.throws(
        () => { authorized.plan.assignments[0]!.project_id = 'painting'; },
        TypeError,
    );
    assert.throws(
        () => { authorized.evidence.target_project_id = 'painting'; },
        TypeError,
    );

    const forged = structuredClone(authorized);
    forged.sessions[0]!.turns[0]!.text = 'forged session';
    assert.throws(
        () => assert_issued_history_authorization(forged, forged.sessions, 'novel'),
        /validated history-manifest authorization/i,
    );
});

test('authorized Codex sessions stage immutable semantic runs independently of legacy assets', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-staging-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const db_path = join(root, 'central-memory.db');
    const loaded = complete_load([
        make_session('one', 'D:\\work\\novel', 'A '.repeat(4_000)),
        make_session('two', 'D:\\work\\novel', 'B '.repeat(2_000)),
    ]);
    const manifest = manifest_for(loaded, [{
        cwd: 'D:\\work\\novel', project_id: 'novel', project_name: 'Novel', confirmed: true,
    }]);
    const authorized = authorize_codex_history_import(
        loaded, manifest, ['one', 'two'], 'novel', db_path,
    );

    const first = stage_authorized_codex_history({
        authorization: authorized,
        db_path,
        project_id: 'novel',
        project_name: 'Novel',
    });
    const retry = stage_authorized_codex_history({
        authorization: authorized,
        db_path,
        project_id: 'novel',
        project_name: 'Novel',
    });
    assert.deepEqual(retry, first);
    assert.equal(first.length, 2);
    assert.ok(first.every((run) => run.chunk_count > 0));

    const store = new SqliteStore(db_path, { startup_integrity_check: false });
    try {
        const rows = store.database.prepare(`SELECT run.project_id, run.reconciliation_digest,
                run.chunk_size_tokens, chunk.token_count
            FROM cm_history_backfill_runs AS run
            JOIN cm_history_backfill_chunks AS chunk
              ON chunk.tenant_id=run.tenant_id AND chunk.user_id=run.user_id
             AND chunk.run_id=run.run_id
            ORDER BY run.run_id, chunk.chunk_index`).all() as Array<{
                project_id: string; reconciliation_digest: string;
                chunk_size_tokens: number; token_count: number;
            }>;
        assert.ok(rows.length >= 2);
        assert.ok(rows.every((row) => row.project_id === 'novel'));
        assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.reconciliation_digest)));
        assert.ok(rows.every((row) => row.chunk_size_tokens === CODEX_HISTORY_CHUNK_TOKENS));
        assert.ok(rows.every((row) => row.token_count <= CODEX_HISTORY_CHUNK_TOKENS));
    } finally {
        store.close();
    }
});

test('credential preflight reports only safe metadata and blocks authorization', () => {
    const credential = 'unsafe-history-value-123456';
    const unsafe = make_session('credential-session', 'D:\\work\\novel', `password=${credential}`);
    const report = inspect_history_credentials([make_session('safe-session'), unsafe]);
    assert.equal(report.scanned_sessions, 2);
    assert.equal(report.affected_sessions, 1);
    assert.equal(report.match_count, 1);
    assert.deepEqual(report.credential_kinds, ['secret_assignment']);
    assert.equal(report.issues[0]?.source_session_ref, 'credential-session');
    assert.deepEqual(report.issues[0]?.locations, ['session.turns[0].text']);
    assert.equal('source_revision' in (report.issues[0] ?? {}), false,
        'credential reports must not expose a hash oracle for the original session');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(credential));

    const loaded = complete_load([unsafe]);
    const manifest = manifest_for(loaded, [{
        cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true,
    }]);
    assert.throws(
        () => authorize_codex_history_import(loaded, manifest, ['credential-session'], 'novel', 'D:\\memory\\central.db'),
        (error) => {
            assert.ok(error instanceof history_credential_preflight_error);
            assert.equal(error.code, 'HISTORY_CREDENTIAL_PREFLIGHT_BLOCKED');
            assert.doesNotMatch(error.message, new RegExp(credential));
            return true;
        },
    );

    const secret_id = `password=${credential}`;
    const identifier_report = inspect_history_credentials([
        make_session(secret_id, 'D:\\work\\novel', 'otherwise safe content'),
    ]);
    assert.equal(identifier_report.issues[0]?.source_session_ref, 'affected-session:1');
    assert.doesNotMatch(JSON.stringify(identifier_report), new RegExp(credential));
    assert.doesNotMatch(
        new history_credential_preflight_error(identifier_report).message,
        new RegExp(credential),
    );
});

test('staging cannot receive a mutated authorization and leaves no partial database', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-credential-preflight-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const db_path = join(root, 'central-memory.db');
    const loaded = complete_load([make_session('one'), make_session('two')]);
    const manifest = manifest_for(loaded, [{
        cwd: 'D:\\work\\novel', project_id: 'novel', confirmed: true,
    }]);
    const authorized = authorize_codex_history_import(
        loaded, manifest, ['one', 'two'], 'novel', db_path,
    );
    const forged = structuredClone(authorized);
    forged.sessions[1]!.turns[0]!.text = `Authorization: Bearer ${'x'.repeat(32)}`;

    assert.throws(() => stage_authorized_codex_history({
        authorization: forged,
        db_path,
        project_id: 'novel',
        project_name: 'Novel',
    }), /validated history-manifest authorization/i);
    assert.equal(existsSync(db_path), false);
});
