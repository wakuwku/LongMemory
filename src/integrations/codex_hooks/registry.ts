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
 *  file  : src/integrations/codex_hooks/registry.ts
 *  usage : implements the LongMemory registry component
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
    CODEX_HOOK_STATE_VERSION,
    type codex_hook_event,
    type codex_hook_runtime_options,
    type codex_hook_session_state,
} from './types.js';

const MAX_STATE_BYTES = 1_048_576;
const MAX_FAILURE_BYTES = 16_384;
const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_WAIT_MS = 5_000;
const SESSION_LOCK_RETRY_MS = 10;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function session_key(session_id: string): string {
    return createHash('sha256').update(session_id).digest('hex');
}

function new_capability(): string {
    return randomBytes(32).toString('base64url');
}

function secure_equal(left: string, right: string): boolean {
    const left_hash = createHash('sha256').update(left).digest();
    const right_hash = createHash('sha256').update(right).digest();
    return timingSafeEqual(left_hash, right_hash);
}

function json_object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert_state(
    value: unknown,
    expected_session_id?: string,
): asserts value is codex_hook_session_state | (Omit<codex_hook_session_state,
    'capability_turn_id' | 'configured_project_id'> & {
    capability_turn_id?: undefined;
    configured_project_id?: undefined;
}) {
    if (!json_object(value) || value.schema_version !== CODEX_HOOK_STATE_VERSION) {
        throw new Error('unsupported Codex hook registry state');
    }
    for (const field of ['session_id', 'capability', 'project_id', 'project_name', 'db_path',
        'tenant_id', 'user_id', 'cwd', 'responsibility']) {
        if (typeof value[field] !== 'string') throw new Error(`invalid Codex hook registry field: ${field}`);
    }
    if (expected_session_id !== undefined && value.session_id !== expected_session_id) {
        throw new Error('Codex hook registry session identity mismatch');
    }
    if (typeof value.bound !== 'boolean' || typeof value.project_was_configured !== 'boolean') {
        throw new Error('invalid Codex hook registry binding state');
    }
    if (value.capability_turn_id !== undefined && value.capability_turn_id !== null
        && typeof value.capability_turn_id !== 'string') {
        throw new Error('invalid Codex hook registry capability turn');
    }
    if (value.configured_project_id !== undefined && value.configured_project_id !== null
        && typeof value.configured_project_id !== 'string') {
        throw new Error('invalid Codex hook configured project anchor');
    }
}

function filesystem_error_code(error: unknown): string | null {
    return error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' ? error.code : null;
}

export class CodexHookRegistry {
    readonly root: string;
    private readonly now: () => number;

    constructor(plugin_data: string, now: () => number = () => Date.now()) {
        if (!plugin_data.trim()) throw new Error('PLUGIN_DATA is required for Codex memory hooks');
        this.root = resolve(plugin_data);
        this.now = now;
    }

    state_path(session_id: string): string {
        return join(this.root, 'sessions', `${session_key(session_id)}.json`);
    }

    private lock_path(session_id: string): string {
        return `${this.state_path(session_id)}.lock`;
    }

    private with_session_lock<T>(session_id: string, operation: () => T): T {
        const lock_path = this.lock_path(session_id);
        mkdirSync(dirname(lock_path), { recursive: true });
        const deadline = Date.now() + SESSION_LOCK_WAIT_MS;
        while (true) {
            try {
                const descriptor = openSync(lock_path, 'wx', 0o600);
                closeSync(descriptor);
                break;
            } catch (error) {
                if (filesystem_error_code(error) !== 'EEXIST') throw error;
                try {
                    if (Date.now() - statSync(lock_path).mtimeMs > SESSION_LOCK_STALE_MS) {
                        rmSync(lock_path, { force: true });
                        continue;
                    }
                } catch (stat_error) {
                    if (filesystem_error_code(stat_error) === 'ENOENT') continue;
                    throw stat_error;
                }
                if (Date.now() >= deadline) throw new Error('Codex hook registry session lock timed out');
                Atomics.wait(WAIT_ARRAY, 0, 0, SESSION_LOCK_RETRY_MS);
            }
        }
        try { return operation(); }
        finally { rmSync(lock_path, { force: true }); }
    }

