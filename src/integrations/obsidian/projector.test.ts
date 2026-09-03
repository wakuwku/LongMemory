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
 *  file  : src/integrations/obsidian/projector.test.ts
 *  usage : tests the LongMemory projector component
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parse_yaml } from 'yaml';
import { CentralMemoryService } from '../../core/central_memory/service.js';
import { HistoryBackfillService } from '../../core/central_memory/history_backfill_service.js';
import type {
    history_backfill_finding,
    history_worker_context,
} from '../../core/central_memory/history_backfill_types.js';
import { HistoryPublicationService } from '../../core/central_memory/history_publication_service.js';
import { HistoryWorkerAuthorizationService } from '../../core/central_memory/history_worker_authorization.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import {
    ObsidianProjectionOwnershipError,
    project_central_memory_to_obsidian,
    type ObsidianProjectionFaultPhase,
    type ObsidianProjectionReport,
} from './projector.js';

type manifest_file = {
    path: string;
    sha256: string;
    kind: string;
    record_id: string;
};

type manifest = {
    source_fingerprint: string;
    proposal_inbox: string;
    managed_files: manifest_file[];
};

type recovery_journal = {
    generator: string;
    schema_version: number;
    credential_detector_version: string;
    transaction_id: string;
    scope_fingerprint: string;
    vault_root_fingerprint: string;
    projection_root: string;
    base_manifest_checksum: string | null;
    base_manifest: manifest | null;
    next_manifest_checksum: string;
    next_manifest: manifest;
    writes: Array<{
        path: string;
        before_sha256: string | null;
        after_sha256: string;
        content: string;
    }>;
    removals: Array<{ path: string; before_sha256: string }>;
};

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function stable_test_value(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable_test_value);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([key, nested]) => [key, stable_test_value(nested)]),
        );
    }
    return value;
}

function stable_test_json(value: unknown, spacing?: number): string {
    const result = JSON.stringify(stable_test_value(value), null, spacing);
    if (result === undefined) throw new Error('cannot serialize undefined test journal data');
    return result;
}

function fixture() {
    const store = new SqliteStore(':memory:', {
        tenant_id: 'tenant',
        user_id: 'user',
        startup_integrity_check: false,
        now: () => 1_000,
    });
    const repository = store.central_memory;
    repository.register_project({
        project_id: 'novel',
        name: 'Novel: "Sky"\n[[unsafe title]]',
        description: 'A serialized novel.',
        metadata: { tags: ['fiction'], nested: { z: 2, a: 1 } },
        at: 1_000,
    });
    repository.register_role({
        role_id: 'writer',
        project_id: 'novel',
        name: 'Writer',
        responsibility: 'Maintain prose continuity.',
        at: 1_001,
    });
    repository.register_task({
        task_id: 'chapter',
        project_id: 'novel',
        role_id: 'writer',
        title: 'Write chapter',
        objective: 'Produce the next chapter.',
        at: 1_002,
    });
    const service = new CentralMemoryService(repository);
    service.register_thread({
        thread_id: 'thread-write',
        project_id: 'novel',
        role_id: 'writer',
        task_id: 'chapter',
        responsibility: 'Draft chapters.',
        metadata: { local_context: 'thread-owned' },
        at: 1_003,
    });
    return { store, repository, service };
}

function user_decision(note: string, action_id: string) {
    return {
        actor_id: 'user',
        actor_kind: 'user' as const,
        action_id,
        channel: 'codex_ui' as const,
        note,
        evidence: { turn_id: `turn-${action_id}`, explicit_user_action: true },
    };
}

function publish_input(memory_id: string, title: string) {
    return {
        memory_id,
        project_id: 'novel',
        role_id: 'writer',
        task_id: 'chapter',
        level: 4 as const,
        memory_kind: 'procedure',
        title,
        summary: `${title} summary.`,
        body: `${title} exact body.`,
        created_by: 'thread-write',
        source_thread_id: 'thread-write',
    };
}

const digest = (character: string): string => character.repeat(64);

