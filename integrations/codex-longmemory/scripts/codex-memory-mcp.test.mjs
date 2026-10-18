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
 *  file  : integrations/codex-longmemory/scripts/codex-memory-mcp.test.mjs
 *  usage : tests the LongMemory codex memory mcp component
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { watchMcpChild } from './codex-memory-mcp.mjs';

function fixture() {
    const owner = Object.assign(new EventEmitter(), { ppid: 12345 });
    const child = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null, kills: [],
        kill(signal) { this.kills.push(signal); return true; },
    });
    return { owner, child };
}

test('launcher forwards signals only once and disposes all listeners on close', () => {
    const { owner, child } = fixture();
    const guardian = watchMcpChild(child, { owner, parentAlive: () => true });
    owner.emit('SIGINT');
    owner.emit('SIGTERM');
    assert.deepEqual(child.kills, ['SIGINT']);
    child.exitCode = 0;
    child.emit('close');
    guardian.dispose();
    for (const event of ['SIGINT', 'SIGTERM', 'exit']) assert.equal(owner.listenerCount(event), 0);
    for (const event of ['close', 'error']) assert.equal(child.listenerCount(event), 0);
    owner.emit('exit');
    assert.deepEqual(child.kills, ['SIGINT']);
});

test('launcher owner exit cleans up its still-running child', () => {
    const { owner, child } = fixture();
    const guardian = watchMcpChild(child, { owner, parentPid: 1 });
    owner.emit('exit');
    assert.deepEqual(child.kills, ['SIGTERM']);
    guardian.dispose();
});

test('the guardian notices parent disappearance without killing unrelated PIDs', { timeout: 2000 }, async () => {
    const { owner, child } = fixture();
    const guardian = watchMcpChild(child, {
        owner, parentAlive: () => false, intervalMs: 5, killAfterMs: 1000,
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(child.kills, ['SIGTERM']);
    } finally { guardian.dispose(); }
});

test('an unresponsive owned child is force-stopped after the grace period', { timeout: 2000 }, async () => {
    const { owner, child } = fixture();
    const guardian = watchMcpChild(child, { owner, parentPid: 1, killAfterMs: 5 });
    try {
        owner.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    } finally { guardian.dispose(); }
});

test('already exited children are never signalled', () => {
    const { owner, child } = fixture();
    child.signalCode = 'SIGTERM';
    const guardian = watchMcpChild(child, { owner, parentPid: 1 });
    owner.emit('SIGTERM');
    owner.emit('exit');
    assert.deepEqual(child.kills, []);
    guardian.dispose();
});

test('controlled real child exits when the launcher owner shuts down', { timeout: 5000 }, async () => {
    // A small isolated Node child, never the real LongMemory database/backend.
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const owner = Object.assign(new EventEmitter(), { ppid: 1 });
    const guardian = watchMcpChild(child, { owner, parentPid: 1, killAfterMs: 1000 });
    try {
        await once(child.stdout, 'data');
        const closed = once(child, 'close');
        owner.emit('SIGTERM');
        await closed;
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(owner.listenerCount('exit'), 0);
    } finally {
        guardian.dispose();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
});
