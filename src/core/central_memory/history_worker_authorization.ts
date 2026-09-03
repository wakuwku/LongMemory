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
 *  file  : src/core/central_memory/history_worker_authorization.ts
 *  usage : implements the LongMemory history worker authorization component
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalize } from '../hash/canonical_json.js';
import { hash_canonical } from '../hash/content_hash.js';
import { assert_no_obvious_credentials } from './sensitive_content.js';

type row = Record<string, unknown>;

export type history_worker_authorization_status = 'active' | 'revoked';

export type history_worker_authorization = {
    authorization_id: string;
    project_id: string;
    worker_session_id: string;
    worker_id: string;
    run_id: string | null;
    plan_id: string | null;
    scope_hash: string;
    status: history_worker_authorization_status;
    authorized_by: string;
    authorize_action_id: string;
    authorize_evidence: Record<string, unknown>;
    authorized_at: number;
    revoked_by: string | null;
    revoke_action_id: string | null;
    revoke_evidence: Record<string, unknown> | null;
    revoked_at: number | null;
};

export type authorize_history_worker_input = {
    project_id: string;
    worker_session_id: string;
    worker_id: string;
    run_id?: string | null;
    plan_id?: string | null;
    actor_id: string;
    action_id: string;
    evidence: Record<string, unknown>;
    at?: number;
};

export type revoke_history_worker_input = {
    authorization_id: string;
    project_id: string;
    actor_id: string;
    action_id: string;
    evidence: Record<string, unknown>;
    at?: number;
};

const optional_string = (value: unknown): string | null => (
    value === null || value === undefined ? null : String(value)
);

function object(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exact_keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const permitted = new Set(allowed);
    if (Object.keys(value).some((key) => !permitted.has(key))) {
        throw new Error(`${label} contains unsupported fields`);
    }
}

function bounded(value: unknown, label: string, maximum: number): string {
    if (typeof value !== 'string' || !value.trim() || [...value].length > maximum) {
        throw new Error(`${label} must contain between 1 and ${maximum} characters`);
    }
    return value;
}

function optional_bounded(value: unknown, label: string, maximum: number): string | null {
    return value === undefined || value === null ? null : bounded(value, label, maximum);
}