function populate_history_governance(store: SqliteStore) {
    const now = { value: 4_000 };
    const capability_guard = (): void => undefined;
    const backfill = new HistoryBackfillService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value, capability_guard,
    });
    const publication = new HistoryPublicationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value, capability_guard,
    });
    const worker = (turn: string): history_worker_context => ({
        worker_id: 'history-projector-test',
        worker_session_id: 'thread-write',
        worker_turn_id: turn,
        capability_epoch_hash: digest('c'),
    });
    new HistoryWorkerAuthorizationService(store.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => now.value,
    }).authorize({
        project_id: 'novel',
        worker_session_id: 'thread-write',
        worker_id: 'history-projector-test',
        actor_id: 'test-human',
        action_id: 'test-authorize:history-projector',
        evidence: { source: 'obsidian_projector_test_fixture' },
        at: 1_003,
    });
    const seed = (session_id: string, overrides: Partial<history_backfill_finding> = {}) => {
        now.value += 10;
        const run = backfill.create_run({
            session: {
                schema_version: '1.0.0',
                source_harness: 'codex',
                source_session_id: session_id,
                source_path: `C:\\codex\\${session_id}.jsonl`,
                cwd: 'D:\\work\\novel',
                title: `History ${session_id}`,
                created_at: 1,
                updated_at: now.value,
                turns: [
                    { role: 'user', text: `请保留 ${session_id} 中确定的完整条件。` },
                    { role: 'assistant', text: '已经完成并核对准确性。' },
                ],
                dropped_turns: 0,
                source_metadata: { parser: 'obsidian-projector-test' },
            },
            evidence: {
                inventory_id: `inventory:${session_id}`,
                reconciliation_digest: digest('a'),
                plan_id: `plan:${session_id}`,
                manifest_hash: digest('b'),
                target_db_path: 'D:\\memory\\central.db',
                target_project_id: 'novel',
            },
            project_id: 'novel',
            max_chunk_tokens: 256,
        });
        const extract_worker = worker(`${session_id}:extract`);
        const claim = backfill.claim_next(extract_worker, 5_000)!;
        const part = claim.chunk.source_parts[0]!;
        const finding: history_backfill_finding = {
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
        backfill.submit_chunk(extract_worker, claim.lease_id, claim.chunk.chunk_hash, [finding]);
        const reduce_worker = worker(`${session_id}:reduce`);
        const reduction = backfill.claim_consolidation(reduce_worker, 5_000)!;
        assert.equal(reduction.is_final, true);
        backfill.complete_consolidation(reduce_worker, reduction.lease_id, [finding]);
        const seeded = publication.list('novel').filter((row) => row.run_id === run.run_id);
        assert.equal(seeded.length, 1);
        return seeded[0]!;
    };

    const published = seed('history-published');
    const published_proposal = publication.propose_hierarchy({
        publication_id: published.publication_id,
        level: 4,
        role: {
            mode: 'proposed', semantic_key: 'novel illustration learning',
            name: '作画学习', responsibility: '沉淀可迁移的小说插画经验',
        },
        task: {
            mode: 'proposed', semantic_key: 'rendering practice',
            title: '复现实验', objective: '保存完整且可复现的作画条件',
        },
        confidence: 0.93,
    }, worker('published:proposal'));
    publication.decide({
        publication_id: published.publication_id,
        proposal_id: published_proposal.proposal_id,
        action: 'accept_hierarchy',
        actor_id: 'local-user',
        actor_kind: 'user',
        action_id: 'accept-projector-hierarchy',
        channel: 'obsidian',
        evidence: { proposal_reviewed: true },
        note: '层级与项目职责匹配。',
    });
    const published_plan = publication.create_plan({
        publication_id: published.publication_id,
        proposal_id: published_proposal.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'reproducible illustration conditions',
    }, worker('published:plan'));
    publication.execute({
        publication_id: published.publication_id,
        plan_version: published_plan.plan_version,
        attempt_id: 'projector-attempt-published',
    }, worker('published:execute'));

    const content_review = seed('history-content-review', {
        body: '后来证据提出了不同的完整条件，因此必须先人工审核再更新。',
    });
    const review_proposal = publication.propose_hierarchy({
        publication_id: content_review.publication_id,
        level: 4,
        role: { mode: 'existing', role_id: published_proposal.role_id! },
        task: { mode: 'existing', task_id: published_proposal.task_id! },
        confidence: 0.88,
    }, worker('content-review:proposal'));
    publication.create_plan({
        publication_id: content_review.publication_id,
        proposal_id: review_proposal.proposal_id,
        memory_kind: 'knowledge',
        semantic_key: 'reproducible illustration conditions',
    }, worker('content-review:plan'));

    const hierarchy_review = seed('history-hierarchy-review', {
        body: [
            '![tracking pixel](https://evil.invalid/pixel)',
            '<iframe src="https://evil.invalid/frame"></iframe>',
            '![[Injected Embed]]',
            '[open vault](obsidian://open?vault=other)',
            '# forged instruction',
        ].join('\n'),
    });
    publication.propose_hierarchy({
        publication_id: hierarchy_review.publication_id,
        level: 4,
        role: {
            mode: 'proposed', semantic_key: 'novel data review',
            name: '小说数据分析', responsibility: '分析小说数据表现并反馈写作任务',
        },
        task: {
            mode: 'proposed', semantic_key: 'diagnose weak performance',
            title: '诊断低表现', objective: '提出有证据的改进方向',
        },
        confidence: 0.82,
    }, worker('hierarchy-review:proposal'));

    const central_confirmation = seed('history-central-confirmation', { is_major: true });
    const central_proposal = publication.propose_hierarchy({
        publication_id: central_confirmation.publication_id,
        level: 1,
        role: { mode: 'none' },
        task: { mode: 'none' },
        confidence: 0.96,
    }, worker('central-confirmation:proposal'));
    const central_plan = publication.create_plan({
        publication_id: central_confirmation.publication_id,
        proposal_id: central_proposal.proposal_id,
        memory_kind: 'requirement',
        semantic_key: 'project wide mandatory rule',
    }, worker('central-confirmation:plan'));
    publication.execute({
        publication_id: central_confirmation.publication_id,
        plan_version: central_plan.plan_version,
        attempt_id: 'projector-attempt-central-confirmation',
    }, worker('central-confirmation:execute'));

    return {
        published_id: published.publication_id,
        published_proposal_id: published_proposal.proposal_id,
        hierarchy_review_id: hierarchy_review.publication_id,
        content_review_id: content_review.publication_id,
        central_confirmation_id: central_confirmation.publication_id,
        published_plan_version: published_plan.plan_version,
    };
}

