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
 *  file  : src/mcp/central_memory_tools.test.ts
 *  usage : tests the LongMemory central memory tools component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcp_audit_log } from './security/audit.js';
import {
    codex_memory_gateway_tool_names,
    create_tool_allowlist,
    mcp_tool_names,
} from './security/tool_allowlist.js';
import { create_longmemory_mcp } from './mcp_server.js';
import { mcp_runtime } from './runtime.js';
import { run_audited_tool } from './tools/common.js';

type json_object = Record<string, unknown>;

test('the Codex memory gateway profile exposes no legacy or governance bypass tools', async () => {
    assert.throws(() => create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'plugin-root',
        profile: 'codex-memory-gateway',
        allowed_tools: ['longmemory_codex_memory', 'longmemory_ingest'],
    }), /profile codex-memory-gateway cannot allow tool longmemory_ingest/);

    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'plugin-root',
        profile: 'codex-memory-gateway',
        roles: ['central_memory_approver', 'central_memory_cross_thread'],
        central_thread_id: 'forged-broadening-attempt',
        audit: new mcp_audit_log(),
    });
    const client = new Client({ name: 'codex-memory-gateway-profile-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);
    try {
        const capabilities = client.getServerCapabilities();
        assert.ok(capabilities?.tools);
        assert.equal(capabilities && 'resources' in capabilities, false);
        assert.equal(capabilities && 'prompts' in capabilities, false);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.deepEqual(names, [...codex_memory_gateway_tool_names]);
        assert.deepEqual([...runtime.access.allowed_tools], [...codex_memory_gateway_tool_names]);
        assert.equal(runtime.profile, 'codex-memory-gateway');
        const legacy = await client.callTool({
            name: 'longmemory_ingest',
            arguments: { project_id: 'victim-project', content: 'bypass the governed queue' },
        });
        assert.equal(legacy.isError, true);
        assert.match(JSON.stringify(legacy.content), /Tool longmemory_ingest not found/);
        assert.equal(runtime.audit.entries().length, 0,
            'an unregistered legacy tool cannot reach the LongMemory audit/write wrapper');
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});

test('human decisions are omitted from the default MCP allowlist while conflict discovery remains available', async () => {
    assert.equal(create_tool_allowlist().has('longmemory_central_confirmation'), false);
    assert.equal(create_tool_allowlist().has('longmemory_history_governance'), false);
    assert.equal(create_tool_allowlist().has('longmemory_central_project_link'), false);
    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
    });
    const client = new Client({ name: 'central-memory-default-tools-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);
    try {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
        assert.equal(names.has('longmemory_central_confirmation'), false);
        assert.equal(names.has('longmemory_history_governance'), false);
        assert.equal(names.has('longmemory_central_project_link'), false);
        assert.equal(names.has('longmemory_central_conflict'), true);
        assert.equal(names.has('longmemory_central_publish'), false);
        assert.equal(names.has('longmemory_recall'), true);
        const conflicts = await client.callTool({
            name: 'longmemory_central_conflict',
            arguments: { action: 'list', project_id: 'novel', status: 'open' },
        });
        assert.notEqual(conflicts.isError, true, JSON.stringify(conflicts.content));
        assert.equal((conflicts.structuredContent as json_object).count, 0);
        assert.equal(runtime.audit.entries().length, 1);
        assert.equal(runtime.audit.failures().length, 0,
            'an in-memory SQLite runtime must not derive a filesystem audit path');
        const denied_report = await client.callTool({
            name: 'longmemory_central_conflict',
            arguments: {
                action: 'report', project_id: 'novel',
                memory_a_id: 'left', memory_a_version: 1,
                memory_b_id: 'right', memory_b_version: 1,
                severity: 0.5, rationale: 'An unattributed report must be rejected.',
            },
        });
        assert.equal(denied_report.isError, true);
        assert.match(JSON.stringify(denied_report.content), /requires a trusted central_thread_id/);
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});

test('project-link MCP governance creates and revokes explicit L4-only directions', async () => {
    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        roles: ['central_memory_approver', 'central_memory_admin'], audit: new mcp_audit_log(),
    });
    const service = runtime.memory.centralMemory()!;
    service.repository.register_project({ project_id: 'novel', name: 'Novel', at: 1 });
    service.repository.register_project({ project_id: 'painting', name: 'Painting', at: 2 });
    const client = new Client({ name: 'central-project-links-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);
    const actor = (action_id: string) => ({
        actor_id: 'user', actor_kind: 'user', action_id,
        channel: 'codex_ui', decided_at: 10,
        evidence: { user_turn_id: `turn-${action_id}`, explicit_user_action: true },
    });
    try {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
        assert.equal(names.has('longmemory_central_project_link'), true);
        const created = await client.callTool({
            name: 'longmemory_central_project_link',
            arguments: {
                action: 'create', project_id: 'novel', source_project_id: 'painting',
                target_project_id: 'novel', direction: 'two_way', actor: actor('link-two-way'),
                metadata: { purpose: 'novel illustration coordination' },
            },
        });
        assert.notEqual(created.isError, true, JSON.stringify(created.content));
        const links = (created.structuredContent as json_object).links as json_object[];
        assert.equal(links.length, 2);
        assert.equal(links.every((link) => link.status === 'active'), true);

        const listed = await client.callTool({
            name: 'longmemory_central_project_link',
            arguments: { action: 'list', project_id: 'novel', status: 'active' },
        });
        assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
        assert.equal((listed.structuredContent as json_object).count, 2);

        const forward = links.find((link) => link.source_project_id === 'painting')!;
        const revoked = await client.callTool({
            name: 'longmemory_central_project_link',
            arguments: {
                action: 'revoke', project_id: 'novel', link_id: forward.link_id,
                actor: actor('revoke-forward'),
            },
        });
        assert.notEqual(revoked.isError, true, JSON.stringify(revoked.content));
        assert.equal(((revoked.structuredContent as json_object).link as json_object).status, 'revoked');
        assert.equal(service.repository.find_active_project_link('painting', 'novel'), null);
        assert.ok(service.repository.find_active_project_link('novel', 'painting'));
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});

test('cross-thread capability does not replace a trusted source thread for conflict reports', async () => {
    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        roles: ['central_memory_cross_thread'], audit: new mcp_audit_log(),
    });
    const client = new Client({ name: 'central-memory-conflict-attribution-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);
    try {
        const denied = await client.callTool({
            name: 'longmemory_central_conflict',
            arguments: {
                action: 'report', project_id: 'novel',
                memory_a_id: 'left', memory_a_version: 1,
                memory_b_id: 'right', memory_b_version: 1,
                severity: 0.5, rationale: 'Cross-thread access is not report provenance.',
            },
        });
        assert.equal(denied.isError, true);
        assert.match(JSON.stringify(denied.content), /requires a trusted central_thread_id/);
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});

test('the CLI approver role enables confirmation in role-derived defaults but not explicit allowlists', async () => {
    const approver = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        roles: ['central_memory_approver'], audit: new mcp_audit_log(),
    });
    const approver_client = new Client({ name: 'central-memory-cli-approver-test', version: '1.0.0' });
    const [approver_client_transport, approver_server_transport] = InMemoryTransport.createLinkedPair();
    await approver.server.connect(approver_server_transport);
    await approver_client.connect(approver_client_transport);
    try {
        const names = new Set((await approver_client.listTools()).tools.map((tool) => tool.name));
        assert.equal(names.has('longmemory_central_confirmation'), true);
        assert.equal(names.has('longmemory_history_governance'), true);
        assert.equal(names.has('longmemory_central_register_thread'), false,
            'an approver role does not invent a thread principal');
    } finally {
        await approver_client.close();
        await approver.server.close();
        await approver.runtime.close();
    }

    const explicit = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        roles: ['central_memory_approver'], allowed_tools: ['longmemory_recall'],
        audit: new mcp_audit_log(),
    });
    const explicit_client = new Client({ name: 'central-memory-explicit-allowlist-test', version: '1.0.0' });
    const [explicit_client_transport, explicit_server_transport] = InMemoryTransport.createLinkedPair();
    await explicit.server.connect(explicit_server_transport);
    await explicit_client.connect(explicit_client_transport);
    try {
        const names = new Set((await explicit_client.listTools()).tools.map((tool) => tool.name));
        assert.deepEqual([...names], ['longmemory_recall']);
    } finally {
        await explicit_client.close();
        await explicit.server.close();
        await explicit.runtime.close();
    }
});

