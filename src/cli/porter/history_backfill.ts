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
 *  file  : src/cli/porter/history_backfill.ts
 *  usage : implements the LongMemory history backfill component
 */

import { isAbsolute, resolve } from 'node:path';
import { HistoryBackfillService } from '../../core/central_memory/history_backfill_service.js';
import type { history_backfill_run } from '../../core/central_memory/history_backfill_types.js';
import { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import {
    assert_issued_history_authorization,
    history_import_evidence_for_session,
    type authorized_history_import,
} from './history_authorization.js';
import { assert_history_credentials_safe } from './history_safety.js';

/**
 * Leave enough of the 1,800-token MCP result budget for immutable locators,
 * lease data and extraction instructions.  The generic queue supports larger
 * chunks, but Codex backfills must always opt into this tighter boundary.
 */
export const CODEX_HISTORY_CHUNK_TOKENS = 1_200;
export const CODEX_HISTORY_CHUNK_CHARS = 16_000;

export type staged_history_run = Pick<history_backfill_run,
    'run_id' | 'source_session_id' | 'source_revision' | 'status' | 'chunk_count'>;

export function stage_authorized_codex_history(input: {
    authorization: authorized_history_import;
    db_path: string;
    project_id: string;
    project_name: string;
    tenant_id?: string;
    user_id?: string;
}): staged_history_run[] {
    const db_path = resolve(input.db_path);
    if (!isAbsolute(input.db_path) || input.db_path === ':memory:') {
        throw new Error('Codex history staging requires an absolute persistent database path');
    }
    const authorization = assert_issued_history_authorization(
        input.authorization,
        input.authorization.sessions,
        input.project_id,
    );
    if (resolve(authorization.evidence.target_db_path) !== db_path) {
        throw new Error('Codex history authorization targets a different database');
    }
    // Recheck the whole selected batch before opening SQLite. Besides guarding
    // against post-authorization object mutation, this prevents a later unsafe
    // session from leaving earlier sessions partially staged.
    assert_history_credentials_safe(authorization.sessions);
    const tenant_id = input.tenant_id ?? 'default';
    const user_id = input.user_id ?? 'default';
    const store = new SqliteStore(db_path, {
        tenant_id,
        user_id,
        startup_integrity_check: false,
    });
    try {
        try { store.central_memory.require_project(input.project_id); }
        catch (error) {
            if (!(error instanceof Error) || !/was not found/.test(error.message)) throw error;
            store.central_memory.register_project({
                project_id: input.project_id,
                name: input.project_name,
                metadata: { source: 'authorized_codex_history_backfill' },
            });
        }
        const service = new HistoryBackfillService(store.database, {
            tenant_id,
            user_id,
            // The porter is authorized only to create immutable runs.  It has
            // no worker capability and must fail closed if a lease method is
            // ever added to this path by mistake.
            capability_guard: () => {
                throw new Error('porter history staging cannot execute worker operations');
            },
        });
        return authorization.sessions.map((session) => {
            const run = service.create_run({
                session,
                evidence: history_import_evidence_for_session(authorization, session),
                project_id: input.project_id,
                max_chunk_tokens: CODEX_HISTORY_CHUNK_TOKENS,
                max_chunk_chars: CODEX_HISTORY_CHUNK_CHARS,
            });
            return {
                run_id: run.run_id,
                source_session_id: run.source_session_id,
                source_revision: run.source_revision,
                status: run.status,
                chunk_count: run.chunk_count,
            };
        });
    } finally {
        store.close();
    }
}