function populate_complete_fixture() {
    const result = fixture();
    const { store, service } = result;
    service.publish({
        ...publish_input('memory-rule', 'Opening rule'),
        importance: 0.9,
        metadata: { tags: ['writing', 'continuity'], instruction: 'keep exact' },
        sources: [{
            source: {
                source_id: 'source-rule-v1',
                source_kind: 'codex_turn',
                uri: 'codex://threads/thread-write/turn-1',
                thread_id: 'thread-write',
                turn_id: 'turn-1',
                locator: { message_index: 1 },
                excerpt_hash: 'fixture-hash',
                metadata: { captured_by: 'test' },
                recorded_at: 2_000,
            },
            evidence_role: 'support',
            locator: { paragraph: 2 },
        }],
        at: 2_000,
    });
    service.add_dependency({
        dependency_id: 'dependency-needs-review',
        subject_kind: 'artifact',
        subject_id: 'chapter-1',
        memory_id: 'memory-rule',
        memory_version: 1,
        details: { file: 'chapter-1.md' },
        at: 2_010,
    });
    service.sync_at_safe_boundary('thread-write', 2_020);
    service.consume('thread-write', 'memory-rule', 1, 2_030);
    service.publish({
        ...publish_input('memory-rule', 'Opening rule'),
        expected_current_version: 1,
        body: 'UPDATED CURRENT BODY — measurable and exact.',
        change_reason: 'Make the rule measurable.',
        at: 2_100,
    });

    const locked = service.publish({
        ...publish_input('memory-locked', 'Canon rule'),
        body: 'LOCKED CURRENT BODY.',
        lock: true,
        at: 2_200,
    });
    service.approve(
        locked.confirmation!.confirmation_id,
        user_decision('Approve and lock.', 'lock-1'),
        2_210,
    );
    service.add_dependency({
        dependency_id: 'dependency-current',
        subject_kind: 'decision',
        subject_id: 'canon-choice',
        memory_id: 'memory-locked',
        memory_version: 1,
        details: { owner: 'writer' },
        at: 2_220,
    });

    service.publish({
        ...publish_input('memory-retracted', 'Obsolete rule'),
        body: 'OBSOLETE BODY THAT MUST NOT BE USED.',
        at: 2_300,
    });
    service.add_dependency({
        dependency_id: 'dependency-invalidated',
        subject_kind: 'output',
        subject_id: 'old-draft',
        memory_id: 'memory-retracted',
        memory_version: 1,
        details: { why: 'used the old rule' },
        at: 2_310,
    });
    service.sync_at_safe_boundary('thread-write', 2_320);
    service.consume('thread-write', 'memory-retracted', 1, 2_330);
    const retraction = service.request_retraction({
        memory_id: 'memory-retracted',
        expected_current_version: 1,
        requested_by: 'thread-write',
        reason: 'Invalidated by later evidence.',
        at: 2_340,
    });
    service.approve(
        retraction.confirmation!.confirmation_id,
        user_decision('Confirm retraction.', 'retract-1'),
        2_350,
    );

    service.publish({
        ...publish_input('memory-pending', 'Proposed major rule'),
        body: 'PENDING CANDIDATE BODY — NOT CURRENT.',
        major: true,
        at: 2_400,
    });
    service.report_conflict({
        conflict_id: 'conflict-open',
        memory_a_id: 'memory-rule',
        memory_a_version: 2,
        memory_b_id: 'memory-locked',
        memory_b_version: 1,
        severity: 0.95,
        rationale: 'The rules cannot both govern the same output.',
        at: 2_500,
    });

    const history = populate_history_governance(store);
    result.repository.register_project({
        project_id: 'painting', name: 'Painting', description: 'Independent illustration project.', at: 2_900,
    });
    const project_links = service.link_projects({
        source_project_id: 'novel', target_project_id: 'painting', direction: 'two_way',
        decision: user_decision('Allow relevant L4 coordination.', 'projector-project-links'),
        metadata: { l4_only: true }, at: 2_910,
    });

    store.database.prepare(`INSERT INTO cm_projects
        (tenant_id, user_id, project_id, name, description, status, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('other-tenant', 'user', 'secret-project', 'CROSS_SCOPE_SECRET', '', 'active', '{}', 3_000, 3_000);
    return { ...result, history, project_links };
}

function read_manifest(report: ObsidianProjectionReport): manifest {
    return JSON.parse(readFileSync(report.manifest_path, 'utf8')) as manifest;
}

function entry_for(value: manifest, kind: string, record_id: string): manifest_file {
    const entry = value.managed_files.find((candidate) => candidate.kind === kind && candidate.record_id === record_id);
    assert.ok(entry, `missing ${kind}:${record_id}`);
    return entry;
}

function read_entry(vault: string, value: manifest, kind: string, record_id: string): string {
    return readFileSync(path.join(vault, ...entry_for(value, kind, record_id).path.split('/')), 'utf8');
}

function total_changes(store: SqliteStore): number {
    return Number((store.database.prepare('SELECT total_changes() AS value').get() as { value: number }).value);
}

function recursive_files(root: string): string[] {
    if (!existsSync(root)) return [];
    const result: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...recursive_files(absolute));
        else result.push(absolute);
    }
    return result;
}

function read_pending_journal(state_root: string): { path: string; value: recovery_journal } {
    const journal_path = recursive_files(state_root).find((file) => file.endsWith('.journal.json'));
    assert.ok(journal_path, 'pending projection journal is missing');
    return {
        path: journal_path,
        value: JSON.parse(readFileSync(journal_path, 'utf8')) as recovery_journal,
    };
}

function write_pending_journal(journal_path: string, journal: recovery_journal): void {
    writeFileSync(journal_path, `${stable_test_json(journal, 2)}\n`);
}

function refresh_pending_journal_transaction_id(journal: recovery_journal): void {
    journal.transaction_id = sha256(stable_test_json({
        scope_fingerprint: journal.scope_fingerprint,
        vault_root_fingerprint: journal.vault_root_fingerprint,
        projection_root: journal.projection_root,
        credential_detector_version: journal.credential_detector_version,
        base_manifest_checksum: journal.base_manifest_checksum,
        next_manifest_checksum: journal.next_manifest_checksum,
        writes: journal.writes.map(({ path: file_path, before_sha256, after_sha256 }) => ({
            path: file_path,
            before_sha256,
            after_sha256,
        })),
        removals: journal.removals.map(({ path: file_path, before_sha256 }) => ({
            path: file_path,
            expected_checksum: before_sha256,
        })),
    }));
}

test('projects the governed central-memory graph as a complete, read-only Obsidian vault', () => {
    const { store, history, project_links } = populate_complete_fixture();
    const vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-complete-'));
    try {
        const before_changes = total_changes(store);
        const report = project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        assert.equal(total_changes(store), before_changes);
        const value = read_manifest(report);
        for (const kind of [
            'home', 'project', 'project_link', 'role', 'task', 'memory', 'memory_version', 'thread', 'source',
            'confirmation', 'conflict', 'dependency', 'history_publication', 'hierarchy_proposal',
            'governance_decision', 'publication_plan', 'publication_attempt', 'dashboard', 'guide',
        ]) {
            assert.ok(value.managed_files.some((entry) => entry.kind === kind), `missing kind ${kind}`);
        }
        assert.equal(value.managed_files.filter((entry) => entry.kind === 'dashboard').length, 19);
        const projected_link = read_entry(vault, value, 'project_link', project_links[0]!.link_id);
        assert.match(projected_link, /L4 only/u);
        assert.match(projected_link, /不会传播 L1–L3/u);
        assert.match(projected_link, /novel.*painting|painting.*novel/us);

        const current = read_entry(vault, value, 'memory', 'memory-rule');
        assert.match(current, /UPDATED CURRENT BODY — measurable and exact\./u);
        assert.doesNotMatch(current, /PENDING CANDIDATE BODY/u);
        assert.match(current, /v00000002|v2/u);
        const pending = read_entry(vault, value, 'memory', 'memory-pending');
        assert.match(pending, /NO CURRENT EFFECTIVE VERSION/u);
        assert.match(pending, /PENDING — NOT EFFECTIVE/u);
        const retracted = read_entry(vault, value, 'memory', 'memory-retracted');
        assert.match(retracted, /RETRACTED — DO NOT USE/u);
        const retracted_version = read_entry(vault, value, 'memory_version', 'memory-retracted@1');
        assert.match(retracted_version, /RETRACTED — DO NOT USE/u);
        const locked = read_entry(vault, value, 'memory', 'memory-locked');
        assert.match(locked, /LOCKED — 重大规则/u);

        const thread = read_entry(vault, value, 'thread', 'thread-write');
        assert.match(thread, /synced_version/u);
        assert.match(thread, /consumed_version/u);
        assert.match(thread, /pending_version/u);
        assert.match(thread, /RETRACTED WORKSET ENTRY/u);
        assert.match(read_entry(vault, value, 'source', 'source-rule-v1'), /paragraph/u);
        assert.match(read_entry(vault, value, 'confirmation', 'confirmation:memory-pending:1:active'), /提案本身不等于批准/u);
        assert.match(read_entry(vault, value, 'conflict', 'conflict-open'), /OPEN CONFLICT/u);
        assert.match(read_entry(vault, value, 'dependency', 'dependency-needs-review'), /NEEDS REVIEW/u);
        assert.match(read_entry(vault, value, 'dependency', 'dependency-invalidated'), /INVALIDATED/u);

        const published = read_entry(vault, value, 'history_publication', history.published_id);
        assert.match(published, /PUBLISHED — 已进入中央记忆/u);
        assert.match(published, /最终压缩候选/u);
        assert.match(published, /历史证据定位/u);
        const hierarchy_review = read_entry(
            vault, value, 'history_publication', history.hierarchy_review_id,
        );
        assert.match(hierarchy_review, /AWAITING HIERARCHY — 待人工确认层级/u);
        assert.match(hierarchy_review, /````text\n[\s\S]*https:\/\/evil\.invalid[\s\S]*\n````/u);
        const active_markdown = hierarchy_review
            .replace(/^---\n[\s\S]*?\n---\n/u, '')
            .replace(/(`{4,})text\n[\s\S]*?\n\1/gu, '');
        assert.doesNotMatch(active_markdown, /evil\.invalid|obsidian:\/\/|!\[\[/u);
        assert.match(read_entry(vault, value, 'history_publication', history.content_review_id),
            /NEEDS CONTENT REVIEW — 待人工审核内容/u);
        assert.match(read_entry(vault, value, 'history_publication', history.central_confirmation_id),
            /PENDING CENTRAL CONFIRMATION — 尚未生效/u);
        assert.match(read_entry(vault, value, 'hierarchy_proposal', history.published_proposal_id),
            /ACCEPTED HIERARCHY/u);
        assert.match(read_entry(
            vault, value, 'publication_plan', `${history.published_id}@${history.published_plan_version}`,
        ), /CURRENT IMMUTABLE PLAN/u);
        assert.match(read_entry(vault, value, 'publication_attempt', 'projector-attempt-published'),
            /COMMITTED ATTEMPT/u);
        assert.match(read_entry(
            vault,
            value,
            'governance_decision',
            value.managed_files.find((entry) => entry.kind === 'governance_decision')!.record_id,
        ), /IMMUTABLE GOVERNANCE EVIDENCE/u);

        const home = read_entry(vault, value, 'home', 'home');
        assert.match(home, /待层级确认：1/u);
        assert.match(home, /待内容审核：1/u);
        assert.match(home, /待中央确认：1/u);

        const all_text = value.managed_files
            .map((entry) => readFileSync(path.join(vault, ...entry.path.split('/')), 'utf8'))
            .join('\n');
        assert.doesNotMatch(all_text, /CROSS_SCOPE_SECRET/u);
        for (const entry of value.managed_files) {
            const content = readFileSync(path.join(vault, ...entry.path.split('/')), 'utf8');
            if (entry.path.endsWith('.base')) {
                assert.doesNotThrow(() => parse_yaml(content));
            } else if (entry.path.endsWith('.md')) {
                const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
                assert.ok(frontmatter, `missing frontmatter: ${entry.path}`);
                assert.doesNotThrow(() => parse_yaml(frontmatter[1]));
            }
        }
    } finally {
        store.close();
        rmSync(vault, { recursive: true, force: true });
    }
});

