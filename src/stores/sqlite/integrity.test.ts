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
 *  file  : src/stores/sqlite/integrity.test.ts
 *  usage : tests the LongMemory integrity component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { HistoryBackfillService } from '../../core/central_memory/history_backfill_service.js';
import type {
    history_backfill_finding,
    history_chunk_claim,
    history_worker_context,
} from '../../core/central_memory/history_backfill_types.js';
import { CentralMemoryService } from '../../core/central_memory/service.js';
import { HistoryPublicationService } from '../../core/central_memory/history_publication_service.js';
import { HistoryWorkerAuthorizationService } from '../../core/central_memory/history_worker_authorization.js';
import { hash_canonical } from '../../core/hash/content_hash.js';
import { check_sqlite_integrity } from './integrity.js';
import { migrations } from './migrations.js';
import { SqliteStore } from './sqlite_store.js';

const digest = (character: string): string => character.repeat(64);

type published_fixture = {
    store: SqliteStore;
    publication_id: string;
};

function worker(turn: string): history_worker_context {
    return {
        worker_id: 'integrity-history-agent',
        worker_session_id: 'integrity-worker',
        worker_turn_id: turn,
        capability_epoch_hash: digest('c'),
    };
}

function finding_for(claim: history_chunk_claim): history_backfill_finding {
    const part = claim.chunk.source_parts[0]!;
    return {
        kind: 'knowledge',
        title: '可复用的历史知识',
        summary: '历史任务确认了一项准确且可复用的事实。',
        body: '完整条件和采用原因已经由历史证据确认，可用于之后的同类任务。',
        importance: 0.8,
        is_major: false,
        evidence: [{
            chunk_index: claim.chunk.chunk_index,
            turn_index: part.turn_index,
            part_index: part.part_index,
        }],
    };
}

function make_published_fixture(): published_fixture {
    const now = { value: 1_000 };
    const store = new SqliteStore(':memory:', {
        tenant_id: 'tenant',
        user_id: 'user',
        now: () => now.value,
        startup_integrity_check: false,
    });
    store.central_memory.register_project({ project_id: 'project-a', name: 'Project A', at: 1 });
    store.central_memory.register_thread({
        thread_id: 'integrity-worker',
        project_id: 'project-a',
        responsibility: 'history integrity test worker',
        at: 1,
    });
    new HistoryWorkerAuthorizationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
    }).authorize({
        project_id: 'project-a',
        worker_session_id: 'integrity-worker',
        worker_id: 'integrity-history-agent',
        actor_id: 'test-human',
        action_id: 'test-authorize:integrity-worker',
        evidence: { source: 'integrity_test_fixture' },
        at: 1,
    });
    const backfill = new HistoryBackfillService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
        capability_guard: () => undefined,
    });
    const publication = new HistoryPublicationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
        capability_guard: () => undefined,
    });

    now.value += 10;
    const run = backfill.create_run({
        session: {
            schema_version: '1.0.0',
            source_harness: 'codex',
            source_session_id: 'integrity-history',
            source_path: 'C:\\codex\\integrity-history.jsonl',
            cwd: 'D:\\work\\project-a',
            title: 'History integrity fixture',
            created_at: 1,
            updated_at: now.value,
            turns: [
                { role: 'user', text: '请保留已经核对的完整条件。' },
                { role: 'assistant', text: '已经完成并核对准确性。' },
            ],
            dropped_turns: 0,
            source_metadata: { parser: 'integrity-test' },
        },
        evidence: {
            inventory_id: 'inventory:integrity-history',
            reconciliation_digest: digest('a'),
            plan_id: 'plan:integrity-history',
            manifest_hash: digest('b'),
            target_db_path: 'D:\\memory\\central.db',
            target_project_id: 'project-a',
        },
        project_id: 'project-a',
        max_chunk_tokens: 256,
    });
    const extract_worker = worker('extract');
    const claim = backfill.claim_next(extract_worker, 5_000)!;
    const finding = finding_for(claim);
    backfill.submit_chunk(extract_worker, claim.lease_id, claim.chunk.chunk_hash, [finding]);
    const reduce_worker = worker('reduce');
    const reduction = backfill.claim_consolidation(reduce_worker, 5_000)!;
    assert.equal(reduction.is_final, true);
    backfill.complete_consolidation(reduce_worker, reduction.lease_id, [finding]);
    assert.equal(backfill.status('project-a', run.run_id).run.status, 'candidates_ready');

    const publications = publication.list('project-a').filter((item) => item.run_id === run.run_id);
    assert.equal(publications.length, 1);
    const publication_id = publications[0]!.publication_id;
    const proposal = publication.propose_hierarchy({
        publication_id,
        level: 4,
        role: {
            mode: 'proposed',
            semantic_key: 'novel illustration',
            name: '小说作画',
            responsibility: '为小说持续制作和改进插画',
        },
        task: {
            mode: 'proposed',
            semantic_key: 'learned rendering practice',
            title: '作画经验沉淀',
            objective: '将作画学习结论提供给实际绘图任务',
        },
        confidence: 0.9,
    }, worker('proposal'));
    publication.decide({
        publication_id,
        proposal_id: proposal.proposal_id,
        action: 'accept_hierarchy',
        actor_id: 'local-user',
        actor_kind: 'user',
        action_id: 'integrity:accept-hierarchy',
        channel: 'codex_ui',
        evidence: { confirmed_in_current_task: true },
    });
    const plan = publication.create_plan({
        publication_id,
        proposal_id: proposal.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'reproducible illustration settings',
    }, worker('plan'));
    const result = publication.execute({
        publication_id,
        plan_version: plan.plan_version,
        attempt_id: 'integrity:attempt',
    }, worker('execute'));
    assert.equal(result.publication.status, 'published');
    assert.equal(result.attempt.outcome, 'created');
    return { store, publication_id };
}

