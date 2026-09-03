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
 *  file  : src/cli/porter/history_redaction.ts
 *  usage : implements the LongMemory history redaction component
 */

import { hash_canonical } from '../../core/hash/content_hash.js';
import {
    find_obvious_credentials,
    find_obvious_credential_spans,
    obvious_credential_detector_version,
} from '../../core/central_memory/sensitive_content.js';
import { portable_session_revision } from './history_revision.js';
import type { portable_session } from './types.js';

export const history_redaction_policy_schema = 'longmemory.history-redaction-policy/v2' as const;
export const history_redaction_policy_version = 'longmemory.codex-history-credential-redaction/v3' as const;
export const history_redaction_mode = 'replace_detected_credential_spans' as const;
const max_redaction_passes = 8;
const redaction_marker = /<LMR-REDACTED-(\d{6})>/g;
const untrusted_redaction_marker = /<LMR-REDACTED-[^>\r\n]*>/g;

export type history_redaction_binding = {
    source_session_id: string;
    derived_source_revision: string;
    detector_version: typeof obvious_credential_detector_version;
    policy_version: typeof history_redaction_policy_version;
    mode: typeof history_redaction_mode;
    match_count: number;
    terminal_marker_ids: number[];
    credential_kinds: string[];
    locations: string[];
    transformation_manifest_hash: string;
};

export type history_redaction_result = {
    /** Safe derived object. The original object is never modified. */
    session: portable_session;
    binding: history_redaction_binding | null;
};

type transformation = {
    path: string;
    kind: string;
    pass: number;
    start: number;
    end: number;
    occurrence: number;
    placeholder: string;
    supersedes: number[];
};

const safe_component = (key: string, index: number): string =>
    /^[a-z_][a-z0-9_-]{0,63}$/i.test(key)
        && find_obvious_credential_spans(key).length === 0
        ? key
        : `<key:${index}>`;

const replace_string = (
    value: string,
    path: string,
    transformations: transformation[],
    next_occurrence: () => number,
    active_occurrences: Set<number>,
): string => {
    let current = value;
    // Marker-shaped source text is not trusted as proof of a prior redaction.
    // Replace it with a newly allocated marker and include that operation in
    // the policy evidence so an unapproved source marker cannot bypass the
    // history staging boundary.
    const source_markers = [...current.matchAll(untrusted_redaction_marker)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
    }));
    if (source_markers.length > 0) {
        let cursor = 0;
        let result = '';
        for (const marker of source_markers) {
            const occurrence = next_occurrence();
            const placeholder = `<LMR-REDACTED-${String(occurrence).padStart(6, '0')}>`;
            active_occurrences.add(occurrence);
            result += current.slice(cursor, marker.start) + placeholder;
            cursor = marker.end;
            transformations.push({
                path,
                kind: 'untrusted_redaction_marker',
                pass: 0,
                start: marker.start,
                end: marker.end,
                occurrence,
                placeholder,
                supersedes: [],
            });
        }
        current = result + current.slice(cursor);
    }
    for (let pass = 1; pass <= max_redaction_passes; pass += 1) {
        const spans = find_obvious_credential_spans(current);
        if (spans.length === 0) return current;
        let cursor = 0;
        let result = '';
        for (const span of spans) {
            const occurrence = next_occurrence();
            // Keep the replacement inert under the credential detector.
            // Embedding names such as `api_key` or `token` in the marker can
            // itself form a fresh assignment match when adjacent source text
            // follows it.
            const placeholder = `<LMR-REDACTED-${String(occurrence).padStart(6, '0')}>`;
            const supersedes: number[] = [];
            for (const match of current.slice(span.start, span.end).matchAll(redaction_marker)) {
                const prior = Number(match[1]);
                if (active_occurrences.delete(prior)) supersedes.push(prior);
            }
            active_occurrences.add(occurrence);
            result += current.slice(cursor, span.start) + placeholder;
            cursor = span.end;
            transformations.push({
                path,
                kind: span.kind,
                pass,
                start: span.start,
                end: span.end,
                occurrence,
                placeholder,
                supersedes: supersedes.sort((left, right) => left - right),
            });
        }
        current = result + current.slice(cursor);
    }
    throw new Error(`history redaction did not converge within ${max_redaction_passes} deterministic passes`);
};

