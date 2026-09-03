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
 *  file  : src/cli/context/central_storage.test.ts
 *  usage : tests the LongMemory central storage component
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
    CENTRAL_MEMORY_DATABASE_NAME,
    DEFAULT_CODEX_PLUGIN_DATA_DIRECTORY,
    resolve_central_storage,
} from './central_storage.js';

function temporary_directory(): string {
    return mkdtempSync(join(tmpdir(), 'longmemory-central-storage-'));
}

test('central storage uses plugin data and keeps Hook, MCP, and projection on one database', () => {
    const root = temporary_directory();
    try {
        const plugin_data = join(root, 'plugin-data');
        const result = resolve_central_storage({
            env: {
                PLUGIN_DATA: plugin_data,
                CLAUDE_PLUGIN_DATA: plugin_data,
                LONGMEMORY_PLUGIN_DATA: plugin_data,
            },
        });
        assert.equal(result.plugin_data, resolve(plugin_data));
        assert.equal(result.db_path, join(resolve(plugin_data), CENTRAL_MEMORY_DATABASE_NAME));
        assert.equal(result.plugin_data_source, 'environment');
        assert.equal(result.db_source, 'plugin-data');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('central storage accepts only an absolute LONGMEMORY_DB_PATH override', () => {
    const root = temporary_directory();
    try {
        const plugin_data = join(root, 'plugin-data');
        const database = join(root, 'database', 'memory.db');
        const result = resolve_central_storage({
            env: { PLUGIN_DATA: plugin_data, LONGMEMORY_DB_PATH: database },
        });
        assert.equal(result.db_path, resolve(database));
        assert.equal(result.db_source, 'environment');
        assert.throws(() => resolve_central_storage({
            env: { PLUGIN_DATA: plugin_data, LONGMEMORY_DB_PATH: 'relative/memory.db' },
        }), /LONGMEMORY_DB_PATH must be an absolute path/);
        assert.throws(() => resolve_central_storage({
            env: { PLUGIN_DATA: plugin_data, LONGMEMORY_DB_PATH: '\\central\\memory.db' },
        }), /LONGMEMORY_DB_PATH must be an absolute path/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('central storage rejects disagreeing plugin data aliases', () => {
    const root = temporary_directory();
    try {
        assert.throws(() => resolve_central_storage({
            env: {
                PLUGIN_DATA: join(root, 'first'),
                LONGMEMORY_PLUGIN_DATA: join(root, 'second'),
            },
        }), /plugin data environment variables disagree/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('central storage fallback is stable under Codex home and never depends on cwd', () => {
    const root = temporary_directory();
    try {
        const result = resolve_central_storage({ env: {}, home_dir: root });
        const expected_plugin_data = join(root, '.codex', 'plugins', 'data', DEFAULT_CODEX_PLUGIN_DATA_DIRECTORY);
        assert.equal(result.plugin_data, expected_plugin_data);
        assert.equal(result.db_path, join(expected_plugin_data, CENTRAL_MEMORY_DATABASE_NAME));
        assert.equal(result.plugin_data_source, 'codex-home-fallback');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Codex hooks can require host-provided plugin data', () => {
    const root = temporary_directory();
    try {
        assert.throws(() => resolve_central_storage({
            env: {},
            home_dir: root,
            require_plugin_data_environment: true,
        }), /PLUGIN_DATA is required/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