function remove_immutable_guards(database: Database.Database): void {
    database.pragma('foreign_keys=OFF');
    database.pragma('ignore_check_constraints=ON');
    const protected_tables = [
        'cm_history_publications',
        'cm_history_hierarchy_proposals',
        'cm_history_governance_decisions',
        'cm_history_publication_plans',
        'cm_semantic_memory_keys',
        'cm_history_publication_attempts',
    ];
    const placeholders = protected_tables.map(() => '?').join(', ');
    const triggers = database.prepare(`SELECT name FROM sqlite_master
        WHERE type='trigger' AND tbl_name IN (${placeholders})`)
        .all(...protected_tables) as Array<{ name: string }>;
    for (const { name } of triggers) {
        assert.match(name, /^[a-z0-9_]+$/i);
        database.exec(`DROP TRIGGER ${name}`);
    }
}

test('history publication integrity remains compatible with schemas before migration 8', () => {
    const database = new Database(':memory:');
    try {
        database.pragma('foreign_keys=ON');
        for (const migration of migrations().filter((item) => item.version < 8)) {
            database.exec(migration.sql);
        }
        const report = check_sqlite_integrity(database, { tenant_id: 'tenant', user_id: 'user' });
        assert.equal(report.checked_history_publications, 0);
        assert.equal(report.issues.some((issue) => issue.table.startsWith('cm_history_')), false);
    } finally {
        database.close();
    }
});

test('history publication integrity accepts a real publication and detects corruption at every layer', () => {
    const value = make_published_fixture();
    try {
        const valid = value.store.check_integrity();
        assert.equal(valid.checked_history_publications, 1);
        assert.deepEqual(valid.issues, []);

        const canonical = value.store.database.prepare(`SELECT project_id, level, role_id, task_id,
                memory_kind, memory_id FROM cm_semantic_memory_keys WHERE is_canonical=1`)
            .get() as {
                project_id: string;
                level: number;
                role_id: string | null;
                task_id: string | null;
                memory_kind: string;
                memory_id: string;
            };
        const alias_key = 'legacy illustration settings alias';
        const alias_hash = hash_canonical({
            schema: 1,
            project_id: canonical.project_id,
            level: canonical.level,
            role_id: canonical.role_id,
            task_id: canonical.task_id,
            memory_kind: canonical.memory_kind,
            semantic_key: alias_key,
        });
        value.store.database.prepare(`INSERT INTO cm_semantic_memory_keys (
            tenant_id, user_id, project_id, semantic_identity_hash, level, role_id, task_id,
            memory_kind, semantic_key_normalized, memory_id, is_canonical, created_at
        ) VALUES ('tenant', 'user', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1000)`)
            .run(canonical.project_id, alias_hash, canonical.level, canonical.role_id,
                canonical.task_id, canonical.memory_kind, alias_key, canonical.memory_id);
        assert.deepEqual(value.store.check_integrity().issues, []);

        remove_immutable_guards(value.store.database);
        value.store.database.prepare(`UPDATE cm_history_publications
            SET terminal_at=NULL WHERE publication_id=?`).run(value.publication_id);
        value.store.database.prepare(`UPDATE cm_history_hierarchy_proposals
            SET proposal_hash=? WHERE publication_id=?`).run(digest('1'), value.publication_id);
        value.store.database.prepare(`UPDATE cm_history_governance_decisions
            SET payload_hash=? WHERE publication_id=?`).run(digest('2'), value.publication_id);
        value.store.database.prepare(`UPDATE cm_history_publication_plans
            SET plan_hash=? WHERE publication_id=?`).run(digest('3'), value.publication_id);
        value.store.database.prepare(`UPDATE cm_semantic_memory_keys
            SET semantic_identity_hash=? WHERE is_canonical=1`).run(digest('4'));
        value.store.database.prepare(`UPDATE cm_history_publication_attempts
            SET outcome='retryable' WHERE publication_id=?`).run(value.publication_id);

        const corrupt = value.store.check_integrity();
        const has_issue = (table: string, code: string): boolean => corrupt.issues.some(
            (issue) => issue.table === table && issue.code === code,
        );
        assert.equal(corrupt.ok, false);
        assert.equal(has_issue('cm_history_publications', 'history_publication'), true);
        assert.equal(has_issue('cm_history_hierarchy_proposals', 'hash_mismatch'), true);
        assert.equal(has_issue('cm_history_governance_decisions', 'hash_mismatch'), true);
        assert.equal(has_issue('cm_history_publication_plans', 'hash_mismatch'), true);
        assert.equal(has_issue('cm_semantic_memory_keys', 'semantic_identity'), true);
        assert.equal(has_issue('cm_history_publication_attempts', 'history_attempt'), true);
    } finally {
        value.store.close();
    }
});

