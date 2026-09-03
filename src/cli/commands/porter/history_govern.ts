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
 *  file  : src/cli/commands/porter/history_govern.ts
 *  usage : implements the LongMemory history govern component
 */

import { existsSync } from 'node:fs';
import { HistoryPublicationService } from '../../../core/central_memory/history_publication_service.js';
import type { history_governance_action } from '../../../core/central_memory/history_publication_types.js';
import { CentralMemoryService } from '../../../core/central_memory/service.js';
import type { central_metadata } from '../../../core/central_memory/types.js';
import { hash_canonical } from '../../../core/hash/content_hash.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import type { cli_command, cli_context } from '../../context/cli_context.js';
import { command_flags, flag, has, positional, require_value } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';

const governance_actions = new Set<history_governance_action>([
    'accept_hierarchy',
    'reject_hierarchy',
    'approve_update',
    'approve_conflict',
    'discard',
    'retry',
]);

type central_decision_action = 'approve' | 'reject' | 'cancel';

type governance_preflight = {
    action_id: string;
    actor_id: string;
    note: string;
    project_id: string;
    tenant_id: string;
    user_id: string;
};

type action_row = {
    confirmation_id: string;
    status: string;
    decision_note: string;
    decision_metadata_json: string;
};

function positive_integer(value: string | undefined, label: string): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
    return parsed;
}

function preflight(context: cli_context): governance_preflight {
    const explicit_db = flag(context, 'db')?.trim();
    if (!has(context, 'db') || !explicit_db || explicit_db === ':memory:' || context.db_path === ':memory:') {
        throw new Error('history governance requires an explicit persistent --db <central-memory.db>');
    }
    const explicit_project = flag(context, 'project')?.trim();
    if (!has(context, 'project') || !explicit_project || explicit_project === 'current') {
        throw new Error('history governance requires an explicit --project <project-id>');
    }
    if (!existsSync(context.db_path)) {
        throw new Error(`central-memory database was not found: ${context.db_path}`);
    }
    if (context.args.flags.get('confirm-human') !== true) {
        throw new Error('history governance requires --confirm-human to attest an explicit human decision');
    }
    if (context.dry_run) throw new Error('--dry-run cannot submit a governance decision');
    const action_id = require_value(flag(context, 'action-id'), '--action-id <id>');
    if (action_id.length > 512) throw new Error('--action-id exceeds 512 characters');
    const note = flag(context, 'note')?.trim() ?? '';
    if (note.length > 2_000) throw new Error('--note exceeds 2000 characters');
    const tenant_id = context.env.LONGMEMORY_TENANT_ID?.trim() || 'default';
    return {
        action_id,
        actor_id: context.user_id,
        note,
        project_id: context.project_id,
        tenant_id,
        user_id: context.user_id,
    };
}

function open_store(context: cli_context, input: governance_preflight): SqliteStore {
    return new SqliteStore(context.db_path, {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        file_must_exist: true,
    });
}

function require_publication_project(
    store: SqliteStore,
    publication_id: string,
    project_id: string,
): void {
    const row = store.database.prepare(`SELECT run.project_id
        FROM cm_history_publications AS publication
        JOIN cm_history_backfill_runs AS run
          ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
         AND run.run_id=publication.run_id
        WHERE publication.tenant_id=? AND publication.user_id=? AND publication.publication_id=?`)
        .get(store.tenant_id, store.user_id, publication_id) as { project_id: string } | undefined;
    if (!row) throw new Error(`history publication ${publication_id} was not found in this tenant/user scope`);
    if (row.project_id !== project_id) {
        throw new Error(`history publication ${publication_id} belongs to project ${row.project_id}, not ${project_id}`);
    }
}

