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
 *  file  : src/cli/context/central_storage.ts
 *  usage : implements the LongMemory central storage component
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse, resolve } from 'node:path';

export const CENTRAL_MEMORY_DATABASE_NAME = 'central-memory.db';
export const DEFAULT_CODEX_PLUGIN_DATA_DIRECTORY = 'longmemory-longmemory';

export type central_storage_resolution = {
    db_path: string;
    plugin_data: string;
    plugin_data_source: 'environment' | 'codex-home-fallback';
    db_source: 'explicit-cli' | 'environment' | 'plugin-data';
};

export type central_storage_options = {
    env: NodeJS.ProcessEnv;
    explicit_db_path?: string;
    home_dir?: string;
    require_plugin_data_environment?: boolean;
};

function absolute_path(value: string, label: string, allow_memory = false): string {
    const trimmed = value.trim();
    if (allow_memory && trimmed === ':memory:') return trimmed;
    const root = parse(trimmed).root;
    const is_windows_root_relative = process.platform === 'win32' && (root === '\\' || root === '/');
    if (!isAbsolute(trimmed) || is_windows_root_relative) {
        throw new Error(`${label} must be an absolute path (drive-qualified or UNC on Windows)`);
    }
    return normalize(resolve(trimmed));
}

function path_key(value: string): string {
    const normalized = normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function environment_plugin_data(env: NodeJS.ProcessEnv): string | null {
    const candidates = [
        ['PLUGIN_DATA', env.PLUGIN_DATA],
        ['CLAUDE_PLUGIN_DATA', env.CLAUDE_PLUGIN_DATA],
        ['LONGMEMORY_PLUGIN_DATA', env.LONGMEMORY_PLUGIN_DATA],
    ] as const;
    const present: Array<{ name: string; path: string }> = [];
    for (const [name, value] of candidates) {
        if (!value?.trim()) continue;
        present.push({ name, path: absolute_path(value, name) });
    }
    if (!present.length) return null;
    const first = present[0]!.path;
    const conflict = present.find((entry) => path_key(entry.path) !== path_key(first));
    if (conflict) {
        throw new Error(`plugin data environment variables disagree (${present.map((entry) => entry.name).join(', ')})`);
    }
    return first;
}

function fallback_plugin_data(env: NodeJS.ProcessEnv, home_dir?: string): string {
    const configured_codex_home = env.CODEX_HOME?.trim();
    const codex_home = configured_codex_home
        ? absolute_path(configured_codex_home, 'CODEX_HOME')
        : join(absolute_path(home_dir ?? homedir(), 'user home'), '.codex');
    return join(codex_home, 'plugins', 'data', DEFAULT_CODEX_PLUGIN_DATA_DIRECTORY);
}

export function resolve_central_storage(options: central_storage_options): central_storage_resolution {
    const environment_data = environment_plugin_data(options.env);
    if (!environment_data && options.require_plugin_data_environment) {
        throw new Error('PLUGIN_DATA is required for Codex memory hooks');
    }
    const plugin_data = environment_data ?? fallback_plugin_data(options.env, options.home_dir);
    const explicit_db = options.explicit_db_path?.trim();
    if (explicit_db) {
        return {
            db_path: absolute_path(explicit_db, '--db', true),
            plugin_data,
            plugin_data_source: environment_data ? 'environment' : 'codex-home-fallback',
            db_source: 'explicit-cli',
        };
    }
    const environment_db = options.env.LONGMEMORY_DB_PATH?.trim();
    if (environment_db) {
        return {
            db_path: absolute_path(environment_db, 'LONGMEMORY_DB_PATH'),
            plugin_data,
            plugin_data_source: environment_data ? 'environment' : 'codex-home-fallback',
            db_source: 'environment',
        };
    }
    return {
        db_path: join(plugin_data, CENTRAL_MEMORY_DATABASE_NAME),
        plugin_data,
        plugin_data_source: environment_data ? 'environment' : 'codex-home-fallback',
        db_source: 'plugin-data',
    };
}