test('projection never copies credential-bearing database content into Markdown', () => {
    const { store } = fixture();
    const vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-credential-'));
    try {
        const credential = 'unsafe-projection-value-123456';
        store.database.prepare(`UPDATE cm_projects SET description=?
            WHERE tenant_id='tenant' AND user_id='user' AND project_id='novel'`)
            .run(`password=${credential}`);
        let failure: Error | null = null;
        try {
            project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                tenant_id: 'tenant',
                user_id: 'user',
            });
        } catch (error) {
            failure = error as Error;
        }
        assert.ok(failure);
        assert.match(failure.message, /prohibited credential material/i);
        assert.doesNotMatch(failure.message, new RegExp(credential));
        assert.equal(recursive_files(vault).length, 0);
    } finally {
        store.close();
        rmSync(vault, { recursive: true, force: true });
        rmSync(`${vault}.longmemory-obsidian-state`, { recursive: true, force: true });
    }
});

test('projection scans credential-bearing metadata beyond ordinary nesting depths', () => {
    const { store } = fixture();
    const vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-deep-credential-'));
    try {
        const credential = 'unsafe-deep-projection-value-123456';
        let nested: unknown = `password=${credential}`;
        for (let depth = 0; depth < 32; depth += 1) nested = { nested };
        store.database.prepare(`UPDATE cm_projects SET metadata_json=?
            WHERE tenant_id='tenant' AND user_id='user' AND project_id='novel'`)
            .run(JSON.stringify({ nested }));
        let failure: Error | null = null;
        try {
            project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                tenant_id: 'tenant',
                user_id: 'user',
            });
        } catch (error) {
            failure = error as Error;
        }
        assert.ok(failure);
        assert.match(failure.message, /prohibited credential material/i);
        assert.doesNotMatch(failure.message, new RegExp(credential));
        assert.equal(recursive_files(vault).length, 0);
    } finally {
        store.close();
        rmSync(vault, { recursive: true, force: true });
        rmSync(`${vault}.longmemory-obsidian-state`, { recursive: true, force: true });
    }
});