    private load_unlocked(session_id: string): codex_hook_session_state | null {
        const path = this.state_path(session_id);
        if (!existsSync(path)) return null;
        const size = readFileSync(path);
        if (size.byteLength > MAX_STATE_BYTES) throw new Error('Codex hook registry state is oversized');
        const parsed = JSON.parse(size.toString('utf8')) as unknown;
        assert_state(parsed, session_id);
        return {
            ...parsed,
            // Version 1 state written before turn-scoped capabilities did not
            // have this field. Treat that bearer token as inactive until the
            // next UserPromptSubmit activates a concrete turn.
            capability_turn_id: parsed.capability_turn_id ?? null,
            // A legacy configured state must re-enter through SessionStart so
            // the current trusted runtime options can establish its anchor.
            configured_project_id: parsed.configured_project_id ?? null,
        };
    }

    load(session_id: string): codex_hook_session_state | null {
        return this.load_unlocked(session_id);
    }

    start_or_resume(
        event: codex_hook_event,
        options: codex_hook_runtime_options,
    ): codex_hook_session_state {
        return this.with_session_lock(event.session_id, () => {
            const prior = this.load_unlocked(event.session_id);
            const at = this.now();
            if (prior?.configured_project_id && options.project_was_configured
                && prior.configured_project_id !== options.project_id) {
                throw new Error(
                    `configured Codex project changed from ${prior.configured_project_id} to ${options.project_id}; `
                    + 'use the governance layer instead of silently moving this task',
                );
            }
            const configured_project_id = prior?.configured_project_id
                ?? (options.project_was_configured ? options.project_id : null);
            const state: codex_hook_session_state = prior ? {
                ...prior,
                capability: new_capability(),
                capability_turn_id: null,
                configured_project_id,
                project_was_configured: configured_project_id !== null,
                ...(configured_project_id ? {
                    project_id: configured_project_id,
                    project_name: options.project_was_configured
                        ? options.project_name
                        : prior.project_name,
                } : {}),
                cwd: event.cwd,
                transcript_path: event.transcript_path,
                updated_at: at,
            } : {
                schema_version: CODEX_HOOK_STATE_VERSION,
                session_id: event.session_id,
                capability: new_capability(),
                capability_turn_id: null,
                project_id: options.project_id,
                project_name: options.project_name,
                project_was_configured: options.project_was_configured,
                configured_project_id,
                db_path: resolve(options.db_path),
                tenant_id: options.tenant_id,
                user_id: options.user_id,
                cwd: event.cwd,
                transcript_path: event.transcript_path,
                bound: false,
                responsibility: '',
                role_id: null,
                task_id: null,
                last_checkpoint: null,
                created_at: at,
                updated_at: at,
            };
            this.save_unlocked(state);
            return state;
        });
    }

