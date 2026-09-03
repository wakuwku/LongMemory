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
 *  file  : src/cli/commands/porter/history_govern.test.ts
 *  usage : tests the LongMemory history govern component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryBackfillService } from '../../../core/central_memory/history_backfill_service.js';
import type {
    history_backfill_finding,
    history_chunk_claim,
    history_worker_context,
} from '../../../core/central_memory/history_backfill_types.js';
import { HistoryPublicationService } from '../../../core/central_memory/history_publication_service.js';
import { HistoryWorkerAuthorizationService } from '../../../core/central_memory/history_worker_authorization.js';
import { CentralMemoryService } from '../../../core/central_memory/service.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import { run_cli_app } from '../../cli_app.js';

const digest = (character: string): string => character.repeat(64);

type fixture = {
    root: string;
    db_path: string;
    store: SqliteStore;
    backfill: HistoryBackfillService;
    publication: HistoryPublicationService;
    central: CentralMemoryService;
    worker: (turn: string) => history_worker_context;
};

type invocation = { code: number; output: string; json: Record<string, unknown> | null };

function make_fixture(): fixture {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-govern-cli-'));
    const db_path = join(root, 'central-memory.db');
    const store = new SqliteStore(db_path, {
        tenant_id: 'tenant', user_id: 'human', startup_integrity_check: false,
    });
    for (const project_id of ['project-a', 'project-b']) {
        store.central_memory.register_project({ project_id, name: project_id, at: 1 });
    }
    store.central_memory.register_thread({
        thread_id: 'history-worker', project_id: 'project-a',
        responsibility: 'Extract authorized historical evidence.', at: 1,
    });
    new HistoryWorkerAuthorizationService(store.database, {
        tenant_id: 'tenant', user_id: 'human', now: () => 1,
    }).authorize({
        project_id: 'project-a',
        worker_session_id: 'history-worker',
        worker_id: 'history-worker',
        actor_id: 'test-human',
        action_id: 'test-authorize:history-govern-worker',
        evidence: { source: 'history_govern_test_fixture' },
        at: 1,
    });
    const worker = (turn: string): history_worker_context => ({
        worker_id: 'history-worker',
        worker_session_id: 'history-worker',
        worker_turn_id: turn,
        capability_epoch_hash: digest('c'),
    });
    const guard = (_worker: history_worker_context): void => undefined;
    return {
        root,
        db_path,
        store,
        backfill: new HistoryBackfillService(store.database, {
            tenant_id: 'tenant', user_id: 'human', capability_guard: guard,
        }),
        publication: new HistoryPublicationService(store.database, {
            tenant_id: 'tenant', user_id: 'human', capability_guard: guard,
        }),
        central: new CentralMemoryService(store.central_memory),
        worker,
    };
}

function finding_for(
    claim: history_chunk_claim,
    overrides: Partial<history_backfill_finding> = {},
): history_backfill_finding {
    const part = claim.chunk.source_parts[0]!;
    return {
        kind: 'knowledge',
        title: 'Verified historical practice',
        summary: 'A durable practice was verified in the historical task.',
        body: 'The complete method and its reason were retained for future work.',
        importance: 0.7,
        is_major: false,
        evidence: [{
            chunk_index: claim.chunk.chunk_index,
            turn_index: part.turn_index,
            part_index: part.part_index,
        }],
        ...overrides,
    };
}

function seed_candidate(
    value: fixture,
    session_id: string,
    overrides: Partial<history_backfill_finding> = {},
): string {
    const run = value.backfill.create_run({
        session: {
            schema_version: '1.0.0',
            source_harness: 'codex',
            source_session_id: session_id,
            source_path: `C:\\codex\\${session_id}.jsonl`,
            cwd: 'D:\\work\\project-a',
            title: `History ${session_id}`,
            created_at: 1,
            updated_at: Date.now(),
            turns: [
                { role: 'user', text: `Retain the exact result from ${session_id}.` },
                { role: 'assistant', text: 'The result was completed and verified.' },
            ],
            dropped_turns: 0,
            source_metadata: { parser: 'history-govern-cli-test' },
        },
        evidence: {
            inventory_id: `inventory:${session_id}`,
            reconciliation_digest: digest('a'),
            plan_id: `plan:${session_id}`,
            manifest_hash: digest('b'),
            target_db_path: value.db_path,
            target_project_id: 'project-a',
        },
        project_id: 'project-a',
        max_chunk_tokens: 256,
    });
    const extract = value.worker(`${session_id}:extract`);
    const claim = value.backfill.claim_next(extract, 5_000)!;
    const finding = finding_for(claim, overrides);
    value.backfill.submit_chunk(extract, claim.lease_id, claim.chunk.chunk_hash, [finding]);
    const reduce = value.worker(`${session_id}:reduce`);
    const reduction = value.backfill.claim_consolidation(reduce, 5_000)!;
    assert.equal(reduction.is_final, true);
    value.backfill.complete_consolidation(reduce, reduction.lease_id, [finding]);
    return value.publication.list('project-a').find((row) => row.run_id === run.run_id)!.publication_id;
}