test('persistent audit failures remain observable without changing a successful tool result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longmemory-audit-'));
    const blocker = join(directory, 'not-a-directory');
    writeFileSync(blocker, 'blocks recursive directory creation', 'utf8');
    const audit = new mcp_audit_log(join(blocker, 'audit.jsonl'));
    const runtime = new mcp_runtime({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        allowed_tools: mcp_tool_names, audit,
    });
    let executions = 0;
    try {
        const result = await run_audited_tool(runtime, 'longmemory_central_conflict',
            { project_id: 'novel' }, async () => {
                executions += 1;
                return { ok: true };
            });
        assert.equal(executions, 1);
        assert.deepEqual(result.structuredContent, { ok: true });
        assert.equal(audit.entries().length, 1);
        assert.equal(audit.entries()[0]?.outcome, 'allowed');
        assert.equal(audit.failures().length, 1);
        assert.equal(audit.last_failure()?.entry_id, audit.entries()[0]?.id);
        assert.match(audit.last_failure()?.error ?? '', /not-a-directory|not a directory|ENOTDIR|EEXIST/i);
    } finally {
        await runtime.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the common MCP boundary keeps credential-bearing input and errors out of every audit surface', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longmemory-safe-audit-'));
    const audit_path = join(directory, 'audit.jsonl');
    const audit = new mcp_audit_log(audit_path);
    const runtime = new mcp_runtime({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        allowed_tools: mcp_tool_names, audit,
    });
    const credential = 'unsafe-mcp-audit-value-123456';
    let executed = false;
    try {
        await assert.rejects(
            () => run_audited_tool(runtime, 'longmemory_central_conflict', {
                project_id: 'novel', conflict_id: `password=${credential}`,
            }, async () => {
                executed = true;
                throw new Error(`password=${credential}`);
            }),
            (error) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /prohibited credential material/i);
                assert.doesNotMatch(error.message, new RegExp(credential));
                return true;
            },
        );
        assert.equal(executed, false, 'credential input must be rejected before tool execution');
        assert.equal(audit.entries().length, 1);
        assert.doesNotMatch(JSON.stringify(audit.entries()), new RegExp(credential));
        assert.doesNotMatch(readFileSync(audit_path, 'utf8'), new RegExp(credential));

        audit.record({
            tool: 'longmemory_central_conflict', user_id: `password=${credential}`,
            project_id: `password=${credential}`, outcome: 'error', dry_run: null,
            started_at: 1, completed_at: 2, error: `password=${credential}`,
        });
        assert.doesNotMatch(JSON.stringify(audit.entries()), new RegExp(credential));
        assert.doesNotMatch(readFileSync(audit_path, 'utf8'), new RegExp(credential));
    } finally {
        await runtime.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('ordinary thread runtimes may report conflicts but cannot resolve or dismiss them', async () => {
    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:', tenant_id: 'tenant', user_id: 'user', project_id: 'novel',
        central_thread_id: 'thread-write',
        audit: new mcp_audit_log(),
    });
    const client = new Client({ name: 'central-memory-conflict-permissions-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);

    const call = async (name: string, args: json_object): Promise<json_object> => {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.ok(result.structuredContent);
        return result.structuredContent as json_object;
    };

    try {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
        assert.equal(names.has('longmemory_central_conflict'), true);
        assert.equal(names.has('longmemory_central_confirmation'), false);

        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', project_name: 'Novel',
            responsibility: 'Detect contradictions in the project memory.',
        });
        for (const memory of [
            { memory_id: 'conflict-left', summary: 'Always open with action.', body: 'Every chapter opens with action.' },
            { memory_id: 'conflict-right', summary: 'Always open quietly.', body: 'Every chapter opens with quiet atmosphere.' },
        ]) {
            await call('longmemory_central_publish', {
                ...memory,
                project_id: 'novel', level: 4, memory_kind: 'procedure',
                title: memory.memory_id, source_thread_id: 'thread-write',
            });
        }

        const reported = await call('longmemory_central_conflict', {
            action: 'report', project_id: 'novel', conflict_id: 'ordinary-report',
            memory_a_id: 'conflict-left', memory_a_version: 1,
            memory_b_id: 'conflict-right', memory_b_version: 1,
            severity: 0.8, rationale: 'The opening rules are mutually exclusive.',
            metadata: { detector: 'automatic-comparison' },
        });
        assert.equal(reported.source_thread_id, 'thread-write');
        assert.equal((reported.conflict as json_object).status, 'open');
        assert.deepEqual((reported.conflict as json_object).metadata, {
            detector: 'automatic-comparison', source_thread_id: 'thread-write',
        });
        const forged_source = await client.callTool({
            name: 'longmemory_central_conflict',
            arguments: {
                action: 'report', project_id: 'novel', conflict_id: 'forged-source',
                memory_a_id: 'conflict-left', memory_a_version: 1,
                memory_b_id: 'conflict-right', memory_b_version: 1,
                severity: 0.8, rationale: 'A forged source must not be accepted.',
                metadata: { source_thread_id: 'thread-other' },
            },
        });
        assert.equal(forged_source.isError, true);
        assert.match(JSON.stringify(forged_source.content), /source_thread_id is reserved/);
        const listed = await call('longmemory_central_conflict', {
            action: 'list', project_id: 'novel', status: 'open',
        });
        assert.equal(listed.count, 1);

        for (const arguments_ of [
            {
                action: 'resolve', project_id: 'novel', conflict_id: 'ordinary-report',
                resolution_memory_id: 'conflict-left', resolution_version: 1,
                actor: {
                    actor_id: 'user', actor_kind: 'user', action_id: 'attempted-resolution',
                    channel: 'codex_ui', decided_at: 10,
                    evidence: { user_turn_id: 'turn-resolution' },
                },
            },
            {
                action: 'dismiss', project_id: 'novel', conflict_id: 'ordinary-report',
                actor: {
                    actor_id: 'user', actor_kind: 'user', action_id: 'attempted-dismissal',
                    channel: 'codex_ui', decided_at: 11,
                    evidence: { user_turn_id: 'turn-dismissal' },
                },
            },
        ]) {
            const denied = await client.callTool({ name: 'longmemory_central_conflict', arguments: arguments_ });
            assert.equal(denied.isError, true);
            assert.match(JSON.stringify(denied.content), /requires a trusted approver runtime/);
        }
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});

