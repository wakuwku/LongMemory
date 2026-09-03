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
 *  file  : src/cli/commands/porter/history_worker.ts
 *  usage : implements the LongMemory history worker component
 */

import { existsSync } from 'node:fs';
import {
    codex_history_worker_id,
    HistoryWorkerAuthorizationService,
} from '../../../core/central_memory/history_worker_authorization.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import type { cli_command, cli_context } from '../../context/cli_context.js';
import { command_flags, flag, has, positional, require_value } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';

type worker_preflight = {
    tenant_id: string;
    user_id: string;
    project_id: string;
};

function preflight(context: cli_context, mutating: boolean): worker_preflight {
    const explicit_db = flag(context, 'db')?.trim();
    if (!has(context, 'db') || !explicit_db || explicit_db === ':memory:' || context.db_path === ':memory:') {
        throw new Error('history worker management requires an explicit persistent --db <central-memory.db>');
    }
    const explicit_project = flag(context, 'project')?.trim();
    if (!has(context, 'project') || !explicit_project || explicit_project === 'current') {
        throw new Error('history worker management requires an explicit --project <project-id>');
    }
    if (!existsSync(context.db_path)) {
        throw new Error(`central-memory database was not found: ${context.db_path}`);
    }
    if (mutating) {
        if (context.args.flags.get('confirm-human') !== true) {
            throw new Error('history worker authorization changes require --confirm-human');
        }
        if (context.dry_run) throw new Error('--dry-run cannot change history worker authorization');
    }
    return {
        tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
        user_id: context.user_id,
        project_id: context.project_id,
    };
}

function management_evidence(input: {
    action: 'authorize' | 'revoke';
    action_id: string;
    project_id: string;
    target_id: string;
    worker_session_id?: string;
    run_id?: string | null;
    plan_id?: string | null;
    all_runs?: boolean;
}): Record<string, unknown> {
    return {
        schema: 1,
        source: 'longmemory_history_worker_cli',
        channel: 'local_cli',
        explicit_human_confirmation: true,
        action: input.action,
        action_id: input.action_id,
        project_id: input.project_id,
        target_id: input.target_id,
        ...(input.worker_session_id === undefined ? {} : { worker_session_id: input.worker_session_id }),
        ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
        ...(input.plan_id === undefined ? {} : { plan_id: input.plan_id }),
        ...(input.all_runs === undefined ? {} : { all_runs: input.all_runs }),
    };
}

export const history_worker_command: cli_command = async (context) => {
    const action = require_value(positional(context, 0), '<authorize|revoke|list>');
    if (!['authorize', 'revoke', 'list'].includes(action)) {
        throw new Error(`unsupported history worker action: ${action}`);
    }
    const mutating = action !== 'list';
    command_flags(context, action === 'authorize'
        ? ['action-id', 'confirm-human', 'run-id', 'plan-id', 'all-runs']
        : action === 'revoke'
            ? ['action-id', 'confirm-human']
            : ['session-id', 'all']);
    const scope = preflight(context, mutating);
    const store = new SqliteStore(context.db_path, {
        tenant_id: scope.tenant_id,
        user_id: scope.user_id,
        file_must_exist: true,
        startup_integrity_check: false,
    });
    try {
        const service = new HistoryWorkerAuthorizationService(store.database, {
            tenant_id: scope.tenant_id,
            user_id: scope.user_id,
        });
        if (action === 'authorize') {
            if (context.args.positionals.length !== 2) {
                throw new Error('history worker authorize accepts exactly one worker session id');
            }
            const worker_session_id = require_value(positional(context, 1), '<worker-session-id>');
            const action_id = require_value(flag(context, 'action-id'), '--action-id <id>');
            const run_id = flag(context, 'run-id')?.trim() || null;
            const plan_id = flag(context, 'plan-id')?.trim() || null;
            const all_runs = context.args.flags.get('all-runs') === true;
            if (has(context, 'all-runs') && !all_runs) {
                throw new Error('--all-runs must be passed as a bare explicit flag');
            }
            if (!all_runs && run_id === null && plan_id === null) {
                throw new Error('history worker authorize requires --run-id, --plan-id, or explicit --all-runs');
            }
            if (all_runs && (run_id !== null || plan_id !== null)) {
                throw new Error('--all-runs cannot be combined with --run-id or --plan-id');
            }
            const authorization = service.authorize({
                project_id: scope.project_id,
                worker_session_id,
                worker_id: codex_history_worker_id(scope.tenant_id, scope.user_id, worker_session_id),
                run_id,
                plan_id,
                actor_id: scope.user_id,
                action_id,
                evidence: management_evidence({
                    action: 'authorize', action_id, project_id: scope.project_id,
                    target_id: worker_session_id, worker_session_id, run_id, plan_id, all_runs,
                }),
            });
            emit(context, {
                ok: true,
                command: 'history worker authorize',
                db_path: context.db_path,
                project_id: scope.project_id,
                authorization,
            }, () => `Authorized ${worker_session_id} as a dedicated history worker (${authorization.authorization_id}).`);
            return;
        }
        if (action === 'revoke') {
            if (context.args.positionals.length !== 2) {
                throw new Error('history worker revoke accepts exactly one authorization id');
            }
            const authorization_id = require_value(positional(context, 1), '<authorization-id>');
            const action_id = require_value(flag(context, 'action-id'), '--action-id <id>');
            const authorization = service.revoke({
                authorization_id,
                project_id: scope.project_id,
                actor_id: scope.user_id,
                action_id,
                evidence: management_evidence({
                    action: 'revoke', action_id, project_id: scope.project_id,
                    target_id: authorization_id,
                }),
            });
            emit(context, {
                ok: true,
                command: 'history worker revoke',
                db_path: context.db_path,
                project_id: scope.project_id,
                authorization,
            }, () => `Revoked history worker authorization ${authorization_id}.`);
            return;
        }
        if (context.args.positionals.length !== 1) {
            throw new Error('history worker list accepts no positional selector');
        }
        const authorizations = service.list(scope.project_id, {
            ...(flag(context, 'session-id') === undefined
                ? {}
                : { worker_session_id: flag(context, 'session-id')!.trim() }),
            ...(has(context, 'all') ? {} : { status: 'active' }),
        });
        emit(context, {
            ok: true,
            command: 'history worker list',
            db_path: context.db_path,
            project_id: scope.project_id,
            authorizations,
        }, () => `${authorizations.length} history worker authorization(s).`);
    } finally {
        store.close();
    }
};