async function invoke(value: fixture, args: string[]): Promise<invocation> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run_cli_app(
        [...args, '--db', value.db_path, '--project', 'project-a', '--user', 'human', '--json'],
        { LONGMEMORY_TENANT_ID: 'tenant' },
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), terminal: false },
    );
    const output = [...stdout, ...stderr].join('\n');
    let json: Record<string, unknown> | null = null;
    if (stdout.length > 0) json = JSON.parse(stdout.at(-1)!) as Record<string, unknown>;
    return { code, output, json };
}

function human_flags(action_id: string): string[] {
    return ['--action-id', action_id, '--confirm-human'];
}

test('trusted local project-link CLI keeps projects separate and governs L4 directions', async () => {
    const value = make_fixture();
    try {
        const denied = await invoke(value, [
            'project', 'link', 'create', 'project-a', 'project-b', '--action-id', 'link-without-human',
        ]);
        assert.notEqual(denied.code, 0);
        assert.match(denied.output, /--confirm-human/);
        assert.deepEqual(value.store.central_memory.list_project_links(), []);

        const created = await invoke(value, [
            'project', 'link', 'create', 'project-a', 'project-b', '--two-way',
            ...human_flags('cli:create-project-links'),
        ]);
        assert.equal(created.code, 0, created.output);
        assert.equal(created.json?.count, 2);
        assert.equal(value.store.central_memory.list_project_links({ status: 'active' }).length, 2);

        const listed = await invoke(value, ['project', 'link', 'list', '--status', 'active']);
        assert.equal(listed.code, 0, listed.output);
        assert.equal(listed.json?.count, 2);

        const forward = value.store.central_memory.find_active_project_link('project-a', 'project-b')!;
        const revoked = await invoke(value, [
            'project', 'link', 'revoke', forward.link_id,
            ...human_flags('cli:revoke-project-link'),
        ]);
        assert.equal(revoked.code, 0, revoked.output);
        assert.equal((revoked.json?.link as Record<string, unknown>).status, 'revoked');
        assert.equal(value.store.central_memory.find_active_project_link('project-a', 'project-b'), null);
        assert.ok(value.store.central_memory.find_active_project_link('project-b', 'project-a'));
    } finally {
        value.store.close();
        rmSync(value.root, { recursive: true, force: true });
    }
});