test('central-memory MCP protocol covers registration, safe sync, publishing, confirmation, usage and turn finalization', async () => {
    const audit = new mcp_audit_log();
    const { server, runtime } = create_longmemory_mcp({
        db_path: ':memory:',
        tenant_id: 'tenant',
        user_id: 'user',
        project_id: 'novel',
        central_thread_id: 'thread-write',
        roles: ['central_memory_approver'],
        allowed_tools: mcp_tool_names,
        audit,
    });
    const client = new Client({ name: 'central-memory-protocol-test', version: '1.0.0' });
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair();
    await server.connect(server_transport);
    await client.connect(client_transport);

    const call = async (name: string, args: json_object): Promise<json_object> => {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.ok(result.structuredContent);
        return result.structuredContent as json_object;
    };

    try {
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        for (const name of [
            'longmemory_central_register_thread',
            'longmemory_central_context',
            'longmemory_central_publish',
            'longmemory_central_confirmation',
            'longmemory_central_conflict',
            'longmemory_central_usage',
            'longmemory_central_finalize_turn',
        ]) assert.ok(names.has(name), `${name} should be exposed`);

        const cross_thread = await client.callTool({
            name: 'longmemory_central_register_thread',
            arguments: { thread_id: 'thread-other', project_id: 'novel' },
        });
        assert.equal(cross_thread.isError, true);
        assert.match(JSON.stringify(cross_thread.content), /permission denied for central thread/);

        const registration_secret = 'unsafe-mcp-registration-value-123456';
        const rejected_registration = await client.callTool({
            name: 'longmemory_central_register_thread',
            arguments: {
                thread_id: 'thread-write', project_id: 'novel', project_name: 'Novel',
                responsibility: `password=${registration_secret}`,
            },
        });
        assert.equal(rejected_registration.isError, true);
        assert.match(JSON.stringify(rejected_registration.content), /prohibited credential material/i);
        assert.doesNotMatch(JSON.stringify(rejected_registration.content), new RegExp(registration_secret));
        assert.doesNotMatch(JSON.stringify(audit.entries().at(-1)), new RegExp(registration_secret));
        assert.throws(() => runtime.memory.centralMemory()!.repository.require_project('novel'), /was not found/);

        const secret_project_id = `password=${registration_secret}`;
        const rejected_secret_project = await client.callTool({
            name: 'longmemory_central_register_thread',
            arguments: { thread_id: 'thread-write', project_id: secret_project_id },
        });
        assert.equal(rejected_secret_project.isError, true);
        assert.doesNotMatch(JSON.stringify(rejected_secret_project.content), new RegExp(registration_secret));
        assert.doesNotMatch(JSON.stringify(audit.entries().at(-1)), new RegExp(registration_secret));
        assert.equal(audit.entries().at(-1)?.project_id, 'novel');

        const registered = await call('longmemory_central_register_thread', {
            thread_id: 'thread-write',
            project_id: 'novel',
            project_name: 'Novel',
            project_description: 'A serialized novel project.',
            role_id: 'writer',
            role_name: 'Writer',
            role_responsibility: 'Maintain prose and story continuity.',
            task_id: 'chapter-one',
            task_title: 'Write chapter one',
            task_objective: 'Produce a coherent opening chapter.',
            responsibility: 'Draft and revise chapter one.',
        });
        assert.equal((registered.thread as json_object).task_id, 'chapter-one');
        const central = runtime.memory.centralMemory();
        assert.ok(central);

        const deep_secret = 'unsafe-deep-mcp-value-123456';
        let nested_metadata: unknown = `password=${deep_secret}`;
        for (let depth = 0; depth < 32; depth += 1) nested_metadata = { nested: nested_metadata };
        const rejected_deep_metadata = await client.callTool({
            name: 'longmemory_central_publish',
            arguments: {
                memory_id: 'deep-secret-attempt', project_id: 'novel', role_id: 'writer',
                task_id: 'chapter-one', level: 4, memory_kind: 'knowledge',
                title: 'Deep metadata attempt', summary: 'Must be rejected.',
                body: 'The visible memory body itself is harmless.', source_thread_id: 'thread-write',
                metadata: { nested: nested_metadata },
            },
        });
        assert.equal(rejected_deep_metadata.isError, true);
        assert.match(JSON.stringify(rejected_deep_metadata.content), /prohibited credential material/i);
        assert.doesNotMatch(JSON.stringify(rejected_deep_metadata.content), new RegExp(deep_secret));
        assert.equal(central.repository.get_memory('deep-secret-attempt'), null);

        const registration_snapshot = () => ({
            project_updated_at: central.repository.require_project('novel').updated_at,
            role_updated_at: central.repository.require_role('writer').updated_at,
            task_updated_at: central.repository.require_task('chapter-one').updated_at,
            thread_updated_at: central.repository.require_thread('thread-write').updated_at,
            subscriptions: central.repository.database.prepare(`SELECT subscription_id, enabled, updated_at
                FROM cm_subscriptions WHERE tenant_id=? AND user_id=? AND thread_id=? ORDER BY subscription_id`)
                .all(central.repository.tenant_id, central.repository.user_id, 'thread-write'),
            outbox_count: (central.repository.database.prepare(`SELECT COUNT(*) AS count FROM cm_outbox
                WHERE tenant_id=? AND user_id=?`)
                .get(central.repository.tenant_id, central.repository.user_id) as { count: number }).count,
        });
        const project_subscription_enabled = () => Boolean((central.repository.database.prepare(`SELECT enabled
            FROM cm_subscriptions WHERE tenant_id=? AND user_id=? AND subscription_id=?`)
            .get(central.repository.tenant_id, central.repository.user_id,
                'thread:thread-write:project:novel') as { enabled: number }).enabled);

        const initial_registration_state = registration_snapshot();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write',
            project_id: 'novel',
            project_name: 'Novel',
            project_description: 'A serialized novel project.',
            role_id: 'writer',
            role_name: 'Writer',
            role_responsibility: 'Maintain prose and story continuity.',
            task_id: 'chapter-one',
            task_title: 'Write chapter one',
            task_objective: 'Produce a coherent opening chapter.',
            responsibility: 'Draft and revise chapter one.',
        });
        assert.deepEqual(registration_snapshot(), initial_registration_state,
            'an identical registration must not refresh governance or subscription timestamps');

        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', subscribe_to_project: false,
        });
        assert.equal(project_subscription_enabled(), false);
        const disabled_registration_state = registration_snapshot();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', subscribe_to_project: false,
        });
        assert.deepEqual(registration_snapshot(), disabled_registration_state,
            'repeating an explicit false must not refresh subscription state');
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel',
            responsibility: 'Draft chapter one after a scope review.',
        });
        assert.equal(project_subscription_enabled(), false,
            'omitting subscribe_to_project must preserve the disabled subscription');
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', subscribe_to_project: true,
        });
        assert.equal(project_subscription_enabled(), true,
            'an explicit true must restore the disabled project subscription');
        const enabled_registration_state = registration_snapshot();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', subscribe_to_project: true,
        });
        assert.deepEqual(registration_snapshot(), enabled_registration_state,
            'repeating an explicit true must not refresh subscription state');

        const governance_override = await client.callTool({
            name: 'longmemory_central_register_thread',
            arguments: {
                thread_id: 'thread-write', project_id: 'novel', project_name: 'Unauthorized rename',
            },
        });
        assert.equal(governance_override.isError, true);
        assert.match(JSON.stringify(governance_override.content), /requires central_memory_admin/);

        const first = await call('longmemory_central_publish', {
            memory_id: 'opening-rule',
            project_id: 'novel',
            role_id: 'writer',
            task_id: 'chapter-one',
            level: 4,
            memory_kind: 'procedure',
            title: 'Opening rule',
            summary: 'Open with a concrete conflict.',
            body: 'The first scene introduces a visible conflict before exposition.',
            source_thread_id: 'thread-write',
            sources: [{
                source_id: 'source-turn-1',
                source_kind: 'codex_turn',
                uri: 'codex://threads/thread-write#turn-1',
                thread_id: 'thread-write',
                turn_id: 'turn-1',
            }],
        });
        assert.equal(first.effective, true);
        assert.equal((first.version as json_object).version, 1);

        const synced = await call('longmemory_central_context', {
            thread_id: 'thread-write',
            project_id: 'novel',
            action: 'sync',
        });
        const initial_packet = synced.packet as json_object;
        assert.equal((synced.included as json_object[])[0]?.version, 1);
        assert.match(String(initial_packet.text), /The first scene introduces a visible conflict/);
        assert.equal(Object.hasOwn(synced, 'context'), false,
            'central context must not return an unbudgeted raw body array');
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel',
            responsibility: 'A deliberately oversized responsibility. '.repeat(1_000),
        });
        const tightly_budgeted = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read', token_budget: 64,
        });
        assert.ok(Number((tightly_budgeted.packet as json_object).tokens_used) <= 64);
        assert.equal((tightly_budgeted.packet as json_object).within_budget, true);
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', project_name: 'Novel',
            project_description: 'A serialized novel project.', role_id: 'writer', role_name: 'Writer',
            role_responsibility: 'Maintain prose and story continuity.', task_id: 'chapter-one',
            task_title: 'Write chapter one', task_objective: 'Produce a coherent opening chapter.',
            responsibility: 'Draft chapter one after a scope review.',
        });
        const after_repeated_registration = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read',
        });
        assert.equal(after_repeated_registration.pending_count, 0);
        assert.equal((after_repeated_registration.included as json_object[])[0]?.version, 1);

        const consumed = await call('longmemory_central_usage', {
            action: 'consume',
            thread_id: 'thread-write',
            project_id: 'novel',
            memory_id: 'opening-rule',
            memory_version: 1,
        });
        assert.equal(((consumed.workset as json_object).consumed_version), 1);
        const consumed_default = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read',
        });
        assert.equal((consumed_default.included as json_object[]).length, 0);
        assert.deepEqual(((consumed_default.packet as json_object).omitted as json_object[])
            .map((entry) => entry.reason), ['already_consumed']);
        const consumed_explicit = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read', include_consumed: true,
        });
        assert.equal((consumed_explicit.included as json_object[])[0]?.version, 1);
        assert.match(String((consumed_explicit.packet as json_object).text), /The first scene introduces a visible conflict/);

        const dependency = await call('longmemory_central_usage', {
            action: 'dependency',
            thread_id: 'thread-write',
            project_id: 'novel',
            memory_id: 'opening-rule',
            memory_version: 1,
            subject_kind: 'artifact',
            subject_id: 'chapter-one.md',
            details: { section: 'opening' },
        });
        assert.equal((dependency.dependency as json_object).status, 'current');
        const repeated_dependency = await call('longmemory_central_usage', {
            action: 'dependency',
            thread_id: 'thread-write',
            project_id: 'novel',
            memory_id: 'opening-rule',
            memory_version: 1,
            subject_kind: 'artifact',
            subject_id: 'chapter-one.md',
            details: { section: 'opening' },
        });
        assert.equal(repeated_dependency.already_recorded, true);
        const conflicting_dependency = await client.callTool({
            name: 'longmemory_central_usage',
            arguments: {
                action: 'dependency', thread_id: 'thread-write', project_id: 'novel',
                memory_id: 'opening-rule', memory_version: 1, subject_kind: 'artifact',
                subject_id: 'chapter-one.md', details: { section: 'different-opening' },
            },
        });
        assert.equal(conflicting_dependency.isError, true);
        assert.match(JSON.stringify(conflicting_dependency.content), /idempotency conflict/);

        const proposed = await call('longmemory_central_publish', {
            memory_id: 'opening-rule',
            project_id: 'novel',
            role_id: 'writer',
            task_id: 'chapter-one',
            level: 4,
            memory_kind: 'procedure',
            title: 'Opening rule',
            summary: 'Open in medias res.',
            body: 'Every opening starts in medias res before any exposition.',
            expected_current_version: 1,
            major: true,
            // Deliberately undeclared: Zod strips it, so callers cannot restore the removed bypass.
            confirmed: true,
            source_thread_id: 'thread-write',
        });
        assert.equal(proposed.effective, false);
        const confirmation_id = (proposed.confirmation as json_object).confirmation_id as string;

        const denied_confirmation = await client.callTool({
            name: 'longmemory_central_confirmation',
            arguments: {
                action: 'approve',
                confirmation_id,
                project_id: 'novel',
                actor: {
                    actor_id: 'automatic-agent',
                    actor_kind: 'user',
                    action_id: 'forged-action',
                    channel: 'codex_ui',
                    decided_at: 4_999,
                    evidence: { user_turn_id: 'forged-turn' },
                },
            },
        });
        assert.equal(denied_confirmation.isError, true);
        assert.match(JSON.stringify(denied_confirmation.content), /permission denied for confirmation actor/);

        const approved = await call('longmemory_central_confirmation', {
            action: 'approve',
            confirmation_id,
            project_id: 'novel',
            decision_note: 'Approved in the Codex UI.',
            actor: {
                actor_id: 'user',
                actor_kind: 'user',
                action_id: 'ui-action-approve-1',
                channel: 'codex_ui',
                decided_at: 5_000,
                evidence: { user_turn_id: 'turn-approval-1' },
            },
        });
        assert.equal(approved.effective, true);
        assert.equal((approved.version as json_object).version, 2);

        const refreshed = await call('longmemory_central_context', {
            thread_id: 'thread-write',
            project_id: 'novel',
            action: 'sync',
        });
        assert.equal((refreshed.included as json_object[])[0]?.version, 2);
        assert.match(String((refreshed.packet as json_object).text), /Every opening starts in medias res/);

        await call('longmemory_central_publish', {
            memory_id: 'alternate-opening-rule', project_id: 'novel', role_id: 'writer', task_id: 'chapter-one',
            level: 4, memory_kind: 'procedure', title: 'Alternate opening rule',
            summary: 'Open with quiet atmosphere.',
            body: 'The opening should establish atmosphere before introducing conflict.',
            source_thread_id: 'thread-write',
        });
        const reported_conflict = await call('longmemory_central_conflict', {
            action: 'report', project_id: 'novel',
            memory_a_id: 'opening-rule', memory_a_version: 2,
            memory_b_id: 'alternate-opening-rule', memory_b_version: 1,
            severity: 0.9,
            rationale: 'The two opening procedures prescribe incompatible scene order.',
        });
        const conflict_id = (reported_conflict.conflict as json_object).conflict_id as string;
        const conflicts = await call('longmemory_central_conflict', {
            action: 'list', project_id: 'novel', status: 'open',
        });
        assert.equal(conflicts.count, 1);
        const resolved_conflict = await call('longmemory_central_conflict', {
            action: 'resolve', project_id: 'novel', conflict_id,
            resolution_memory_id: 'opening-rule', resolution_version: 2,
            decision_note: 'Keep the confirmed in-medias-res rule.',
            actor: {
                actor_id: 'user', actor_kind: 'user', action_id: 'ui-conflict-resolution-1',
                channel: 'codex_ui', decided_at: 5_100,
                evidence: { user_turn_id: 'turn-conflict-resolution-1' },
            },
        });
        assert.equal((resolved_conflict.conflict as json_object).status, 'resolved');
        await call('longmemory_central_conflict', {
            action: 'report', project_id: 'novel', conflict_id: 'conflict-to-dismiss',
            memory_a_id: 'opening-rule', memory_a_version: 2,
            memory_b_id: 'alternate-opening-rule', memory_b_version: 1,
            severity: 0.2,
            rationale: 'A duplicate low-confidence signal retained for dismissal auditing.',
        });
        const dismissed_conflict = await call('longmemory_central_conflict', {
            action: 'dismiss', project_id: 'novel', conflict_id: 'conflict-to-dismiss',
            decision_note: 'Dismissed as a duplicate low-confidence signal.',
            actor: {
                actor_id: 'user', actor_kind: 'user', action_id: 'ui-conflict-dismissal-1',
                channel: 'codex_ui', decided_at: 5_110,
                evidence: { user_turn_id: 'turn-conflict-dismissal-1' },
            },
        });
        assert.equal((dismissed_conflict.conflict as json_object).status, 'dismissed');

        const major_downgrade_attempt = await call('longmemory_central_publish', {
            memory_id: 'opening-rule', project_id: 'novel', role_id: 'writer', task_id: 'chapter-one',
            level: 4, memory_kind: 'procedure', title: 'Opening rule',
            summary: 'Quiet openings are allowed.',
            body: 'A quiet opening is allowed whenever it improves suspense.',
            expected_current_version: 2,
            major: false,
            source_thread_id: 'thread-write',
        });
        assert.equal(major_downgrade_attempt.effective, false);
        assert.equal((major_downgrade_attempt.version as json_object).status, 'pending_confirmation');

        await call('longmemory_central_publish', {
            memory_id: 'retired-rule', project_id: 'novel', role_id: 'writer', task_id: 'chapter-one',
            level: 4, memory_kind: 'procedure', title: 'Retired rule',
            summary: 'A temporary rule that will be withdrawn.',
            body: 'RETRACTED_BODY_SENTINEL must never be injected after withdrawal.',
            source_thread_id: 'thread-write',
        });
        await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'sync',
        });
        await call('longmemory_central_usage', {
            action: 'consume', thread_id: 'thread-write', project_id: 'novel',
            memory_id: 'retired-rule', memory_version: 1,
        });
        await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', thread_status: 'completed',
        });
        const retraction_request = central.request_retraction({
            memory_id: 'retired-rule', expected_current_version: 1,
            requested_by: 'thread-write', reason: 'Later evidence invalidated this temporary rule.',
        });
        assert.ok(retraction_request.confirmation);
        central.approve(retraction_request.confirmation.confirmation_id, {
            actor_id: 'user', actor_kind: 'user', action_id: 'approve-retired-rule',
            channel: 'codex_ui', note: 'Withdraw the invalid rule.',
            evidence: { user_turn_id: 'turn-retract-retired-rule', explicit_user_action: true },
        });
        assert.equal(central.repository.require_workset('thread-write', 'retired-rule').sync_state, 'current',
            'the core intentionally leaves completed-thread worksets untouched until resume');
        const resumed = await call('longmemory_central_register_thread', {
            thread_id: 'thread-write', project_id: 'novel', thread_status: 'active',
        });
        assert.equal(resumed.reconciled_retractions, 1);
        assert.equal(central.repository.require_workset('thread-write', 'retired-rule').sync_state, 'retracted');

        const after_retraction = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read', include_consumed: true,
        });
        const retired_notice = (after_retraction.retracted as json_object[])
            .find((entry) => entry.memory_id === 'retired-rule');
        assert.deepEqual(retired_notice && {
            memory_id: retired_notice.memory_id,
            synced_version: retired_notice.synced_version,
            consumed_version: retired_notice.consumed_version,
            title: retired_notice.title,
            reason: retired_notice.reason,
        }, {
            memory_id: 'retired-rule', synced_version: 1, consumed_version: 1,
            title: 'Retired rule', reason: 'Later evidence invalidated this temporary rule.',
        });
        assert.match(String((after_retraction.packet as json_object).text), /retired-rule@v1.*MUST NOT USE/s);
        assert.doesNotMatch(String((after_retraction.packet as json_object).text), /RETRACTED_BODY_SENTINEL/);
        assert.equal((after_retraction.included as json_object[])
            .some((entry) => entry.memory_id === 'retired-rule'), false);
        const budgeted_retraction = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read', token_budget: 64,
        });
        assert.ok(Number((budgeted_retraction.packet as json_object).tokens_used) <= 64);
        assert.match(String((budgeted_retraction.packet as json_object).text), /retired-rule@v1.*MUST NOT USE/s);
        const repeated_retraction_notice = await call('longmemory_central_context', {
            thread_id: 'thread-write', project_id: 'novel', action: 'read',
        });
        assert.equal((repeated_retraction_notice.retracted as json_object[])
            .some((entry) => entry.memory_id === 'retired-rule'), true,
        'retraction notices remain visible until a future explicit acknowledgement protocol exists');

        const finalized = await call('longmemory_central_finalize_turn', {
            thread_id: 'thread-write',
            turn_id: 'turn-2',
            project_id: 'novel',
            memory_extracted: true,
            memory_id: 'opening-rule',
            memory_version: 2,
            note: 'The major rule was confirmed and published.',
        });
        assert.equal(finalized.already_finalized, false);
        const repeated = await call('longmemory_central_finalize_turn', {
            thread_id: 'thread-write',
            turn_id: 'turn-2',
            project_id: 'novel',
            memory_extracted: true,
            memory_id: 'opening-rule',
            memory_version: 2,
            note: 'The major rule was confirmed and published.',
        });
        assert.equal(repeated.already_finalized, true);
        const conflicting_finalization = await client.callTool({
            name: 'longmemory_central_finalize_turn',
            arguments: {
                thread_id: 'thread-write', turn_id: 'turn-2', project_id: 'novel',
                memory_extracted: true, memory_id: 'opening-rule', memory_version: 2,
                note: 'A conflicting retry.',
            },
        });
        assert.equal(conflicting_finalization.isError, true);
        assert.match(JSON.stringify(conflicting_finalization.content), /already finalized with a different result/);

        const turn_events = central.repository.database.prepare(`SELECT COUNT(*) AS count FROM cm_outbox
            WHERE event_type='central_memory.turn_finalized'`).get() as { count: number };
        assert.equal(turn_events.count, 1);
        assert.ok(audit.entries().some((entry) => entry.outcome === 'denied'));
        assert.ok(audit.entries().some((entry) => entry.outcome === 'error'));
        assert.ok(audit.entries().every((entry) => entry.project_id === 'novel'));
    } finally {
        await client.close();
        await server.close();
        await runtime.close();
    }
});