function require_confirmation_project(
    store: SqliteStore,
    confirmation_id: string,
    project_id: string,
): void {
    const row = store.database.prepare(`SELECT memory.project_id
        FROM cm_confirmations AS confirmation
        JOIN cm_memories AS memory
          ON memory.tenant_id=confirmation.tenant_id AND memory.user_id=confirmation.user_id
         AND memory.memory_id=confirmation.memory_id
        WHERE confirmation.tenant_id=? AND confirmation.user_id=? AND confirmation.confirmation_id=?`)
        .get(store.tenant_id, store.user_id, confirmation_id) as { project_id: string } | undefined;
    if (!row) throw new Error(`central confirmation ${confirmation_id} was not found in this tenant/user scope`);
    if (row.project_id !== project_id) {
        throw new Error(`central confirmation ${confirmation_id} belongs to project ${row.project_id}, not ${project_id}`);
    }
}

function history_evidence(
    input: governance_preflight,
    publication_id: string,
    action: history_governance_action,
): Record<string, unknown> {
    return {
        schema: 1,
        source: 'longmemory_history_govern_cli',
        explicit_human_confirmation: true,
        action_id: input.action_id,
        project_id: input.project_id,
        target_kind: 'history_publication',
        target_id: publication_id,
        action,
    };
}

function confirmation_evidence(
    input: governance_preflight,
    confirmation_id: string,
    action: central_decision_action,
): central_metadata {
    return {
        schema: 1,
        source: 'longmemory_history_confirm_cli',
        explicit_human_confirmation: true,
        action_id: input.action_id,
        project_id: input.project_id,
        target_kind: 'central_confirmation',
        target_id: confirmation_id,
        action,
    };
}

function history_publication_for_confirmation(
    store: SqliteStore,
    confirmation_id: string,
    project_id: string,
): string | null {
    const rows = store.database.prepare(`SELECT publication.publication_id
        FROM cm_history_publications AS publication
        JOIN cm_history_backfill_runs AS run
          ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
         AND run.run_id=publication.run_id
        WHERE publication.tenant_id=? AND publication.user_id=?
          AND (publication.result_confirmation_id=? OR EXISTS (
              SELECT 1 FROM cm_history_publication_attempts AS attempt
              WHERE attempt.tenant_id=publication.tenant_id
                AND attempt.user_id=publication.user_id
                AND attempt.publication_id=publication.publication_id
                AND attempt.result_confirmation_id=?
          ))
          AND run.project_id=?
        ORDER BY publication.publication_id`)
        .all(store.tenant_id, store.user_id, confirmation_id, confirmation_id, project_id) as Array<{ publication_id: string }>;
    if (rows.length > 1) throw new Error(`central confirmation ${confirmation_id} is linked to multiple history publications`);
    return rows[0]?.publication_id ?? null;
}

function find_action_rows(store: SqliteStore, action_id: string): action_row[] {
    return store.database.prepare(`SELECT confirmation_id, status, decision_note, decision_metadata_json
        FROM cm_confirmations
        WHERE tenant_id=? AND user_id=?
          AND json_extract(decision_metadata_json, '$.action_id')=?
        ORDER BY confirmation_id`)
        .all(store.tenant_id, store.user_id, action_id) as action_row[];
}

export const history_govern_command: cli_command = async (context) => {
    command_flags(context, ['action-id', 'proposal-id', 'plan-version', 'note', 'confirm-human']);
    const raw_action = require_value(positional(context, 0), '<governance-action>');
    if (!governance_actions.has(raw_action as history_governance_action)) {
        throw new Error(`unsupported history governance action: ${raw_action}`);
    }
    const action = raw_action as history_governance_action;
    const publication_id = require_value(positional(context, 1), '<publication-id>');
    if (context.args.positionals.length !== 2) throw new Error('history govern accepts exactly an action and publication id');
    const input = preflight(context);
    const proposal_id = flag(context, 'proposal-id')?.trim() || null;
    const plan_version = positive_integer(flag(context, 'plan-version'), '--plan-version');
    const store = open_store(context, input);
    try {
        require_publication_project(store, publication_id, input.project_id);
        const service = new HistoryPublicationService(store.database, {
            tenant_id: input.tenant_id,
            user_id: input.user_id,
            capability_guard: () => {
                throw new Error('the local governance CLI has no history worker capability');
            },
        });
        const decision = service.decide({
            publication_id,
            proposal_id,
            plan_version,
            action,
            actor_id: input.actor_id,
            actor_kind: 'user',
            action_id: input.action_id,
            channel: 'local_cli',
            evidence: history_evidence(input, publication_id, action),
            note: input.note,
        });
        const publication = service.get(publication_id);
        emit(context, {
            ok: true,
            command: 'history govern',
            project_id: input.project_id,
            db_path: context.db_path,
            decision,
            publication,
        }, () => `Recorded ${action} for ${publication_id}; publication status is ${publication.status}.`);
    } finally {
        store.close();
    }
};