test('rejects a pending journal from a different credential detector before recovery writes', () => {
    const { store } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-journal-detector-'));
    const vault = path.join(container, 'vault');
    const state_root = path.join(container, 'state');
    try {
        const baseline = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        const baseline_manifest = read_manifest(baseline);
        const project_file = path.join(
            vault,
            ...entry_for(baseline_manifest, 'project', 'novel').path.split('/'),
        );
        const project_before = readFileSync(project_file);
        const manifest_before = readFileSync(baseline.manifest_path);
        store.database.prepare(`UPDATE cm_projects SET description=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND project_id=?`)
            .run('Safe pending detector-version update.', 5_000, 'tenant', 'user', 'novel');
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            state_root,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (phase === 'after_prepare') throw new Error('pause with current detector journal');
            },
        }), /pause with current detector journal/u);

        const pending = read_pending_journal(state_root);
        pending.value.credential_detector_version = 'longmemory.obvious-credentials/older-test-version';
        refresh_pending_journal_transaction_id(pending.value);
        write_pending_journal(pending.path, pending.value);
        const journal_before = readFileSync(pending.path);

        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            state_root,
            tenant_id: 'tenant',
            user_id: 'user',
        }), /credential detector version does not match/u);
        assert.deepEqual(readFileSync(project_file), project_before);
        assert.deepEqual(readFileSync(baseline.manifest_path), manifest_before);
        assert.deepEqual(readFileSync(pending.path), journal_before);
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('rejects credential-bearing pending journal content before recovery writes without echoing it', () => {
    const { store } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-journal-credential-'));
    const vault = path.join(container, 'vault');
    const state_root = path.join(container, 'state');
    try {
        const baseline = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        const baseline_manifest = read_manifest(baseline);
        const project_file = path.join(
            vault,
            ...entry_for(baseline_manifest, 'project', 'novel').path.split('/'),
        );
        const project_before = readFileSync(project_file);
        const manifest_before = readFileSync(baseline.manifest_path);
        const safe_marker = 'SAFE_PENDING_DESCRIPTION_FOR_JOURNAL';
        store.database.prepare(`UPDATE cm_projects SET description=?, updated_at=?
            WHERE tenant_id=? AND user_id=? AND project_id=?`)
            .run(safe_marker, 6_000, 'tenant', 'user', 'novel');
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            state_root,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (phase === 'after_prepare') throw new Error('pause before credential recovery');
            },
        }), /pause before credential recovery/u);

        const pending = read_pending_journal(state_root);
        const write = pending.value.writes.find((operation) => operation.content.includes(safe_marker));
        assert.ok(write, 'pending project write is missing');
        const credential = 'unsafe-pending-journal-value-123456';
        write.content = write.content.replace(safe_marker, `password=${credential}`);
        write.after_sha256 = sha256(write.content);
        const managed = pending.value.next_manifest.managed_files.find((entry) => entry.path === write.path);
        assert.ok(managed, 'pending project manifest entry is missing');
        managed.sha256 = write.after_sha256;
        pending.value.next_manifest_checksum = sha256(`${stable_test_json(pending.value.next_manifest, 2)}\n`);
        refresh_pending_journal_transaction_id(pending.value);
        write_pending_journal(pending.path, pending.value);
        const journal_before = readFileSync(pending.path);

        let write_phase_reached = false;
        let failure: Error | null = null;
        try {
            project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                state_root,
                tenant_id: 'tenant',
                user_id: 'user',
                fault_inject: (phase) => {
                    if (phase === 'after_write') {
                        write_phase_reached = true;
                        throw new Error('recovery wrote before credential scan');
                    }
                },
            });
        } catch (error) {
            failure = error as Error;
        }
        assert.ok(failure);
        assert.match(failure.message, /prohibited credential material/u);
        assert.equal(failure.message.includes(credential), false);
        assert.equal(write_phase_reached, false);
        assert.deepEqual(readFileSync(project_file), project_before);
        assert.deepEqual(readFileSync(baseline.manifest_path), manifest_before);
        assert.deepEqual(readFileSync(pending.path), journal_before);
        for (const file of recursive_files(vault)) {
            assert.equal(readFileSync(file, 'utf8').includes(credential), false, `credential leaked to ${file}`);
        }
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('is byte-idempotent and never reads, rewrites or owns proposal inbox files', () => {
    const { store } = populate_complete_fixture();
    const vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-idempotent-'));
    try {
        const first = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, tenant_id: 'tenant', user_id: 'user',
        });
        const first_manifest = read_manifest(first);
        const proposal = path.join(vault, 'LongMemory', 'Proposals', 'inbox', 'my-proposal.md');
        const proposal_bytes = Buffer.from([0, 1, 2, 13, 10, 255]);
        writeFileSync(proposal, proposal_bytes);
        const tracked = [first.manifest_path, ...first_manifest.managed_files.map((entry) =>
            path.join(vault, ...entry.path.split('/')))];
        const fixed = new Date('2020-01-02T03:04:05.000Z');
        for (const file of [...tracked, proposal]) utimesSync(file, fixed, fixed);
        const mtimes = new Map([...tracked, proposal].map((file) => [file, statSync(file).mtimeMs]));
        const manifest_bytes = readFileSync(first.manifest_path);
        const before_changes = total_changes(store);

        const second = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, tenant_id: 'tenant', user_id: 'user',
        });
        assert.deepEqual(second.written, []);
        assert.deepEqual(second.removed, []);
        assert.equal(second.unchanged.length, first_manifest.managed_files.length);
        assert.equal(total_changes(store), before_changes);
        assert.deepEqual(readFileSync(first.manifest_path), manifest_bytes);
        for (const file of [...tracked, proposal]) assert.equal(statSync(file).mtimeMs, mtimes.get(file));
        assert.deepEqual(readFileSync(proposal), proposal_bytes);
        assert.equal(read_manifest(second).managed_files.some((entry) => entry.path.includes('/Proposals/inbox/')), false);
    } finally {
        store.close();
        rmSync(vault, { recursive: true, force: true });
    }
});

