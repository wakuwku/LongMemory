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
 *  file  : src/cli/commands/project/link.ts
 *  usage : implements the LongMemory link component
 */

import { existsSync } from 'node:fs';
import { CentralMemoryService } from '../../../core/central_memory/service.js';
import type { central_confirmation_decision } from '../../../core/central_memory/types.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import type { cli_command, cli_context } from '../../context/cli_context.js';
import { command_flags, flag, has, positional, require_value } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';

type project_link_action = 'list' | 'create' | 'revoke';

function require_persistent_scope(context: cli_context): { tenant_id: string; project_id: string } {
    const explicit_db = flag(context, 'db')?.trim();
    if (!has(context, 'db') || !explicit_db || explicit_db === ':memory:' || context.db_path === ':memory:') {
        throw new Error('project link governance requires an explicit persistent --db <central-memory.db>');
    }
    const explicit_project = flag(context, 'project')?.trim();
    if (!has(context, 'project') || !explicit_project || explicit_project === 'current') {
        throw new Error('project link governance requires an explicit --project <project-id>');
    }
    if (!existsSync(context.db_path)) {
        throw new Error(`central-memory database was not found: ${context.db_path}`);
    }
    return {
        tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
        project_id: context.project_id,
    };
}

function human_decision(
    context: cli_context,
    action: project_link_action,
    target: Record<string, unknown>,
): central_confirmation_decision {
    if (context.args.flags.get('confirm-human') !== true) {
        throw new Error('project link governance requires --confirm-human to attest an explicit human decision');
    }
    if (context.dry_run) throw new Error('--dry-run cannot submit a project link governance decision');
    const action_id = require_value(flag(context, 'action-id'), '--action-id <id>');
    if (action_id.length > 512) throw new Error('--action-id exceeds 512 characters');
    const note = flag(context, 'note')?.trim() ?? '';
    if (note.length > 2_000) throw new Error('--note exceeds 2000 characters');
    return {
        actor_id: context.user_id,
        actor_kind: 'user',
        action_id,
        channel: 'local_cli',
        note,
        evidence: {
            schema: 1,
            source: 'longmemory_project_link_cli',
            explicit_human_confirmation: true,
            authorized_project_id: context.project_id,
            action,
            ...target,
        },
    };
}

export const project_link_command: cli_command = async (context) => {
    command_flags(context, ['action-id', 'note', 'confirm-human', 'two-way', 'status']);
    const raw_action = require_value(positional(context, 0), '<list|create|revoke>');
    if (!['list', 'create', 'revoke'].includes(raw_action)) {
        throw new Error(`unsupported project link action: ${raw_action}`);
    }
    const action = raw_action as project_link_action;
    const scope = require_persistent_scope(context);
    const store = new SqliteStore(context.db_path, {
        tenant_id: scope.tenant_id,
        user_id: context.user_id,
        file_must_exist: true,
    });
    try {
        const service = new CentralMemoryService(store.central_memory);
        if (action === 'list') {
            if (context.args.positionals.length !== 1) throw new Error('project link list accepts no positional target');
            const status = flag(context, 'status');
            if (status !== undefined && status !== 'active' && status !== 'revoked') {
                throw new Error('--status must be active or revoked');
            }
            const links = store.central_memory.list_project_links({
                project_id: scope.project_id,
                status,
            });
            emit(context, {
                ok: true, command: 'project link list', project_id: scope.project_id,
                db_path: context.db_path, links, count: links.length,
            }, () => `Found ${links.length} project link direction(s) for ${scope.project_id}.`);
            return;
        }

        if (action === 'create') {
            const source_project_id = require_value(positional(context, 1), '<source-project-id>');
            const target_project_id = require_value(positional(context, 2), '<target-project-id>');
            if (context.args.positionals.length !== 3) {
                throw new Error('project link create accepts exactly source and target project ids');
            }
            if (scope.project_id !== source_project_id && scope.project_id !== target_project_id) {
                throw new Error(`project link must include authorized project ${scope.project_id}`);
            }
            const direction = has(context, 'two-way') ? 'two_way' : 'one_way';
            const decision = human_decision(context, action, {
                source_project_id, target_project_id, direction,
            });
            const links = service.link_projects({
                source_project_id, target_project_id, direction, decision,
                metadata: { managed_by: 'local_cli', l4_only: true },
            });
            emit(context, {
                ok: true, command: 'project link create', project_id: scope.project_id,
                db_path: context.db_path, links, count: links.length,
            }, () => `Enabled ${links.length} governed L4 project link direction(s).`);
            return;
        }

        const link_id = require_value(positional(context, 1), '<link-id>');
        if (context.args.positionals.length !== 2) throw new Error('project link revoke accepts exactly one link id');
        const prior = store.central_memory.require_project_link(link_id);
        if (scope.project_id !== prior.source_project_id && scope.project_id !== prior.target_project_id) {
            throw new Error(`project link ${link_id} does not include authorized project ${scope.project_id}`);
        }
        const decision = human_decision(context, action, { link_id });
        const result = service.revoke_project_link(link_id, decision);
        emit(context, {
            ok: true, command: 'project link revoke', project_id: scope.project_id,
            db_path: context.db_path, ...result,
        }, () => `Revoked ${link_id}; retracted ${result.retracted_worksets} linked workset(s).`);
    } finally {
        store.close();
    }
};