export const history_confirm_command: cli_command = async (context) => {
    command_flags(context, ['action-id', 'note', 'confirm-human']);
    const raw_action = require_value(positional(context, 0), '<approve|reject|cancel>');
    if (!['approve', 'reject', 'cancel'].includes(raw_action)) {
        throw new Error(`unsupported central confirmation action: ${raw_action}`);
    }
    const action = raw_action as central_decision_action;
    const confirmation_id = require_value(positional(context, 1), '<confirmation-id>');
    if (context.args.positionals.length !== 2) throw new Error('history confirm accepts exactly an action and confirmation id');
    const input = preflight(context);
    const store = open_store(context, input);
    try {
        require_confirmation_project(store, confirmation_id, input.project_id);
        const evidence = confirmation_evidence(input, confirmation_id, action);
        const expected_metadata = {
            actor_kind: 'user',
            action_id: input.action_id,
            channel: 'local_cli',
            evidence,
        };
        const desired_status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
        let replayed = false;
        const central = new CentralMemoryService(store.central_memory);
        store.central_memory.transaction(() => {
            const prior_actions = find_action_rows(store, input.action_id);
            if (prior_actions.length > 0) {
                if (prior_actions.length !== 1
                    || prior_actions[0]!.confirmation_id !== confirmation_id
                    || prior_actions[0]!.status !== desired_status
                    || prior_actions[0]!.decision_note !== input.note
                    || hash_canonical(JSON.parse(prior_actions[0]!.decision_metadata_json)) !== hash_canonical(expected_metadata)) {
                    throw new Error(`central confirmation action_id ${input.action_id} was already used with different content`);
                }
                replayed = true;
                return;
            }
            const confirmation = store.central_memory.require_confirmation(confirmation_id);
            if (confirmation.status !== 'pending') {
                throw new Error(`central confirmation ${confirmation_id} is not pending and was not decided by this action_id`);
            }
            const decision = {
                actor_id: input.actor_id,
                actor_kind: 'user' as const,
                action_id: input.action_id,
                channel: 'local_cli' as const,
                evidence,
                note: input.note,
            };
            if (action === 'approve') central.approve(confirmation_id, decision);
            else if (action === 'reject') central.reject(confirmation_id, decision);
            else central.cancel(confirmation_id, decision);
        });

        const publication_id = history_publication_for_confirmation(store, confirmation_id, input.project_id);
        let publication = null;
        if (publication_id) {
            const history = new HistoryPublicationService(store.database, {
                tenant_id: input.tenant_id,
                user_id: input.user_id,
                capability_guard: () => {
                    throw new Error('the local confirmation CLI has no history worker capability');
                },
            });
            publication = history.reconcile_confirmation(publication_id);
        }
        const confirmation = store.central_memory.require_confirmation(confirmation_id);
        emit(context, {
            ok: true,
            command: 'history confirm',
            project_id: input.project_id,
            db_path: context.db_path,
            replayed,
            confirmation,
            publication,
        }, () => `Central confirmation ${confirmation_id} is ${confirmation.status}${publication
            ? `; history publication is ${publication.status}` : ''}.`);
    } finally {
        store.close();
    }
};
