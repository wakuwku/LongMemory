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
 *  file  : src/cli/porter/history_plan.ts
 *  usage : implements the LongMemory history plan component
 */

/*
 * Read-only planning for historical session backfills.
 *
 * This module deliberately has no store or central-memory dependency. It turns
 * portable sessions into a deterministic inventory and a reviewable project
 * assignment plan; callers must perform any eventual import separately.
 */

import { readFileSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { hash_canonical } from '../../core/hash/content_hash.js';
import type { harness_id, portable_session, source_reconciliation } from './types.js';
import { portable_session_revision } from './history_revision.js';
import {
    parse_history_source_snapshot,
    type history_source_snapshot,
} from './history_snapshot.js';
import {
    derive_redacted_history_session,
    history_redaction_mode,
    history_redaction_policy_schema,
    history_redaction_policy_version,
    type history_redaction_binding,
} from './history_redaction.js';
import {
    find_obvious_credentials,
    obvious_credential_detector_version,
} from '../../core/central_memory/sensitive_content.js';

export const history_inventory_schema = 'longmemory.history-inventory/v4' as const;
export const history_plan_schema = 'longmemory.history-project-plan/v3' as const;
export const history_override_schema = 'longmemory.history-project-overrides/v3' as const;

export type history_inventory_session = {
    source_session_id: string;
    source_revision: string;
    source_path: string;
    title: string;
    cwd: string;
    normalized_cwd: string | null;
    source_kind: string;
    parent_source_ids: string[];
    known_parent_source_ids: string[];
    missing_parent_source_ids: string[];
    created_at?: number;
    updated_at?: number;
    turn_count: number;
    dropped_turns: number;
    /** Safe review metadata only; never contains a matched credential value. */
    redaction?: history_redaction_binding;
};

export type history_inventory = {
    schema_version: typeof history_inventory_schema;
    source_harness: harness_id;
    inventory_id: string;
    counts: {
        sessions: number;
        cwd_scopes: number;
        sessions_without_cwd: number;
        parent_links: number;
        missing_parent_links: number;
    };
    source_scan: {
        reconciliation_digest: string;
        source_files: number;
        importable_tasks: number;
        empty_tasks: number;
        parse_failures: number;
        excluded_tasks: number;
        partial_tasks: number;
    };
    source_snapshot?: history_source_snapshot;
    sessions: history_inventory_session[];
};

export type history_cwd_override = {
    cwd: string;
    project_id: string;
    project_name?: string;
    confirmed: boolean;
    note?: string;
};

export type history_session_override = {
    source_session_id: string;
    action: 'assign' | 'exclude';
    project_id?: string;
    project_name?: string;
    confirmed: boolean;
    note?: string;
};

export type history_redaction_manifest_session = history_redaction_binding & {
    confirmed: boolean;
};

export type history_redaction_manifest_policy = {
    schema_version: typeof history_redaction_policy_schema;
    detector_version: typeof obvious_credential_detector_version;
    policy_version: typeof history_redaction_policy_version;
    mode: typeof history_redaction_mode;
    confirmed: boolean;
    sessions: history_redaction_manifest_session[];
};

export type history_override_manifest = {
    schema_version: typeof history_override_schema;
    source_harness: harness_id;
    inventory_id: string;
    source_snapshot?: history_source_snapshot;
    cwd_overrides: history_cwd_override[];
    session_overrides: history_session_override[];
    redaction_policy?: history_redaction_manifest_policy;
};

export type history_plan_assignment = {
    source_session_id: string;
    source_revision: string;
    action: 'assign' | 'exclude' | 'unresolved';
    project_id?: string;
    project_name?: string;
    assignment_source: 'session_override' | 'cwd_override' | 'cwd_candidate' | 'parent_inference' | 'unresolved';
    confirmation: 'confirmed' | 'required';
    normalized_cwd: string | null;
    parent_source_ids: string[];
    note?: string;
};

export type history_plan_issue = {
    code: 'semantic_confirmation_required' | 'missing_cwd' | 'ambiguous_parent_projects'
        | 'cross_cwd_parent_link' | 'parent_not_in_inventory' | 'unconfirmed_override'
        | 'credential_redaction_confirmation_required';
    review: 'semantic' | 'manual';
    blocking: boolean;
    message: string;
    source_session_ids: string[];
    project_id?: string;
};

export type history_project_candidate = {
    project_id: string;
    project_name: string;
    confirmation: 'confirmed' | 'required';
    assignment_sources: history_plan_assignment['assignment_source'][];
    cwd_scopes: string[];
    source_session_ids: string[];
};

export type history_project_plan = {
    schema_version: typeof history_plan_schema;
    source_harness: harness_id;
    inventory_id: string;
    plan_id: string;
    manifest_hash: string | null;
    dry_run: true;
    writes: { central_memory: false; project_database: false; source_sessions: false; files: false };
    safe_to_import: boolean;
    counts: { sessions: number; assigned: number; excluded: number; unresolved: number; confirmed: number; review_items: number };
    projects: history_project_candidate[];
    assignments: history_plan_assignment[];
    review_items: history_plan_issue[];
    override_manifest_template: history_override_manifest;
};

const as_object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
};