test('project-link integrity accepts governed L4 sharing and detects lifecycle and scope corruption', () => {
    const store = new SqliteStore(':memory:', {
        tenant_id: 'tenant', user_id: 'user', startup_integrity_check: false, now: () => 2_000,
    });
    try {
        const repository = store.central_memory;
        const service = new CentralMemoryService(repository);
        repository.register_project({ project_id: 'novel', name: 'Novel', at: 1 });
        repository.register_project({ project_id: 'illustration', name: 'Illustration', at: 1 });
        repository.register_role({
            role_id: 'art-research', project_id: 'illustration', name: 'Art research',
            responsibility: 'Learn reusable illustration techniques', at: 2,
        });
        repository.register_task({
            task_id: 'rendering-practice', project_id: 'illustration', role_id: 'art-research',
            title: 'Rendering practice', at: 3,
        });
        service.register_thread({
            thread_id: 'art-thread', project_id: 'illustration', role_id: 'art-research',
            task_id: 'rendering-practice', responsibility: 'Extract reusable rendering knowledge', at: 4,
        });
        service.register_thread({
            thread_id: 'novel-thread', project_id: 'novel', responsibility: 'Write the novel', at: 4,
        });
        service.publish({
            memory_id: 'rendering-rule', project_id: 'illustration', role_id: 'art-research',
            task_id: 'rendering-practice', level: 4, memory_kind: 'procedure',
            title: 'Rendering rule', summary: 'Keep reproducible render settings.',
            body: 'Record the complete seed, sampler, steps, model, dimensions, and revision reason.',
            created_by: 'art-thread', source_thread_id: 'art-thread', at: 5,
        });
        const [link] = service.link_projects({
            source_project_id: 'illustration', target_project_id: 'novel',
            decision: {
                actor_id: 'local-user', actor_kind: 'user', action_id: 'link-art-to-novel',
                channel: 'local_cli', note: 'Share only relevant L4 illustration knowledge.',
                evidence: { explicit_human_confirmation: true },
            },
            at: 6,
        });
        repository.stage_workset({
            thread_id: 'novel-thread', memory_id: 'rendering-rule', pending_version: 1,
            relevance: 0.9, origin: 'linked_project', at: 7,
        });

        const valid = store.check_integrity();
        assert.equal(valid.checked_project_links, 1);
        assert.deepEqual(valid.issues, []);

        const protected_tables = ['cm_project_links', 'cm_thread_worksets'];
        const triggers = store.database.prepare(`SELECT name FROM sqlite_master
            WHERE type='trigger' AND tbl_name IN (?, ?)`).all(...protected_tables) as Array<{ name: string }>;
        for (const { name } of triggers) {
            assert.match(name, /^[a-z0-9_]+$/i);
            store.database.exec(`DROP TRIGGER ${name}`);
        }
        store.database.prepare(`UPDATE cm_project_links SET created_evidence_json='{}'
            WHERE tenant_id='tenant' AND user_id='user' AND link_id=?`).run(link!.link_id);
        store.database.prepare(`UPDATE cm_thread_worksets SET origin='shared'
            WHERE tenant_id='tenant' AND user_id='user'
              AND thread_id='novel-thread' AND memory_id='rendering-rule'`).run();

        const corrupt = store.check_integrity();
        assert.equal(corrupt.ok, false);
        assert.equal(corrupt.issues.some((issue) => issue.table === 'cm_project_links'
            && issue.code === 'central_project_link'), true);
        assert.equal(corrupt.issues.some((issue) => issue.table === 'cm_thread_worksets'
            && issue.code === 'central_project_link'), true);
    } finally {
        store.close();
    }
});
