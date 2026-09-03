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
 *  file  : src/cli/porter/history_redaction.test.ts
 *  usage : tests the LongMemory history redaction component
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    authorize_codex_history_import,
    history_import_evidence_for_session,
} from './history_authorization.js';
import { stage_authorized_codex_history } from './history_backfill.js';
import {
    build_history_inventory,
    build_history_project_plan,
    type history_override_manifest,
} from './history_plan.js';
import { derive_redacted_history_session } from './history_redaction.js';
import { portable_session_revision } from './history_revision.js';
import type { history_inventory_load } from './history_source.js';
import type { portable_session, source_reconciliation } from './types.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { HistoryBackfillService } from '../../core/central_memory/history_backfill_service.js';
import { HistoryWorkerAuthorizationService } from '../../core/central_memory/history_worker_authorization.js';
import type { history_worker_context } from '../../core/central_memory/history_backfill_types.js';
import { project_central_memory_to_obsidian } from '../../integrations/obsidian/projector.js';

const session = (text: string): portable_session => ({
    schema_version: '1.0.0',
    source_harness: 'codex',
    source_session_id: 'sentinel-session',
    source_path: 'C:\\safe\\sentinel-session.jsonl',
    cwd: 'D:\\work\\novel',
    title: 'Sentinel history',
    created_at: 1,
    updated_at: 2,
    turns: [{ role: 'user', text }],
    dropped_turns: 0,
    source_metadata: { parser: 'synthetic-test' },
});

const reconciliation = (): source_reconciliation => ({
    source_files: 1,
    importable_tasks: 1,
    empty_tasks: 0,
    parse_failures: 0,
    excluded_tasks: 0,
    partial_tasks: 0,
    empty: [],
    failures: [],
    excluded: [],
    partial: [],
});

const loaded = (source: portable_session): history_inventory_load => {
    const scan = reconciliation();
    return {
        inventory: build_history_inventory([source], 'codex', scan),
        discovered: 1,
        selected: 1,
        complete_source_scan: true,
        parse_failures: [],
        reconciliation: scan,
        sessions: [source],
        deferred_source_files: 0,
    };
};

const confirmed_manifest = (value: history_inventory_load): history_override_manifest => {
    const template = structuredClone(build_history_project_plan(value.inventory).override_manifest_template);
    template.cwd_overrides = template.cwd_overrides.map((entry) => ({
        ...entry,
        project_id: 'novel',
        project_name: 'Novel',
        confirmed: true,
    }));
    if (template.redaction_policy) {
        template.redaction_policy.confirmed = true;
        template.redaction_policy.sessions = template.redaction_policy.sessions
            .map((entry) => ({ ...entry, confirmed: true }));
    }
    return template;
};

const all_files = (root: string): string[] => existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? all_files(path) : [path];
    })
    : [];

const assert_tree_does_not_contain = (root: string, value: string): void => {
    for (const file of all_files(root)) {
        if (!statSync(file).isFile()) continue;
        assert.equal(readFileSync(file).includes(Buffer.from(value)), false, `secret leaked to ${file}`);
    }
};

test('derived history redaction is deterministic, complete, and never mutates source', () => {
    const secret = 'unsafe-redaction-sentinel-123456789';
    const source = session(`password=${secret}\nAuthorization: Bearer ${'z'.repeat(32)}`);
    const before = structuredClone(source);
    const first = derive_redacted_history_session(source);
    const second = derive_redacted_history_session(structuredClone(source));
    assert.deepEqual(source, before);
    assert.deepEqual(first, second);
    assert.ok(first.binding);
    assert.equal(first.binding.match_count, 2);
    assert.deepEqual(first.binding.credential_kinds, ['bearer_token', 'secret_assignment']);
    assert.deepEqual(first.binding.locations, ['session.turns[0].text']);
    assert.deepEqual(first.binding.terminal_marker_ids, [1, 2]);
    assert.equal('original_source_revision' in first.binding, false,
        'review and runtime evidence must not expose a hash of the credential-bearing source');
    assert.match(first.session.turns[0]!.text, /LMR-REDACTED/);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
});