const transform_value = (
    value: unknown,
    path: string,
    transformations: transformation[],
    next_occurrence: () => number,
    active_occurrences: Set<number>,
    seen: WeakSet<object>,
): unknown => {
    if (typeof value === 'string') {
        return replace_string(value, path, transformations, next_occurrence, active_occurrences);
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new Error('history redaction only accepts acyclic JSON-shaped session snapshots');
    seen.add(value);
    if (Array.isArray(value)) {
        const result = value.map((item, index) => transform_value(
            item, `${path}[${index}]`, transformations, next_occurrence, active_occurrences, seen,
        ));
        seen.delete(value);
        return result;
    }
    const result: Record<string, unknown> = {};
    // Match canonical_json's object semantics exactly: undefined-valued keys
    // do not participate, and key order is UTF-16 lexical order. Placeholder
    // occurrence numbers and safe key indexes must never depend on insertion
    // order when the canonical source revision does not.
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    entries.forEach(([key, item], index) => {
        const component = safe_component(key, index);
        const transformed_key = replace_string(
            key, `${path}.<key:${index}>`, transformations, next_occurrence, active_occurrences,
        );
        if (Object.prototype.hasOwnProperty.call(result, transformed_key)) {
            throw new Error('history redaction produced a duplicate object key');
        }
        Object.defineProperty(result, transformed_key, {
            value: transform_value(
                item, `${path}.${component}`, transformations, next_occurrence, active_occurrences, seen,
            ),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    });
    seen.delete(value);
    return result;
};

/**
 * Build a deterministic, credential-free derived snapshot entirely in memory.
 * Audit data records only structural offsets, detector kinds, and placeholders;
 * it never hashes or retains the matched value.
 */
export function derive_redacted_history_session(session: portable_session): history_redaction_result {
    const transformations: transformation[] = [];
    const reserved_occurrences = new Set<number>();
    for (const match of JSON.stringify(session).matchAll(redaction_marker)) {
        reserved_occurrences.add(Number(match[1]));
    }
    const active_occurrences = new Set<number>();
    let occurrence = 0;
    const next_occurrence = (): number => {
        do { occurrence += 1; } while (reserved_occurrences.has(occurrence) && occurrence <= 999_999);
        if (occurrence > 999_999) throw new Error('history redaction exhausted its deterministic marker namespace');
        return occurrence;
    };
    const transformed = transform_value(
        session,
        'session',
        transformations,
        next_occurrence,
        active_occurrences,
        new WeakSet<object>(),
    ) as portable_session;
    if (transformations.length === 0) return { session: transformed, binding: null };
    // The session id is a routing key across inventory, manifest, and database
    // uniqueness constraints. A credential there cannot be redacted without
    // creating an ambiguous identity mapping, so this rare case remains blocked.
    const protected_locations = new Set([
        'session.source_session_id',
        'session.source_path',
        'session.cwd',
        'session.source_metadata.parent_thread_id',
        'session.source_metadata.parent_session_id',
        'session.source_metadata.forked_from_id',
    ]);
    if (transformations.some((item) => protected_locations.has(item.path))) {
        throw new Error('history redaction cannot safely transform a credential-bearing source identity locator');
    }
    const remaining = find_obvious_credentials({ history_derived_session: transformed });
    if (remaining.length > 0) {
        throw new Error('history redaction post-condition failed; the derived snapshot still contains prohibited credential material');
    }
    const derived_source_revision = portable_session_revision(transformed);
    const terminal_marker_ids = [...active_occurrences].sort((left, right) => left - right);
    const credential_kinds = [...new Set(transformations.map((item) => item.kind))].sort();
    const locations = [...new Set(transformations.map((item) => item.path))].sort();
    const transformation_manifest_hash = hash_canonical({
        schema_version: history_redaction_policy_schema,
        detector_version: obvious_credential_detector_version,
        policy_version: history_redaction_policy_version,
        mode: history_redaction_mode,
        max_redaction_passes,
        transformations,
    });
    return {
        session: transformed,
        binding: {
            source_session_id: session.source_session_id,
            derived_source_revision,
            detector_version: obvious_credential_detector_version,
            policy_version: history_redaction_policy_version,
            mode: history_redaction_mode,
            match_count: terminal_marker_ids.length,
            terminal_marker_ids,
            credential_kinds,
            locations,
            transformation_manifest_hash,
        },
    };
}

export const history_redaction_binding_hash = (binding: history_redaction_binding): string =>
    hash_canonical(binding);