const required_string = (value: unknown, label: string, max = 512): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    const result = value.trim();
    if (result.length > max || /[\0\r\n]/.test(result)) throw new Error(`${label} is invalid or too long`);
    return result;
};

const optional_string = (value: unknown, label: string, max = 1_024): string | undefined => value === undefined
    ? undefined
    : required_string(value, label, max);

const required_boolean = (value: unknown, label: string): boolean => {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    return value;
};

const required_string_array = (value: unknown, label: string, max_items = 256): string[] => {
    if (!Array.isArray(value) || value.length > max_items) throw new Error(`${label} must be an array with at most ${max_items} items`);
    const result = value.map((item, index) => required_string(item, `${label}[${index}]`, 4_096));
    if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
    if (result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
        throw new Error(`${label} must be sorted in canonical order`);
    }
    return result;
};

const sha256 = (value: unknown, label: string): string => {
    const result = required_string(value, label, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 digest`);
    return result;
};

const assert_keys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`${label} contains unsupported fields`);
};

const required_marker_ids = (value: unknown, label: string): number[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 999_999) {
        throw new Error(`${label} must contain between 1 and 999999 marker ids`);
    }
    const result = value.map((item) => {
        if (!Number.isSafeInteger(item) || (item as number) < 1 || (item as number) > 999_999) {
            throw new Error(`${label} contains an invalid marker id`);
        }
        return item as number;
    });
    if (result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
        throw new Error(`${label} must be unique and sorted in ascending order`);
    }
    return result;
};

const windows_path = (value: string): boolean => /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);

export const normalize_history_cwd = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (windows_path(trimmed)) {
        const full = win32.normalize(trimmed);
        const root = win32.parse(full).root;
        const normalized = full.length > root.length ? full.replace(/[\\/]+$/, '') : root;
        return normalized.toLocaleLowerCase('en-US');
    }
    const normalized = posix.normalize(trimmed.replace(/\\/g, '/'));
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const metadata_string = (session: portable_session, key: string): string | null => {
    const value = session.source_metadata[key];
    return typeof value === 'string' && value.trim() && value !== session.source_session_id ? value.trim() : null;
};

const parent_ids = (session: portable_session): string[] => [...new Set([
    metadata_string(session, 'parent_thread_id'),
    metadata_string(session, 'parent_session_id'),
    metadata_string(session, 'forked_from_id'),
].filter((value): value is string => Boolean(value)))].sort();

const candidate_id = (cwd: string): string => `candidate:cwd:${hash_canonical(cwd).slice(0, 16)}`;
const cwd_name = (cwd: string): string => {
    const name = windows_path(cwd) ? win32.basename(cwd) : posix.basename(cwd);
    return name && name !== '.' && name !== '/' ? name : 'Historical project';
};

const sorted_reconciliation_rows = <T extends { source_session_id: string; source_path: string }>(rows: T[]): T[] =>
    [...rows].sort((left, right) => left.source_path < right.source_path ? -1
        : left.source_path > right.source_path ? 1
            : left.source_session_id < right.source_session_id ? -1
                : left.source_session_id > right.source_session_id ? 1 : 0);

export const assert_history_reconciliation = (value: source_reconciliation): void => {
    const unsafe = find_obvious_credentials({ history_source_reconciliation: value })[0];
    if (unsafe) {
        throw new Error(`history source reconciliation contains prohibited credential material (${unsafe.kind})`);
    }
    const count_fields = [
        'source_files', 'importable_tasks', 'empty_tasks', 'parse_failures',
        'excluded_tasks', 'partial_tasks',
    ] as const;
    for (const field of count_fields) {
        if (!Number.isInteger(value[field]) || value[field] < 0) {
            throw new Error(`history source reconciliation ${field} must be a non-negative integer`);
        }
    }
    if (value.empty.length !== value.empty_tasks
        || value.failures.length !== value.parse_failures
        || value.excluded.length !== value.excluded_tasks
        || value.partial.length !== value.partial_tasks) {
        throw new Error('history source reconciliation detail counts do not match their summaries');
    }
    if (value.partial_tasks > value.importable_tasks) {
        throw new Error('history source reconciliation partial_tasks cannot exceed importable_tasks');
    }
    const accounted = value.importable_tasks + value.empty_tasks
        + value.parse_failures + value.excluded_tasks;
    if (value.source_files !== accounted) {
        throw new Error(`history source reconciliation is incomplete: ${value.source_files} files but ${accounted} accounted`);
    }

    const categorized_paths = new Set<string>();
    const validate_ref = (
        entry: { source_session_id: string; source_path: string },
        label: string,
        index: number,
    ): void => {
        if (typeof entry.source_session_id !== 'string' || !entry.source_session_id.trim()) {
            throw new Error(`history source reconciliation ${label}[${index}] has an invalid source_session_id`);
        }
        if (typeof entry.source_path !== 'string' || !entry.source_path.trim()) {
            throw new Error(`history source reconciliation ${label}[${index}] has an invalid source_path`);
        }
    };
    for (const [label, rows] of [
        ['empty', value.empty],
        ['failures', value.failures],
        ['excluded', value.excluded],
    ] as const) {
        rows.forEach((entry, index) => {
            validate_ref(entry, label, index);
            if (categorized_paths.has(entry.source_path)) {
                throw new Error(`history source reconciliation accounts for ${entry.source_path} more than once`);
            }
            categorized_paths.add(entry.source_path);
        });
    }
    value.failures.forEach((entry, index) => {
        if (typeof entry.error !== 'string' || !entry.error.trim()) {
            throw new Error(`history source reconciliation failures[${index}] has an invalid error`);
        }
    });
    value.excluded.forEach((entry, index) => {
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw new Error(`history source reconciliation excluded[${index}] has an invalid reason`);
        }
    });
    const partial_paths = new Set<string>();
    value.partial.forEach((entry, index) => {
        validate_ref(entry, 'partial', index);
        if (!Number.isInteger(entry.skipped_line_count) || entry.skipped_line_count <= 0) {
            throw new Error(`history source reconciliation partial[${index}] has an invalid skipped_line_count`);
        }
        if (categorized_paths.has(entry.source_path)) {
            throw new Error(`history source reconciliation marks non-importable ${entry.source_path} as partial`);
        }
        if (partial_paths.has(entry.source_path)) {
            throw new Error(`history source reconciliation lists partial ${entry.source_path} more than once`);
        }
        partial_paths.add(entry.source_path);
    });
};

export const history_reconciliation_digest = (value: source_reconciliation): string => {
    assert_history_reconciliation(value);
    return hash_canonical({
        source_files: value.source_files,
        importable_tasks: value.importable_tasks,
        empty_tasks: value.empty_tasks,
        parse_failures: value.parse_failures,
        excluded_tasks: value.excluded_tasks,
        partial_tasks: value.partial_tasks,
        empty: sorted_reconciliation_rows(value.empty),
        failures: sorted_reconciliation_rows(value.failures),
        excluded: sorted_reconciliation_rows(value.excluded),
        partial: sorted_reconciliation_rows(value.partial),
    });
};

const synthetic_reconciliation = (session_count: number): source_reconciliation => ({
    source_files: session_count,
    importable_tasks: session_count,
    empty_tasks: 0,
    parse_failures: 0,
    excluded_tasks: 0,
    partial_tasks: 0,
    empty: [],
    failures: [],
    excluded: [],
    partial: [],
});

export const build_history_inventory = (
    sessions: portable_session[],
    source_harness: harness_id = sessions[0]?.source_harness ?? 'codex',
    reconciliation: source_reconciliation = synthetic_reconciliation(sessions.length),
    raw_source_snapshot?: history_source_snapshot,
): history_inventory => {
    assert_history_reconciliation(reconciliation);
    const source_snapshot = raw_source_snapshot ? parse_history_source_snapshot(raw_source_snapshot) : undefined;
    if (source_snapshot && source_harness !== 'codex') {
        throw new Error('Codex source snapshots cannot be attached to another history harness');
    }
    const ids = new Set<string>();
    for (const session of sessions) {
        if (session.source_harness !== source_harness) throw new Error(`session ${session.source_session_id} belongs to ${session.source_harness}, not ${source_harness}`);
        if (ids.has(session.source_session_id)) throw new Error(`duplicate source session id: ${session.source_session_id}`);
        ids.add(session.source_session_id);
    }
    const values = sessions.map((session): history_inventory_session => {
        const derived = derive_redacted_history_session(session);
        const review_session = derived.session;
        const parents = parent_ids(review_session);
        return {
            source_session_id: session.source_session_id,
            // Review artifacts must never expose a hash of the credential-bearing
            // source object. For affected sessions this is the safe derived
            // revision; for unaffected sessions it is naturally unchanged.
            source_revision: portable_session_revision(review_session),
            source_path: review_session.source_path,
            title: review_session.title,
            cwd: review_session.cwd,
            normalized_cwd: normalize_history_cwd(review_session.cwd),
            source_kind: typeof review_session.source_metadata.thread_source === 'string' ? review_session.source_metadata.thread_source : 'unknown',
            parent_source_ids: parents,
            known_parent_source_ids: parents.filter((id) => ids.has(id)),
            missing_parent_source_ids: parents.filter((id) => !ids.has(id)),
            ...(session.created_at === undefined ? {} : { created_at: session.created_at }),
            ...(session.updated_at === undefined ? {} : { updated_at: session.updated_at }),
            turn_count: session.turns.length,
            dropped_turns: session.dropped_turns,
            ...(derived.binding ? { redaction: derived.binding } : {}),
        };
    }).sort((left, right) => left.source_session_id < right.source_session_id ? -1
        : left.source_session_id > right.source_session_id ? 1 : 0);
    const source_scan = {
        reconciliation_digest: history_reconciliation_digest(reconciliation),
        source_files: reconciliation.source_files,
        importable_tasks: reconciliation.importable_tasks,
        empty_tasks: reconciliation.empty_tasks,
        parse_failures: reconciliation.parse_failures,
        excluded_tasks: reconciliation.excluded_tasks,
        partial_tasks: reconciliation.partial_tasks,
    };
    const identity = {
        source_scan,
        ...(source_snapshot ? { source_snapshot_id: source_snapshot.snapshot_id } : {}),
        sessions: values.map((item) => ({
            source_session_id: item.source_session_id,
            source_revision: item.source_revision,
            normalized_cwd: item.normalized_cwd,
            parent_source_ids: item.parent_source_ids,
            source_kind: item.source_kind,
            ...(item.redaction ? { redaction: item.redaction } : {}),
        })),
    };
    return {
        schema_version: history_inventory_schema,
        source_harness,
        inventory_id: `inventory:${hash_canonical(identity).slice(0, 24)}`,
        counts: {
            sessions: values.length,
            cwd_scopes: new Set(values.flatMap((item) => item.normalized_cwd ? [item.normalized_cwd] : [])).size,
            sessions_without_cwd: values.filter((item) => !item.normalized_cwd).length,
            parent_links: values.reduce((sum, item) => sum + item.known_parent_source_ids.length, 0),
            missing_parent_links: values.reduce((sum, item) => sum + item.missing_parent_source_ids.length, 0),
        },
        source_scan,
        ...(source_snapshot ? { source_snapshot } : {}),
        sessions: values,
    };
};

export const parse_history_override_manifest = (value: unknown): history_override_manifest => {
    const root = as_object(value, 'override manifest');
    assert_keys(root, ['schema_version', 'source_harness', 'inventory_id', 'source_snapshot', 'cwd_overrides', 'session_overrides', 'redaction_policy'], 'override manifest');
    if (root.schema_version !== history_override_schema) throw new Error(`override manifest schema_version must be ${history_override_schema}`);
    const source_harness = required_string(root.source_harness, 'source_harness') as harness_id;
    const inventory_id = required_string(root.inventory_id, 'inventory_id', 256);
    const source_snapshot = root.source_snapshot === undefined
        ? undefined
        : parse_history_source_snapshot(root.source_snapshot);
    if (source_snapshot && source_harness !== 'codex') {
        throw new Error('history source snapshots are only supported for the codex harness');
    }
    const raw_cwds = root.cwd_overrides ?? [];
    const raw_sessions = root.session_overrides ?? [];
    if (!Array.isArray(raw_cwds) || !Array.isArray(raw_sessions)) throw new Error('cwd_overrides and session_overrides must be arrays');
    const cwd_overrides = raw_cwds.map((raw, index): history_cwd_override => {
        const item = as_object(raw, `cwd_overrides[${index}]`);
        assert_keys(item, ['cwd', 'project_id', 'project_name', 'confirmed', 'note'], `cwd_overrides[${index}]`);
        return {
            cwd: required_string(item.cwd, `cwd_overrides[${index}].cwd`, 2_048),
            project_id: required_string(item.project_id, `cwd_overrides[${index}].project_id`, 256),
            ...(optional_string(item.project_name, `cwd_overrides[${index}].project_name`, 256) ? { project_name: optional_string(item.project_name, `cwd_overrides[${index}].project_name`, 256) } : {}),
            confirmed: required_boolean(item.confirmed, `cwd_overrides[${index}].confirmed`),
            ...(optional_string(item.note, `cwd_overrides[${index}].note`) ? { note: optional_string(item.note, `cwd_overrides[${index}].note`) } : {}),
        };
    });
    const session_overrides = raw_sessions.map((raw, index): history_session_override => {
        const item = as_object(raw, `session_overrides[${index}]`);
        assert_keys(item, ['source_session_id', 'action', 'project_id', 'project_name', 'confirmed', 'note'], `session_overrides[${index}]`);
        const action = required_string(item.action, `session_overrides[${index}].action`);
        if (action !== 'assign' && action !== 'exclude') throw new Error(`session_overrides[${index}].action must be assign or exclude`);
        const project_id = optional_string(item.project_id, `session_overrides[${index}].project_id`, 256);
        if (action === 'assign' && !project_id) throw new Error(`session_overrides[${index}].project_id is required for assign`);
        if (action === 'exclude' && (project_id || item.project_name !== undefined)) throw new Error(`session_overrides[${index}] exclude must not specify a project`);
        return {
            source_session_id: required_string(item.source_session_id, `session_overrides[${index}].source_session_id`, 256),
            action,
            ...(project_id ? { project_id } : {}),
            ...(optional_string(item.project_name, `session_overrides[${index}].project_name`, 256) ? { project_name: optional_string(item.project_name, `session_overrides[${index}].project_name`, 256) } : {}),
            confirmed: required_boolean(item.confirmed, `session_overrides[${index}].confirmed`),
            ...(optional_string(item.note, `session_overrides[${index}].note`) ? { note: optional_string(item.note, `session_overrides[${index}].note`) } : {}),
        };
    });
    const cwd_keys = cwd_overrides.map((entry) => normalize_history_cwd(entry.cwd));
    if (cwd_keys.some((key) => key === null)) throw new Error('cwd override paths cannot be empty');
    if (new Set(cwd_keys).size !== cwd_keys.length) throw new Error('override manifest contains duplicate cwd entries');
    const session_ids = session_overrides.map((entry) => entry.source_session_id);
    if (new Set(session_ids).size !== session_ids.length) throw new Error('override manifest contains duplicate session entries');
    let redaction_policy: history_redaction_manifest_policy | undefined;
    if (root.redaction_policy !== undefined) {
        if (source_harness !== 'codex') throw new Error('redaction_policy is only supported for Codex history');
        const raw_policy = as_object(root.redaction_policy, 'redaction_policy');
        assert_keys(raw_policy, [
            'schema_version', 'detector_version', 'policy_version', 'mode', 'confirmed', 'sessions',
        ], 'redaction_policy');
        if (raw_policy.schema_version !== history_redaction_policy_schema) {
            throw new Error(`redaction_policy.schema_version must be ${history_redaction_policy_schema}`);
        }
        if (raw_policy.detector_version !== obvious_credential_detector_version) {
            throw new Error(`redaction_policy.detector_version must be ${obvious_credential_detector_version}`);
        }
        if (raw_policy.policy_version !== history_redaction_policy_version) {
            throw new Error(`redaction_policy.policy_version must be ${history_redaction_policy_version}`);
        }
        if (raw_policy.mode !== history_redaction_mode) {
            throw new Error(`redaction_policy.mode must be ${history_redaction_mode}`);
        }
        if (!Array.isArray(raw_policy.sessions) || raw_policy.sessions.length === 0) {
            throw new Error('redaction_policy.sessions must contain at least one explicit session approval');
        }
        const policy_sessions = raw_policy.sessions.map((raw, index): history_redaction_manifest_session => {
            const item = as_object(raw, `redaction_policy.sessions[${index}]`);
            assert_keys(item, [
                'source_session_id', 'derived_source_revision',
                'detector_version', 'policy_version', 'mode', 'match_count',
                'terminal_marker_ids', 'credential_kinds', 'locations',
                'transformation_manifest_hash', 'confirmed',
            ], `redaction_policy.sessions[${index}]`);
            if (item.detector_version !== obvious_credential_detector_version
                || item.policy_version !== history_redaction_policy_version
                || item.mode !== history_redaction_mode) {
                throw new Error(`redaction_policy.sessions[${index}] uses an unsupported detector, policy, or mode`);
            }
            if (!Number.isSafeInteger(item.match_count) || (item.match_count as number) <= 0) {
                throw new Error(`redaction_policy.sessions[${index}].match_count must be a positive safe integer`);
            }
            const credential_kinds = required_string_array(item.credential_kinds, `redaction_policy.sessions[${index}].credential_kinds`);
            const locations = required_string_array(item.locations, `redaction_policy.sessions[${index}].locations`);
            const terminal_marker_ids = required_marker_ids(
                item.terminal_marker_ids, `redaction_policy.sessions[${index}].terminal_marker_ids`,
            );
            if (credential_kinds.length === 0 || locations.length === 0) {
                throw new Error(`redaction_policy.sessions[${index}] must bind credential kinds and structural locations`);
            }
            if (terminal_marker_ids.length !== item.match_count) {
                throw new Error(`redaction_policy.sessions[${index}] marker ids must exactly match match_count`);
            }
            return {
                source_session_id: required_string(item.source_session_id, `redaction_policy.sessions[${index}].source_session_id`, 256),
                derived_source_revision: sha256(item.derived_source_revision, `redaction_policy.sessions[${index}].derived_source_revision`),
                detector_version: obvious_credential_detector_version,
                policy_version: history_redaction_policy_version,
                mode: history_redaction_mode,
                match_count: item.match_count as number,
                terminal_marker_ids,
                credential_kinds,
                locations,
                transformation_manifest_hash: sha256(item.transformation_manifest_hash, `redaction_policy.sessions[${index}].transformation_manifest_hash`),
                confirmed: required_boolean(item.confirmed, `redaction_policy.sessions[${index}].confirmed`),
            };
        });
        const redaction_ids = policy_sessions.map((entry) => entry.source_session_id);
        if (new Set(redaction_ids).size !== redaction_ids.length) {
            throw new Error('redaction_policy contains duplicate session approvals');
        }
        redaction_policy = {
            schema_version: history_redaction_policy_schema,
            detector_version: obvious_credential_detector_version,
            policy_version: history_redaction_policy_version,
            mode: history_redaction_mode,
            confirmed: required_boolean(raw_policy.confirmed, 'redaction_policy.confirmed'),
            sessions: policy_sessions.sort((left, right) => left.source_session_id < right.source_session_id ? -1
                : left.source_session_id > right.source_session_id ? 1 : 0),
        };
    }
    const parsed: history_override_manifest = {
        schema_version: history_override_schema,
        source_harness,
        inventory_id,
        ...(source_snapshot ? { source_snapshot } : {}),
        cwd_overrides,
        session_overrides,
        ...(redaction_policy ? { redaction_policy } : {}),
    };
    const unsafe = find_obvious_credentials({ history_override_manifest: parsed })[0];
    if (unsafe) {
        throw new Error(`override manifest ${unsafe.path} contains prohibited credential material (${unsafe.kind})`);
    }
    return parsed;
};

export const read_history_override_manifest = (path: string): history_override_manifest => {
    const unsafe_path = find_obvious_credentials({ history_override_manifest_path: path })[0];
    if (unsafe_path) throw new Error('history override manifest path contains prohibited credential material');
    const size = statSync(path).size;
    if (size > 2 * 1024 * 1024) throw new Error('history override manifest exceeds the 2 MiB safety limit');
    try { return parse_history_override_manifest(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) { throw new Error(`invalid history override manifest: ${error instanceof Error ? error.message : String(error)}`); }
};

const connected_cwds = (session: history_inventory_session, by_id: Map<string, history_inventory_session>): string[] => {
    const seen = new Set<string>();
    const pending = [session.source_session_id];
    const cwds = new Set<string>();
    const children = new Map<string, string[]>();
    for (const item of by_id.values()) for (const parent of item.known_parent_source_ids) children.set(parent, [...(children.get(parent) ?? []), item.source_session_id]);
    while (pending.length) {
        const id = pending.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const item = by_id.get(id);
        if (!item) continue;
        if (item.normalized_cwd) cwds.add(item.normalized_cwd);
        pending.push(...item.known_parent_source_ids, ...(children.get(id) ?? []));
    }
    return [...cwds].sort();
};

export const build_history_project_plan = (inventory: history_inventory, raw_manifest?: history_override_manifest): history_project_plan => {
    const manifest = raw_manifest ? parse_history_override_manifest(raw_manifest) : undefined;
    if (manifest && manifest.source_harness !== inventory.source_harness) throw new Error(`manifest harness ${manifest.source_harness} does not match inventory harness ${inventory.source_harness}`);
    if (manifest && manifest.inventory_id !== inventory.inventory_id) throw new Error(`manifest inventory ${manifest.inventory_id} does not match current inventory ${inventory.inventory_id}; regenerate and re-confirm the history plan`);
    if (manifest?.source_snapshot && manifest.source_snapshot.snapshot_id !== inventory.source_snapshot?.snapshot_id) {
        throw new Error('manifest source snapshot does not match the loaded inventory snapshot');
    }
    const by_id = new Map(inventory.sessions.map((item) => [item.source_session_id, item]));
    const cwd_set = new Set(inventory.sessions.flatMap((item) => item.normalized_cwd ? [item.normalized_cwd] : []));
    for (const entry of manifest?.session_overrides ?? []) if (!by_id.has(entry.source_session_id)) throw new Error(`manifest references unknown session ${entry.source_session_id}`);
    for (const entry of manifest?.cwd_overrides ?? []) {
        const key = normalize_history_cwd(entry.cwd) as string;
        if (!cwd_set.has(key)) throw new Error(`manifest references unknown cwd ${entry.cwd}`);
    }
    const expected_redactions = inventory.sessions
        .flatMap((session) => session.redaction ? [session.redaction] : [])
        .sort((left, right) => left.source_session_id < right.source_session_id ? -1
            : left.source_session_id > right.source_session_id ? 1 : 0);
    if (manifest?.redaction_policy) {
        if (manifest.redaction_policy.sessions.length !== expected_redactions.length) {
            throw new Error('redaction policy must enumerate every and only credential-affected session in the approved inventory');
        }
        const provided = new Map(manifest.redaction_policy.sessions.map((entry) => [entry.source_session_id, entry]));
        for (const expected of expected_redactions) {
            const entry = provided.get(expected.source_session_id);
            if (!entry) throw new Error(`redaction policy is missing session ${expected.source_session_id}`);
            const { confirmed: _confirmed, ...binding } = entry;
            if (hash_canonical(binding) !== hash_canonical(expected)) {
                throw new Error(`redaction policy evidence for session ${expected.source_session_id} does not match the exact derived snapshot`);
            }
        }
    }
    const cwd_overrides = new Map((manifest?.cwd_overrides ?? []).map((entry) => [normalize_history_cwd(entry.cwd) as string, entry]));
    const session_overrides = new Map((manifest?.session_overrides ?? []).map((entry) => [entry.source_session_id, entry]));
    const review_items: history_plan_issue[] = [];
    const assignments: history_plan_assignment[] = [];

    if (expected_redactions.length > 0) {
        const policy = manifest?.redaction_policy;
        const unconfirmed = expected_redactions.filter((binding) =>
            policy?.confirmed !== true
            || policy.sessions.find((entry) => entry.source_session_id === binding.source_session_id)?.confirmed !== true);
        if (unconfirmed.length > 0) review_items.push({
            code: 'credential_redaction_confirmation_required',
            review: 'manual',
            blocking: true,
            message: `${unconfirmed.length} credential-affected session(s) require explicit confirmation of the exact deterministic redaction policy.`,
            source_session_ids: unconfirmed.map((entry) => entry.source_session_id),
        });
    } else if (manifest?.redaction_policy) {
        throw new Error('redaction policy is not allowed when the approved inventory has no credential findings');
    }

    for (const session of inventory.sessions) {
        const session_override = session_overrides.get(session.source_session_id);
        if (session_override?.confirmed) {
            assignments.push(session_override.action === 'exclude' ? {
                source_session_id: session.source_session_id, source_revision: session.source_revision, action: 'exclude', assignment_source: 'session_override', confirmation: 'confirmed',
                normalized_cwd: session.normalized_cwd, parent_source_ids: session.parent_source_ids, ...(session_override.note ? { note: session_override.note } : {}),
            } : {
                source_session_id: session.source_session_id, source_revision: session.source_revision, action: 'assign', project_id: session_override.project_id as string,
                project_name: session_override.project_name ?? session_override.project_id as string,
                assignment_source: 'session_override', confirmation: 'confirmed', normalized_cwd: session.normalized_cwd,
                parent_source_ids: session.parent_source_ids, ...(session_override.note ? { note: session_override.note } : {}),
            });
            continue;
        }
        if (session_override && !session_override.confirmed) review_items.push({
            code: 'unconfirmed_override', review: 'manual', blocking: true,
            message: `Session override for ${session.source_session_id} is only a proposal; set confirmed=true after review.`,
            source_session_ids: [session.source_session_id],
        });

        const inferred_cwds = session.normalized_cwd ? [session.normalized_cwd] : connected_cwds(session, by_id);
        if (inferred_cwds.length === 0) {
            assignments.push({ source_session_id: session.source_session_id, source_revision: session.source_revision, action: 'unresolved', assignment_source: 'unresolved', confirmation: 'required', normalized_cwd: null, parent_source_ids: session.parent_source_ids });
            review_items.push({ code: 'missing_cwd', review: 'manual', blocking: true, message: `Session ${session.source_session_id} has no cwd and no unambiguous in-inventory parent project.`, source_session_ids: [session.source_session_id] });
            continue;
        }
        if (inferred_cwds.length > 1) {
            assignments.push({ source_session_id: session.source_session_id, source_revision: session.source_revision, action: 'unresolved', assignment_source: 'unresolved', confirmation: 'required', normalized_cwd: null, parent_source_ids: session.parent_source_ids });
            review_items.push({ code: 'ambiguous_parent_projects', review: 'manual', blocking: true, message: `Session ${session.source_session_id} is connected to multiple cwd scopes and needs an explicit session override.`, source_session_ids: [session.source_session_id] });
            continue;
        }
        const cwd = inferred_cwds[0] as string;
        const cwd_override = cwd_overrides.get(cwd);
        const confirmed = cwd_override?.confirmed === true && session.normalized_cwd !== null;
        const project_id = cwd_override?.project_id ?? candidate_id(cwd);
        assignments.push({
            source_session_id: session.source_session_id,
            source_revision: session.source_revision,
            action: 'assign', project_id, project_name: cwd_override?.project_name ?? cwd_override?.project_id ?? cwd_name(cwd),
            assignment_source: confirmed ? 'cwd_override' : session.normalized_cwd ? 'cwd_candidate' : 'parent_inference',
            confirmation: confirmed ? 'confirmed' : 'required', normalized_cwd: session.normalized_cwd,
            parent_source_ids: session.parent_source_ids,
        });
    }

    const by_project = new Map<string, history_plan_assignment[]>();
    for (const assignment of assignments) if (assignment.action === 'assign' && assignment.project_id) {
        by_project.set(assignment.project_id, [...(by_project.get(assignment.project_id) ?? []), assignment]);
    }
    const projects = [...by_project.entries()].map(([project_id, values]): history_project_candidate => ({
        project_id,
        project_name: values.find((value) => value.project_name)?.project_name ?? project_id,
        confirmation: values.every((value) => value.confirmation === 'confirmed') ? 'confirmed' : 'required',
        assignment_sources: [...new Set(values.map((value) => value.assignment_source))].sort(),
        cwd_scopes: [...new Set(values.flatMap((value) => value.normalized_cwd ? [value.normalized_cwd] : []))].sort(),
        source_session_ids: values.map((value) => value.source_session_id).sort(),
    })).sort((left, right) => left.project_id < right.project_id ? -1
        : left.project_id > right.project_id ? 1 : 0);
    for (const project of projects.filter((item) => item.confirmation === 'required')) review_items.push({
        code: 'semantic_confirmation_required', review: 'semantic', blocking: true,
        message: `Cwd is only a location signal; confirm that ${project.source_session_ids.length} session(s) belong to project ${project.project_name}, or split them with session overrides.`,
        source_session_ids: project.source_session_ids, project_id: project.project_id,
    });
    const seen_cross_edges = new Set<string>();
    for (const session of inventory.sessions) {
        for (const parent_id of session.known_parent_source_ids) {
            const parent = by_id.get(parent_id) as history_inventory_session;
            if (!session.normalized_cwd || !parent.normalized_cwd || session.normalized_cwd === parent.normalized_cwd) continue;
            const edge = [session.source_session_id, parent_id].sort().join('\0');
            if (seen_cross_edges.has(edge)) continue;
            seen_cross_edges.add(edge);
            review_items.push({ code: 'cross_cwd_parent_link', review: 'manual', blocking: false, message: `Parent-linked sessions ${parent_id} and ${session.source_session_id} have different cwd scopes; preserve the lineage but review the project split.`, source_session_ids: [parent_id, session.source_session_id].sort() });
        }
        if (session.missing_parent_source_ids.length) review_items.push({ code: 'parent_not_in_inventory', review: 'manual', blocking: false, message: `Session ${session.source_session_id} references parent(s) outside this inventory: ${session.missing_parent_source_ids.join(', ')}.`, source_session_ids: [session.source_session_id] });
    }

    const template: history_override_manifest = {
        schema_version: history_override_schema,
        source_harness: inventory.source_harness,
        inventory_id: inventory.inventory_id,
        ...(inventory.source_snapshot ? { source_snapshot: inventory.source_snapshot } : {}),
        cwd_overrides: [...cwd_set].sort().map((cwd) => {
            const existing = cwd_overrides.get(cwd);
            return existing ?? { cwd, project_id: candidate_id(cwd), project_name: cwd_name(cwd), confirmed: false, note: 'Review the sessions in this cwd; rename or split if it contains multiple semantic projects.' };
        }),
        session_overrides: assignments.filter((assignment) => assignment.action === 'unresolved' || (assignment.assignment_source === 'parent_inference' && assignment.confirmation === 'required')).map((assignment) => {
            const existing = session_overrides.get(assignment.source_session_id);
            return existing ?? {
                source_session_id: assignment.source_session_id, action: 'assign' as const,
                ...(assignment.project_id ? { project_id: assignment.project_id, project_name: assignment.project_name } : {}),
                confirmed: false, note: 'Choose a project explicitly because cwd evidence is missing or ambiguous.',
            };
        }),
        ...(expected_redactions.length > 0 ? {
            redaction_policy: manifest?.redaction_policy ?? {
                schema_version: history_redaction_policy_schema,
                detector_version: obvious_credential_detector_version,
                policy_version: history_redaction_policy_version,
                mode: history_redaction_mode,
                confirmed: false,
                sessions: expected_redactions.map((binding) => ({ ...binding, confirmed: false })),
            },
        } : {}),
    };
    const manifest_hash = manifest ? hash_canonical(manifest) : null;
    const plan_identity = {
        inventory_id: inventory.inventory_id,
        manifest_hash,
        assignments: assignments.map(({ source_session_id, action, project_id, assignment_source, confirmation }) => ({ source_session_id, action, project_id, assignment_source, confirmation })),
    };
    const counts = {
        sessions: assignments.length,
        assigned: assignments.filter((item) => item.action === 'assign').length,
        excluded: assignments.filter((item) => item.action === 'exclude').length,
        unresolved: assignments.filter((item) => item.action === 'unresolved').length,
        confirmed: assignments.filter((item) => item.confirmation === 'confirmed').length,
        review_items: review_items.length,
    };
    return {
        schema_version: history_plan_schema, source_harness: inventory.source_harness, inventory_id: inventory.inventory_id,
        plan_id: `plan:${hash_canonical(plan_identity).slice(0, 24)}`, manifest_hash, dry_run: true,
        writes: { central_memory: false, project_database: false, source_sessions: false, files: false },
        safe_to_import: assignments.length > 0 && assignments.every((item) => item.confirmation === 'confirmed') && !review_items.some((item) => item.blocking),
        counts, projects, assignments, review_items, override_manifest_template: template,
    };
};
