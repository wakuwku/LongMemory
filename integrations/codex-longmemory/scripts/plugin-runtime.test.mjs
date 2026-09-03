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
 *  file  : integrations/codex-longmemory/scripts/plugin-runtime.test.mjs
 *  usage : tests the LongMemory plugin runtime component
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
    CODEX_MEMORY_MCP_PROFILE,
    MAX_HOOK_IO_BYTES,
    codexMemoryMcpArgs,
    collectBounded,
    readBounded,
    resolvePluginRuntime,
} from './plugin-runtime.mjs';

const hookScript = resolve('integrations/codex-longmemory/scripts/codex-memory-hook.mjs');
const mcpConfig = resolve('integrations/codex-longmemory/.mcp.json');

test('the bundled MCP launcher selects the restricted Codex memory gateway profile', () => {
    assert.equal(CODEX_MEMORY_MCP_PROFILE, 'codex-memory-gateway');
    assert.deepEqual(codexMemoryMcpArgs(), [
        'mcp', '--project', 'current', '--profile', 'codex-memory-gateway',
    ]);
});

function temporaryDirectory() {
    return mkdtempSync(join(tmpdir(), 'longmemory-plugin-runtime-'));
}

function runNode(script, { env, input, timeout = 10_000 }) {
    return new Promise((resolveProcess, rejectProcess) => {
        const child = spawn(process.execPath, [script], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        const timer = setTimeout(() => {
            child.kill();
            rejectProcess(new Error(`child timed out after ${timeout} ms`));
        }, timeout);
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.once('error', (error) => {
            clearTimeout(timer);
            rejectProcess(error);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolveProcess({
                code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

test('bundled MCP configuration uses the validated companion-file server map', () => {
    const value = JSON.parse(readFileSync(mcpConfig, 'utf8'));
    assert.deepEqual(Object.keys(value), ['mcpServers']);
    assert.deepEqual(Object.keys(value.mcpServers), ['longmemory']);
    assert.equal(typeof value.mcpServers.longmemory, 'object');
    assert.equal(value.mcpServers.longmemory.command, 'node');
    assert.ok(Array.isArray(value.mcpServers.longmemory.args));
});

test('real Hook PLUGIN_DATA and legacy MCP cache derivation resolve byte-identical paths', () => {
    const root = temporaryDirectory();
    try {
        const scriptPath = join(root, '.codex', 'plugins', 'cache', 'longmemory', 'longmemory', '0.1.0', 'scripts', 'codex-memory-mcp.mjs');
        const expectedPluginData = join(root, '.codex', 'plugins', 'data', 'longmemory-longmemory');
        const hook = resolvePluginRuntime({
            env: { PLUGIN_DATA: expectedPluginData, CLAUDE_PLUGIN_DATA: expectedPluginData },
            scriptPath,
        });
        const mcp = resolvePluginRuntime({ env: {}, scriptPath });
        assert.deepEqual(Buffer.from(mcp.pluginData), Buffer.from(hook.pluginData));
        assert.deepEqual(Buffer.from(mcp.database), Buffer.from(hook.database));
        assert.equal(mcp.env.PLUGIN_DATA, hook.env.PLUGIN_DATA);
        assert.equal(mcp.env.LONGMEMORY_DB_PATH, hook.env.LONGMEMORY_DB_PATH);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('plugin runtime rejects a relative central database override', () => {
    const root = temporaryDirectory();
    try {
        assert.throws(() => resolvePluginRuntime({
            env: { PLUGIN_DATA: root, LONGMEMORY_DB_PATH: 'relative/central-memory.db' },
        }), /LONGMEMORY_DB_PATH must be an absolute path/);
        assert.throws(() => resolvePluginRuntime({
            env: { PLUGIN_DATA: root, LONGMEMORY_DB_PATH: '\\central\\memory.db' },
        }), /LONGMEMORY_DB_PATH must be an absolute path/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('explicit CODEX_HOME outranks an installed cache path', () => {
    const root = temporaryDirectory();
    try {
        const codexHome = join(root, 'configured-codex-home');
        const scriptPath = join(root, 'stale-codex-home', 'plugins', 'cache', 'longmemory', 'longmemory', '0.1.0', 'scripts', 'codex-memory-mcp.mjs');
        const runtime = resolvePluginRuntime({ env: { CODEX_HOME: codexHome }, scriptPath });
        assert.equal(runtime.pluginData, join(codexHome, 'plugins', 'data', 'longmemory-longmemory'));
        assert.equal(runtime.database, join(runtime.pluginData, 'central-memory.db'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('bounded stream helpers reject Hook input and output above 1 MiB', async () => {
    await assert.rejects(
        readBounded(Readable.from([Buffer.alloc(MAX_HOOK_IO_BYTES + 1)])),
        /hook stdin exceeds/,
    );
    let overflowed = false;
    await assert.rejects(
        collectBounded(
            Readable.from([Buffer.alloc(MAX_HOOK_IO_BYTES + 1)]),
            MAX_HOOK_IO_BYTES,
            () => { overflowed = true; },
        ),
        /hook stdout exceeds/,
    );
    assert.equal(overflowed, true);
});

test('Hook launcher fails open without launching the CLI when stdin exceeds 1 MiB', async () => {
    const root = temporaryDirectory();
    try {
        const fakeCli = join(root, 'fake-cli.mjs');
        const marker = join(root, 'launched.txt');
        writeFileSync(fakeCli, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'launched');\n`, 'utf8');
        const result = await runNode(hookScript, {
            env: { ...process.env, PLUGIN_DATA: root, LONGMEMORY_CLI_COMMAND: fakeCli },
            input: Buffer.alloc(MAX_HOOK_IO_BYTES + 1),
        });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, JSON.stringify({ continue: true }));
        assert.match(result.stderr, /hook stdin exceeds/);
        assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(marker)), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Hook launcher kills an oversized CLI response and fails open', async () => {
    const root = temporaryDirectory();
    try {
        const fakeCli = join(root, 'fake-cli.mjs');
        writeFileSync(fakeCli, `process.stdin.resume(); process.stdout.write(Buffer.alloc(${MAX_HOOK_IO_BYTES + 1}, 65)); setInterval(() => {}, 1000);\n`, 'utf8');
        const result = await runNode(hookScript, {
            env: { ...process.env, PLUGIN_DATA: root, LONGMEMORY_CLI_COMMAND: fakeCli },
            input: Buffer.from('{}'),
        });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, JSON.stringify({ continue: true }));
        assert.match(result.stderr, /hook stdout exceeds/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