test('hashes hostile identifiers and preflights unknown or externally modified generated targets', () => {
    const hostile = fixture();
    const long_id = `../../outside:C:\\CON?*|<>/雪-${'x'.repeat(5_000)}`;
    hostile.repository.register_project({ project_id: long_id, name: 'Hostile ID project', at: 4_000 });
    const hostile_vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-hostile-'));
    try {
        const report = project_central_memory_to_obsidian({
            database: hostile.store.database,
            vault_root: hostile_vault,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        const value = read_manifest(report);
        const entry = entry_for(value, 'project', long_id);
        assert.match(path.posix.basename(entry.path), /^id-[a-f0-9]{64}\.md$/u);
        assert.equal(entry.path.includes('..'), false);
        assert.equal(entry.path.includes('雪'), false);
        for (const managed of value.managed_files) {
            const absolute = path.resolve(hostile_vault, ...managed.path.split('/'));
            const relative = path.relative(hostile_vault, absolute);
            assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
        }
        for (const unsafe_root of ['../outside', 'LongMemory/../outside', 'C:\\outside', '/outside', 'LongMemory\\..\\outside']) {
            assert.throws(() => project_central_memory_to_obsidian({
                database: hostile.store.database,
                vault_root: hostile_vault,
                tenant_id: 'tenant',
                user_id: 'user',
                projection_root: unsafe_root,
            }));
        }
    } finally {
        hostile.store.close();
        rmSync(hostile_vault, { recursive: true, force: true });
    }

    const collision = fixture();
    const collision_vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-collision-'));
    try {
        const project_token = sha256('project\0novel');
        const occupied = path.join(collision_vault, 'LongMemory', 'Projects', `id-${project_token}.md`);
        mkdirSync(path.dirname(occupied), { recursive: true });
        writeFileSync(occupied, 'USER OWNED');
        assert.throws(() => project_central_memory_to_obsidian({
            database: collision.store.database,
            vault_root: collision_vault,
            tenant_id: 'tenant',
            user_id: 'user',
        }), ObsidianProjectionOwnershipError);
        assert.equal(readFileSync(occupied, 'utf8'), 'USER OWNED');
        assert.equal(existsSync(path.join(collision_vault, 'LongMemory', 'Home.md')), false);
    } finally {
        collision.store.close();
        rmSync(collision_vault, { recursive: true, force: true });
    }

    const modified = fixture();
    const modified_vault = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-modified-'));
    try {
        const first = project_central_memory_to_obsidian({
            database: modified.store.database,
            vault_root: modified_vault,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        const value = read_manifest(first);
        const project_file = path.join(modified_vault, ...entry_for(value, 'project', 'novel').path.split('/'));
        writeFileSync(project_file, 'MANUAL EDIT');
        modified.repository.register_project({ project_id: 'novel', name: 'Changed centrally', at: 5_000 });
        const manifest_before = readFileSync(first.manifest_path);
        assert.throws(() => project_central_memory_to_obsidian({
            database: modified.store.database,
            vault_root: modified_vault,
            tenant_id: 'tenant',
            user_id: 'user',
        }), ObsidianProjectionOwnershipError);
        assert.equal(readFileSync(project_file, 'utf8'), 'MANUAL EDIT');
        assert.deepEqual(readFileSync(first.manifest_path), manifest_before);
    } finally {
        modified.store.close();
        rmSync(modified_vault, { recursive: true, force: true });
    }
});

test('removes only genuinely owned stale files and ignores forged manifests inside the vault', () => {
    const { store } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-manifest-'));
    const vault = path.join(container, 'vault');
    const state_root = path.join(container, 'state');
    try {
        store.central_memory.register_project({ project_id: 'stale-delete', name: 'Delete me', at: 4_000 });
        store.central_memory.register_project({ project_id: 'stale-preserve', name: 'Preserve me', at: 4_001 });
        const first = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        const value = read_manifest(first);
        const deletable_relative = entry_for(value, 'project', 'stale-delete').path;
        const preserved_relative = entry_for(value, 'project', 'stale-preserve').path;
        const deletable = path.join(vault, ...deletable_relative.split('/'));
        const preserved = path.join(vault, ...preserved_relative.split('/'));
        writeFileSync(preserved, 'USER MODIFIED STALE FILE\n');
        store.database.prepare(`DELETE FROM cm_projects
            WHERE tenant_id = ? AND user_id = ? AND project_id IN (?, ?)`)
            .run('tenant', 'user', 'stale-delete', 'stale-preserve');

        const cleanup = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        assert.deepEqual(cleanup.removed, [deletable_relative]);
        assert.deepEqual(cleanup.preserved, [preserved_relative]);
        assert.equal(existsSync(deletable), false);
        assert.equal(readFileSync(preserved, 'utf8'), 'USER MODIFIED STALE FILE\n');
        const cleaned_manifest = read_manifest(cleanup);
        assert.equal(cleaned_manifest.managed_files.some((entry) => entry.record_id === 'stale-delete'), false);
        assert.equal(cleaned_manifest.managed_files.some((entry) => entry.record_id === 'stale-preserve'), false);

        const user_relative = 'LongMemory/User Notes/important.md';
        const user_file = path.join(vault, ...user_relative.split('/'));
        mkdirSync(path.dirname(user_file), { recursive: true });
        writeFileSync(user_file, 'USER OWNED — DO NOT DELETE\n');
        const forged_manifest = path.join(vault, '.longmemory', 'obsidian-projector-manifest.json');
        mkdirSync(path.dirname(forged_manifest), { recursive: true });
        writeFileSync(forged_manifest, JSON.stringify({
            generator: 'longmemory-obsidian-projector',
            schema_version: 1,
            managed_files: [{
                path: user_relative,
                sha256: sha256('USER OWNED — DO NOT DELETE\n'),
                kind: 'guide',
                record_id: 'forged-user-file',
            }],
        }));
        const after_forgery = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        assert.equal(readFileSync(user_file, 'utf8'), 'USER OWNED — DO NOT DELETE\n');
        assert.deepEqual(after_forgery.removed, []);

        const outside = path.join(container, 'outside.txt');
        writeFileSync(outside, 'DO NOT TOUCH');
        const valid_manifest_bytes = readFileSync(after_forgery.manifest_path, 'utf8');
        const home = path.join(vault, 'LongMemory', 'Home.md');
        const home_bytes = readFileSync(home);
        for (const malicious_path of ['../../outside.txt', 'LongMemory\\..\\outside.txt', 'C:\\outside.txt']) {
            const malicious = JSON.parse(valid_manifest_bytes) as manifest;
            malicious.managed_files.push({
                path: malicious_path,
                sha256: sha256('DO NOT TOUCH'),
                kind: 'guide',
                record_id: 'malicious',
            });
            writeFileSync(after_forgery.manifest_path, `${JSON.stringify(malicious, null, 2)}\n`);
            assert.throws(() => project_central_memory_to_obsidian({
                database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
            }));
            assert.equal(readFileSync(outside, 'utf8'), 'DO NOT TOUCH');
            assert.deepEqual(readFileSync(home), home_bytes);
        }
        const mismatched = JSON.parse(valid_manifest_bytes) as manifest;
        entry_for(mismatched, 'home', 'home').path = 'LongMemory/not-the-home-page.md';
        writeFileSync(after_forgery.manifest_path, `${JSON.stringify(mismatched, null, 2)}\n`);
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        }), /path does not match kind\/record_id/u);
        assert.deepEqual(readFileSync(home), home_bytes);
        writeFileSync(after_forgery.manifest_path, valid_manifest_bytes);
        assert.equal(recursive_files(vault).some((file) => file.endsWith('.longmemory-tmp')), false);
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('rejects nested vault/state roots before creating either root', () => {
    const { store } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-root-separation-'));
    try {
        const vault_with_nested_state = path.join(container, 'vault-with-state');
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault_with_nested_state,
            state_root: path.join(vault_with_nested_state, 'state'),
            tenant_id: 'tenant',
            user_id: 'user',
        }), /state_root must be outside the vault/u);
        assert.equal(existsSync(vault_with_nested_state), false);

        const state_with_nested_vault = path.join(container, 'state-with-vault');
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: path.join(state_with_nested_vault, 'vault'),
            state_root: state_with_nested_vault,
            tenant_id: 'tenant',
            user_id: 'user',
        }), /vault_root must not be nested inside state_root/u);
        assert.equal(existsSync(state_with_nested_vault), false);
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('rejects symlinked or junction vault/state roots', (context) => {
    const { store } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-root-link-'));
    try {
        const real_vault = path.join(container, 'real-vault');
        const real_state = path.join(container, 'real-state');
        const vault_link = path.join(container, 'vault-link');
        const state_link = path.join(container, 'state-link');
        mkdirSync(real_vault);
        mkdirSync(real_state);
        try {
            const link_type = process.platform === 'win32' ? 'junction' : 'dir';
            symlinkSync(real_vault, vault_link, link_type);
            symlinkSync(real_state, state_link, link_type);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                context.skip(`filesystem cannot create directory links: ${code}`);
                return;
            }
            throw error;
        }
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault_link,
            state_root: real_state,
            tenant_id: 'tenant',
            user_id: 'user',
        }), /vault_root cannot be a symlink or junction/u);
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: real_vault,
            state_root: state_link,
            tenant_id: 'tenant',
            user_id: 'user',
        }), /state_root cannot be a symlink or junction/u);
        assert.equal(existsSync(path.join(real_vault, 'LongMemory')), false);
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('recovers an initial projection after every applicable transaction fault phase', () => {
    const phases: ObsidianProjectionFaultPhase[] = [
        'after_prepare',
        'after_inbox',
        'after_write',
        'after_manifest_commit',
    ];
    for (const phase of phases) {
        const { store } = fixture();
        const container = mkdtempSync(path.join(tmpdir(), `longmemory-obsidian-recovery-${phase}-`));
        const vault = path.join(container, 'vault');
        const state_root = path.join(container, 'state');
        try {
            let injected = false;
            assert.throws(() => project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                state_root,
                tenant_id: 'tenant',
                user_id: 'user',
                fault_inject: (current) => {
                    if (!injected && current === phase) {
                        injected = true;
                        throw new Error(`injected ${phase}`);
                    }
                },
            }), new RegExp(`injected ${phase}`, 'u'));
            assert.equal(injected, true, `fault phase was not reached: ${phase}`);
            assert.equal(
                recursive_files(state_root).some((file) => file.endsWith('.journal.json')),
                true,
                `prepared journal missing after ${phase}`,
            );

            const recovered = project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                state_root,
                tenant_id: 'tenant',
                user_id: 'user',
            });
            const value = read_manifest(recovered);
            for (const entry of value.managed_files) {
                const generated = path.join(vault, ...entry.path.split('/'));
                assert.equal(existsSync(generated), true, `missing ${entry.path} after ${phase}`);
                assert.equal(sha256(readFileSync(generated)), entry.sha256, `checksum mismatch after ${phase}`);
            }
            assert.equal(recursive_files(state_root).some((file) => file.endsWith('.journal.json')), false);

            const idempotent = project_central_memory_to_obsidian({
                database: store.database,
                vault_root: vault,
                state_root,
                tenant_id: 'tenant',
                user_id: 'user',
            });
            assert.deepEqual(idempotent.written, []);
            assert.deepEqual(idempotent.removed, []);
            assert.equal(idempotent.unchanged.length, value.managed_files.length);
        } finally {
            store.close();
            rmSync(container, { recursive: true, force: true });
        }
    }
});

