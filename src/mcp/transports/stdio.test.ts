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
 *  file  : src/mcp/transports/stdio.test.ts
 *  usage : tests the LongMemory stdio component
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { mcp_runtime } from '../runtime.js';
import { create_stdio_mcp } from './stdio.js';

const config = {
    db_path: ':memory:', tenant_id: 'stdio-test', user_id: 'test',
    profile: 'codex-memory-gateway' as const,
};

test('stdin EOF closes the SDK protocol and owned runtime exactly once', { timeout: 2000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mcp = create_stdio_mcp(config, input, output);
    let runtime_closes = 0;
    let protocol_closes = 0;
    const runtime_close = mcp.runtime.close.bind(mcp.runtime);
    mcp.runtime.close = async () => { runtime_closes++; await runtime_close(); };
    mcp.server.server.onclose = () => { protocol_closes++; };
    await mcp.start();
    const protocol_onclose = mcp.transport.onclose;
    input.end();
    await mcp.closed;
    await Promise.all([mcp.close(), mcp.close()]);
    assert.equal(mcp.transport.onclose, protocol_onclose, 'SDK transport callback must not be replaced');
    assert.equal(mcp.server.server.transport, undefined);
    assert.equal(protocol_closes, 1);
    assert.equal(runtime_closes, 1);
    for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0);
    for (const event of ['error', 'finish', 'close', 'drain']) assert.equal(output.listenerCount(event), 0);
});

for (const event of ['close', 'error'] as const) {
    test(`input ${event} releases the runtime`, { timeout: 2000 }, async () => {
        const input = new PassThrough();
        const mcp = create_stdio_mcp(config, input, new PassThrough());
        let errors = 0;
        mcp.server.server.onerror = () => { errors++; };
        await mcp.start();
        if (event === 'error') input.emit('error', new Error('test input failure'));
        else input.destroy();
        await mcp.closed;
        assert.equal(mcp.server.server.transport, undefined);
        if (event === 'error') assert.equal(errors, 1, 'SDK still receives the stream error');
    });
}

test('an output pipe error rejects send and closes without uncaught errors', { timeout: 2000 }, async () => {
    const output = new Writable({
        write(_chunk, _encoding, callback) {
            const error = Object.assign(new Error('broken output pipe'), { code: 'EPIPE' });
            callback(error);
        },
    });
    const mcp = create_stdio_mcp(config, new PassThrough(), output);
    await mcp.start();
    await assert.rejects(mcp.transport.send({ jsonrpc: '2.0', method: 'test' }), /broken output pipe/);
    await mcp.closed;
    assert.equal(output.listenerCount('error'), 0);
});

test('closing while a write is backpressured rejects rather than waiting for drain', { timeout: 2000 }, async () => {
    const output = new Writable({ highWaterMark: 1, write() { /* intentionally held */ } });
    const mcp = create_stdio_mcp(config, new PassThrough(), output);
    await mcp.start();
    const sent = assert.rejects(mcp.transport.send({ jsonrpc: '2.0', method: 'test' }), /closed/);
    await mcp.close();
    await sent;
    assert.equal(output.listenerCount('drain'), 0);
    output.destroy();
});

test('output finish also closes the MCP connection', { timeout: 2000 }, async () => {
    const output = new PassThrough();
    const mcp = create_stdio_mcp(config, new PassThrough(), output);
    await mcp.start();
    output.end();
    await mcp.closed;
    assert.equal(mcp.server.server.transport, undefined);
});

test('start failure still releases the owned runtime and stream listeners', { timeout: 2000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mcp = create_stdio_mcp(config, input, output);
    let closed = 0;
    const original_close = mcp.runtime.close.bind(mcp.runtime);
    mcp.runtime.close = async () => { closed++; await original_close(); };
    mcp.server.connect = async () => { throw new Error('mock connect failure'); };
    await assert.rejects(mcp.start(), /mock connect failure/);
    await mcp.closed;
    assert.equal(closed, 1);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(output.listenerCount('error'), 0);
});

test('runtime is not owned when supplied by the caller', { timeout: 2000 }, async () => {
    const runtime = new mcp_runtime(config);
    let closed = 0;
    const original_close = runtime.close.bind(runtime);
    runtime.close = async () => { closed++; await original_close(); };
    const input = new PassThrough();
    const mcp = create_stdio_mcp({ runtime }, input, new PassThrough());
    try {
        await mcp.start();
        input.end();
        await mcp.closed;
        assert.equal(closed, 0);
    } finally { await runtime.close(); }
});

test('close before start is idempotent and does not leak a runtime', { timeout: 2000 }, async () => {
    const mcp = create_stdio_mcp(config, new PassThrough(), new PassThrough());
    await Promise.all([mcp.close(), mcp.close()]);
    await mcp.closed;
    await assert.rejects(mcp.start(), /closed/);
});

for (const shutdown of ['EOF', 'SIGTERM', 'SIGINT']) {
    test(`isolated stdio runner exits cleanly on ${shutdown}`, { timeout: 5000 }, async () => {
        const module_url = new URL('./stdio.ts', import.meta.url).href;
        const script = `
            const { run_mcp_stdio } = await import(${JSON.stringify(module_url)});
            const baseline = ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event));
            const done = run_mcp_stdio(${JSON.stringify(config)});
            process.stderr.write('ready\\n');
            ${shutdown === 'EOF' ? '' : `setTimeout(() => process.emit(${JSON.stringify(shutdown)}), 10);`}
            await done;
            const remaining = ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event));
            if (JSON.stringify(baseline) !== JSON.stringify(remaining)) throw new Error('signal listener leak');
            process.stderr.write('closed\\n');
        `;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let diagnostic = '';
        child.stderr.on('data', (chunk) => { diagnostic += String(chunk); });
        try {
            const closed = once(child, 'close');
            if (shutdown === 'EOF') {
                await once(child.stderr, 'data');
                child.stdin.end();
            }
            const [code] = await closed;
            assert.equal(code, 0, diagnostic);
            assert.match(diagnostic, /closed/);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    });
}