function timestamp(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function evidence_json(value: unknown, label: string): string {
    const evidence = object(value, label);
    assert_no_obvious_credentials({ [label]: evidence });
    const json = canonicalize(evidence);
    if (Buffer.byteLength(json, 'utf8') > 16_384) throw new Error(`${label} exceeds 16384 UTF-8 bytes`);
    return json;
}

function map_authorization(value: row): history_worker_authorization {
    return {
        authorization_id: String(value.authorization_id),
        project_id: String(value.project_id),
        worker_session_id: String(value.worker_session_id),
        worker_id: String(value.worker_id),
        run_id: optional_string(value.run_id),
        plan_id: optional_string(value.plan_id),
        scope_hash: String(value.scope_hash),
        status: value.status as history_worker_authorization_status,
        authorized_by: String(value.authorized_by),
        authorize_action_id: String(value.authorize_action_id),
        authorize_evidence: JSON.parse(String(value.authorize_evidence_json)) as Record<string, unknown>,
        authorized_at: Number(value.authorized_at),
        revoked_by: optional_string(value.revoked_by),
        revoke_action_id: optional_string(value.revoke_action_id),
        revoke_evidence: value.revoke_evidence_json === null
            ? null
            : JSON.parse(String(value.revoke_evidence_json)) as Record<string, unknown>,
        revoked_at: value.revoked_at === null ? null : Number(value.revoked_at),
    };
}

export function codex_history_worker_id(
    tenant_id: string,
    user_id: string,
    worker_session_id: string,
): string {
    return `codex-history:${createHash('sha256').update([
        tenant_id, user_id, worker_session_id,
    ].join('\0')).digest('hex').slice(0, 40)}`;
}

export function history_worker_scope_hash(input: {
    tenant_id: string;
    user_id: string;
    project_id: string;
    worker_session_id: string;
    worker_id: string;
    run_id: string | null;
    plan_id: string | null;
}): string {
    return hash_canonical({ schema: 1, ...input });
}

export function has_active_history_worker_authorization(
    database: Database.Database,
    input: {
        tenant_id: string;
        user_id: string;
        project_id: string;
        worker_session_id: string;
        worker_id: string;
        run_id?: string;
    },
): boolean {
    const values = input.run_id === undefined
        ? database.prepare(`SELECT * FROM cm_history_worker_authorizations
            WHERE tenant_id=? AND user_id=? AND project_id=?
              AND worker_session_id=? AND worker_id=? AND status='active'
            ORDER BY authorization_id`)
            .all(input.tenant_id, input.user_id, input.project_id,
                input.worker_session_id, input.worker_id) as row[]
        : database.prepare(`SELECT authorization.*
            FROM cm_history_backfill_runs AS run
            JOIN cm_history_worker_authorizations AS authorization
              ON authorization.tenant_id=run.tenant_id
             AND authorization.user_id=run.user_id
             AND authorization.project_id=run.project_id
            WHERE run.tenant_id=? AND run.user_id=? AND run.run_id=?
              AND run.project_id=?
              AND authorization.worker_session_id=?
              AND authorization.worker_id=?
              AND authorization.status='active'
              AND (authorization.run_id IS NULL OR authorization.run_id=run.run_id)
              AND (authorization.plan_id IS NULL OR authorization.plan_id=run.plan_id)
            ORDER BY authorization.authorization_id`)
            .all(input.tenant_id, input.user_id, input.run_id, input.project_id,
                input.worker_session_id, input.worker_id) as row[];
    return values.some((value) => String(value.scope_hash) === history_worker_scope_hash({
        tenant_id: String(value.tenant_id),
        user_id: String(value.user_id),
        project_id: String(value.project_id),
        worker_session_id: String(value.worker_session_id),
        worker_id: String(value.worker_id),
        run_id: optional_string(value.run_id),
        plan_id: optional_string(value.plan_id),
    }));
}

export class HistoryWorkerAuthorizationService {
    readonly tenant_id: string;
    readonly user_id: string;
    private readonly now: () => number;

    constructor(
        readonly database: Database.Database,
        options: { tenant_id: string; user_id: string; now?: () => number },
    ) {
        this.tenant_id = bounded(options.tenant_id, 'tenant_id', 1_024);
        this.user_id = bounded(options.user_id, 'user_id', 1_024);
        this.now = options.now ?? (() => Date.now());
    }

    private write<T>(operation: () => T): T {
        if (this.database.inTransaction) return operation();
        return this.database.transaction(operation).immediate();
    }

    private by_action_id(action_id: string): history_worker_authorization | null {
        const value = this.database.prepare(`SELECT * FROM cm_history_worker_authorizations
            WHERE tenant_id=? AND user_id=?
              AND (authorize_action_id=? OR revoke_action_id=?)`)
            .get(this.tenant_id, this.user_id, action_id, action_id) as row | undefined;
        return value ? map_authorization(value) : null;
    }

    private require(authorization_id: string): history_worker_authorization {
        const value = this.database.prepare(`SELECT * FROM cm_history_worker_authorizations
            WHERE tenant_id=? AND user_id=? AND authorization_id=?`)
            .get(this.tenant_id, this.user_id, authorization_id) as row | undefined;
        if (!value) throw new Error(`history worker authorization ${authorization_id} was not found`);
        return map_authorization(value);
    }

    authorize(raw_input: authorize_history_worker_input): history_worker_authorization {
        const input = object(raw_input, 'history worker authorization');
        exact_keys(input, [
            'project_id', 'worker_session_id', 'worker_id', 'run_id', 'plan_id',
            'actor_id', 'action_id', 'evidence', 'at',
        ], 'history worker authorization');
        const project_id = bounded(input.project_id, 'project_id', 1_024);
        const worker_session_id = bounded(input.worker_session_id, 'worker_session_id', 1_024);
        const worker_id = bounded(input.worker_id, 'worker_id', 256);
        const run_id = optional_bounded(input.run_id, 'run_id', 1_024);
        const plan_id = optional_bounded(input.plan_id, 'plan_id', 1_024);
        const actor_id = bounded(input.actor_id, 'actor_id', 1_024);
        const action_id = bounded(input.action_id, 'action_id', 512);
        const evidence = evidence_json(input.evidence, 'history worker authorization evidence');
        const at = timestamp(input.at ?? this.now(), 'history worker authorization timestamp');
        const scope = {
            tenant_id: this.tenant_id,
            user_id: this.user_id,
            project_id,
            worker_session_id,
            worker_id,
            run_id,
            plan_id,
        };
        const scope_hash = history_worker_scope_hash(scope);
        const authorization_id = `history-worker-auth:${hash_canonical([
            this.tenant_id, this.user_id, action_id,
        ]).slice(0, 40)}`;

        return this.write(() => {
            const prior = this.by_action_id(action_id);
            if (prior) {
                if (prior.authorize_action_id === action_id
                    && prior.authorization_id === authorization_id
                    && prior.scope_hash === scope_hash
                    && prior.authorized_by === actor_id
                    && canonicalize(prior.authorize_evidence) === evidence) {
                    return prior;
                }
                throw new Error(`history worker action_id ${action_id} was already used with different content`);
            }
            const thread = this.database.prepare(`SELECT project_id, status FROM cm_threads
                WHERE tenant_id=? AND user_id=? AND thread_id=?`)
                .get(this.tenant_id, this.user_id, worker_session_id) as {
                    project_id: string; status: string;
                } | undefined;
            if (!thread || thread.status !== 'active' || thread.project_id !== project_id) {
                throw new Error('history worker authorization requires an active task in the exact project scope');
            }
            if (run_id !== null) {
                const run = this.database.prepare(`SELECT project_id, plan_id FROM cm_history_backfill_runs
                    WHERE tenant_id=? AND user_id=? AND run_id=?`)
                    .get(this.tenant_id, this.user_id, run_id) as {
                        project_id: string; plan_id: string;
                    } | undefined;
                if (!run || run.project_id !== project_id || (plan_id !== null && run.plan_id !== plan_id)) {
                    throw new Error('history worker run scope is outside the selected project or plan');
                }
            }
            if (plan_id !== null) {
                const plan = this.database.prepare(`SELECT 1 FROM cm_history_backfill_runs
                    WHERE tenant_id=? AND user_id=? AND project_id=? AND plan_id=? LIMIT 1`)
                    .get(this.tenant_id, this.user_id, project_id, plan_id);
                if (!plan) throw new Error('history worker plan scope has no staged run in the selected project');
            }
            try {
                this.database.prepare(`INSERT INTO cm_history_worker_authorizations (
                    tenant_id, user_id, authorization_id, project_id, worker_session_id,
                    worker_id, run_id, plan_id, scope_hash, status, authorized_by,
                    authorize_action_id, authorize_evidence_json, authorized_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
                    .run(this.tenant_id, this.user_id, authorization_id, project_id,
                        worker_session_id, worker_id, run_id, plan_id, scope_hash,
                        actor_id, action_id, evidence, at);
            } catch (error) {
                if (error instanceof Error && /active_scope|UNIQUE constraint failed/.test(error.message)) {
                    throw new Error('an active history worker authorization already exists for this exact scope');
                }
                throw error;
            }
            return this.require(authorization_id);
        });
    }

    revoke(raw_input: revoke_history_worker_input): history_worker_authorization {
        const input = object(raw_input, 'history worker revocation');
        exact_keys(input, [
            'authorization_id', 'project_id', 'actor_id', 'action_id', 'evidence', 'at',
        ], 'history worker revocation');
        const authorization_id = bounded(input.authorization_id, 'authorization_id', 512);
        const project_id = bounded(input.project_id, 'project_id', 1_024);
        const actor_id = bounded(input.actor_id, 'actor_id', 1_024);
        const action_id = bounded(input.action_id, 'action_id', 512);
        const evidence = evidence_json(input.evidence, 'history worker revocation evidence');
        const at = timestamp(input.at ?? this.now(), 'history worker revocation timestamp');

        return this.write(() => {
            const used = this.by_action_id(action_id);
            if (used) {
                if (used.authorization_id === authorization_id
                    && used.revoke_action_id === action_id
                    && used.revoked_by === actor_id
                    && used.revoke_evidence !== null
                    && canonicalize(used.revoke_evidence) === evidence) {
                    return used;
                }
                throw new Error(`history worker action_id ${action_id} was already used with different content`);
            }
            const current = this.require(authorization_id);
            if (current.project_id !== project_id) {
                throw new Error(`history worker authorization ${authorization_id} is outside project ${project_id}`);
            }
            if (current.status !== 'active') {
                throw new Error(`history worker authorization ${authorization_id} is already revoked by another action`);
            }
            const changed = this.database.prepare(`UPDATE cm_history_worker_authorizations
                SET status='revoked', revoked_by=?, revoke_action_id=?,
                    revoke_evidence_json=?, revoked_at=?
                WHERE tenant_id=? AND user_id=? AND authorization_id=? AND status='active'`)
                .run(actor_id, action_id, evidence, at, this.tenant_id, this.user_id, authorization_id);
            if (changed.changes !== 1) throw new Error('history worker authorization changed during revocation');
            return this.require(authorization_id);
        });
    }

    list(
        project_id: string,
        options: {
            worker_session_id?: string;
            status?: history_worker_authorization_status;
        } = {},
    ): history_worker_authorization[] {
        const project = bounded(project_id, 'project_id', 1_024);
        const session = options.worker_session_id === undefined
            ? null
            : bounded(options.worker_session_id, 'worker_session_id', 1_024);
        const status = options.status ?? null;
        if (status !== null && status !== 'active' && status !== 'revoked') {
            throw new Error('history worker authorization status is invalid');
        }
        return (this.database.prepare(`SELECT * FROM cm_history_worker_authorizations
            WHERE tenant_id=? AND user_id=? AND project_id=?
              AND (? IS NULL OR worker_session_id=?)
              AND (? IS NULL OR status=?)
            ORDER BY authorized_at, authorization_id`)
            .all(this.tenant_id, this.user_id, project, session, session, status, status) as row[])
            .map(map_authorization);
    }
}
