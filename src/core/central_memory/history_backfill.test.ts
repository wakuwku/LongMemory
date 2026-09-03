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
 *  file  : src/core/central_memory/history_backfill.test.ts
 *  usage : tests the LongMemory history backfill component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorize_codex_history_import } from '../../cli/porter/history_authorization.js';
import {
    build_history_inventory,
    history_override_schema,
    type history_override_manifest,
} from '../../cli/porter/history_plan.js';
import type { history_inventory_load } from '../../cli/porter/history_source.js';
import type { portable_session, source_reconciliation } from '../../cli/porter/types.js';
import { canonicalize } from '../hash/canonical_json.js';
import { count_tokens } from '../recall/context_builder.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { HistoryBackfillService } from './history_backfill_service.js';
import { HistoryWorkerAuthorizationService } from './history_worker_authorization.js';
import type {
    history_backfill_finding,
    history_chunk_claim,
    history_chunk_payload,
    history_reduction_page_item,
    history_worker_context,
} from './history_backfill_types.js';

const digest = (character: string): string => character.repeat(64);

const evidence = (project_id = 'project-a') => ({
    inventory_id: 'inventory:test',
    reconciliation_digest: digest('a'),
    plan_id: 'plan:test',
    manifest_hash: digest('b'),
    target_db_path: 'D:\\memory\\central.db',
    target_project_id: project_id,
});

const session = (
    id = 'history-1',
    turns: portable_session['turns'] = [
        { role: 'user', text: 'Remember the exact alpha decision.' },
        { role: 'assistant', text: 'Completed the alpha implementation.' },
    ],
    updated_at = 10,
): portable_session => ({
    schema_version: '1.0.0',
    source_harness: 'codex',
    source_session_id: id,
    source_path: `C:\\codex\\${id}.jsonl`,
    cwd: 'D:\\work\\project-a',
    title: `History ${id}`,
    created_at: 1,
    updated_at,
    turns,
    dropped_turns: 0,
    source_metadata: { parser: 'test' },
});

type fixture = {
    store: SqliteStore;
    service: HistoryBackfillService;
    now: { value: number };
    worker: (turn: string, session_id?: string, character?: string) => history_worker_context;
};

const fixture = (
    path = ':memory:',
    scope: { tenant_id?: string; user_id?: string } = {},
): fixture => {
    const now = { value: 1_000 };
    const tenant_id = scope.tenant_id ?? 'tenant';
    const user_id = scope.user_id ?? 'user';
    const store = new SqliteStore(path, {
        tenant_id, user_id, now: () => now.value, startup_integrity_check: false,
    });
    for (const project_id of ['project-a', 'project-b']) {
        store.central_memory.register_project({ project_id, name: project_id, at: 1 });
    }
    store.central_memory.register_thread({
        thread_id: 'worker-a', project_id: 'project-a', responsibility: 'history worker', at: 1,
    });
    store.central_memory.register_thread({
        thread_id: 'worker-b', project_id: 'project-b', responsibility: 'history worker', at: 1,
    });
    const authorizations = new HistoryWorkerAuthorizationService(store.database, {
        tenant_id, user_id, now: () => now.value,
    });
    for (const [worker_session_id, project_id] of [
        ['worker-a', 'project-a'],
        ['worker-b', 'project-b'],
    ] as const) {
        authorizations.authorize({
            project_id,
            worker_session_id,
            worker_id: 'history-agent',
            actor_id: 'test-human',
            action_id: `test-authorize:${worker_session_id}`,
            evidence: { source: 'history_backfill_test_fixture' },
            at: 1,
        });
    }
    const service = new HistoryBackfillService(store.database, {
        tenant_id,
        user_id,
        now: () => now.value,
        capability_guard: (worker) => {
            if (worker.capability_epoch_hash === digest('0')) throw new Error('stale capability epoch');
        },
    });
    return {
        store,
        service,
        now,
        worker: (turn, session_id = 'worker-a', character = 'c') => ({
            worker_id: 'history-agent',
            worker_session_id: session_id,
            worker_turn_id: turn,
            capability_epoch_hash: digest(character),
        }),
    };
};

