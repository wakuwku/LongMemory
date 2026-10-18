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
 *  file  : src/core/create_gateway_memory.test.ts
 *  usage : tests the LongMemory create gateway memory component
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create_memory } from './create_memory.js';
import { create_gateway_memory } from './create_gateway_memory.js';
import { mcp_runtime } from '../mcp/runtime.js';

test('file-backed gateway central operations and close never hydrate Hydrograph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-lazy-test-'));
    let hydration = 0;
    const memory = create_gateway_memory({ store: 'sqlite', db_path: join(root, 'memory.db') }, (cfg) => {
        hydration++;
        return create_memory(cfg);
    });
    try {
        assert.ok(memory.centralMemory());
        assert.equal(memory.status().ready, true);
        assert.ok(memory.invariants().length > 0);
        assert.equal(hydration, 0);
        await memory.close();
        await memory.close();
        assert.equal(memory.status().ready, false);
        assert.equal(hydration, 0, 'close must not create or persist an unused graph');
        await assert.rejects(memory.getStats(), /instance is closed/);
        await assert.rejects(memory.recall({ text: 'closed' }), /instance is closed/);
    } finally { await memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy graph access still hydrates the unchanged engine once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-lazy-test-'));
    let hydration = 0;
    const memory = create_gateway_memory({ store: 'sqlite', db_path: join(root, 'memory.db') }, (cfg) => {
        hydration++;
        return create_memory(cfg);
    });
    try {
        const central = memory.centralMemory();
        assert.equal((await memory.getStats()).nodes, 0);
        await memory.listWorlds();
        assert.equal(hydration, 1);
        assert.equal(memory.centralMemory(), central, 'previously obtained SQL service remains usable');
        await memory.close();
        assert.equal((await memory.getStats()).closed, true);
        assert.equal(hydration, 1);
    } finally { await memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('gateway keeps writable, readonly, and default MCP behavior', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-lazy-test-'));
    const file = join(root, 'memory.db');
    const writable = new mcp_runtime({ db_path: file, profile: 'codex-memory-gateway', audit_path: null, env: {} });
    await writable.close();
    const readonly = new mcp_runtime({ db_path: file, profile: 'codex-memory-gateway', read_only: true, audit_path: null, env: {} });
    const normal = new mcp_runtime({ db_path: ':memory:', env: {} });
    try {
        assert.ok(readonly.memory.centralMemory());
        assert.equal(normal.profile, 'default');
        assert.equal((await normal.memory.getStats()).nodes, 0);
        assert.deepEqual([...readonly.access.allowed_tools], ['longmemory_codex_memory', 'longmemory_history_backfill', 'longmemory_history_publication']);
    } finally { await readonly.close(); await normal.close(); rmSync(root, { recursive: true, force: true }); }
});

test('central publish, update, reopen and readonly guards work without graph hydration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-lazy-test-'));
    const config = { store: 'sqlite' as const, db_path: join(root, 'memory.db') };
    const forbidden = () => { throw new Error('central operations must not hydrate Hydrograph'); };
    const memory = create_gateway_memory(config, forbidden);
    try {
        const service = memory.centralMemory()!;
        service.repository.register_project({ project_id: 'novel', name: 'Novel' });
        service.repository.register_role({ role_id: 'writer', project_id: 'novel', name: 'Writer', responsibility: 'Write' });
        service.repository.register_task({ task_id: 'chapter', project_id: 'novel', role_id: 'writer', title: 'Chapter' });
        service.register_thread({ thread_id: 'thread', project_id: 'novel', role_id: 'writer', task_id: 'chapter', responsibility: 'Write chapter' });
        const input = { memory_id: 'style', project_id: 'novel', role_id: 'writer', task_id: 'chapter', level: 4 as const,
            memory_kind: 'procedure', title: 'Style', summary: 'Use concrete scenes', body: 'Start with a visible conflict.',
            created_by: 'thread', source_thread_id: 'thread' };
        service.publish(input);
        service.publish({ ...input, body: 'Updated scene rule.', expected_current_version: 1 });
        assert.equal(service.repository.get_memory('style')?.current_version, 2);
        await memory.close();
        const reopened = create_gateway_memory({ ...config, readonly: true }, forbidden);
        try {
            const readonly = reopened.centralMemory()!;
            assert.equal(readonly.repository.get_version('style', 2)?.body, 'Updated scene rule.');
            assert.throws(() => readonly.publish(input), /readonly/);
        } finally { await reopened.close(); }
    } finally { await memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('three SQL gateways retain optimistic version conflicts and major confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-lazy-test-'));
    const config = { store: 'sqlite' as const, db_path: join(root, 'memory.db') };
    const forbidden = () => { throw new Error('central operations must not hydrate Hydrograph'); };
    const connections = Array.from({ length: 3 }, () => create_gateway_memory(config, forbidden));
    try {
        const [first, second, third] = connections.map(m => m.centralMemory()!);
        first.repository.register_project({ project_id: 'novel', name: 'Novel' });
        first.repository.register_role({ role_id: 'writer', project_id: 'novel', name: 'Writer', responsibility: 'Write' });
        first.repository.register_task({ task_id: 'chapter', project_id: 'novel', role_id: 'writer', title: 'Chapter' });
        first.register_thread({ thread_id: 'thread', project_id: 'novel', role_id: 'writer', task_id: 'chapter', responsibility: 'Write chapter' });
        const input = { memory_id: 'rule', project_id: 'novel', role_id: 'writer', task_id: 'chapter', level: 4 as const,
            memory_kind: 'procedure', title: 'Scene rule', summary: 'Concrete scenes', body: 'First version.',
            created_by: 'thread', source_thread_id: 'thread' };
        first.publish(input);
        assert.equal(second.repository.get_memory('rule')?.current_version, 1);
        second.publish({ ...input, body: 'Second version.', expected_current_version: 1 });
        assert.throws(() => third.publish({ ...input, body: 'Stale write.', expected_current_version: 1 }), /version|conflict/i);
        const pending = third.publish({ ...input, body: 'Major rule.', major: true, expected_current_version: 2 });
        assert.equal(pending.effective, false);
        assert.equal(pending.version.status, 'pending_confirmation');
        assert.equal(pending.confirmation?.status, 'pending');
        assert.equal(first.repository.get_memory('rule')?.current_version, 2);
        assert.equal(first.repository.get_version('rule', 2)?.body, 'Second version.');
    } finally { await Promise.all(connections.map(m => m.close())); rmSync(root, { recursive: true, force: true }); }
});
