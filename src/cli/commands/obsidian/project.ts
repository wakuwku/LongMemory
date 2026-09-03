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
 *  file  : src/cli/commands/obsidian/project.ts
 *  usage : implements the LongMemory project component
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { project_central_memory_to_obsidian } from '../../../integrations/obsidian/projector.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import type { cli_command } from '../../context/cli_context.js';
import { command_flags, flag, has } from '../../context/cli_context.js';
import { resolve_central_storage } from '../../context/central_storage.js';
import { emit } from '../../output/pretty.js';
import { panel } from '../../output/panel.js';

function contains_path(parent: string, child: string): boolean {
    const value = relative(parent, child);
    return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

export const obsidian_project_command: cli_command = async (context) => {
    command_flags(context, ['vault', 'projection-root', 'state-root']);
    const requested_vault = flag(context, 'vault');
    if (!requested_vault?.trim()) throw new Error('--vault <path> is required');
    const central = resolve_central_storage({
        env: context.env,
        explicit_db_path: context.args.flags.has('db') ? context.db_path : undefined,
    });
    if (!existsSync(central.db_path)) {
        throw new Error(`central-memory database was not found: ${central.db_path}`);
    }
    const vault_root = resolve(context.cwd, requested_vault);
    const requested_state_root = flag(context, 'state-root');
    const state_root = requested_state_root
        ? resolve(context.cwd, requested_state_root)
        : join(central.plugin_data, 'obsidian-projector-state');
    if (contains_path(vault_root, state_root) || contains_path(state_root, vault_root)) {
        throw new Error('Obsidian --state-root and --vault must be separate, non-nested directories');
    }
    const projection_root = flag(context, 'projection-root');
    if (has(context, 'dry-run')) {
        emit(context, {
            ok: true,
            dry_run: true,
            db_path: central.db_path,
            vault_root,
            state_root,
            projection_root: projection_root ?? 'LongMemory',
        }, () => panel('Projection configuration is valid; no files were written.', context.colors, {
            title: 'Obsidian projection preview',
            kind: 'warning',
            width: context.terminal_width,
            rows: [
                ['Database', central.db_path],
                ['Vault', vault_root],
                ['State root', state_root],
                ['Projection root', projection_root ?? 'LongMemory'],
            ],
        }));
        return;
    }

    const store = new SqliteStore(central.db_path, {
        tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
        user_id: context.user_id,
        readonly: true,
        file_must_exist: true,
        startup_integrity_check: false,
    });
    try {
        const report = project_central_memory_to_obsidian({
            database: store.database,
            vault_root,
            state_root,
            tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
            user_id: context.user_id,
            ...(projection_root ? { projection_root } : {}),
        });
        emit(context, { ok: true, db_path: central.db_path, vault_root, ...report }, () => panel(
            'SQLite remained read-only; generated pages were projected atomically.',
            context.colors,
            {
                title: 'Obsidian projection complete',
                kind: 'success',
                width: context.terminal_width,
                rows: [
                    ['Written', report.written.length],
                    ['Unchanged', report.unchanged.length],
                    ['Removed', report.removed.length],
                    ['Preserved', report.preserved.length],
                    ['Vault', vault_root],
                    ['State root', report.state_root],
                    ['Manifest', report.manifest_path],
                ],
            },
        ));
    } finally {
        store.close();
    }
};