const finding_for = (
    claim: history_chunk_claim,
    overrides: Partial<history_backfill_finding> = {},
): history_backfill_finding => {
    const part = claim.chunk.source_parts[0]!;
    return {
        kind: 'knowledge',
        title: 'Durable historical knowledge',
        summary: 'The historical task established an exact durable fact.',
        body: 'The exact historical source and its outcome are retained for later governance.',
        importance: 0.7,
        is_major: false,
        evidence: [{
            chunk_index: claim.chunk.chunk_index,
            turn_index: part.turn_index,
            part_index: part.part_index,
        }],
        ...overrides,
    };
};

test('deterministic token-bounded chunks cover every turn and code point without loss', () => {
    const value = fixture();
    const turns: portable_session['turns'] = [
        { role: 'user', text: `中文🙂${'复现实验条件。'.repeat(260)}` },
        { role: 'assistant', text: '' },
        { role: 'tool', text: `${'tool-output '.repeat(160)}终` },
    ];
    const run = value.service.create_run({
        session: session('coverage', turns), evidence: evidence(), project_id: 'project-a',
        max_chunk_tokens: 256, max_chunk_chars: 300,
    });
    assert.ok(run.chunk_count > turns.length, 'a long individual turn must be split');
    const rows = value.store.database.prepare(`SELECT payload_json, token_count, character_count
        FROM cm_history_backfill_chunks WHERE tenant_id='tenant' AND user_id='user' AND run_id=?
        ORDER BY chunk_index`).all(run.run_id) as Array<{
            payload_json: string; token_count: number; character_count: number;
        }>;
    const by_turn = new Map<number, Array<{ part_index: number; part_count: number; text: string }>>();
    for (const row of rows) {
        assert.ok(row.token_count <= 256);
        assert.ok(row.character_count <= 300);
        const payload = JSON.parse(row.payload_json) as history_chunk_payload;
        assert.equal(count_tokens(payload.model_text), row.token_count);
        for (const part of payload.parts) {
            const items = by_turn.get(part.turn_index) ?? [];
            items.push({ part_index: part.part_index, part_count: part.part_count, text: part.text });
            by_turn.set(part.turn_index, items);
        }
    }
    turns.forEach((turn, turn_index) => {
        const parts = (by_turn.get(turn_index) ?? []).sort((left, right) => left.part_index - right.part_index);
        assert.ok(parts.length >= 1, `empty turn ${turn_index} must retain a locator`);
        assert.deepEqual(parts.map((part) => part.part_index), parts.map((_, index) => index));
        assert.ok(parts.every((part) => part.part_count === parts.length));
        assert.equal(parts.map((part) => part.text).join(''), turn.text);
    });
    const retry = value.service.create_run({
        session: session('coverage', turns), evidence: evidence(), project_id: 'project-a',
        max_chunk_tokens: 256, max_chunk_chars: 300,
    });
    assert.equal(retry.run_id, run.run_id);
    const claim = value.service.claim_next(value.worker('coverage-claim'), 2_000)!;
    assert.ok(count_tokens(canonicalize(claim)) <= 1_800);
    assert.ok(claim.chunk.source_parts.every((part) => !('text' in part)),
        'source locators must not duplicate model_text in the claim DTO');
    assert.throws(() => value.service.create_run({
        session: session('coverage', turns), evidence: evidence(), project_id: 'project-a',
        max_chunk_tokens: 300, max_chunk_chars: 300,
    }), /different immutable content/i);
    value.store.close();
});

