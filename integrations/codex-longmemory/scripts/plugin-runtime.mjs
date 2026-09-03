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
 *  file  : integrations/codex-longmemory/scripts/plugin-runtime.mjs
 *  usage : supports the LongMemory plugin runtime integration
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    normalize,
    parse,
    resolve,
} from 'node:path';

export const MAX_HOOK_IO_BYTES = 1_048_576;
export const CODEX_MEMORY_MCP_PROFILE = 'codex-memory-gateway';
const DEFAULT_PLUGIN_DATA_DIRECTORY = 'longmemory-longmemory';
const CENTRAL_DATABASE_NAME = 'central-memory.db';

function absolutePath(value, label) {
    const trimmed = String(value ?? '').trim();
    const root = parse(trimmed).root;
    const isWindowsRootRelative = process.platform === 'win32' && (root === '\\' || root === '/');
    if (!trimmed || !isAbsolute(trimmed) || isWindowsRootRelative) {
        throw new Error(`${label} must be an absolute path (drive-qualified or UNC on Windows)`);
    }
    return normalize(resolve(trimmed));
}

function pathKey(value) {
    const normalized = normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function environmentPluginData(env) {
    const present = [
        ['PLUGIN_DATA', env.PLUGIN_DATA],
        ['CLAUDE_PLUGIN_DATA', env.CLAUDE_PLUGIN_DATA],
        ['LONGMEMORY_PLUGIN_DATA', env.LONGMEMORY_PLUGIN_DATA],
    ].filter(([, value]) => String(value ?? '').trim())
        .map(([name, value]) => ({ name, path: absolutePath(value, name) }));
    if (!present.length) return null;
    const first = present[0].path;
    if (present.some((entry) => pathKey(entry.path) !== pathKey(first))) {
        throw new Error(`plugin data environment variables disagree (${present.map((entry) => entry.name).join(', ')})`);
    }
    return first;
}

export function deriveInstalledPluginData(scriptPath) {
    let candidate = dirname(absolutePath(scriptPath, 'plugin script path'));
    while (true) {
        const versionDirectory = candidate;
        const pluginDirectory = dirname(versionDirectory);
        const marketplaceDirectory = dirname(pluginDirectory);
        const cacheDirectory = dirname(marketplaceDirectory);
        const pluginsDirectory = dirname(cacheDirectory);
        if (basename(cacheDirectory).toLocaleLowerCase('en-US') === 'cache'
            && basename(pluginsDirectory).toLocaleLowerCase('en-US') === 'plugins') {
            const plugin = basename(pluginDirectory);
            const marketplace = basename(marketplaceDirectory);
            const codexHome = dirname(pluginsDirectory);
            if (plugin && marketplace) {
                return join(codexHome, 'plugins', 'data', `${plugin}-${marketplace}`);
            }
        }
        const parent = dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
    }
}

function fallbackPluginData(env, homeDirectory) {
    const configured = String(env.CODEX_HOME ?? '').trim();
    const codexHome = configured
        ? absolutePath(configured, 'CODEX_HOME')
        : join(absolutePath(homeDirectory ?? homedir(), 'user home'), '.codex');
    return join(codexHome, 'plugins', 'data', DEFAULT_PLUGIN_DATA_DIRECTORY);
}

export function resolvePluginRuntime({ env = process.env, scriptPath, homeDirectory } = {}) {
    const configuredCodexHome = String(env.CODEX_HOME ?? '').trim();
    const pluginData = environmentPluginData(env)
        ?? (configuredCodexHome ? fallbackPluginData(env, homeDirectory) : null)
        ?? (scriptPath ? deriveInstalledPluginData(scriptPath) : null)
        ?? fallbackPluginData(env, homeDirectory);
    const configuredDatabase = String(env.LONGMEMORY_DB_PATH ?? '').trim();
    const database = configuredDatabase
        ? absolutePath(configuredDatabase, 'LONGMEMORY_DB_PATH')
        : join(pluginData, CENTRAL_DATABASE_NAME);
    return {
        pluginData,
        database,
        env: {
            ...env,
            PLUGIN_DATA: pluginData,
            CLAUDE_PLUGIN_DATA: pluginData,
            LONGMEMORY_PLUGIN_DATA: pluginData,
            LONGMEMORY_DB_PATH: database,
        },
    };
}

export async function readBounded(stream, limit = MAX_HOOK_IO_BYTES) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += value.byteLength;
        if (bytes > limit) throw new Error(`hook stdin exceeds ${limit} bytes`);
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

export function collectBounded(stream, limit = MAX_HOOK_IO_BYTES, onOverflow = () => {}) {
    return new Promise((resolveOutput, rejectOutput) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const finish = (operation) => {
            if (settled) return;
            settled = true;
            operation();
        };
        stream.on('data', (chunk) => {
            if (settled) return;
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            bytes += value.byteLength;
            if (bytes > limit) {
                try { onOverflow(); } catch { /* best effort */ }
                finish(() => rejectOutput(new Error(`hook stdout exceeds ${limit} bytes`)));
                return;
            }
            chunks.push(value);
        });
        stream.once('end', () => finish(() => resolveOutput(Buffer.concat(chunks))));
        stream.once('error', (error) => finish(() => rejectOutput(error)));
    });
}

function invocation(env, args) {
    const configured = String(env.LONGMEMORY_CLI_COMMAND ?? '').trim();
    if (configured.includes('\0')) throw new Error('LONGMEMORY_CLI_COMMAND contains NUL');
    if (configured && /\.m?js$/i.test(configured)) {
        return { command: process.execPath, args: [configured, ...args] };
    }
    const executable = configured || (process.platform === 'win32' ? 'longmemory.cmd' : 'longmemory');
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
        return {
            command: env.ComSpec || process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', 'call', executable, ...args],
        };
    }
    return { command: executable, args };
}

export function spawnLongMemory(args, options = {}) {
    const env = options.env ?? process.env;
    const launch = invocation(env, args);
    return spawn(launch.command, launch.args, {
        env,
        stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
    });
}

export function codexMemoryMcpArgs() {
    return ['mcp', '--project', 'current', '--profile', CODEX_MEMORY_MCP_PROFILE];
}

export function waitForChild(child) {
    return new Promise((resolveExit) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolveExit(result);
        };
        child.once('error', (error) => finish({ code: 1, error }));
        child.once('close', (code, signal) => finish({ code: code ?? 1, signal }));
    });
}

export function terminateChild(child) {
    if (child && child.exitCode === null && !child.killed) {
        try { child.kill(); } catch { /* best effort */ }
    }
}
