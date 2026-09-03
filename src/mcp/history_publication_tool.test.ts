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
 *  file  : src/mcp/history_publication_tool.test.ts
 *  usage : tests the LongMemory history publication tool component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { portable_session } from '../cli/porter/types.js';
import { HistoryBackfillService } from '../core/central_memory/history_backfill_service.js';
import type { history_worker_context } from '../core/central_memory/history_backfill_types.js';
import { HistoryPublicationService } from '../core/central_memory/history_publication_service.js';
import {
    codex_history_worker_id,
    HistoryWorkerAuthorizationService,
} from '../core/central_memory/history_worker_authorization.js';
import { count_tokens } from '../core/recall/context_builder.js';
import { bind_codex_task } from '../integrations/codex_hooks/gateway.js';
import { handle_codex_hook } from '../integrations/codex_hooks/hook_bridge.js';
import { CodexHookRegistry } from '../integrations/codex_hooks/registry.js';
import type {
    codex_hook_runtime_options,
    codex_hook_session_state,
} from '../integrations/codex_hooks/types.js';
import { SqliteStore } from '../stores/sqlite/sqlite_store.js';
import { create_longmemory_mcp, type longmemory_mcp } from './mcp_server.js';
import { codex_memory_gateway_tool_names } from './security/tool_allowlist.js';

type json_object = Record<string, unknown>;

const digest = (character: string): string => character.repeat(64);

function text_result(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content;
    assert.ok(Array.isArray(content));
    const text = content.find((item: unknown): item is { type: 'text'; text: string } => (
        Boolean(item) && typeof item === 'object'
        && (item as { type?: unknown }).type === 'text'
        && typeof (item as { text?: unknown }).text === 'string'
    ));
    assert.ok(text);
    return text.text;
}

function json_result(result: Awaited<ReturnType<Client['callTool']>>): json_object {
    assert.notEqual(result.isError, true, text_result(result));
    return JSON.parse(text_result(result)) as json_object;
}

function source_session(source_session_id: string, project_id: string): portable_session {
    return {
        schema_version: '1.0.0',
        source_harness: 'codex',
        source_session_id,
        source_path: `C:\\codex\\${source_session_id}.jsonl`,
        cwd: `D:\\work\\${project_id}`,
        title: `History ${source_session_id}`,
        created_at: 1,
        updated_at: 2,
        turns: [
            { role: 'user', text: `Preserve the exact durable fact from ${source_session_id}.` },
            { role: 'assistant', text: 'The durable fact was verified and completed.' },
        ],
        dropped_turns: 0,
        source_metadata: { parser: 'history-publication-mcp-test' },
    };
}

function seed_candidate(
    backfill: HistoryBackfillService,
    publication: HistoryPublicationService,
    db_path: string,
    project_id: string,
    worker_session_id: string,
    suffix: string,
): string {
    const run = backfill.create_run({
        session: source_session(`source-${project_id}-${suffix}`, project_id),
        evidence: {
            inventory_id: `inventory:${suffix}`,
            reconciliation_digest: digest('a'),
            plan_id: `plan:${suffix}`,
            manifest_hash: digest('b'),
            target_db_path: db_path,
            target_project_id: project_id,
        },
        project_id,
        max_chunk_tokens: 256,
        max_chunk_chars: 2_000,
        at: 10 + Number(suffix.replace(/\D/g, '') || 0),
    });
    const worker: history_worker_context = {
        worker_id: codex_history_worker_id('tenant', 'user', worker_session_id),
        worker_session_id,
        worker_turn_id: `extract-${suffix}`,
        capability_epoch_hash: digest(project_id === 'project-a' ? 'c' : 'd'),
    };
    const claim = backfill.claim_next(worker, 60_000);
    assert.ok(claim);
    assert.equal(claim.run.run_id, run.run_id);
    const part = claim.chunk.source_parts[0]!;
    const finding = {
        kind: 'knowledge' as const,
        title: `Verified history ${suffix}`,
        summary: `A concise durable result for ${suffix}.`,
        body: `The exact reusable conditions for ${suffix} were verified in the historical task.`,
        importance: 0.7,
        is_major: false,
        evidence: [{
            chunk_index: claim.chunk.chunk_index,
            turn_index: part.turn_index,
            part_index: part.part_index,
        }],
    };
    backfill.submit_chunk(worker, claim.lease_id, claim.chunk.chunk_hash, [finding]);
    const reduce_worker = { ...worker, worker_turn_id: `reduce-${suffix}` };
    const reduction = backfill.claim_consolidation(reduce_worker, 60_000);
    assert.ok(reduction);
    assert.equal(reduction.run.run_id, run.run_id);
    backfill.complete_consolidation(reduce_worker, reduction.lease_id, [finding]);
    const item = publication.list(project_id).find((candidate) => candidate.run_id === run.run_id);
    assert.ok(item);
    return item.publication_id;
}