test('immutable history staging rejects credential-bearing source snapshots', () => {
    const value = fixture();
    const credential = 'unsafe-source-value-123456';
    assert.throws(() => value.service.create_run({
        session: session('credential-source', [{ role: 'user', text: `password=${credential}` }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    }), /credential material \(secret_assignment\)/i);
    const counts = value.store.database.prepare(`SELECT
            (SELECT count(*) FROM cm_history_backfill_runs) AS runs,
            (SELECT count(*) FROM cm_history_backfill_chunks) AS chunks`).get() as {
                runs: number; chunks: number;
            };
    assert.deepEqual(counts, { runs: 0, chunks: 0 });
    value.store.close();
});

test('expired leases are reclaimed after restart and stale leases cannot submit', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-queue-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'memory.db');
    const first = fixture(path);
    const run = first.service.create_run({
        session: session('crash', [{ role: 'user', text: 'alpha crash recovery' }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const old_worker = first.worker('turn-old', 'worker-a', 'c');
    const old_claim = first.service.claim_next(old_worker, 1_000)!;
    first.store.close();

    const clock = { value: 2_100 };
    const reopened = new SqliteStore(path, {
        tenant_id: 'tenant', user_id: 'user', now: () => clock.value, startup_integrity_check: false,
    });
    const service = new HistoryBackfillService(reopened.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => clock.value, capability_guard: () => {},
    });
    const new_worker = {
        ...old_worker, worker_turn_id: 'turn-new', capability_epoch_hash: digest('d'),
    };
    const reclaimed = service.claim_next(new_worker, 1_000)!;
    assert.equal(reclaimed.chunk.chunk_index, old_claim.chunk.chunk_index);
    assert.notEqual(reclaimed.lease_id, old_claim.lease_id);
    const finding = finding_for(reclaimed);
    assert.throws(
        () => service.submit_chunk(old_worker, old_claim.lease_id, old_claim.chunk.chunk_hash, [finding]),
        /stale|active/i,
    );
    const receipt = service.submit_chunk(new_worker, reclaimed.lease_id, reclaimed.chunk.chunk_hash, [finding]);
    assert.equal(service.submit_chunk(new_worker, reclaimed.lease_id, reclaimed.chunk.chunk_hash, [finding]).receipt_id, receipt.receipt_id);
    assert.throws(() => service.submit_chunk(new_worker, reclaimed.lease_id, reclaimed.chunk.chunk_hash, [{
        ...finding, body: 'different retry content',
    }]), /different content/i);
    assert.equal(service.status('project-a', run.run_id).chunks.completed, 1);
    assert.equal(service.turn_usage('worker-a', 'turn-old')?.status, 'expired');
    assert.equal(service.turn_usage('worker-a', 'turn-new')?.status, 'consumed');
    reopened.close();
});

test('failed chunks require retry and history-consumed turns reject regular memories', () => {
    const value = fixture();
    const run = value.service.create_run({
        session: session('retry', [{ role: 'user', text: 'retry this exact source' }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const worker = value.worker('turn-fail');
    const claim = value.service.claim_next(worker, 2_000)!;
    const credential = `Bearer ${'s'.repeat(32)}`;
    assert.throws(
        () => value.service.fail_chunk(
            worker, claim.lease_id, claim.chunk.chunk_hash, credential,
        ),
        /credential material \(bearer_token\)/i,
    );
    assert.equal(value.service.status('project-a', run.run_id).run.last_error, null);
    value.service.fail_chunk(worker, claim.lease_id, claim.chunk.chunk_hash, 'model unavailable');
    assert.equal(value.service.status('project-a', run.run_id).chunks.failed, 1);
    assert.equal(value.service.claim_next(value.worker('turn-too-early', 'worker-a', 'd'), 2_000), null);
    assert.throws(
        () => value.service.assert_turn_available_for_regular_memory('worker-a', 'turn-fail', true),
        /history workflow/i,
    );
    value.service.assert_turn_available_for_regular_memory('worker-a', 'turn-fail', false);
    value.service.retry_chunk('project-a', run.run_id, claim.chunk.chunk_index);
    const retry = value.service.claim_next(value.worker('turn-retry', 'worker-a', 'e'), 2_000)!;
    value.service.submit_chunk(value.worker('turn-retry', 'worker-a', 'e'), retry.lease_id, retry.chunk.chunk_hash, []);
    assert.equal(value.service.status('project-a', run.run_id).run.status, 'ready_for_consolidation');
    value.store.close();
});

test('consolidation failure diagnostics reject credentials before persistence', () => {
    const value = fixture();
    const run = value.service.create_run({
        session: session('safe-failure-detail', [{ role: 'user', text: 'durable source' }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const extract_worker = value.worker('safe-failure-extract');
    const claim = value.service.claim_next(extract_worker, 2_000)!;
    value.service.submit_chunk(
        extract_worker, claim.lease_id, claim.chunk.chunk_hash, [finding_for(claim)],
    );
    const reduce_worker = value.worker('safe-failure-reduce');
    const reduction = value.service.claim_consolidation(reduce_worker, 2_000)!;
    const credential = `password=${'s'.repeat(32)}`;
    assert.throws(
        () => value.service.fail_consolidation(reduce_worker, reduction.lease_id, credential),
        /credential material \(secret_assignment\)/i,
    );
    assert.equal(value.service.status('project-a', run.run_id).run.last_error, null);
    value.service.fail_consolidation(reduce_worker, reduction.lease_id, 'model unavailable');
    assert.equal(value.service.status('project-a', run.run_id).run.last_error, 'model unavailable');
    value.store.close();
});

test('new source revisions supersede unfinished work without rewriting old snapshots', () => {
    const value = fixture();
    const old_session = session('revision', [{ role: 'user', text: 'old immutable text' }], 10);
    const old = value.service.create_run({
        session: old_session, evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const old_snapshot = (value.store.database.prepare(`SELECT session_snapshot_json FROM cm_history_backfill_runs
        WHERE tenant_id='tenant' AND user_id='user' AND run_id=?`).get(old.run_id) as { session_snapshot_json: string }).session_snapshot_json;
    const old_worker = value.worker('old-turn');
    const old_claim = value.service.claim_next(old_worker, 10_000)!;
    const current = value.service.create_run({
        session: session('revision', [{ role: 'user', text: 'new immutable text' }], 20),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    assert.equal(value.service.status('project-a', old.run_id).run.status, 'superseded');
    assert.equal(value.service.status('project-a', current.run_id).run.status, 'pending');
    assert.equal((value.store.database.prepare(`SELECT session_snapshot_json FROM cm_history_backfill_runs
        WHERE tenant_id='tenant' AND user_id='user' AND run_id=?`).get(old.run_id) as { session_snapshot_json: string }).session_snapshot_json, old_snapshot);
    assert.throws(
        () => value.service.submit_chunk(old_worker, old_claim.lease_id, old_claim.chunk.chunk_hash, []),
        /stale|active/i,
    );
    assert.equal(value.service.create_run({
        session: old_session, evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    }).status, 'superseded', 'replaying a known stale revision must not supersede the current run');
    value.store.close();
});

test('worker project is derived from its active bound thread and scopes are isolated', () => {
    const value = fixture();
    const run_a = value.service.create_run({
        session: session('scope-a'), evidence: evidence('project-a'), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const run_b = value.service.create_run({
        session: session('scope-b'), evidence: evidence('project-b'), project_id: 'project-b', max_chunk_tokens: 256,
    });
    const claim_a = value.service.claim_next(value.worker('a-turn'), 2_000)!;
    assert.equal(claim_a.run.run_id, run_a.run_id);
    const worker_b = value.worker('b-turn', 'worker-b', 'd');
    assert.throws(
        () => value.service.submit_chunk(worker_b, claim_a.lease_id, claim_a.chunk.chunk_hash, []),
        /scope|capability/i,
    );
    const claim_b = value.service.claim_next(worker_b, 2_000)!;
    assert.equal(claim_b.run.run_id, run_b.run_id);
    assert.throws(() => value.service.claim_next({
        ...value.worker('invalid'), capability_epoch_hash: digest('0'),
    }, 2_000), /stale capability/i);

    const other = new HistoryBackfillService(value.store.database, {
        tenant_id: 'tenant', user_id: 'other-user', now: () => value.now.value, capability_guard: () => {},
    });
    assert.throws(() => other.status('project-a', run_a.run_id), /not found/i);
    value.store.close();
});

test('finding boundary rejects invalid evidence, oversized fields, extra fields, and credentials', () => {
    const value = fixture();
    value.service.create_run({
        session: session('validation', [{ role: 'user', text: 'source text alpha' }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const attempts: Array<{ turn: string; mutate: (finding: history_backfill_finding) => unknown; pattern: RegExp }> = [
        { turn: 'bad-quote', mutate: (finding) => ({ ...finding, evidence: [{ ...finding.evidence[0]!, quote: 'not in source' }] }), pattern: /not present/i },
        { turn: 'bad-kind', mutate: (finding) => ({ ...finding, kind: 'progress_update' }), pattern: /allowed durable-memory category/i },
        { turn: 'too-long', mutate: (finding) => ({ ...finding, title: 'x'.repeat(161) }), pattern: /between 1 and 160/i },
        { turn: 'extra', mutate: (finding) => ({ ...finding, temporary_note: 'noise' }), pattern: /unsupported field/i },
        { turn: 'secret', mutate: (finding) => ({ ...finding, body: `Authorization: Bearer ${'a'.repeat(32)}` }), pattern: /credential material/i },
    ];
    for (const attempt of attempts) {
        const worker = value.worker(attempt.turn, 'worker-a', attempt.turn[0]!.toLowerCase().replace(/[^a-f]/g, 'e'));
        const claim = value.service.claim_next(worker, 2_000)!;
        const finding = finding_for(claim);
        assert.throws(
            () => value.service.submit_chunk(worker, claim.lease_id, claim.chunk.chunk_hash, [attempt.mutate(finding)]),
            attempt.pattern,
        );
        value.service.fail_chunk(worker, claim.lease_id, claim.chunk.chunk_hash, 'invalid model result', value.now.value);
    }
    value.store.close();
});

test('bounded persistent reduction rounds only accept the union of input-candidate evidence', () => {
    const value = fixture();
    const source_turns = Array.from({ length: 3 }, (_, chunk_index) => ({
        role: 'user' as const,
        text: Array.from({ length: 24 }, (_, index) => `quote-${chunk_index}-${index}`).join(' | ').padEnd(256, '.'),
    }));
    const run = value.service.create_run({
        session: session('reductions', source_turns), evidence: evidence(), project_id: 'project-a',
        max_chunk_tokens: 1_000, max_chunk_chars: 256,
    });
    assert.ok(run.chunk_count >= 3);
    for (let chunk_index = 0; chunk_index < run.chunk_count; chunk_index++) {
        const worker = value.worker(`extract-${chunk_index}`, 'worker-a', 'c');
        const claim = value.service.claim_next(worker, 2_000)!;
        assert.equal(claim.chunk.chunk_index, chunk_index);
        const part = claim.chunk.source_parts[0]!;
        const findings = Array.from({ length: 24 }, (_, finding_index): history_backfill_finding => ({
            kind: 'knowledge',
            title: `Candidate ${chunk_index}-${finding_index}`,
            summary: `Summary ${chunk_index}-${finding_index}`,
            body: `Body ${chunk_index}-${finding_index}`,
            importance: 0.5,
            is_major: false,
            evidence: [{
                chunk_index,
                turn_index: part.turn_index,
                part_index: part.part_index,
            }],
        }));
        value.service.submit_chunk(worker, claim.lease_id, claim.chunk.chunk_hash, findings);
    }
    const expected_candidates = run.chunk_count * 24;
    assert.equal(value.service.status('project-a', run.run_id).chunk_candidates, expected_candidates);

    const candidates = value.service.list_candidates('project-a', run.run_id, {
        stage: 'chunk', limit: 500,
    });
    const candidate_by_id = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
    const expected_round_zero_batches = Math.ceil(expected_candidates / 64);
    let first_evidence: history_backfill_finding['evidence'] | null = null;
    for (let batch = 0; batch < expected_round_zero_batches; batch++) {
        const worker = value.worker(`reduce-${batch}`, 'worker-a', 'd');
        const claim = value.service.claim_consolidation(worker, 2_000)!;
        assert.ok(count_tokens(canonicalize(claim)) <= 1_800);
        assert.equal(claim.round_index, 0);
        assert.ok(claim.input_candidate_ids.length <= 64);
        assert.equal(claim.is_final, false);
        const input = candidate_by_id.get(claim.input_candidate_ids[0]!)!;
        if (first_evidence === null) {
            first_evidence = input.finding.evidence;
        } else if (batch === 1) {
            assert.throws(() => value.service.complete_consolidation(worker, claim.lease_id, [{
                ...input.finding,
                evidence: first_evidence!,
            }]), /outside its reduction inputs/i);
        }
        value.service.complete_consolidation(worker, claim.lease_id, [{
            ...input.finding,
            title: `Reduction result ${batch}`,
        }]);
    }

    const final_worker = value.worker('reduce-final', 'worker-a', 'e');
    const final_claim = value.service.claim_consolidation(final_worker, 2_000)!;
    assert.equal(final_claim.round_index, 1);
    assert.equal(final_claim.is_final, true);
    assert.equal(final_claim.input_candidate_ids.length, expected_round_zero_batches);
    const reduction_outputs = value.service.list_candidates('project-a', run.run_id, {
        stage: 'consolidated', limit: 100,
    });
    const final_input = reduction_outputs.find((candidate) => final_claim.input_candidate_ids.includes(candidate.candidate_id))!;
    value.service.complete_consolidation(final_worker, final_claim.lease_id, [{
        ...final_input.finding,
        title: 'Final governed candidate',
    }]);
    const status = value.service.status('project-a', run.run_id);
    assert.equal(status.run.status, 'candidates_ready');
    assert.equal(status.run.consolidated_candidate_count, 1);
    const formal_count = value.store.database.prepare(`SELECT count(*) AS count FROM cm_memories`).get() as { count: number };
    assert.equal(formal_count.count, 0,
        'history queue must never publish formal memories directly');
    value.store.close();
});

test('reduction pages reconstruct canonical candidates without gaps and obey the serialized token budget', () => {
    const value = fixture();
    value.service.create_run({
        session: session('paged-reduction', [{ role: 'user', text: 'Exact source for the paged candidate.' }]),
        evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    const extraction_worker = value.worker('paged-extract');
    const extraction = value.service.claim_next(extraction_worker, 2_000)!;
    const large_finding = finding_for(extraction, {
        title: 'Unicode-safe paged candidate',
        summary: 'The complete candidate must survive deterministic transport pagination.',
        body: '中文🙂 precise durable context — '.repeat(24),
    });
    value.service.submit_chunk(
        extraction_worker, extraction.lease_id, extraction.chunk.chunk_hash, [large_finding],
    );
    const candidates = value.service.list_candidates('project-a', extraction.run.run_id, {
        stage: 'chunk', limit: 10,
    });
    assert.equal(candidates.length, 1);

    const reduction_worker = value.worker('paged-reduce', 'worker-a', 'd');
    const claim = value.service.claim_consolidation(reduction_worker, 2_000)!;
    assert.equal(claim.input_candidate_ids.length, 1);
    const collected: history_reduction_page_item[] = [];
    let cursor = 0;
    for (let page_index = 0; page_index < 10_000; page_index++) {
        const page = value.service.reduction_page(reduction_worker, claim.lease_id, cursor, 128);
        assert.deepEqual(
            value.service.reduction_page(reduction_worker, claim.lease_id, cursor, 128),
            page,
            'the same cursor and budget must return the same page',
        );
        assert.equal(page.run_id, claim.run.run_id);
        assert.equal(page.reduction_id, claim.reduction_id);
        assert.equal(page.cursor, cursor);
        assert.ok(page.items.length > 0);
        assert.ok(count_tokens(canonicalize(page)) <= 128,
            'the final canonical DTO must fit the requested token budget');
        collected.push(...page.items);
        if (page.next_cursor === null) break;
        assert.equal(page.next_cursor, cursor + page.items.length);
        assert.ok(page.next_cursor > cursor, 'next_cursor must advance monotonically');
        cursor = page.next_cursor;
        assert.ok(page_index < 9_999, 'pagination must terminate');
    }

    const candidate = candidates[0]!;
    assert.ok(collected.length > 1, 'a large candidate must be split into multiple transport fragments');
    assert.ok(collected.every((item) => item.candidate_id === candidate.candidate_id));
    assert.deepEqual(
        collected.map((item) => item.fragment_index),
        collected.map((_, index) => index),
        'fragment indexes must have no overlaps or gaps',
    );
    assert.ok(collected.every((item) => item.fragment_count === collected.length));
    for (const item of collected) {
        for (let index = 0; index < item.fragment_text.length; index++) {
            const code = item.fragment_text.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = item.fragment_text.charCodeAt(index + 1);
                assert.ok(next >= 0xdc00 && next <= 0xdfff, 'a fragment cannot end with a lone high surrogate');
                index++;
            } else {
                assert.ok(code < 0xdc00 || code > 0xdfff, 'a fragment cannot start with a lone low surrogate');
            }
        }
    }
    const reconstructed = collected.map((item) => item.fragment_text).join('');
    assert.equal(reconstructed, canonicalize({
        candidate_id: candidate.candidate_id,
        finding: candidate.finding,
        finding_hash: candidate.finding_hash,
    }));
    assert.deepEqual(JSON.parse(reconstructed), {
        candidate_id: candidate.candidate_id,
        finding: candidate.finding,
        finding_hash: candidate.finding_hash,
    });

    const terminal_cursor = collected.length;
    const terminal = value.service.reduction_page(reduction_worker, claim.lease_id, terminal_cursor, 128);
    assert.deepEqual(terminal.items, []);
    assert.equal(terminal.next_cursor, null);
    assert.ok(count_tokens(canonicalize(terminal)) <= 128);
    assert.throws(
        () => value.service.reduction_page(reduction_worker, claim.lease_id, terminal_cursor + 1, 128),
        /cursor is beyond/i,
    );
    assert.throws(
        () => value.service.reduction_page(
            value.worker('wrong-project-page', 'worker-b', 'e'), claim.lease_id, 0, 1_400,
        ),
        /scope|stale|expired/i,
    );
    value.service.complete_consolidation(reduction_worker, claim.lease_id, [candidate.finding]);
    assert.throws(
        () => value.service.reduction_page(reduction_worker, claim.lease_id, 0, 1_400),
        /stale|expired|scope/i,
    );
    value.store.close();
});

test('database triggers reject forged completion states and mutable source snapshots', () => {
    const value = fixture();
    const run = value.service.create_run({
        session: session('trigger'), evidence: evidence(), project_id: 'project-a', max_chunk_tokens: 256,
    });
    assert.throws(() => value.store.database.prepare(`UPDATE cm_history_backfill_runs
        SET status='ready_for_consolidation', completed_chunks=chunk_count WHERE tenant_id='tenant'
          AND user_id='user' AND run_id=?`).run(run.run_id), /every chunk|completed/i);
    assert.throws(() => value.store.database.prepare(`UPDATE cm_history_backfill_chunks
        SET status='completed', result_hash=?, receipt_id='forged', completed_at=2
        WHERE tenant_id='tenant' AND user_id='user' AND run_id=? AND chunk_index=0`)
        .run(digest('f'), run.run_id), /receipt/i);
    assert.throws(() => value.store.database.prepare(`UPDATE cm_history_backfill_runs
        SET session_snapshot_json='{}' WHERE tenant_id='tenant' AND user_id='user' AND run_id=?`)
        .run(run.run_id), /immutable/i);
    value.store.close();
});

test('real complete Codex authorization evidence can create an immutable queue run', () => {
    const value = fixture();
    const parsed = session('authorized');
    const reconciliation: source_reconciliation = {
        source_files: 1, importable_tasks: 1, empty_tasks: 0, parse_failures: 0,
        excluded_tasks: 0, partial_tasks: 0,
        empty: [], failures: [], excluded: [], partial: [],
    };
    const loaded: history_inventory_load = {
        inventory: build_history_inventory([parsed], 'codex', reconciliation),
        discovered: 1,
        selected: 1,
        complete_source_scan: true,
        parse_failures: [],
        reconciliation,
        sessions: [parsed],
        deferred_source_files: 0,
    };
    const manifest: history_override_manifest = {
        schema_version: history_override_schema,
        source_harness: 'codex',
        inventory_id: loaded.inventory.inventory_id,
        cwd_overrides: [{ cwd: parsed.cwd, project_id: 'project-a', confirmed: true }],
        session_overrides: [],
    };
    const authorization = authorize_codex_history_import(
        loaded, manifest, ['authorized'], 'project-a', 'D:\\memory\\central.db',
    );
    const run = value.service.create_run({
        session: authorization.sessions[0]!,
        evidence: authorization.evidence,
        project_id: 'project-a',
        max_chunk_tokens: 256,
    });
    assert.equal(run.reconciliation_digest, authorization.evidence.reconciliation_digest);
    assert.equal(run.manifest_hash, authorization.evidence.manifest_hash);
    assert.equal(run.project_id, 'project-a');
    value.store.close();
});
