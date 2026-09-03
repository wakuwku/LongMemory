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
 *  file  : src/stores/sqlite/history_publication_hardening.test.ts
 *  usage : tests the LongMemory history publication hardening component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { apply_migrations, migrations } from './migrations.js';
import { SqliteStore } from './sqlite_store.js';

const scope = { tenant: 'tenant', user: 'user' } as const;
const digest = (value: string): string => value.repeat(64).slice(0, 64);

type db = Database.Database;

function seed_projects(database: db): void {
    for (const project of ['project-a', 'project-b']) {
        database.prepare(`INSERT INTO cm_projects (
            tenant_id, user_id, project_id, name, description, status,
            metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', 'active', '{}', 1, 1)`)
            .run(scope.tenant, scope.user, project, project);
        database.prepare(`INSERT INTO cm_threads (
            tenant_id, user_id, thread_id, project_id, role_id, task_id,
            responsibility, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'publication worker', 'active', '{}', 1, 1)`)
            .run(scope.tenant, scope.user, `worker-${project.at(-1)}`, project);
    }
}

type seeded_candidate = {
    run_id: string;
    candidate_id: string;
    publication_id: string;
    receipt_id: string;
    finding_hash: string;
    evidence_json: string;
};

function insert_consolidation_turn_claim(
    database: db,
    input: {
        run_id: string;
        reduction_id: string;
        lease_id: string;
        worker_turn_id: string;
        capability_epoch_hash: string;
        at: number;
    },
): void {
    database.prepare(`INSERT INTO cm_history_backfill_turn_usage (
        tenant_id, user_id, worker_session_id, worker_turn_id, project_id,
        worker_id, capability_epoch_hash, operation_kind, run_id, chunk_index,
        reduction_id, lease_id, lease_expires_at, status, claimed_at,
        consumed_at, expired_at, updated_at
    ) VALUES (?, ?, 'worker-a', ?, 'project-a', 'worker', ?, 'consolidation',
        ?, NULL, ?, ?, ?, 'active', ?, NULL, NULL, ?)`)
        .run(
            scope.tenant,
            scope.user,
            input.worker_turn_id,
            input.capability_epoch_hash,
            input.run_id,
            input.reduction_id,
            input.lease_id,
            input.at + 100,
            input.at,
            input.at,
        );
}