    private save_unlocked(state: codex_hook_session_state): void {
        assert_state(state, state.session_id);
        const path = this.state_path(state.session_id);
        mkdirSync(dirname(path), { recursive: true });
        const persisted = { ...state, updated_at: this.now() } as Record<string, unknown>;
        // Drop receipt fields left by the pre-ledger implementation. Delivery
        // truth now lives only in central SQLite and must never regress to a
        // single overwritable registry slot.
        delete persisted.pending_delivery;
        delete persisted.acknowledged_retractions;
        const payload = `${JSON.stringify(persisted, null, 2)}\n`;
        if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error('Codex hook registry state is oversized');
        const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        try {
            writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            try { chmodSync(temporary, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
            renameSync(temporary, path);
        } finally {
            if (existsSync(temporary)) rmSync(temporary, { force: true });
        }
    }

    save(state: codex_hook_session_state): void {
        this.with_session_lock(state.session_id, () => {
            const current = this.load_unlocked(state.session_id);
            if (current && (!secure_equal(current.capability, state.capability)
                || current.capability_turn_id !== state.capability_turn_id)) {
                throw new Error('Codex hook registry state used a stale turn capability');
            }
            if (current && current.configured_project_id !== state.configured_project_id) {
                throw new Error('Codex hook registry configured project anchor is immutable');
            }
            this.save_unlocked(state);
        });
    }

    activate_turn(session_id: string, turn_id: string): codex_hook_session_state {
        if (!turn_id.trim()) throw new Error('Codex capability turn_id is required');
        return this.with_session_lock(session_id, () => {
            const current = this.load_unlocked(session_id);
            if (!current) throw new Error('Codex hook registry session was not found');
            if (current.capability_turn_id === turn_id) return current;
            const next: codex_hook_session_state = {
                ...current,
                capability: new_capability(),
                capability_turn_id: turn_id,
                updated_at: this.now(),
            };
            this.save_unlocked(next);
            return next;
        });
    }

    require_capability(
        session_id: string,
        capability: string,
        turn_id: string,
    ): codex_hook_session_state {
        const state = this.load(session_id);
        this.assert_capability(state, capability, turn_id);
        return state;
    }

    /**
     * Validate a turn capability and keep the per-session filesystem lock for
     * the complete synchronous operation.  Write paths must use this method
     * instead of `require_capability()` so UserPromptSubmit cannot rotate the
     * capability between authorization and the protected database commit.
     *
     * The scoped save function is the only registry mutation permitted while
     * the lock is held.  It becomes invalid as soon as the operation returns.
     */
    with_capability<T>(
        session_id: string,
        capability: string,
        turn_id: string,
        operation: (
            state: codex_hook_session_state,
            save: (next: codex_hook_session_state) => void,
        ) => T,
    ): T {
        return this.with_session_lock(session_id, () => {
            const state = this.load_unlocked(session_id);
            this.assert_capability(state, capability, turn_id);
            let active = true;
            const save = (next: codex_hook_session_state): void => {
                if (!active) throw new Error('Codex capability save scope has expired');
                if (next.session_id !== session_id
                    || next.capability_turn_id !== turn_id
                    || !secure_equal(next.capability, capability)) {
                    throw new Error('Codex hook registry state used a stale turn capability');
                }
                if (next.configured_project_id !== state.configured_project_id) {
                    throw new Error('Codex hook registry configured project anchor is immutable');
                }
                this.save_unlocked(next);
            };
            try {
                const result = operation(state, save);
                if (result !== null && typeof result === 'object'
                    && 'then' in result && typeof result.then === 'function') {
                    throw new Error('Codex capability operations must be synchronous');
                }
                return result;
            } finally {
                active = false;
            }
        });
    }

    private assert_capability(
        state: codex_hook_session_state | null,
        capability: string,
        turn_id: string,
    ): asserts state is codex_hook_session_state {
        if (!state || !capability.trim() || !turn_id.trim()
            || state.capability_turn_id !== turn_id
            || !secure_equal(state.capability, capability)) {
            throw new Error('permission denied: invalid Codex turn capability');
        }
    }

    record_failure(event: Partial<codex_hook_event>, error: unknown): void {
        try {
            const directory = join(this.root, 'failures');
            mkdirSync(directory, { recursive: true });
            const message = error instanceof Error ? error.message : String(error);
            const entry = JSON.stringify({
                at: this.now(),
                session_id_hash: typeof event.session_id === 'string' ? session_key(event.session_id) : null,
                hook_event_name: event.hook_event_name ?? null,
                error: message.slice(0, MAX_FAILURE_BYTES),
            });
            appendFileSync(join(directory, 'hook-errors.jsonl'), `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch {
            // Hook diagnostics must never turn a memory failure into a Codex failure.
        }
    }
}