test('trusted local governance CLI completes hierarchy, update, conflict, retry and central confirmation flows', async () => {
    const value = make_fixture();
    try {
        const major_id = seed_candidate(value, 'major', {
            kind: 'requirement', is_major: true, importance: 1,
            title: 'Mandatory project rule',
            summary: 'This project-wide rule requires explicit human confirmation.',
            body: 'All project tasks must apply this exact verified rule.',
        });
        const hierarchy = value.publication.propose_hierarchy({
            publication_id: major_id,
            level: 1,
            role: { mode: 'none' },
            task: { mode: 'none' },
            confidence: 0.99,
        }, value.worker('major:proposal'));
        const accept_args = [
            'history', 'govern', 'accept_hierarchy', major_id,
            '--proposal-id', hierarchy.proposal_id,
            ...human_flags('cli:accept-major-hierarchy'),
        ];
        const accepted = await invoke(value, accept_args);
        assert.equal(accepted.code, 0, accepted.output);
        const accepted_replay = await invoke(value, accept_args);
        assert.equal(accepted_replay.code, 0, accepted_replay.output);
        assert.equal(value.publication.get(major_id).status, 'ready');

        const major_plan = value.publication.create_plan({
            publication_id: major_id,
            proposal_id: hierarchy.proposal_id,
            memory_kind: 'requirement',
            semantic_key: 'mandatory project rule',
        }, value.worker('major:plan'));
        const pending = value.publication.execute({
            publication_id: major_id, plan_version: major_plan.plan_version, attempt_id: 'major:attempt',
        }, value.worker('major:execute'));
        assert.equal(pending.publication.status, 'pending_confirmation');
        const confirmation_id = pending.publication.result_confirmation_id!;
        const approve_args = [
            'history', 'confirm', 'approve', confirmation_id,
            ...human_flags('cli:approve-major'),
        ];
        const approved = await invoke(value, approve_args);
        assert.equal(approved.code, 0, approved.output);
        assert.equal((approved.json!.publication as { status: string }).status, 'published');
        const approved_replay = await invoke(value, approve_args);
        assert.equal(approved_replay.code, 0, approved_replay.output);
        assert.equal(approved_replay.json!.replayed, true);

        const normal_id = seed_candidate(value, 'normal');
        const normal_hierarchy = value.publication.propose_hierarchy({
            publication_id: normal_id, level: 4,
            role: {
                mode: 'proposed', semantic_key: 'illustration-role',
                name: 'Illustration', responsibility: 'Produce and improve project illustrations.',
            },
            task: {
                mode: 'proposed', semantic_key: 'illustration-practice',
                title: 'Reusable rendering practice', objective: 'Retain verified rendering methods.',
            },
            confidence: 0.95,
        }, value.worker('normal:proposal'));
        const normal_accept = await invoke(value, [
            'history', 'govern', 'accept_hierarchy', normal_id,
            '--proposal-id', normal_hierarchy.proposal_id,
            ...human_flags('cli:accept-normal-hierarchy'),
        ]);
        assert.equal(normal_accept.code, 0, normal_accept.output);
        const normal_plan = value.publication.create_plan({
            publication_id: normal_id, proposal_id: normal_hierarchy.proposal_id,
            memory_kind: 'knowledge', semantic_key: 'normal reusable method',
        }, value.worker('normal:plan'));
        assert.equal(value.publication.execute({
            publication_id: normal_id, plan_version: normal_plan.plan_version, attempt_id: 'normal:attempt',
        }, value.worker('normal:execute')).publication.status, 'published');

        const update_id = seed_candidate(value, 'update', {
            body: 'The durable method was expanded with a second verified step and its reason.',
        });
        const update_hierarchy = value.publication.propose_hierarchy({
            publication_id: update_id, level: 4,
            role: { mode: 'existing', role_id: normal_hierarchy.role_id! },
            task: { mode: 'existing', task_id: normal_hierarchy.task_id! }, confidence: 0.95,
        }, value.worker('update:proposal'));
        const update_plan = value.publication.create_plan({
            publication_id: update_id, proposal_id: update_hierarchy.proposal_id,
            memory_kind: 'knowledge', semantic_key: 'normal reusable method',
        }, value.worker('update:plan'));
        assert.equal(update_plan.relation, 'update');
        const update_approved = await invoke(value, [
            'history', 'govern', 'approve_update', update_id,
            '--plan-version', String(update_plan.plan_version),
            ...human_flags('cli:approve-update'),
        ]);
        assert.equal(update_approved.code, 0, update_approved.output);
        assert.equal(value.publication.execute({
            publication_id: update_id, plan_version: update_plan.plan_version, attempt_id: 'update:attempt',
        }, value.worker('update:execute')).publication.status, 'published');

        const conflict_id = seed_candidate(value, 'conflict', {
            kind: 'requirement', is_major: true, importance: 1,
            title: 'Mandatory project rule',
            summary: 'A historical source proposes a changed mandatory project rule.',
            body: 'This conflicting project rule must not apply without two governance gates.',
        });
        const conflict_hierarchy = value.publication.propose_hierarchy({
            publication_id: conflict_id, level: 1,
            role: { mode: 'none' }, task: { mode: 'none' }, confidence: 0.95,
        }, value.worker('conflict:proposal'));
        const conflict_plan = value.publication.create_plan({
            publication_id: conflict_id, proposal_id: conflict_hierarchy.proposal_id,
            memory_kind: 'requirement', semantic_key: 'mandatory project rule',
        }, value.worker('conflict:plan'));
        assert.equal(conflict_plan.relation, 'conflict');
        const conflict_approved = await invoke(value, [
            'history', 'govern', 'approve_conflict', conflict_id,
            '--plan-version', String(conflict_plan.plan_version),
            ...human_flags('cli:approve-conflict'),
        ]);
        assert.equal(conflict_approved.code, 0, conflict_approved.output);
        const conflict_pending = value.publication.execute({
            publication_id: conflict_id, plan_version: conflict_plan.plan_version, attempt_id: 'conflict:attempt',
        }, value.worker('conflict:execute'));
        assert.equal(conflict_pending.publication.status, 'pending_confirmation');
        const conflict_rejected = await invoke(value, [
            'history', 'confirm', 'reject', conflict_pending.publication.result_confirmation_id!,
            ...human_flags('cli:reject-conflict'),
        ]);
        assert.equal(conflict_rejected.code, 0, conflict_rejected.output);
        assert.equal((conflict_rejected.json!.publication as { status: string }).status, 'discarded');

        const retry_id = seed_candidate(value, 'retry');
        const retry_hierarchy = value.publication.propose_hierarchy({
            publication_id: retry_id, level: 4,
            role: { mode: 'existing', role_id: normal_hierarchy.role_id! },
            task: { mode: 'existing', task_id: normal_hierarchy.task_id! }, confidence: 0.9,
        }, value.worker('retry:proposal'));
        const retry_plan = value.publication.create_plan({
            publication_id: retry_id, proposal_id: retry_hierarchy.proposal_id,
            memory_kind: 'knowledge', semantic_key: 'retryable method',
        }, value.worker('retry:plan'));
        value.store.database.exec(`CREATE TRIGGER cli_test_fail_publication
            BEFORE UPDATE ON cm_history_publications
            WHEN NEW.status='published'
            BEGIN SELECT RAISE(ABORT, 'simulated CLI publication failure'); END`);
        assert.equal(value.publication.execute({
            publication_id: retry_id, plan_version: retry_plan.plan_version, attempt_id: 'retry:failed',
        }, value.worker('retry:failed')).publication.status, 'retryable');
        value.store.database.exec('DROP TRIGGER cli_test_fail_publication');
        const retried = await invoke(value, [
            'history', 'govern', 'retry', retry_id,
            ...human_flags('cli:retry-publication'),
        ]);
        assert.equal(retried.code, 0, retried.output);
        assert.equal(value.publication.execute({
            publication_id: retry_id, plan_version: retry_plan.plan_version, attempt_id: 'retry:recovered',
        }, value.worker('retry:recovered')).publication.status, 'published');

        const discard_id = seed_candidate(value, 'discard');
        const discard_proposal = value.publication.propose_hierarchy({
            publication_id: discard_id, level: 4,
            role: {
                mode: 'proposed', semantic_key: 'discarded-role',
                name: 'Discarded proposal', responsibility: 'This hierarchy will not be materialized.',
            },
            task: {
                mode: 'proposed', semantic_key: 'discarded-task',
                title: 'Discarded task', objective: 'Exercise rejection without materializing hierarchy.',
            },
            confidence: 0.6,
        }, value.worker('discard:proposal'));
        const rejected_hierarchy = await invoke(value, [
            'history', 'govern', 'reject_hierarchy', discard_id,
            '--proposal-id', discard_proposal.proposal_id,
            ...human_flags('cli:reject-hierarchy'),
        ]);
        assert.equal(rejected_hierarchy.code, 0, rejected_hierarchy.output);
        const discarded = await invoke(value, [
            'history', 'govern', 'discard', discard_id,
            ...human_flags('cli:discard-publication'),
        ]);
        assert.equal(discarded.code, 0, discarded.output);
        assert.equal(value.publication.get(discard_id).status, 'discarded');

        for (const action of ['reject', 'cancel'] as const) {
            const pending_direct = value.central.publish({
                memory_id: `direct-${action}`,
                project_id: 'project-a',
                level: 1,
                memory_kind: 'requirement',
                title: `Direct ${action}`,
                summary: `Exercise the ${action} confirmation command.`,
                body: `This candidate must be ${action === 'reject' ? 'rejected' : 'cancelled'} by the local CLI.`,
                importance: 1,
                major: true,
                created_by: 'test',
            });
            const result = await invoke(value, [
                'history', 'confirm', action, pending_direct.confirmation!.confirmation_id,
                ...human_flags(`cli:direct-${action}`),
            ]);
            assert.equal(result.code, 0, result.output);
            assert.equal(value.store.central_memory.require_confirmation(
                pending_direct.confirmation!.confirmation_id,
            ).status, action === 'reject' ? 'rejected' : 'cancelled');
        }

        const decisions = value.store.database.prepare(`SELECT actor_id, channel, evidence_json
            FROM cm_history_governance_decisions
            WHERE tenant_id='tenant' AND user_id='human'`)
            .all() as Array<{ actor_id: string; channel: string; evidence_json: string }>;
        assert.ok(decisions.length >= 6);
        for (const decision of decisions) {
            assert.equal(decision.actor_id, 'human');
            assert.equal(decision.channel, 'local_cli');
            const evidence = JSON.parse(decision.evidence_json) as Record<string, unknown>;
            assert.equal(evidence.explicit_human_confirmation, true);
            assert.equal(evidence.source, 'longmemory_history_govern_cli');
        }
    } finally {
        value.store.close();
        rmSync(value.root, { recursive: true, force: true });
    }
});

