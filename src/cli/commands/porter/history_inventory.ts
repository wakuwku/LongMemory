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
 *  file  : src/cli/commands/porter/history_inventory.ts
 *  usage : implements the LongMemory history inventory component
 */

import type { cli_command } from '../../context/cli_context.js';
import { command_flags, flags, has } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';
import { table } from '../../output/table.js';
import { exit_codes } from '../../output/errors.js';
import { load_history_inventory } from '../../porter/history_source.js';
import { parse_harness } from './common.js';
import { flag } from '../../context/cli_context.js';

export const history_inventory_command: cli_command = async (context) => {
    command_flags(context, ['from', 'id', 'all']);
    const harness = parse_harness(flag(context, 'from'));
    const ids = flags(context, 'id').filter(Boolean);
    if (has(context, 'all') && ids.length) throw new Error('--all and --id cannot be combined');
    const loaded = await load_history_inventory(harness, { ids, env: context.env });
    const result = {
        ok: loaded.parse_failures.length === 0,
        operation: 'history_inventory',
        dry_run: true,
        writes: { central_memory: false, project_database: false, source_sessions: false, files: false },
        discovered: loaded.discovered,
        selected: loaded.selected,
        parse_failures: loaded.parse_failures,
        inventory: loaded.inventory,
    };
    if (loaded.parse_failures.length) context.exit_code = exit_codes.generic;
    emit(context, result, () => table(loaded.inventory.sessions.map((session) => ({
        session: session.source_session_id,
        cwd: session.normalized_cwd ?? '(missing)',
        parents: session.parent_source_ids.join(', ') || '—',
        title: session.title,
    })), [
        { key: 'session', label: 'SOURCE SESSION', min: 18 },
        { key: 'cwd', label: 'CWD CANDIDATE', min: 20 },
        { key: 'parents', label: 'PARENT IDS', min: 12 },
        { key: 'title', label: 'TITLE', min: 16 },
    ], context.colors, context.terminal_width));
};