test('recovers interrupted additions, updates, and removals', () => {
    const { store, repository } = fixture();
    const container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-change-recovery-'));
    const vault = path.join(container, 'vault');
    const state_root = path.join(container, 'state');
    try {
        project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        repository.register_project({ project_id: 'new-project', name: 'New after baseline', at: 5_000 });
        repository.register_project({ project_id: 'novel', name: 'Updated after baseline', at: 5_001 });
        let write_fault = false;
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            state_root,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (!write_fault && phase === 'after_write') {
                    write_fault = true;
                    throw new Error('injected update write');
                }
            },
        }), /injected update write/u);
        assert.equal(write_fault, true);

        const after_writes = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        const after_write_manifest = read_manifest(after_writes);
        assert.match(read_entry(vault, after_write_manifest, 'project', 'new-project'), /New after baseline/u);
        assert.match(read_entry(vault, after_write_manifest, 'project', 'novel'), /Updated after baseline/u);

        const removed_entry = entry_for(after_write_manifest, 'project', 'new-project');
        const removed_file = path.join(vault, ...removed_entry.path.split('/'));
        store.database.prepare(`DELETE FROM cm_projects
            WHERE tenant_id = ? AND user_id = ? AND project_id = ?`)
            .run('tenant', 'user', 'new-project');
        let remove_fault = false;
        assert.throws(() => project_central_memory_to_obsidian({
            database: store.database,
            vault_root: vault,
            state_root,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (!remove_fault && phase === 'after_remove') {
                    remove_fault = true;
                    throw new Error('injected removal');
                }
            },
        }), /injected removal/u);
        assert.equal(remove_fault, true);

        const after_removal = project_central_memory_to_obsidian({
            database: store.database, vault_root: vault, state_root, tenant_id: 'tenant', user_id: 'user',
        });
        assert.equal(existsSync(removed_file), false);
        assert.equal(read_manifest(after_removal).managed_files.some((entry) => entry.record_id === 'new-project'), false);
        assert.equal(recursive_files(state_root).some((file) => file.endsWith('.journal.json')), false);
    } finally {
        store.close();
        rmSync(container, { recursive: true, force: true });
    }
});