async function connected(config: Parameters<typeof create_longmemory_mcp>[0]): Promise<{
    app: longmemory_mcp;
    client: Client;
}> {
    const app = create_longmemory_mcp(config);
    const client = new Client({ name: 'history-publication-mcp-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await app.server.connect(server_transport);
    await client.connect(client_transport);
    return { app, client };
}

async function close_connected(value: { app: longmemory_mcp; client: Client } | null): Promise<void> {
    if (!value) return;
    await value.client.close();
    await value.app.server.close();
    await value.app.runtime.close();
}

test('history publication MCP separates capability workers from server-attributed human governance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-history-publication-mcp-'));
    const plugin_data = join(root, 'plugin-data');
    const db_path = join(plugin_data, 'central-memory.db');
    const runtime_options: codex_hook_runtime_options = {
        plugin_data,
        db_path,
        tenant_id: 'tenant',
        user_id: 'user',
        project_id: 'detected',
        project_name: 'Detected',
        project_was_configured: false,
        token_budget: 1_800,
    };
    const registry = new CodexHookRegistry(plugin_data);
    const bind = (session_id: string, project_id: string, turn_id: string): codex_hook_session_state => {
        handle_codex_hook({
            session_id,
            transcript_path: null,
            cwd: root,
            hook_event_name: 'SessionStart',
            source: 'startup',
        }, runtime_options);
        const state = registry.activate_turn(session_id, turn_id);
        bind_codex_task(registry, state, {
            session_id,
            capability: state.capability,
            turn_id,
            project_id,
            project_name: project_id,
            responsibility: 'Publish only authorized durable historical candidates.',
        });
        return registry.load(session_id)!;
    };

    let worker_a = bind('publication-worker-a', 'project-a', 'worker-turn-a');
    const worker_b = bind('publication-worker-b', 'project-b', 'worker-turn-b');
    const staging = new SqliteStore(db_path, {
        tenant_id: 'tenant', user_id: 'user', startup_integrity_check: false,
    });
    const backfill = new HistoryBackfillService(staging.database, {
        tenant_id: 'tenant', user_id: 'user', capability_guard: () => undefined,
    });
    const publication = new HistoryPublicationService(staging.database, {
        tenant_id: 'tenant', user_id: 'user', capability_guard: () => undefined,
    });
    const authorizations = new HistoryWorkerAuthorizationService(staging.database, {
        tenant_id: 'tenant', user_id: 'user', now: () => 5,
    });
    for (const [state, project_id] of [
        [worker_a, 'project-a'],
        [worker_b, 'project-b'],
    ] as const) {
        authorizations.authorize({
            project_id,
            worker_session_id: state.session_id,
            worker_id: codex_history_worker_id('tenant', 'user', state.session_id),
            actor_id: 'test-human',
            action_id: `test-authorize:${state.session_id}`,
            evidence: { source: 'history_publication_mcp_test_fixture' },
            at: 5,
        });
    }
    const project_a_publications = Array.from({ length: 12 }, (_, index) => seed_candidate(
        backfill, publication, db_path, 'project-a', worker_a.session_id, `a${index}`,
    ));
    const project_b_publication = seed_candidate(
        backfill, publication, db_path, 'project-b', worker_b.session_id, 'b0',
    );
    staging.close();

    let gateway: Awaited<ReturnType<typeof connected>> | null = null;
    let denied_governance: Awaited<ReturnType<typeof connected>> | null = null;
    let governance: Awaited<ReturnType<typeof connected>> | null = null;
    try {
        gateway = await connected({
            db_path,
            tenant_id: 'tenant',
            user_id: 'user',
            project_id: 'plugin-root',
            profile: 'codex-memory-gateway',
            env: { ...process.env, PLUGIN_DATA: plugin_data },
        });
        const tools = (await gateway.client.listTools()).tools;
        assert.deepEqual(tools.map((tool) => tool.name), [...codex_memory_gateway_tool_names]);
        assert.equal(tools.some((tool) => tool.name === 'longmemory_history_governance'), false);
        const worker_tool = tools.find((tool) => tool.name === 'longmemory_history_publication')!;
        const worker_properties = (worker_tool.inputSchema.properties ?? {}) as json_object;
        for (const forbidden of [
            'project_id', 'worker_id', 'source_session_id', 'source_revision',
            'actor_id', 'actor_kind', 'evidence',
        ]) {
            assert.equal(forbidden in worker_properties, false, `${forbidden} must not be worker-controlled`);
        }

        const call_worker = (
            state: codex_hook_session_state,
            action: string,
            extra: json_object = {},
        ) => gateway!.client.callTool({
            name: 'longmemory_history_publication',
            arguments: {
                action,
                session_id: state.session_id,
                capability: state.capability,
                turn_id: state.capability_turn_id,
                ...extra,
            },
        });

        const cross_project = await call_worker(worker_b, 'get', {
            publication_id: project_a_publications[0],
        });
        assert.equal(cross_project.isError, true);
        assert.match(text_result(cross_project), /outside project|authorization scope/i);

        const list_result = await call_worker(worker_a, 'list', { limit: 5 });
        const list_text = text_result(list_result);
        assert.ok(count_tokens(list_text) <= 1_800);
        assert.doesNotMatch(list_text, new RegExp(worker_a.capability));
        const list = json_result(list_result);
        assert.equal(list.project_id, 'project-a');
        assert.ok((list.items as json_object[]).length > 0);
        assert.equal((list.items as json_object[]).some((item) => (
            item.publication_id === project_b_publication
        )), false);
        assert.equal(list.next_offset, 5, 'bounded publication listings must remain pageable');

        const get_result = await call_worker(worker_a, 'get', {
            publication_id: project_a_publications[0],
        });
        assert.ok(count_tokens(text_result(get_result)) <= 1_800);
        assert.doesNotMatch(text_result(get_result), new RegExp(worker_a.capability));
        assert.equal((json_result(get_result).publication as json_object).publication_id,
            project_a_publications[0]);

        const old_worker_a = worker_a;
        worker_a = registry.activate_turn(worker_a.session_id, 'worker-turn-a-next');
        const stale = await call_worker(old_worker_a, 'get', {
            publication_id: project_a_publications[0],
        });
        assert.equal(stale.isError, true);
        assert.match(text_result(stale), /invalid Codex turn capability/);

        const level_one = json_result(await call_worker(worker_a, 'propose_hierarchy', {
            publication_id: project_a_publications[0],
            level: 1,
            role: { mode: 'none' },
            task: { mode: 'none' },
            confidence: 0.98,
        }));
        const level_one_proposal = level_one.proposal as json_object;
        const plan_result = json_result(await call_worker(worker_a, 'create_plan', {
            publication_id: project_a_publications[0],
            proposal_id: level_one_proposal.proposal_id,
            memory_kind: 'knowledge',
            semantic_key: 'verified level one historical knowledge',
        }));
        const plan = plan_result.plan as json_object;
        const executed_result = await call_worker(worker_a, 'execute', {
            publication_id: project_a_publications[0],
            plan_version: plan.plan_version,
            attempt_id: 'publication-attempt-level-one',
        });
        assert.ok(count_tokens(text_result(executed_result)) <= 1_800);
        const executed = json_result(executed_result);
        assert.equal((executed.publication as json_object).status, 'pending_confirmation');
        assert.equal((executed.attempt as json_object).outcome, 'pending_confirmation');
        const reconciled_pending = json_result(await call_worker(worker_a, 'reconcile_confirmation', {
            publication_id: project_a_publications[0],
        }));
        assert.equal((reconciled_pending.publication as json_object).status, 'pending_confirmation');

        const governed_proposal_result = json_result(await call_worker(worker_a, 'propose_hierarchy', {
            publication_id: project_a_publications[1],
            level: 4,
            role: {
                mode: 'proposed', semantic_key: 'novel illustration',
                name: 'Novel illustration', responsibility: 'Create and improve novel artwork.',
            },
            task: {
                mode: 'proposed', semantic_key: 'learned rendering practice',
                title: 'Rendering practice', objective: 'Transfer verified drawing lessons.',
            },
            confidence: 0.91,
        }));
        const governed_proposal = governed_proposal_result.proposal as json_object;
        const proposal_inspection = new SqliteStore(db_path, {
            tenant_id: 'tenant', user_id: 'user', startup_integrity_check: false,
        });
        const stored_proposal = proposal_inspection.database.prepare(`SELECT capability_epoch_hash
            FROM cm_history_hierarchy_proposals WHERE tenant_id=? AND user_id=? AND proposal_id=?`)
            .get('tenant', 'user', governed_proposal.proposal_id) as { capability_epoch_hash: string };
        proposal_inspection.close();
        assert.match(stored_proposal.capability_epoch_hash, /^[a-f0-9]{64}$/);
        assert.notEqual(stored_proposal.capability_epoch_hash, worker_a.capability);

        const forbidden_worker_action = await call_worker(worker_a, 'accept_hierarchy', {
            publication_id: project_a_publications[1],
            proposal_id: governed_proposal.proposal_id,
        });
        assert.equal(forbidden_worker_action.isError, true);
        const absent_governance = await gateway.client.callTool({
            name: 'longmemory_history_governance',
            arguments: {
                action: 'accept_hierarchy',
                publication_id: project_a_publications[1],
                proposal_id: governed_proposal.proposal_id,
                action_id: 'must-not-reach-governance',
                channel: 'codex_ui',
                evidence: { ui_event_id: 'event-forbidden' },
            },
        });
        assert.equal(absent_governance.isError, true);
        assert.match(text_result(absent_governance), /not found/i);

        denied_governance = await connected({
            db_path,
            tenant_id: 'tenant',
            user_id: 'user',
            project_id: 'project-a',
            allowed_tools: ['longmemory_history_governance'],
        });
        const denied = await denied_governance.client.callTool({
            name: 'longmemory_history_governance',
            arguments: {
                action: 'accept_hierarchy',
                publication_id: project_a_publications[1],
                proposal_id: governed_proposal.proposal_id,
                action_id: 'ordinary-runtime-cannot-approve',
                channel: 'codex_ui',
                evidence: { ui_event_id: 'event-denied' },
            },
        });
        assert.equal(denied.isError, true);
        assert.match(text_result(denied), /central_memory_approver/);

        governance = await connected({
            db_path,
            tenant_id: 'tenant',
            user_id: 'user',
            project_id: 'project-a',
            roles: ['central_memory_approver'],
            allowed_tools: ['longmemory_history_governance'],
        });
        const governance_tool = (await governance.client.listTools()).tools[0]!;
        const governance_properties = (governance_tool.inputSchema.properties ?? {}) as json_object;
        for (const server_identity of ['actor_id', 'actor_kind', 'project_id']) {
            assert.equal(server_identity in governance_properties, false,
                `${server_identity} must be supplied by the trusted runtime`);
        }
        const empty_evidence = await governance.client.callTool({
            name: 'longmemory_history_governance',
            arguments: {
                action: 'accept_hierarchy',
                publication_id: project_a_publications[1],
                proposal_id: governed_proposal.proposal_id,
                action_id: 'empty-evidence',
                channel: 'codex_ui',
                evidence: {},
            },
        });
        assert.equal(empty_evidence.isError, true);
        assert.match(text_result(empty_evidence), /evidence/i);

        const accepted_result = await governance.client.callTool({
            name: 'longmemory_history_governance',
            arguments: {
                action: 'accept_hierarchy',
                publication_id: project_a_publications[1],
                proposal_id: governed_proposal.proposal_id,
                action_id: 'human-accepted-hierarchy',
                channel: 'codex_ui',
                evidence: { ui_event_id: 'event-accepted', acted_at: 123_456 },
                actor_id: 'forged-worker-identity',
                actor_kind: 'policy',
            },
        });
        assert.ok(count_tokens(text_result(accepted_result)) <= 1_800);
        const accepted = json_result(accepted_result);
        assert.equal((accepted.decision as json_object).actor_id, 'user');
        assert.equal((accepted.decision as json_object).actor_kind, 'user');

        const decision_inspection = new SqliteStore(db_path, {
            tenant_id: 'tenant', user_id: 'user', startup_integrity_check: false,
        });
        const stored_decision = decision_inspection.database.prepare(`SELECT actor_id, actor_kind
            FROM cm_history_governance_decisions WHERE tenant_id=? AND user_id=? AND action_id=?`)
            .get('tenant', 'user', 'human-accepted-hierarchy') as { actor_id: string; actor_kind: string };
        decision_inspection.close();
        assert.deepEqual(stored_decision, { actor_id: 'user', actor_kind: 'user' });

        const cross_project_governance = await governance.client.callTool({
            name: 'longmemory_history_governance',
            arguments: {
                action: 'discard',
                publication_id: project_b_publication,
                action_id: 'cross-project-discard',
                channel: 'local_cli',
                evidence: { command_event_id: 'cross-project-event' },
            },
        });
        assert.equal(cross_project_governance.isError, true);
        assert.match(text_result(cross_project_governance), /outside project/i);

        const governed_plan_result = json_result(await call_worker(worker_a, 'create_plan', {
            publication_id: project_a_publications[1],
            proposal_id: governed_proposal.proposal_id,
            memory_kind: 'knowledge',
            semantic_key: 'verified rendering practice',
        }));
        const governed_plan = governed_plan_result.plan as json_object;
        const governed_execution = json_result(await call_worker(worker_a, 'execute', {
            publication_id: project_a_publications[1],
            plan_version: governed_plan.plan_version,
            attempt_id: 'publication-attempt-governed',
        }));
        assert.equal((governed_execution.publication as json_object).status, 'published');
        assert.equal((governed_execution.attempt as json_object).outcome, 'created');
    } finally {
        await close_connected(governance);
        await close_connected(denied_governance);
        await close_connected(gateway);
        rmSync(root, { recursive: true, force: true });
    }
});
