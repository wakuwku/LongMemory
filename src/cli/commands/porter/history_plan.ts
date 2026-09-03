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
 *  file  : src/cli/commands/porter/history_plan.ts
 *  usage : implements the LongMemory history plan component
 */

import { resolve } from 'node:path';
import type { cli_command } from '../../context/cli_context.js';
import { command_flags, flag, flags, has } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';
import { table } from '../../output/table.js';
import { exit_codes } from '../../output/errors.js';
import { build_history_project_plan, read_history_override_manifest } from '../../porter/history_plan.js';
import { load_history_inventory } from '../../porter/history_source.js';
import { parse_harness } from './common.js';

export const history_plan_command: cli_command = async (context) => {
    command_flags(context, ['from', 'id', 'all', 'manifest']);
    const harness = parse_harness(flag(context, 'from'));
    const ids = flags(context, 'id').filter(Boolean);
    if (has(context, 'all') && ids.length) throw new Error('--all and --id cannot be combined');
    if (harness === 'codex' && ids.length) throw new Error('Codex history authorization plans must cover the complete current inventory; use --all and review the emitted manifest template');
    const manifest_path = flag(context, 'manifest');
    const manifest = manifest_path ? read_history_override_manifest(resolve(context.cwd, manifest_path)) : undefined;
    const loaded = await load_history_inventory(harness, {
        ids,
        env: context.env,
        ...(manifest?.source_snapshot ? { source_snapshot: manifest.source_snapshot } : {}),
        ...(manifest && !manifest.source_snapshot ? { include_source_snapshot: false } : {}),
    });
    const plan = build_history_project_plan(loaded.inventory, manifest);
    const ok = loaded.parse_failures.length === 0;
    if (!ok) context.exit_code = exit_codes.generic;
    const result = {
        ok,
        operation: 'history_project_plan',
        discovered: loaded.discovered,
        selected: loaded.selected,
        deferred_source_files: loaded.deferred_source_files,
        parse_failures: loaded.parse_failures,
        plan,
    };
    emit(context, result, () => table(plan.projects.map((project) => ({
        project: project.project_id,
        name: project.project_name,
        sessions: project.source_session_ids.length,
        cwd: project.cwd_scopes.join(', ') || '(inherited)',
        confirmation: project.confirmation,
    })), [
        { key: 'project', label: 'PROJECT CANDIDATE', min: 20 },
        { key: 'name', label: 'NAME', min: 12 },
        { key: 'sessions', label: 'SESSIONS', width: 8 },
        { key: 'cwd', label: 'CWD SCOPE', min: 20 },
        { key: 'confirmation', label: 'CONFIRMATION', width: 12 },
    ], context.colors, context.terminal_width));
};