test('never overwrites or deletes a user change made during crash recovery', () => {
    const update = fixture();
    const update_container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-user-update-'));
    const update_vault = path.join(update_container, 'vault');
    const update_state = path.join(update_container, 'state');
    try {
        const baseline = project_central_memory_to_obsidian({
            database: update.store.database,
            vault_root: update_vault,
            state_root: update_state,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        const baseline_manifest = read_manifest(baseline);
        const project_file = path.join(
            update_vault,
            ...entry_for(baseline_manifest, 'project', 'novel').path.split('/'),
        );
        const manifest_before = readFileSync(baseline.manifest_path);
        update.repository.register_project({ project_id: 'novel', name: 'Central update', at: 6_000 });
        assert.throws(() => project_central_memory_to_obsidian({
            database: update.store.database,
            vault_root: update_vault,
            state_root: update_state,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (phase === 'after_prepare') throw new Error('pause before overwrite');
            },
        }), /pause before overwrite/u);
        writeFileSync(project_file, 'USER CHANGE DURING CRASH WINDOW\n');
        assert.throws(() => project_central_memory_to_obsidian({
            database: update.store.database,
            vault_root: update_vault,
            state_root: update_state,
            tenant_id: 'tenant',
            user_id: 'user',
        }), /projection target changed during recovery/u);
        assert.equal(readFileSync(project_file, 'utf8'), 'USER CHANGE DURING CRASH WINDOW\n');
        assert.deepEqual(readFileSync(baseline.manifest_path), manifest_before);
    } finally {
        update.store.close();
        rmSync(update_container, { recursive: true, force: true });
    }

    const removal = fixture();
    const removal_container = mkdtempSync(path.join(tmpdir(), 'longmemory-obsidian-user-removal-'));
    const removal_vault = path.join(removal_container, 'vault');
    const removal_state = path.join(removal_container, 'state');
    try {
        removal.repository.register_project({ project_id: 'remove-me', name: 'Owned before removal', at: 7_000 });
        const baseline = project_central_memory_to_obsidian({
            database: removal.store.database,
            vault_root: removal_vault,
            state_root: removal_state,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        const stale_entry = entry_for(read_manifest(baseline), 'project', 'remove-me');
        const stale_file = path.join(removal_vault, ...stale_entry.path.split('/'));
        removal.store.database.prepare(`DELETE FROM cm_projects
            WHERE tenant_id = ? AND user_id = ? AND project_id = ?`)
            .run('tenant', 'user', 'remove-me');
        assert.throws(() => project_central_memory_to_obsidian({
            database: removal.store.database,
            vault_root: removal_vault,
            state_root: removal_state,
            tenant_id: 'tenant',
            user_id: 'user',
            fault_inject: (phase) => {
                if (phase === 'after_prepare') throw new Error('pause before removal');
            },
        }), /pause before removal/u);
        writeFileSync(stale_file, 'USER SAVED THIS FILE DURING CRASH WINDOW\n');
        const recovered = project_central_memory_to_obsidian({
            database: removal.store.database,
            vault_root: removal_vault,
            state_root: removal_state,
            tenant_id: 'tenant',
            user_id: 'user',
        });
        assert.deepEqual(recovered.preserved, [stale_entry.path]);
        assert.equal(readFileSync(stale_file, 'utf8'), 'USER SAVED THIS FILE DURING CRASH WINDOW\n');
        assert.equal(read_manifest(recovered).managed_files.some((entry) => entry.record_id === 'remove-me'), false);
        assert.equal(recursive_files(removal_state).some((file) => file.endsWith('.journal.json')), false);
    } finally {
        removal.store.close();
        rmSync(removal_container, { recursive: true, force: true });
    }
});
