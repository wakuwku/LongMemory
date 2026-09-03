/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/cli/commands/porter/verify.ts
 *  usage : implements the LongMemory verify component
 */


import type { cli_command } from '../../context/cli_context.js';
import { command_flags, flag, number_flag } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';
import { panel } from '../../output/panel.js';
import { verify_sessions } from '../../porter/orchestrator.js';
import { exit_codes } from '../../output/errors.js';
import { parse_harness } from './common.js';

export const verify_command: cli_command = async (context) => {
    command_flags(context, ['from', 'sample']);
    const harness = parse_harness(flag(context, 'from'));
    const sample = Math.max(1, Math.min(1_000, number_flag(context, 'sample', 10) ?? 10));
    const result = await verify_sessions(harness, sample, context.env);
    const reconciliation = result.reconciliation;
    const failed = result.failures.length > 0 || (reconciliation?.parse_failures ?? 0) > 0;
    if (failed) context.exit_code = exit_codes.generic;
    const rows: Array<[string, unknown]> = [
        ['Discovered', result.discovered],
        ['Verified', result.verified],
        ['Failures', result.failures.length],
    ];
    if (reconciliation) rows.push(
        ['Source JSONL files', reconciliation.source_files],
        ['Importable tasks', reconciliation.importable_tasks],
        ['Empty tasks', reconciliation.empty_tasks],
        ['Parse failures', reconciliation.parse_failures],
        ['Excluded tasks', reconciliation.excluded_tasks],
        ['Partial tasks', reconciliation.partial_tasks],
    );
    emit(context, { ok: !failed, ...result }, () => panel('', context.colors, {
        title: `Verify ${harness}`,
        kind: failed ? 'danger' : reconciliation && (reconciliation.empty_tasks || reconciliation.partial_tasks) ? 'warning' : 'success',
        width: context.terminal_width,
        rows,
    }));
};
