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
 *  file  : src/cli/porter/history_plan.test.ts
 *  usage : tests the LongMemory history plan component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { portable_session, source_reconciliation } from './types.js';
import {
    assert_history_reconciliation,
    build_history_inventory,
    build_history_project_plan,
    history_reconciliation_digest,
    history_override_schema,
    normalize_history_cwd,
    parse_history_override_manifest,
    type history_override_manifest,
} from './history_plan.js';
import {
    build_history_source_snapshot,
    parse_history_source_snapshot,
} from './history_snapshot.js';

const session = (
    id: string,
    cwd: string,
    metadata: Record<string, unknown> = {},
): portable_session => ({
    schema_version: '1.0.0',
    source_harness: 'codex',
    source_session_id: id,
    source_path: `C:\\codex\\${id}.jsonl`,
    cwd,
    title: `Task ${id}`,
    turns: [{ role: 'user', text: `work ${id}` }],
    dropped_turns: 0,
    source_metadata: metadata,
});

test('builds deterministic cwd candidates and retains parent lineage independent of input order', () => {
    const parent = session('parent', 'D:\\Work\\Novel\\');
    const child = session('child', '', { parent_thread_id: 'parent' });
    const first = build_history_project_plan(build_history_inventory([parent, child]));
    const second = build_history_project_plan(build_history_inventory([child, parent]));

    assert.equal(normalize_history_cwd('D:/WORK/Novel/'), 'd:\\work\\novel');
    assert.equal(normalize_history_cwd('D:\\'), 'd:\\');
    assert.equal(first.inventory_id, second.inventory_id);
    assert.equal(first.plan_id, second.plan_id);
    assert.deepEqual(first.assignments, second.assignments);
    assert.equal(first.assignments.find((item) => item.source_session_id === 'child')?.assignment_source, 'parent_inference');
    assert.equal(first.safe_to_import, false);
    assert.ok(first.review_items.some((item) => item.code === 'semantic_confirmation_required'));
});

test('only confirmed explicit overrides produce an import-safe plan', () => {
    const inventory = build_history_inventory([
        session('one', 'D:\\work\\novel'),
        session('two', 'd:/work/novel'),
        session('skip', 'D:\\work\\scratch'),
    ]);
    const manifest: history_override_manifest = {
        schema_version: history_override_schema,
        source_harness: 'codex',
        inventory_id: inventory.inventory_id,
        cwd_overrides: [{ cwd: 'D:\\WORK\\NOVEL', project_id: 'novel', project_name: 'Novel', confirmed: true }],
        session_overrides: [{ source_session_id: 'skip', action: 'exclude', confirmed: true, note: 'temporary scratch task' }],
    };
    const plan = build_history_project_plan(inventory, manifest);

    assert.equal(plan.safe_to_import, true);
    assert.deepEqual(plan.counts, { sessions: 3, assigned: 2, excluded: 1, unresolved: 0, confirmed: 3, review_items: 0 });
    assert.deepEqual(plan.projects.map((project) => [project.project_id, project.source_session_ids]), [['novel', ['one', 'two']]]);
    assert.equal(plan.writes.central_memory, false);
    assert.equal(plan.dry_run, true);
});

test('requires an exact session confirmation when a cwd-less child is only inferred from its parent', () => {
    const inventory = build_history_inventory([
        session('parent', 'D:\\work\\art'),
        session('child', '', { parent_session_id: 'parent' }),
    ]);
    const manifest: history_override_manifest = {
        schema_version: history_override_schema,
        source_harness: 'codex',
        inventory_id: inventory.inventory_id,
        cwd_overrides: [{ cwd: 'D:\\work\\art', project_id: 'art', confirmed: true }],
        session_overrides: [],
    };
    const proposed = build_history_project_plan(inventory, manifest);
    assert.equal(proposed.assignments.find((item) => item.source_session_id === 'parent')?.confirmation, 'confirmed');
    assert.deepEqual(proposed.assignments.find((item) => item.source_session_id === 'child') && {
        project_id: proposed.assignments.find((item) => item.source_session_id === 'child')?.project_id,
        source: proposed.assignments.find((item) => item.source_session_id === 'child')?.assignment_source,
        confirmation: proposed.assignments.find((item) => item.source_session_id === 'child')?.confirmation,
    }, { project_id: 'art', source: 'parent_inference', confirmation: 'required' });
    assert.equal(proposed.safe_to_import, false);

    manifest.session_overrides.push({ source_session_id: 'child', action: 'assign', project_id: 'art', confirmed: true });
    assert.equal(build_history_project_plan(inventory, manifest).safe_to_import, true);
});

test('surfaces cross-cwd parent relations without silently merging the projects', () => {
    const plan = build_history_project_plan(build_history_inventory([
        session('parent', 'D:\\work\\novel'),
        session('child', 'D:\\work\\painting', { parent_thread_id: 'parent' }),
    ]));

    assert.equal(plan.projects.length, 2);
    assert.ok(plan.review_items.some((item) => item.code === 'cross_cwd_parent_link'));
});