test('governance CLI requires explicit authority and enforces tenant/user/project and action-id scope', async () => {
    const value = make_fixture();
    try {
        const publication_id = seed_candidate(value, 'security');
        const proposal = value.publication.propose_hierarchy({
            publication_id, level: 1,
            role: { mode: 'none' }, task: { mode: 'none' }, confidence: 0.9,
        }, value.worker('security:proposal'));
        const base = [
            'history', 'govern', 'accept_hierarchy', publication_id,
            '--proposal-id', proposal.proposal_id,
            '--action-id', 'security:accept',
        ];
        const no_human = await invoke(value, base);
        assert.notEqual(no_human.code, 0);
        assert.match(no_human.output, /--confirm-human/u);

        const false_human = await invoke(value, [...base, '--confirm-human=false']);
        assert.notEqual(false_human.code, 0);
        assert.match(false_human.output, /--confirm-human/u);

        const forged_evidence = await invoke(value, [
            ...base, '--confirm-human', '--evidence', '{"forged":true}',
        ]);
        assert.notEqual(forged_evidence.code, 0);
        assert.match(forged_evidence.output, /unknown flag: --evidence/u);

        const cross_project = await run_cli_app([
            ...base, '--confirm-human', '--db', value.db_path,
            '--project', 'project-b', '--user', 'human', '--json',
        ], { LONGMEMORY_TENANT_ID: 'tenant' }, {
            stdout: () => undefined, stderr: () => undefined, terminal: false,
        });
        assert.notEqual(cross_project, 0);

        const missing_db_output: string[] = [];
        const missing_db = await run_cli_app([
            'history', 'govern', 'discard', publication_id,
            '--project', 'project-a', ...human_flags('security:no-db'), '--json',
        ], { LONGMEMORY_TENANT_ID: 'tenant' }, {
            stdout: (text) => missing_db_output.push(text),
            stderr: (text) => missing_db_output.push(text), terminal: false,
        });
        assert.notEqual(missing_db, 0);
        assert.match(missing_db_output.join('\n'), /explicit persistent --db/u);
    } finally {
        value.store.close();
        rmSync(value.root, { recursive: true, force: true });
    }
});

