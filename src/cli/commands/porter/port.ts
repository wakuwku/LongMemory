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
 *  file  : src/cli/commands/porter/port.ts
 *  usage : implements the LongMemory port component
 */


import type { cli_command } from '../../context/cli_context.js';
import { command_flags, flag, flags, has, with_project } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';
import { table } from '../../output/table.js';
import { port_preparsed_sessions, port_sessions, type porter_event, type port_outcome } from '../../porter/orchestrator.js';
import { exit_codes } from '../../output/errors.js';
import { format_event, outcome_counts, parse_harness } from './common.js';
import { load_history_inventory } from '../../porter/history_source.js';
import { read_history_override_manifest } from '../../porter/history_plan.js';
import { authorize_codex_history_import, type history_import_evidence } from '../../porter/history_authorization.js';
import { stage_authorized_codex_history, type staged_history_run } from '../../porter/history_backfill.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const port_command: cli_command = async (context) => {
    command_flags(context, ['from', 'to', 'id', 'all', 'force', 'agent', 'history-manifest']);
    const harness = parse_harness(flag(context, 'from'));
    const destination = flag(context, 'to');
    if (destination !== 'longmemory') throw new Error('--to must be longmemory; direct harness-store writes are intentionally disabled');
    const ids = flags(context, 'id').filter(Boolean);
    const all = has(context, 'all');
    if (!all && !ids.length) throw new Error('one of --all or --id <session-id> is required');
    if (harness === 'codex' && all) throw new Error('Codex --all import is disabled because historical tasks can belong to different projects. Run `longmemory history plan --from codex --all`, review/override its groups, then import explicit --id values into one project at a time.');
    if (harness === 'codex' && new Set(ids).size !== ids.length) throw new Error('duplicate --id values are not allowed in an authorized Codex import');
    const on_event = (event: porter_event) => {
        if (context.jsonl) context.io.stdout(JSON.stringify(event));
        else if (context.human) context.io.stderr(`${format_event(event)}\n`);
    };
    let outcomes: port_outcome[];
    let history_evidence: history_import_evidence | undefined;
    let history_runs: staged_history_run[] | undefined;
    if (harness === 'codex') {
        if (!has(context, 'project')) throw new Error('Codex history import requires an explicit --project <confirmed-project-id>');
        if (!has(context, 'db') || context.db_path === ':memory:') throw new Error('Codex history import requires an explicit persistent --db <central-memory.db>');
        const manifest_arg = flag(context, 'history-manifest');
        if (!manifest_arg) throw new Error('Codex history import requires --history-manifest <confirmed-overrides.json>');
        const manifest = read_history_override_manifest(resolve(context.cwd, manifest_arg));
        const loaded = await load_history_inventory('codex', {
            env: context.env,
            ...(manifest.source_snapshot ? { source_snapshot: manifest.source_snapshot } : {}),
            ...(!manifest.source_snapshot ? { include_source_snapshot: false } : {}),
        });
        const authorized = authorize_codex_history_import(loaded, manifest, ids, context.project_id, context.db_path);
        history_evidence = authorized.evidence;
        if (!context.dry_run) {
            // Codex history staging opens the central database before the
            // legacy project porter reaches with_project(), so a first import
            // must create the already-authorized database parent here.
            mkdirSync(dirname(context.db_path), { recursive: true });
            history_runs = stage_authorized_codex_history({
                authorization: authorized,
                db_path: context.db_path,
                project_id: context.project_id,
                project_name: context.project_name,
            });
        }
        on_event({ type: 'import:start', harness, total: authorized.sessions.length, message: `authorized plan ${authorized.plan.plan_id}` });
        outcomes = await with_project(context, (project) => port_preparsed_sessions(project, context.project_id, harness, authorized.sessions, {
            force: has(context, 'force'), agent_id: flag(context, 'agent'), on_event, history_authorization: authorized,
        }));
        on_event({ type: 'import:done', harness, current: outcomes.length, total: authorized.sessions.length });
    } else {
        outcomes = await with_project(context, (project) => port_sessions(project, context.project_id, harness, {
            all, ids, force: has(context, 'force'), agent_id: flag(context, 'agent'), env: context.env, on_event,
        }));
    }
    const counts = outcome_counts(outcomes);
    const result = { ok: counts.errors === 0, source: harness, destination: 'longmemory', project_id: context.project_id, db_path: context.db_path, ...(history_evidence ? { history_evidence } : {}), ...(history_runs ? { history_runs } : {}), counts, outcomes };
    if (counts.errors) context.exit_code = exit_codes.generic;
    if (context.jsonl) context.io.stdout(JSON.stringify({ type: 'summary', ...result }));
    else emit(context, result, () => table(outcomes.map((outcome) => ({ session: outcome.source_session_id, status: outcome.status, asset: outcome.asset_id, detail: outcome.reason ?? outcome.error ?? outcome.imported_session_id ?? '—' })), [{ key: 'session', label: 'SESSION', min: 12 }, { key: 'status', label: 'STATUS', width: 8 }, { key: 'asset', label: 'CHAT MEMORY ASSET', min: 18 }, { key: 'detail', label: 'DETAIL', min: 12 }], context.colors, context.terminal_width));
};