test('strict manifest parsing rejects typos and unknown inventory references', () => {
    assert.throws(() => parse_history_override_manifest({
        schema_version: history_override_schema,
        source_harness: 'codex',
        inventory_id: 'inventory:test',
        cwd_overrides: [],
        session_overrides: [],
        typo: true,
    }), /contains unsupported fields/);

    const inventory = build_history_inventory([session('known', 'D:\\work\\known')]);
    assert.throws(() => build_history_project_plan(inventory, {
        schema_version: history_override_schema,
        source_harness: 'codex',
        inventory_id: inventory.inventory_id,
        cwd_overrides: [],
        session_overrides: [{ source_session_id: 'unknown', action: 'exclude', confirmed: true }],
    }), /unknown session unknown/);
});

test('unknown manifest and snapshot fields never echo attacker-controlled keys', () => {
    const secret_key = 'password=ActualPassword123';
    for (const invoke of [
        () => parse_history_override_manifest({
            schema_version: history_override_schema,
            source_harness: 'codex',
            inventory_id: 'inventory:test',
            cwd_overrides: [],
            session_overrides: [],
            [secret_key]: true,
        }),
        () => parse_history_source_snapshot({
            schema_version: 'longmemory.codex-source-snapshot/v2',
            source_harness: 'codex',
            snapshot_id: 'snapshot:test',
            files: [],
            [secret_key]: true,
        }),
    ]) {
        let failure: Error | undefined;
        try { invoke(); } catch (error) { failure = error as Error; }
        assert.ok(failure);
        assert.doesNotMatch(failure.message, /ActualPassword123/);
    }
});

test('source snapshot id binds every exact path, cutoff, and prefix hash', () => {
    const snapshot = build_history_source_snapshot([{
        source_session_id: 'one',
        source_path: 'C:\\codex\\one.jsonl',
        cutoff_bytes: 42,
        prefix_sha256: 'a'.repeat(64),
    }]);
    const tampered = structuredClone(snapshot) as unknown as {
        files: Array<{ cutoff_bytes: number }>;
    };
    tampered.files[0]!.cutoff_bytes++;
    assert.throws(() => parse_history_source_snapshot(tampered), /id does not match its exact file cutoffs/i);
    assert.throws(() => build_history_source_snapshot([
        snapshot.files[0]!, snapshot.files[0]!,
    ]), /duplicate source paths/i);
});

test('source snapshots use UTF-16 canonical order and reject credential-bearing locators', () => {
    const snapshot = build_history_source_snapshot([
        { source_session_id: 'a', source_path: 'C:\\codex\\a.jsonl', cutoff_bytes: 1, prefix_sha256: 'a'.repeat(64) },
        { source_session_id: 'A', source_path: 'C:\\codex\\A.jsonl', cutoff_bytes: 1, prefix_sha256: 'b'.repeat(64) },
    ]);
    assert.deepEqual(snapshot.files.map((file) => file.source_session_id), ['A', 'a']);

    const secret = 'ActualPassword123';
    let failure: Error | undefined;
    try {
        build_history_source_snapshot([{
            source_session_id: 'unsafe',
            source_path: `C:\\password=${secret}\\history.jsonl`,
            cutoff_bytes: 1,
            prefix_sha256: 'c'.repeat(64),
        }]);
    } catch (error) { failure = error as Error; }
    assert.ok(failure);
    assert.match(failure.message, /prohibited credential material/i);
    assert.doesNotMatch(failure.message, new RegExp(secret));
});

test('source reconciliation rejects duplicate categories and invalid partial details', () => {
    const base: source_reconciliation = {
        source_files: 2,
        importable_tasks: 0,
        empty_tasks: 1,
        parse_failures: 1,
        excluded_tasks: 0,
        partial_tasks: 0,
        empty: [{ source_session_id: 'one', source_path: 'one.jsonl' }],
        failures: [{ source_session_id: 'one', source_path: 'one.jsonl', error: 'unreadable' }],
        excluded: [],
        partial: [],
    };
    assert.throws(() => assert_history_reconciliation(base), /more than once/i);

    assert.throws(() => assert_history_reconciliation({
        source_files: 1,
        importable_tasks: 1,
        empty_tasks: 0,
        parse_failures: 0,
        excluded_tasks: 0,
        partial_tasks: 1,
        empty: [], failures: [], excluded: [],
        partial: [{ source_session_id: 'one', source_path: 'one.jsonl', skipped_line_count: 0 }],
    }), /invalid skipped_line_count/i);

    const digest = history_reconciliation_digest({
        source_files: 1,
        importable_tasks: 1,
        empty_tasks: 0,
        parse_failures: 0,
        excluded_tasks: 0,
        partial_tasks: 0,
        empty: [], failures: [], excluded: [], partial: [],
    });
    assert.match(digest, /^[a-f0-9]{64}$/);
});