test('history confirm rejects a credential-bearing note without echoing or persistence', async () => {
    const value = make_fixture();
    try {
        const pending = value.central.publish({
            memory_id: 'credential-note-confirmation',
            project_id: 'project-a',
            level: 1,
            memory_kind: 'requirement',
            title: 'Credential boundary test',
            summary: 'The confirmation note must remain secret-free.',
            body: 'A major rule waits for a trusted local confirmation.',
            importance: 1,
            major: true,
            created_by: 'test',
        });
        const confirmation_id = pending.confirmation!.confirmation_id;
        const credential = 'unsafe-cli-note-value-123456';
        const result = await invoke(value, [
            'history', 'confirm', 'approve', confirmation_id,
            '--note', `password=${credential}`,
            ...human_flags('cli:credential-note'),
        ]);
        assert.notEqual(result.code, 0);
        assert.match(result.output, /prohibited credential material/i);
        assert.doesNotMatch(result.output, new RegExp(credential));
        const unchanged = value.store.central_memory.require_confirmation(confirmation_id);
        assert.equal(unchanged.status, 'pending');
        assert.equal(unchanged.decision_note, '');
        assert.deepEqual(unchanged.decision_metadata, {});
    } finally {
        value.store.close();
        rmSync(value.root, { recursive: true, force: true });
    }
});