function insert_run(
    database: db,
    suffix: string,
    options: { session?: string; observed_at?: number; status?: 'candidates_ready' | 'consolidating' } = {},
): seeded_candidate {
    const run_id = `run-${suffix}`;
    const reduction_id = `reduction-${suffix}`;
    const receipt_id = `receipt-${suffix}`;
    const candidate_id = `candidate-${suffix}`;
    const publication_id = `history-publication:${candidate_id}`;
    const session = options.session ?? `session-${suffix}`;
    const observed = options.observed_at ?? 10;
    const status = options.status ?? 'candidates_ready';
    const source_revision = digest(suffix);
    const finding_hash = digest(`f${suffix}`);
    const evidence_json = JSON.stringify({
        source_harness: 'codex', source_session_id: session, source_revision,
        references: [{ chunk_index: 0, turn_index: 0, part_index: 0 }],
    });
    const consolidating = status === 'consolidating';
    database.prepare(`INSERT INTO cm_history_backfill_runs (
        tenant_id, user_id, run_id, project_id, source_harness, source_session_id,
        source_revision, source_observed_at, inventory_id, reconciliation_digest,
        plan_id, manifest_hash, target_db_path, authorization_json, authorization_hash,
        session_snapshot_json, snapshot_hash, chunk_size_chars, chunk_size_tokens,
        chunk_count, total_chars, completed_chunks, status,
        consolidation_lease_id, consolidation_reduction_id, consolidation_worker_id,
        consolidation_worker_session_id, consolidation_worker_turn_id,
        consolidation_capability_epoch_hash, consolidation_leased_at,
        consolidation_lease_expires_at, consolidation_result_hash,
        consolidation_receipt_id, consolidated_candidate_count,
        created_at, updated_at, candidates_ready_at
    ) VALUES (?, ?, ?, 'project-a', 'codex', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?,
        256, 256, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.tenant, scope.user, run_id, session, source_revision, observed,
            `inventory-${suffix}`, digest('r'), `plan-${suffix}`, digest('m'),
            `db-${suffix}`, digest('a'), digest('s'), status,
            consolidating ? `run-lease-${suffix}` : null,
            consolidating ? reduction_id : null,
            consolidating ? 'worker' : null,
            consolidating ? 'worker-a' : null,
            consolidating ? `turn-${suffix}` : null,
            consolidating ? digest('c') : null,
            consolidating ? observed : null,
            consolidating ? observed + 100 : null,
            consolidating ? null : digest('z'),
            consolidating ? null : receipt_id,
            consolidating ? 0 : 1,
            observed, observed, consolidating ? null : observed);
    database.prepare(`INSERT INTO cm_history_backfill_reductions (
        tenant_id, user_id, reduction_id, run_id, round_index, batch_index, is_final,
        input_candidate_ids_json, allowed_evidence_json, input_hash, input_count,
        status, available_at, result_hash, receipt_id, output_count,
        created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 0, 0, 1, '[]', '[]', ?, 0,
        'completed', ?, ?, ?, 1, ?, ?, ?)`)
        .run(scope.tenant, scope.user, reduction_id, run_id, digest('i'), observed,
            digest('z'), receipt_id, observed, observed, observed);
    insert_consolidation_turn_claim(database, {
        run_id,
        reduction_id,
        lease_id: `lease-${suffix}`,
        worker_turn_id: `turn-${suffix}`,
        capability_epoch_hash: digest('c'),
        at: observed,
    });
    database.prepare(`INSERT INTO cm_history_backfill_receipts (
        tenant_id, user_id, receipt_id, run_id, operation_kind, operation_key,
        chunk_index, reduction_id, lease_id, worker_id, worker_session_id,
        worker_turn_id, capability_epoch_hash, input_hash, result_hash,
        candidate_count, payload_json, created_at
    ) VALUES (?, ?, ?, ?, 'consolidation', ?, NULL, ?, ?, 'worker', 'worker-a', ?, ?, ?, ?, 1, '{}', ?)`)
        .run(scope.tenant, scope.user, receipt_id, run_id, reduction_id, reduction_id,
            `lease-${suffix}`, `turn-${suffix}`, digest('c'), digest('i'), digest('z'), observed);
    database.prepare(`INSERT INTO cm_history_backfill_candidates (
        tenant_id, user_id, candidate_id, run_id, stage, source_chunk_index,
        reduction_id, finding_index, finding_kind, title, summary, body,
        importance, is_major, evidence_json, finding_json, finding_hash,
        receipt_id, created_at
    ) VALUES (?, ?, ?, ?, 'consolidated', NULL, ?, 0, 'knowledge',
        'title', 'summary', 'body', 0.8, 0, ?, '{}', ?, ?, ?)`)
        .run(scope.tenant, scope.user, candidate_id, run_id, reduction_id,
            evidence_json, finding_hash, receipt_id, observed);
    return { run_id, candidate_id, publication_id, receipt_id, finding_hash, evidence_json };
}

function insert_intermediate(database: db, run: seeded_candidate, suffix: string): seeded_candidate {
    const reduction_id = `reduction-intermediate-${suffix}`;
    const receipt_id = `receipt-intermediate-${suffix}`;
    const candidate_id = `candidate-intermediate-${suffix}`;
    const finding_hash = digest(`x${suffix}`);
    const batch_index = [...suffix].reduce(
        (sum, character) => sum + (character.codePointAt(0) ?? 0),
        0,
    );
    database.prepare(`INSERT INTO cm_history_backfill_reductions (
        tenant_id, user_id, reduction_id, run_id, round_index, batch_index, is_final,
        input_candidate_ids_json, allowed_evidence_json, input_hash, input_count,
        status, available_at, result_hash, receipt_id, output_count,
        created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 1, ?, 0, '[]', '[]', ?, 0,
        'completed', 20, ?, ?, 1, 20, 20, 20)`)
        .run(scope.tenant, scope.user, reduction_id, run.run_id,
            batch_index, digest('j'), digest('y'), receipt_id);
    insert_consolidation_turn_claim(database, {
        run_id: run.run_id,
        reduction_id,
        lease_id: `lease-intermediate-${suffix}`,
        worker_turn_id: `turn-intermediate-${suffix}`,
        capability_epoch_hash: digest('c'),
        at: 20,
    });
    database.prepare(`INSERT INTO cm_history_backfill_receipts (
        tenant_id, user_id, receipt_id, run_id, operation_kind, operation_key,
        chunk_index, reduction_id, lease_id, worker_id, worker_session_id,
        worker_turn_id, capability_epoch_hash, input_hash, result_hash,
        candidate_count, payload_json, created_at
    ) VALUES (?, ?, ?, ?, 'consolidation', ?, NULL, ?, ?, 'worker', 'worker-a', ?, ?, ?, ?, 1, '{}', 20)`)
        .run(scope.tenant, scope.user, receipt_id, run.run_id, reduction_id,
            reduction_id, `lease-intermediate-${suffix}`, `turn-intermediate-${suffix}`,
            digest('c'), digest('j'), digest('y'));
    database.prepare(`INSERT INTO cm_history_backfill_candidates (
        tenant_id, user_id, candidate_id, run_id, stage, source_chunk_index,
        reduction_id, finding_index, finding_kind, title, summary, body,
        importance, is_major, evidence_json, finding_json, finding_hash,
        receipt_id, created_at
    ) VALUES (?, ?, ?, ?, 'consolidated', NULL, ?, 0, 'knowledge',
        'intermediate', 'intermediate', 'intermediate', 0.5, 0, ?, '{}', ?, ?, 20)`)
        .run(scope.tenant, scope.user, candidate_id, run.run_id, reduction_id,
            run.evidence_json, finding_hash, receipt_id);
    return {
        run_id: run.run_id, candidate_id,
        publication_id: `history-publication:${candidate_id}`,
        receipt_id, finding_hash, evidence_json: run.evidence_json,
    };
}

function insert_pending_publication(database: db, candidate: seeded_candidate, at = 20): void {
    database.prepare(`INSERT INTO cm_history_publications (
        tenant_id, user_id, publication_id, run_id, candidate_id, status,
        available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(scope.tenant, scope.user, candidate.publication_id,
            candidate.run_id, candidate.candidate_id, at, at, at);
}

function install_legacy_candidate_scope(database: db): void {
    database.exec(`DROP TRIGGER cm_history_publications_candidate_scope;
        CREATE TRIGGER cm_history_publications_candidate_scope
        BEFORE INSERT ON cm_history_publications
        WHEN NOT EXISTS (
            SELECT 1 FROM cm_history_backfill_candidates AS candidate
            JOIN cm_history_backfill_runs AS run
              ON run.tenant_id=candidate.tenant_id AND run.user_id=candidate.user_id
             AND run.run_id=candidate.run_id
            WHERE candidate.tenant_id=NEW.tenant_id AND candidate.user_id=NEW.user_id
              AND candidate.candidate_id=NEW.candidate_id AND candidate.run_id=NEW.run_id
              AND candidate.stage='consolidated' AND run.status='candidates_ready'
        ) BEGIN SELECT RAISE(ABORT, 'legacy candidate scope'); END;`);
}

test('fresh schema rejects intermediate candidates and forged initial states, and supersedes an older run', () => {
    const store = new SqliteStore(':memory:', {
        tenant_id: scope.tenant, user_id: scope.user, startup_integrity_check: false,
    });
    seed_projects(store.database);
    const first = insert_run(store.database, 'a', { session: 'shared-session', observed_at: 10 });
    insert_pending_publication(store.database, first, 10);
    const intermediate = insert_intermediate(store.database, first, 'a');
    assert.throws(() => insert_pending_publication(store.database, intermediate), /final candidate|latest final/i);

    const forged = insert_run(store.database, 'b', { observed_at: 11 });
    assert.throws(() => store.database.prepare(`INSERT INTO cm_history_publications (
        tenant_id, user_id, publication_id, run_id, candidate_id, status,
        available_at, created_at, updated_at, terminal_at
    ) VALUES (?, ?, ?, ?, ?, 'discarded', 11, 11, 11, 11)`)
        .run(scope.tenant, scope.user, forged.publication_id, forged.run_id, forged.candidate_id),
    /pristine pending/i);

    const newer = insert_run(store.database, 'c', {
        session: 'shared-session', observed_at: 30, status: 'consolidating',
    });
    store.database.prepare(`UPDATE cm_history_backfill_runs SET
        status='candidates_ready', consolidation_lease_id=NULL,
        consolidation_reduction_id=NULL, consolidation_worker_id=NULL,
        consolidation_worker_session_id=NULL, consolidation_worker_turn_id=NULL,
        consolidation_capability_epoch_hash=NULL, consolidation_leased_at=NULL,
        consolidation_lease_expires_at=NULL, consolidation_result_hash=?,
        consolidation_receipt_id=?, consolidated_candidate_count=1,
        candidates_ready_at=30, updated_at=30
        WHERE tenant_id=? AND user_id=? AND run_id=?`)
        .run(digest('z'), newer.receipt_id, scope.tenant, scope.user, newer.run_id);
    const old_status = store.database.prepare(`SELECT status FROM cm_history_publications
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .get(scope.tenant, scope.user, first.publication_id) as { status: string };
    assert.equal(old_status.status, 'superseded');
    const new_status = store.database.prepare(`SELECT status FROM cm_history_publications
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .get(scope.tenant, scope.user, newer.publication_id) as { status: string };
    assert.equal(new_status.status, 'pending');
    store.close();
});

test('direct SQL cannot cross worker, proposal, plan, semantic-memory, or attempt scopes', () => {
    const store = new SqliteStore(':memory:', {
        tenant_id: scope.tenant, user_id: scope.user, startup_integrity_check: false,
    });
    seed_projects(store.database);
    const seeded = insert_run(store.database, 'scope');
    insert_pending_publication(store.database, seeded);
    const proposal_sql = `INSERT INTO cm_history_hierarchy_proposals (
        tenant_id, user_id, proposal_id, publication_id, run_id, candidate_id,
        scope_kind, proposed_level, role_mode, role_id, role_semantic_key,
        role_name, role_responsibility, task_mode, task_id, task_semantic_key,
        task_title, task_objective, confidence, evidence_json, proposal_hash,
        worker_session_id, worker_turn_id, capability_epoch_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'candidate_full', 1, 'none', NULL, NULL,
        NULL, NULL, 'none', NULL, NULL, NULL, NULL, 1, ?, ?, ?, 'turn', ?, 20)`;
    assert.throws(() => store.database.prepare(proposal_sql).run(
        scope.tenant, scope.user, 'proposal-wrong-worker', seeded.publication_id,
        seeded.run_id, seeded.candidate_id, JSON.stringify(JSON.parse(seeded.evidence_json).references),
        digest('p'), 'worker-b', digest('c')),
    /outside its publication scope/i);
    store.database.prepare(proposal_sql).run(
        scope.tenant, scope.user, 'proposal-valid', seeded.publication_id,
        seeded.run_id, seeded.candidate_id, JSON.stringify(JSON.parse(seeded.evidence_json).references),
        digest('q'), 'worker-a', digest('c'));
    store.database.prepare(`UPDATE cm_history_publications SET status='ready', updated_at=21
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .run(scope.tenant, scope.user, seeded.publication_id);

    const other = insert_run(store.database, 'other');
    insert_pending_publication(store.database, other);
    assert.throws(() => store.database.prepare(`INSERT INTO cm_history_governance_decisions (
        tenant_id, user_id, decision_id, publication_id, proposal_id, plan_version,
        action, actor_kind, actor_id, action_id, channel, evidence_json, note,
        payload_hash, created_at
    ) VALUES (?, ?, 'decision-cross', ?, 'proposal-valid', NULL,
        'accept_hierarchy', 'user', 'actor', 'action-cross', 'codex_ui', '{"ok":true}', '', ?, 22)`)
        .run(scope.tenant, scope.user, other.publication_id, digest('d')),
    /foreign key|selector/i);

    const semantic_hash = digest('1');
    const target_memory = `cm-semantic:${semantic_hash.slice(0, 40)}`;
    const plan_sql = `INSERT INTO cm_history_publication_plans (
        tenant_id, user_id, publication_id, plan_version, project_id, proposal_id,
        hierarchy_decision_id, level, role_id, task_id, memory_kind,
        semantic_key_normalized, semantic_identity_hash, target_memory_id,
        expected_memory_exists, expected_current_version, expected_current_status,
        expected_current_content_hash, relation, conflicts_json, candidate_finding_hash,
        publication_content_hash, is_major, plan_hash, created_by_session_id,
        created_by_turn_id, capability_epoch_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, 'proposal-valid', NULL, 1, NULL, NULL,
        'knowledge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'turn', ?, 23)`;
    store.database.prepare(plan_sql).run(
        scope.tenant, scope.user, seeded.publication_id, 1, 'project-a',
        'semantic-key', semantic_hash, target_memory, 0, null, null, null,
        'new', '[]', seeded.finding_hash, digest('v'), digest('h'), 'worker-a', digest('c'));
    assert.throws(() => store.database.prepare(plan_sql).run(
        scope.tenant, scope.user, seeded.publication_id, 2, 'project-b',
        'semantic-key-2', digest('2'), `cm-semantic:${digest('2').slice(0, 40)}`,
        0, null, null, null, 'new', '[]', seeded.finding_hash,
        digest('w'), digest('k'), 'worker-b', digest('d')),
    /immutable scope|foreign key/i);
    assert.throws(() => store.database.prepare(plan_sql).run(
        scope.tenant, scope.user, seeded.publication_id, 2, 'project-a',
        'semantic-key-2', digest('2'), `cm-semantic:${digest('2').slice(0, 40)}`,
        1, 1, 'active', digest('e'), 'update', '[{}]', seeded.finding_hash,
        digest('w'), digest('l'), 'worker-a', digest('c')),
    /CAS snapshot/i);

    store.database.prepare(`INSERT INTO cm_memories (
        tenant_id, user_id, memory_id, project_id, role_id, task_id, level,
        memory_kind, title, current_version, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'project-a', NULL, NULL, 1, 'knowledge', 'title', NULL, '{}', 24, 24)`)
        .run(scope.tenant, scope.user, target_memory);
    store.database.prepare(`INSERT INTO cm_semantic_memory_keys (
        tenant_id, user_id, project_id, semantic_identity_hash, level, role_id,
        task_id, memory_kind, semantic_key_normalized, memory_id, is_canonical, created_at
    ) VALUES (?, ?, 'project-a', ?, 1, NULL, NULL, 'knowledge', 'semantic-key', ?, 1, 24)`)
        .run(scope.tenant, scope.user, semantic_hash, target_memory);
    assert.throws(() => store.database.prepare(`INSERT INTO cm_semantic_memory_keys (
        tenant_id, user_id, project_id, semantic_identity_hash, level, role_id,
        task_id, memory_kind, semantic_key_normalized, memory_id, is_canonical, created_at
    ) VALUES (?, ?, 'project-a', ?, 1, NULL, NULL, 'knowledge', 'semantic-key', ?, 0, 25)`)
        .run(scope.tenant, scope.user, digest('3'), target_memory), /UNIQUE constraint/i);

    store.database.prepare(`UPDATE cm_history_publications
        SET current_plan_version=1, updated_at=25
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .run(scope.tenant, scope.user, seeded.publication_id);
    assert.throws(() => store.database.prepare(`INSERT INTO cm_history_publication_attempts (
        tenant_id, user_id, attempt_id, publication_id, plan_version,
        worker_session_id, worker_turn_id, capability_epoch_hash, request_hash,
        outcome, result_memory_id, result_version, result_confirmation_id,
        error_code, error_detail, created_at
    ) VALUES (?, ?, 'attempt-wrong-worker', ?, 1, 'worker-b', 'turn', ?, ?,
        'retryable', NULL, NULL, NULL, 'ERROR', 'detail', 26)`)
        .run(scope.tenant, scope.user, seeded.publication_id, digest('d'), digest('r')),
    /current executable plan/i);
    assert.throws(() => store.database.prepare(`UPDATE cm_history_publications
        SET status='published', terminal_at=27, updated_at=27
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .run(scope.tenant, scope.user, seeded.publication_id),
    /state shape|published|terminal state lacks its scoped attempt/i);
    store.close();
});

test('a database that already recorded legacy v8 receives the same v9 final-candidate guard', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    )`);
    for (const migration of migrations().filter((value) => value.version <= 8)) {
        database.exec(migration.sql);
        database.prepare(`INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 1)`)
            .run(migration.version, migration.name);
    }
    seed_projects(database);
    const run = insert_run(database, 'legacy');
    const first_intermediate = insert_intermediate(database, run, 'legacy-a');
    const second_intermediate = insert_intermediate(database, run, 'legacy-b');
    install_legacy_candidate_scope(database);
    insert_pending_publication(database, first_intermediate);
    assert.deepEqual(
        apply_migrations(database, 30),
        migrations().filter((value) => value.version > 8).map((value) => value.version),
    );
    const retired = database.prepare(`SELECT status FROM cm_history_publications
        WHERE tenant_id=? AND user_id=? AND publication_id=?`)
        .get(scope.tenant, scope.user, first_intermediate.publication_id) as { status: string };
    assert.equal(retired.status, 'superseded');
    assert.throws(() => insert_pending_publication(database, second_intermediate), /latest final candidate/i);
    assert.equal((database.prepare(`SELECT 1 FROM migrations WHERE version=9`).get() as unknown) !== undefined, true);
    database.close();
});

test('migration 9 refuses a terminal non-final publication and does not record the upgrade', () => {
    for (const status of ['published', 'pending_confirmation'] as const) {
        const database = new Database(':memory:');
        try {
            database.pragma('foreign_keys = ON');
            database.exec(`CREATE TABLE migrations (
                version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
            )`);
            for (const migration of migrations().filter((value) => value.version <= 8)) {
                database.exec(migration.sql);
                database.prepare(`INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, 1)`)
                    .run(migration.version, migration.name);
            }
            seed_projects(database);
            const run = insert_run(database, `guard-${status}`);
            const intermediate = insert_intermediate(database, run, `guard-${status}`);
            install_legacy_candidate_scope(database);
            insert_pending_publication(database, intermediate);

            database.exec(`DROP TRIGGER cm_history_publications_state_shape;
                DROP TRIGGER cm_history_publications_terminal_attempt_scope;
                DROP TRIGGER cm_history_publications_valid_transition;`);
            database.pragma('ignore_check_constraints = ON');
            database.prepare(`UPDATE cm_history_publications
                SET status=?, terminal_at=? WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .run(
                    status,
                    status === 'published' ? 30 : null,
                    scope.tenant,
                    scope.user,
                    intermediate.publication_id,
                );
            database.pragma('ignore_check_constraints = OFF');

            assert.throws(() => apply_migrations(database, 30), /CHECK constraint failed.*invalid/i);
            assert.equal(database.prepare(`SELECT 1 FROM migrations WHERE version=9`).get(), undefined);
            const preserved = database.prepare(`SELECT status FROM cm_history_publications
                WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .get(scope.tenant, scope.user, intermediate.publication_id) as { status: string };
            assert.equal(preserved.status, status);
        } finally {
            database.close();
        }
    }
});
