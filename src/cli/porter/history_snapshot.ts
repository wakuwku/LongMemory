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
 *  file  : src/cli/porter/history_snapshot.ts
 *  usage : implements the LongMemory history snapshot component
 */

import { hash_canonical } from '../../core/hash/content_hash.js';
import { find_obvious_credentials } from '../../core/central_memory/sensitive_content.js';

export const history_source_snapshot_schema = 'longmemory.codex-source-snapshot/v2' as const;
export const history_snapshot_capture_errors = [
    'source_cutoff_failed',
    'source_scan_failed',
] as const;
export type history_snapshot_capture_error = typeof history_snapshot_capture_errors[number];

export type history_source_snapshot_file = {
    source_session_id: string;
    source_path: string;
    cutoff_bytes: number | null;
    prefix_sha256: string | null;
    capture_error?: history_snapshot_capture_error;
};

export type history_source_snapshot = {
    schema_version: typeof history_source_snapshot_schema;
    source_harness: 'codex';
    snapshot_id: string;
    files: history_source_snapshot_file[];
};

const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
};

const keys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`${label} contains unsupported fields`);
};

const string = (value: unknown, label: string, max = 4_096): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    const result = value.trim();
    if (result.length > max || /[\0\r\n]/.test(result)) throw new Error(`${label} is invalid or too long`);
    return result;
};

const canonical_files = (files: history_source_snapshot_file[]): history_source_snapshot_file[] =>
    [...files].sort((left, right) => left.source_path < right.source_path ? -1
        : left.source_path > right.source_path ? 1
            : left.source_session_id < right.source_session_id ? -1
                : left.source_session_id > right.source_session_id ? 1 : 0);

const snapshot_identity = (files: history_source_snapshot_file[]): Record<string, unknown> => ({
    schema_version: history_source_snapshot_schema,
    source_harness: 'codex',
    files: canonical_files(files),
});

export const build_history_source_snapshot = (
    files: history_source_snapshot_file[],
): history_source_snapshot => {
    const parsed_files = files.map((file, index): history_source_snapshot_file => {
        const unsafe = find_obvious_credentials({ history_source_snapshot_file: file })[0];
        if (unsafe) {
            throw new Error(`snapshot files[${index}] contains prohibited credential material (${unsafe.kind})`);
        }
        const source_session_id = string(file.source_session_id, `snapshot files[${index}].source_session_id`, 256);
        const source_path = string(file.source_path, `snapshot files[${index}].source_path`);
        const capture_error = file.capture_error === undefined
            ? undefined
            : history_snapshot_capture_errors.find((value) => value === file.capture_error);
        if (file.capture_error !== undefined && capture_error === undefined) {
            throw new Error(`snapshot files[${index}].capture_error is unsupported`);
        }
        if (capture_error !== undefined) {
            if (file.cutoff_bytes !== null || file.prefix_sha256 !== null) {
                throw new Error(`snapshot files[${index}] with capture_error must not claim a verified prefix`);
            }
            return { source_session_id, source_path, cutoff_bytes: null, prefix_sha256: null, capture_error };
        }
        if (!Number.isSafeInteger(file.cutoff_bytes) || (file.cutoff_bytes as number) < 0) {
            throw new Error(`snapshot files[${index}].cutoff_bytes must be a non-negative safe integer`);
        }
        if (typeof file.prefix_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.prefix_sha256)) {
            throw new Error(`snapshot files[${index}].prefix_sha256 must be a SHA-256 hex digest`);
        }
        return {
            source_session_id,
            source_path,
            cutoff_bytes: file.cutoff_bytes as number,
            prefix_sha256: file.prefix_sha256.toLowerCase(),
        };
    });
    const paths = parsed_files.map((file) => file.source_path);
    if (new Set(paths).size !== paths.length) throw new Error('history source snapshot contains duplicate source paths');
    const canonical = canonical_files(parsed_files);
    return {
        schema_version: history_source_snapshot_schema,
        source_harness: 'codex',
        snapshot_id: `snapshot:${hash_canonical(snapshot_identity(canonical)).slice(0, 24)}`,
        files: canonical,
    };
};

export const parse_history_source_snapshot = (value: unknown): history_source_snapshot => {
    const root = object(value, 'history source snapshot');
    const unsafe = find_obvious_credentials({ history_source_snapshot: root })[0];
    if (unsafe) throw new Error(`history source snapshot contains prohibited credential material (${unsafe.kind})`);
    keys(root, ['schema_version', 'source_harness', 'snapshot_id', 'files'], 'history source snapshot');
    if (root.schema_version !== history_source_snapshot_schema) {
        throw new Error(`history source snapshot schema_version must be ${history_source_snapshot_schema}`);
    }
    if (root.source_harness !== 'codex') throw new Error('history source snapshot source_harness must be codex');
    if (!Array.isArray(root.files)) throw new Error('history source snapshot files must be an array');
    const files = root.files.map((raw, index): history_source_snapshot_file => {
        const item = object(raw, `snapshot files[${index}]`);
        keys(item, ['source_session_id', 'source_path', 'cutoff_bytes', 'prefix_sha256', 'capture_error'], `snapshot files[${index}]`);
        return {
            source_session_id: item.source_session_id as string,
            source_path: item.source_path as string,
            cutoff_bytes: item.cutoff_bytes as number | null,
            prefix_sha256: item.prefix_sha256 as string | null,
            ...(item.capture_error === undefined ? {} : {
                capture_error: item.capture_error as history_snapshot_capture_error,
            }),
        };
    });
    const rebuilt = build_history_source_snapshot(files);
    const snapshot_id = string(root.snapshot_id, 'history source snapshot snapshot_id', 256);
    if (snapshot_id !== rebuilt.snapshot_id) throw new Error('history source snapshot id does not match its exact file cutoffs');
    return rebuilt;
};
