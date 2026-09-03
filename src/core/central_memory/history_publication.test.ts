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
 *  file  : src/core/central_memory/history_publication.test.ts
 *  usage : tests the LongMemory history publication component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { CentralMemoryRepository } from '../../stores/sqlite/central_memory_repository.js';
import { CentralMemoryService } from './service.js';
import { HistoryBackfillService } from './history_backfill_service.js';
import type {
    history_backfill_finding,
    history_chunk_claim,
    history_worker_context,
} from './history_backfill_types.js';
import { HistoryPublicationService } from './history_publication_service.js';
import { HistoryWorkerAuthorizationService } from './history_worker_authorization.js';

const digest = (character: string): string => character.repeat(64);

type fixture = {
    store: SqliteStore;
    backfill: HistoryBackfillService;
    publication: HistoryPublicationService;
    central: CentralMemoryService;
    now: { value: number };
    worker: (turn: string, project?: 'project-a' | 'project-b') => history_worker_context;
};

const make_fixture = (): fixture => {
    const now = { value: 1_000 };
    const store = new SqliteStore(':memory:', {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value, startup_integrity_check: false,
    });
    for (const project_id of ['project-a', 'project-b']) {
        store.central_memory.register_project({ project_id, name: project_id, at: 1 });
        store.central_memory.register_thread({
            thread_id: `worker-${project_id.at(-1)}`,
            project_id,
            responsibility: 'history publication worker',
            at: 1,
        });
    }
    const authorizations = new HistoryWorkerAuthorizationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
    });
    for (const project_id of ['project-a', 'project-b'] as const) {
        const worker_session_id = `worker-${project_id.at(-1)}`;
        authorizations.authorize({
            project_id,
            worker_session_id,
            worker_id: 'history-agent',
            actor_id: 'test-human',
            action_id: `test-authorize:${worker_session_id}`,
            evidence: { source: 'history_publication_test_fixture' },
            at: 1,
        });
    }
    const guard = (worker: history_worker_context): void => {
        if (worker.capability_epoch_hash === digest('0')) throw new Error('stale publication capability');
    };
    const backfill = new HistoryBackfillService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value, capability_guard: guard,
    });
    const publication = new HistoryPublicationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value, capability_guard: guard,
    });
    const central = new CentralMemoryService(new CentralMemoryRepository(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
    }));
    return {
        store,
        backfill,
        publication,
        central,
        now,
        worker: (turn, project = 'project-a') => ({
            worker_id: 'history-agent',
            worker_session_id: `worker-${project.at(-1)}`,
            worker_turn_id: turn,
            capability_epoch_hash: digest(project === 'project-a' ? 'c' : 'd'),
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
        title: '可复用的历史知识',
        summary: '历史任务确定了一项准确且可复用的事实。',
        body: '完整条件和采用原因已经由历史证据确认，可用于之后的同类任务。',
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

const seed_candidate = (
    value: fixture,
    session_id: string,
    overrides: Partial<history_backfill_finding> = {},
): { publication_id: string; finding: history_backfill_finding } => {
    value.now.value += 10;
    const run = value.backfill.create_run({
        session: {
            schema_version: '1.0.0',
            source_harness: 'codex',
            source_session_id: session_id,
            source_path: `C:\\codex\\${session_id}.jsonl`,
            cwd: 'D:\\work\\project-a',
            title: `History ${session_id}`,
            created_at: 1,
            updated_at: value.now.value,
            turns: [
                { role: 'user', text: `请保留 ${session_id} 中确定的完整条件。` },
                { role: 'assistant', text: '已经完成并核对准确性。' },
            ],
            dropped_turns: 0,
            source_metadata: { parser: 'publication-test' },
        },
        evidence: {
            inventory_id: `inventory:${session_id}`,
            reconciliation_digest: digest('a'),
            plan_id: `plan:${session_id}`,
            manifest_hash: digest('b'),
            target_db_path: 'D:\\memory\\central.db',
            target_project_id: 'project-a',
        },
        project_id: 'project-a',
        max_chunk_tokens: 256,
    });
    const extract_worker = value.worker(`${session_id}:extract`);
    const claim = value.backfill.claim_next(extract_worker, 5_000)!;
    const finding = finding_for(claim, overrides);
    value.backfill.submit_chunk(extract_worker, claim.lease_id, claim.chunk.chunk_hash, [finding]);
    const reduce_worker = value.worker(`${session_id}:reduce`);
    const reduction = value.backfill.claim_consolidation(reduce_worker, 5_000)!;
    assert.equal(reduction.is_final, true);
    value.backfill.complete_consolidation(reduce_worker, reduction.lease_id, [finding]);
    assert.equal(value.backfill.status('project-a', run.run_id).run.status, 'candidates_ready');
    const rows = value.publication.list('project-a').filter((item) => item.run_id === run.run_id);
    assert.equal(rows.length, 1);
    return { publication_id: rows[0]!.publication_id, finding };
};

const accept_new_hierarchy = (value: fixture, publication_id: string, suffix: string) => {
    const proposal = value.publication.propose_hierarchy({
        publication_id,
        level: 4,
        role: {
            mode: 'proposed', semantic_key: 'novel illustration',
            name: '小说作画', responsibility: '为小说持续制作和改进插画',
        },
        task: {
            mode: 'proposed', semantic_key: 'learned rendering practice',
            title: '作画经验沉淀', objective: '将作画学习结论提供给实际绘图任务',
        },
        confidence: 0.9,
    }, value.worker(`${suffix}:proposal`));
    value.publication.decide({
        publication_id,
        proposal_id: proposal.proposal_id,
        action: 'accept_hierarchy',
        actor_id: 'local-user',
        actor_kind: 'user',
        action_id: `${suffix}:accept-hierarchy`,
        channel: 'codex_ui',
        evidence: { confirmed_in_current_task: true },
    });
    return proposal;
};

test('new roles and tasks wait for human governance, then a final candidate publishes with server-derived evidence', () => {
    const value = make_fixture();
    const seeded = seed_candidate(value, 'history-new');
    const proposal = value.publication.propose_hierarchy({
        publication_id: seeded.publication_id,
        level: 4,
        role: {
            mode: 'proposed', semantic_key: 'novel illustration',
            name: '小说作画', responsibility: '为小说制作插画',
        },
        task: {
            mode: 'proposed', semantic_key: 'rendering practice',
            title: '绘画经验', objective: '复用已经验证的作画方法',
        },
        confidence: 0.91,
    }, value.worker('proposal-new'));
    assert.equal(value.publication.get(seeded.publication_id).status, 'awaiting_hierarchy');
    const role_count = value.store.database.prepare(`SELECT count(*) AS count FROM cm_roles`)
        .get() as { count: number };
    assert.equal(role_count.count, 0);
    assert.throws(() => value.publication.create_plan({
        publication_id: seeded.publication_id,
        proposal_id: proposal.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'reproducible illustration settings',
    }, value.worker('plan-before-confirm')), /awaiting_hierarchy|human hierarchy decision/i);

    value.publication.decide({
        publication_id: seeded.publication_id,
        proposal_id: proposal.proposal_id,
        action: 'accept_hierarchy',
        actor_id: 'local-user',
        actor_kind: 'user',
        action_id: 'accept-new-hierarchy',
        channel: 'codex_ui',
        evidence: { confirmed_in_current_task: true },
    });
    const plan = value.publication.create_plan({
        publication_id: seeded.publication_id,
        proposal_id: proposal.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'reproducible illustration settings',
    }, value.worker('plan-new'));
    assert.equal(plan.relation, 'new');
    assert.equal(plan.target_memory_id, `cm-semantic:${plan.semantic_identity_hash.slice(0, 40)}`);
    const result = value.publication.execute({
        publication_id: seeded.publication_id,
        plan_version: plan.plan_version,
        attempt_id: 'attempt-new',
    }, value.worker('publish-new'));
    assert.equal(result.publication.status, 'published');
    assert.equal(result.attempt.outcome, 'created');
    const source = value.store.database.prepare(`SELECT locator_json FROM cm_sources`).get() as { locator_json: string };
    assert.doesNotMatch(source.locator_json, /完整条件|已经完成/);
    assert.match(source.locator_json, /source_revision/);
    value.store.close();
});

test('same semantic content is a no-op that appends evidence without creating another version', () => {
    const value = make_fixture();
    const first = seed_candidate(value, 'history-noop-a');
    const hierarchy = accept_new_hierarchy(value, first.publication_id, 'noop-a');
    const first_plan = value.publication.create_plan({
        publication_id: first.publication_id,
        proposal_id: hierarchy.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'shared exact method',
    }, value.worker('noop-a:plan'));
    value.publication.execute({
        publication_id: first.publication_id,
        plan_version: first_plan.plan_version,
        attempt_id: 'noop-a:attempt',
    }, value.worker('noop-a:publish'));

    const second = seed_candidate(value, 'history-noop-b');
    const existing = value.publication.propose_hierarchy({
        publication_id: second.publication_id,
        level: 4,
        role: { mode: 'existing', role_id: hierarchy.role_id! },
        task: { mode: 'existing', task_id: hierarchy.task_id! },
        confidence: 0.95,
    }, value.worker('noop-b:proposal'));
    const plan = value.publication.create_plan({
        publication_id: second.publication_id,
        proposal_id: existing.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'shared exact method',
    }, value.worker('noop-b:plan'));
    assert.equal(plan.relation, 'noop');
    const result = value.publication.execute({
        publication_id: second.publication_id,
        plan_version: plan.plan_version,
        attempt_id: 'noop-b:attempt',
    }, value.worker('noop-b:publish'));
    assert.equal(result.attempt.outcome, 'noop');
    const versions = value.store.database.prepare(`SELECT count(*) AS count FROM cm_memory_versions
        WHERE memory_id=?`).get(plan.target_memory_id) as { count: number };
    const sources = value.store.database.prepare(`SELECT count(*) AS count FROM cm_memory_version_sources
        WHERE memory_id=?`).get(plan.target_memory_id) as { count: number };
    assert.equal(versions.count, 1);
    assert.equal(sources.count, 2);
    value.store.close();
});

test('changed content requires human approval and exact CAS prevents overwriting intervening work', () => {
    const value = make_fixture();
    const first = seed_candidate(value, 'history-cas-a');
    const hierarchy = accept_new_hierarchy(value, first.publication_id, 'cas-a');
    const initial = value.publication.create_plan({
        publication_id: first.publication_id, proposal_id: hierarchy.proposal_id,
        memory_kind: 'knowledge', semantic_key: 'cas memory',
    }, value.worker('cas-a:plan'));
    value.publication.execute({
        publication_id: first.publication_id, plan_version: initial.plan_version,
        attempt_id: 'cas-a:attempt',
    }, value.worker('cas-a:publish'));

    const changed = seed_candidate(value, 'history-cas-b', {
        body: '历史复盘得到更完整但必须经过人工审查的新做法。',
    });
    const proposal = value.publication.propose_hierarchy({
        publication_id: changed.publication_id, level: 4,
        role: { mode: 'existing', role_id: hierarchy.role_id! },
        task: { mode: 'existing', task_id: hierarchy.task_id! }, confidence: 0.9,
    }, value.worker('cas-b:proposal'));
    const plan = value.publication.create_plan({
        publication_id: changed.publication_id, proposal_id: proposal.proposal_id,
        memory_kind: 'knowledge', semantic_key: 'cas memory',
    }, value.worker('cas-b:plan'));
    assert.equal(plan.relation, 'update');
    assert.equal(value.publication.get(changed.publication_id).status, 'needs_review');
    assert.throws(() => value.publication.execute({
        publication_id: changed.publication_id, plan_version: plan.plan_version,
        attempt_id: 'cas-b:too-early',
    }, value.worker('cas-b:too-early')), /cannot execute/i);
    value.publication.decide({
        publication_id: changed.publication_id,
        plan_version: plan.plan_version,
        action: 'approve_update', actor_id: 'local-user', actor_kind: 'user',
        action_id: 'cas-b:approve', channel: 'codex_ui', evidence: { approved: true },
    });
    value.central.publish({
        memory_id: plan.target_memory_id,
        project_id: plan.project_id,
        role_id: plan.role_id,
        task_id: plan.task_id,
        level: plan.level,
        memory_kind: plan.memory_kind,
        title: '当前任务的新结论',
        summary: '计划生成后，当前任务已经写入了更新的正式结论。',
        body: '这条当前工作结果必须优先，历史候选不能覆盖它。',
        importance: 0.8,
        created_by: 'current-task',
        expected_current_version: plan.expected_current_version,
    });
    const result = value.publication.execute({
        publication_id: changed.publication_id,
        plan_version: plan.plan_version,
        attempt_id: 'cas-b:attempt',
    }, value.worker('cas-b:publish'));
    assert.equal(result.publication.status, 'needs_review');
    assert.equal(result.attempt.outcome, 'needs_review');
    assert.equal(result.attempt.error_code, 'PUBLICATION_CAS_MISMATCH');
    assert.equal(value.store.central_memory.require_memory(plan.target_memory_id).current_version, 2);
    value.store.close();
});

test('level-one and major history candidates remain pending until central human confirmation', () => {
    const value = make_fixture();
    const seeded = seed_candidate(value, 'history-major', {
        kind: 'requirement',
        title: '项目必须遵守的规则',
        summary: '这是一条需要人工确认的项目级规则。',
        body: '在所有相关任务中必须优先遵守这条明确规则。',
        is_major: true,
        importance: 1,
    });
    const proposal = value.publication.propose_hierarchy({
        publication_id: seeded.publication_id,
        level: 1,
        role: { mode: 'none' },
        task: { mode: 'none' },
        confidence: 0.99,
    }, value.worker('major:proposal'));
    const plan = value.publication.create_plan({
        publication_id: seeded.publication_id,
        proposal_id: proposal.proposal_id,
        memory_kind: 'requirement',
        semantic_key: 'mandatory project rule',
    }, value.worker('major:plan'));
    const pending = value.publication.execute({
        publication_id: seeded.publication_id,
        plan_version: plan.plan_version,
        attempt_id: 'major:attempt',
    }, value.worker('major:publish'));
    assert.equal(pending.publication.status, 'pending_confirmation');
    assert.equal(pending.attempt.outcome, 'pending_confirmation');
    const confirmation = pending.publication.result_confirmation_id!;
    assert.equal(value.store.central_memory.require_confirmation(confirmation).confirmation_kind, 'major_rule');
    value.central.approve(confirmation, {
        actor_id: 'local-user', actor_kind: 'user', action_id: 'major:approve-central',
        channel: 'codex_ui', evidence: { confirmed_exact_version: true },
    });
    assert.equal(value.publication.reconcile_confirmation(seeded.publication_id).status, 'published');
    value.store.close();
});

test('rejecting a central confirmation terminally discards that exact historical candidate', () => {
    const value = make_fixture();
    const seeded = seed_candidate(value, 'history-rejected', {
        kind: 'requirement',
        title: '待判断的项目规则',
        summary: '该规则必须由用户决定是否进入正式记忆。',
        body: '拒绝后，这个候选版本不能在后台自行重新激活。',
        is_major: true,
        importance: 1,
    });
    const proposal = value.publication.propose_hierarchy({
        publication_id: seeded.publication_id, level: 1,
        role: { mode: 'none' }, task: { mode: 'none' }, confidence: 0.9,
    }, value.worker('rejected:proposal'));
    const plan = value.publication.create_plan({
        publication_id: seeded.publication_id, proposal_id: proposal.proposal_id,
        memory_kind: 'requirement', semantic_key: 'rejected project rule',
    }, value.worker('rejected:plan'));
    const pending = value.publication.execute({
        publication_id: seeded.publication_id, plan_version: plan.plan_version,
        attempt_id: 'rejected:attempt',
    }, value.worker('rejected:publish'));
    value.central.reject(pending.publication.result_confirmation_id!, {
        actor_id: 'local-user', actor_kind: 'user', action_id: 'rejected:central-decision',
        channel: 'codex_ui', evidence: { rejected_exact_version: true },
    });
    const discarded = value.publication.reconcile_confirmation(seeded.publication_id);
    assert.equal(discarded.status, 'discarded');
    assert.equal(discarded.result_memory_id, null);
    assert.equal(value.store.central_memory.require_memory(plan.target_memory_id).current_version, null);
    assert.throws(() => value.publication.create_plan({
        publication_id: seeded.publication_id, proposal_id: proposal.proposal_id,
        memory_kind: 'requirement', semantic_key: 'rejected project rule',
    }, value.worker('rejected:retry-plan')), /terminal|cannot be planned|final authorized candidate/i);
    value.store.close();
});

test('publication failure rolls back formal memory but keeps an idempotent retry receipt', () => {
    const value = make_fixture();
    value.store.central_memory.register_role({
        role_id: 'role-existing', project_id: 'project-a', name: 'Existing role', at: 1,
    });
    value.store.central_memory.register_task({
        task_id: 'task-existing', project_id: 'project-a', role_id: 'role-existing',
        title: 'Existing task', at: 1,
    });
    const seeded = seed_candidate(value, 'history-fault');
    const proposal = value.publication.propose_hierarchy({
        publication_id: seeded.publication_id, level: 4,
        role: { mode: 'existing', role_id: 'role-existing' },
        task: { mode: 'existing', task_id: 'task-existing' }, confidence: 0.9,
    }, value.worker('fault:proposal'));
    const plan = value.publication.create_plan({
        publication_id: seeded.publication_id, proposal_id: proposal.proposal_id,
        memory_kind: 'knowledge', semantic_key: 'fault recovery memory',
    }, value.worker('fault:plan'));
    value.store.database.exec(`CREATE TRIGGER test_fail_publication_summary
        BEFORE UPDATE ON cm_history_publications
        WHEN NEW.status='published' BEGIN
            SELECT RAISE(ABORT, 'simulated publication-ledger failure');
        END`);
    const failed = value.publication.execute({
        publication_id: seeded.publication_id, plan_version: plan.plan_version,
        attempt_id: 'fault:attempt',
    }, value.worker('fault:publish'));
    assert.equal(failed.publication.status, 'retryable');
    assert.equal(failed.attempt.outcome, 'retryable');
    assert.equal(value.store.central_memory.get_memory(plan.target_memory_id), null);
    const semantic_count = value.store.database.prepare(`SELECT count(*) AS count
        FROM cm_semantic_memory_keys`).get() as { count: number };
    assert.equal(semantic_count.count, 0);
    const replay = value.publication.execute({
        publication_id: seeded.publication_id, plan_version: plan.plan_version,
        attempt_id: 'fault:attempt',
    }, value.worker('fault:publish'));
    assert.equal(replay.attempt.created_at, failed.attempt.created_at);
    value.store.database.exec('DROP TRIGGER test_fail_publication_summary');
    value.publication.decide({
        publication_id: seeded.publication_id,
        action: 'retry', actor_id: 'local-user', actor_kind: 'user',
        action_id: 'fault:retry', channel: 'codex_ui', evidence: { requested_retry: true },
    });
    const recovered = value.publication.execute({
        publication_id: seeded.publication_id, plan_version: plan.plan_version,
        attempt_id: 'fault:attempt-2',
    }, value.worker('fault:publish-2'));
    assert.equal(recovered.publication.status, 'published');
    assert.equal(recovered.attempt.outcome, 'created');
    value.store.close();
});

test('publication workers are project-scoped and their own role/task is never inherited', () => {
    const value = make_fixture();
    const seeded = seed_candidate(value, 'history-scope');
    assert.throws(() => value.publication.propose_hierarchy({
        publication_id: seeded.publication_id,
        level: 1,
        role: { mode: 'none' },
        task: { mode: 'none' },
        confidence: 1,
    }, value.worker('scope:wrong', 'project-b')), /outside the worker project|authorization scope/i);
    const proposal = value.publication.propose_hierarchy({
        publication_id: seeded.publication_id,
        level: 1,
        role: { mode: 'none' },
        task: { mode: 'none' },
        confidence: 1,
    }, value.worker('scope:right'));
    assert.equal(proposal.role_id, null);
    assert.equal(proposal.task_id, null);
    value.store.close();
});