test('generated placeholders are detector-inert and source marker text is ordinary untrusted history', () => {
    const secret = `sk-proj-${'a'.repeat(24)}`;
    const source = session(
        `Historical literal <LONGMEMORY_REDACTED:secret_assignment:000001> api_key=${secret}suffix`,
    );
    const result = derive_redacted_history_session(source);
    assert.ok(result.binding);
    assert.match(result.session.turns[0]!.text, /<LONGMEMORY_REDACTED:secret_assignment:000001>/);
    assert.match(result.session.turns[0]!.text, /api_key=<LMR-REDACTED-000001>$/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('overlapping specific and assignment findings converge without retaining swallowed markers', () => {
    const secret = `ghp_${'b'.repeat(24)}`;
    const source = session(`password=prefix-${secret}-suffix`);
    const first = derive_redacted_history_session(source);
    const second = derive_redacted_history_session(structuredClone(source));
    assert.deepEqual(first, second);
    assert.ok(first.binding);
    assert.deepEqual(first.binding.credential_kinds, ['github_token', 'secret_assignment']);
    assert.deepEqual(first.binding.locations, ['session.turns[0].text']);
    assert.equal(first.binding.match_count, 1,
        'the encompassing second pass leaves one terminal redacted region');
    assert.match(first.session.turns[0]!.text, /^password=<LMR-REDACTED-\d{6}>$/);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
});

test('generated marker occurrences never collide with marker-shaped source text', () => {
    const source_marker = '<LMR-REDACTED-000001>';
    const result = derive_redacted_history_session(session(
        `Historical literal ${source_marker}; password=unsafe-marker-collision-123456`,
    ));
    assert.ok(result.binding);
    assert.match(result.session.turns[0]!.text, /<LMR-REDACTED-000002>/);
    assert.match(result.session.turns[0]!.text, /<LMR-REDACTED-000003>/);
    assert.doesNotMatch(result.session.turns[0]!.text, /<LMR-REDACTED-000001>/);
    assert.deepEqual(result.binding.credential_kinds, [
        'secret_assignment', 'untrusted_redaction_marker',
    ]);
    assert.equal(result.binding.match_count, 2);
});

test('malformed LMR marker-shaped source text is replaced rather than becoming an unstaged blocker', () => {
    const result = derive_redacted_history_session(session('Historical <LMR-REDACTED-not-an-id> literal'));
    assert.ok(result.binding);
    assert.equal(result.binding.match_count, 1);
    assert.deepEqual(result.binding.terminal_marker_ids, [1]);
    assert.equal(result.session.turns[0]!.text, 'Historical <LMR-REDACTED-000001> literal');
});

test('angle-bracketed secrets are not mistaken for safe placeholders', () => {
    const result = derive_redacted_history_session(session('password=<ActualPassword123>'));
    assert.ok(result.binding);
    assert.match(result.session.turns[0]!.text, /^password=<LMR-REDACTED-\d{6}>$/);
    assert.doesNotMatch(JSON.stringify(result), /ActualPassword123/);
});

test('canonical-equivalent metadata insertion order yields identical redaction evidence', () => {
    const first = session('ordinary turn');
    first.source_metadata = {
        z_note: 'password=unsafe-order-z-123456789',
        a_note: 'token=unsafe-order-a-123456789',
        parser: 'synthetic-test',
    };
    const second = session('ordinary turn');
    second.source_metadata = {
        parser: 'synthetic-test',
        a_note: 'token=unsafe-order-a-123456789',
        z_note: 'password=unsafe-order-z-123456789',
    };
    assert.equal(portable_session_revision(first), portable_session_revision(second));

    const first_derived = derive_redacted_history_session(first);
    const second_derived = derive_redacted_history_session(second);
    assert.ok(first_derived.binding);
    assert.ok(second_derived.binding);
    assert.equal(
        first_derived.binding.derived_source_revision,
        second_derived.binding.derived_source_revision,
    );
    assert.equal(
        first_derived.binding.transformation_manifest_hash,
        second_derived.binding.transformation_manifest_hash,
    );
    assert.deepEqual(first_derived.session, second_derived.session);
});

test('credential history remains blocked unless the exact generated policy is explicitly confirmed', () => {
    const secret = 'unsafe-opt-in-sentinel-123456789';
    const source = session(`password=${secret}`);
    const value = loaded(source);
    const unconfirmed = build_history_project_plan(value.inventory).override_manifest_template;
    unconfirmed.cwd_overrides = unconfirmed.cwd_overrides.map((entry) => ({
        ...entry, project_id: 'novel', confirmed: true,
    }));
    assert.throws(
        () => authorize_codex_history_import(value, unconfirmed, [source.source_session_id], 'novel', 'D:\\safe\\memory.db'),
        /blocked before database writes/i,
    );

    const manifest = confirmed_manifest(value);
    const authorized = authorize_codex_history_import(
        value, manifest, [source.source_session_id], 'novel', 'D:\\safe\\memory.db',
    );
    assert.equal(Object.isFrozen(authorized), true);
    assert.equal(Object.isFrozen(authorized.sessions[0]), true);
    assert.doesNotMatch(JSON.stringify(authorized), new RegExp(secret));
    assert.equal(value.inventory.sessions[0]?.source_revision,
        authorized.evidence.redaction_bindings?.[0]?.derived_source_revision);
    assert.equal('original_source_revision' in (authorized.evidence.redaction_bindings?.[0] ?? {}), false);

    const tampered = structuredClone(manifest);
    tampered.redaction_policy!.sessions[0]!.transformation_manifest_hash = '0'.repeat(64);
    assert.throws(
        () => authorize_codex_history_import(value, tampered, [source.source_session_id], 'novel', 'D:\\safe\\memory.db'),
        /does not match the exact derived snapshot/i,
    );
});

test('redaction evidence is live-issued, marker-exact, and cannot be forged or cloned', () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-redaction-evidence-'));
    const db_path = join(root, 'central-memory.db');
    const source = session('password=unsafe-issued-evidence-123456789');
    const value = loaded(source);
    const manifest = confirmed_manifest(value);
    const authorization = authorize_codex_history_import(
        value, manifest, [source.source_session_id], 'novel', db_path,
    );
    const derived = authorization.sessions[0]!;
    const issued = history_import_evidence_for_session(authorization, derived);
    const binding = issued.redaction_bindings?.[0];
    assert.ok(binding);
    assert.deepEqual(binding.terminal_marker_ids, [1]);

    const store = new SqliteStore(db_path, { startup_integrity_check: false });
    try {
        store.central_memory.register_project({ project_id: 'novel', name: 'Novel' });
        const service = new HistoryBackfillService(store.database, {
            tenant_id: 'default', user_id: 'default', capability_guard: () => undefined,
        });
        assert.throws(() => service.create_run({
            session: derived,
            evidence: structuredClone(issued),
            project_id: 'novel',
        }), /live issued redaction evidence/i);
        assert.throws(() => service.create_run({
            session: {
                ...session('ordinary source marker'),
                turns: [{ role: 'user', text: '<LMR-REDACTED-000001>' }],
            },
            evidence: {
                inventory_id: 'inventory:forged',
                reconciliation_digest: 'a'.repeat(64),
                plan_id: 'plan:forged',
                manifest_hash: 'b'.repeat(64),
                target_db_path: db_path,
                target_project_id: 'novel',
            },
            project_id: 'novel',
        }), /without issued binding evidence/i);
        const created = service.create_run({ session: derived, evidence: issued, project_id: 'novel' });
        assert.equal(created.source_revision, binding.derived_source_revision);
        const persisted = store.database.prepare(
            'SELECT authorization_json FROM cm_history_backfill_runs WHERE run_id=?',
        ).get(created.run_id) as { authorization_json: string };
        assert.doesNotMatch(persisted.authorization_json, /original_source_revision/);
    } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('A/a ordering remains identical through manifest parsing, authorization, and staging', () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-redaction-order-'));
    const db_path = join(root, 'central-memory.db');
    const upper = { ...session('password=unsafe-upper-order-123456789'), source_session_id: 'A-session' };
    const lower = { ...session('password=unsafe-lower-order-123456789'), source_session_id: 'a-session' };
    const value = loaded(upper);
    value.sessions = [lower, upper];
    value.reconciliation = {
        ...reconciliation(), source_files: 2, importable_tasks: 2,
    };
    value.selected = 2;
    value.discovered = 2;
    value.inventory = build_history_inventory(value.sessions, 'codex', value.reconciliation);
    const manifest = confirmed_manifest(value);
    assert.deepEqual(value.inventory.sessions.map((entry) => entry.source_session_id), ['A-session', 'a-session']);
    assert.deepEqual(manifest.redaction_policy?.sessions.map((entry) => entry.source_session_id), ['A-session', 'a-session']);
    const authorization = authorize_codex_history_import(
        value, manifest, ['A-session', 'a-session'], 'novel', db_path,
    );
    assert.deepEqual(
        authorization.evidence.redaction_bindings?.map((entry) => entry.source_session_id),
        ['A-session', 'a-session'],
    );
    try {
        const staged = stage_authorized_codex_history({
            authorization, db_path, project_id: 'novel', project_name: 'Novel',
        });
        assert.deepEqual(staged.map((entry) => entry.source_session_id), ['A-session', 'a-session']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('sentinel credential never reaches SQLite artifacts, workflow rows, reports, or Obsidian', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-redaction-sentinel-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const db_path = join(root, 'central-memory.db');
    const vault = join(root, 'vault');
    const state = join(root, 'projection-state');
    const secret = 'unsafe-e2e-sentinel-987654321';
    const source = session(`password=${secret}`);
    const value = loaded(source);
    const manifest = confirmed_manifest(value);
    const authorized = authorize_codex_history_import(
        value, manifest, [source.source_session_id], 'novel', db_path,
    );
    const staged = stage_authorized_codex_history({
        authorization: authorized,
        db_path,
        project_id: 'novel',
        project_name: 'Novel',
    });
    const report: unknown[] = [authorized.evidence, staged];

    const store = new SqliteStore(db_path, { startup_integrity_check: false });
    try {
        store.central_memory.register_thread({
            thread_id: 'redaction-worker',
            project_id: 'novel',
            responsibility: 'Synthetic redaction test worker',
            at: 3,
        });
        report.push(new HistoryWorkerAuthorizationService(store.database, {
            tenant_id: 'default', user_id: 'default',
        }).authorize({
            project_id: 'novel',
            worker_session_id: 'redaction-worker',
            worker_id: 'worker',
            run_id: staged[0]!.run_id,
            actor_id: 'synthetic-test-user',
            action_id: 'synthetic-redaction-worker-authorization',
            evidence: { explicit_human_test_authorization: true },
            at: 4,
        }));
        const service = new HistoryBackfillService(store.database, {
            tenant_id: 'default',
            user_id: 'default',
            capability_guard: () => undefined,
        });
        const worker = (turn: string): history_worker_context => ({
            worker_id: 'worker',
            worker_session_id: 'redaction-worker',
            worker_turn_id: turn,
            capability_epoch_hash: 'c'.repeat(64),
        });
        const claim = service.claim_next(worker('extract'), 5_000)!;
        const part = claim.chunk.source_parts[0]!;
        const finding = {
            kind: 'knowledge' as const,
            title: 'Sanitized historical knowledge',
            summary: 'The source was deterministically sanitized before staging.',
            body: 'Only the stable replacement marker remains available to workers.',
            importance: 0.7,
            is_major: false,
            evidence: [{
                chunk_index: claim.chunk.chunk_index,
                turn_index: part.turn_index,
                part_index: part.part_index,
            }],
        };
        report.push(claim, service.submit_chunk(
            worker('extract'), claim.lease_id, claim.chunk.chunk_hash, [finding],
        ));
        const reduction = service.claim_consolidation(worker('reduce'), 5_000)!;
        report.push(reduction, service.complete_consolidation(
            worker('reduce'), reduction.lease_id, [finding],
        ));
        report.push(project_central_memory_to_obsidian({
            database: store.database,
            tenant_id: 'default',
            user_id: 'default',
            vault_root: vault,
            state_root: state,
        }));
        // Inspect the live main database, WAL/SHM, projection journal/state,
        // and generated vault before checkpointing can truncate anything.
        assert_tree_does_not_contain(root, secret);
        store.database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        store.close();
    }

    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
    assert_tree_does_not_contain(root, secret);
});
