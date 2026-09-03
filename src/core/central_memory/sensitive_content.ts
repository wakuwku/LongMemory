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
 *  file  : src/core/central_memory/sensitive_content.ts
 *  usage : implements the LongMemory sensitive content component
 */

type credential_pattern = { kind: string; pattern: RegExp };

export const obvious_credential_detector_version = 'longmemory.obvious-credentials/v4' as const;

export type obvious_credential_span = {
    /** UTF-16 offsets for deterministic in-memory replacement only. */
    start: number;
    end: number;
    kind: string;
};

export type obvious_credential_finding = {
    /** Structural location only. The matched value is intentionally never returned. */
    path: string;
    kind: string;
};

const high_signal_patterns: credential_pattern[] = [
    // Consume the complete key block. For a truncated block, fail safely by
    // consuming through the end of the containing string.
    { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|$)/i },
    { kind: 'bearer_token', pattern: /\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~+\/-]{12,}/i },
    { kind: 'openai_api_key', pattern: /\bsk-(?:proj-)?[a-z0-9_-]{20,}\b/i },
    { kind: 'github_token', pattern: /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i },
    { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
    { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
    { kind: 'slack_token', pattern: /\bxox[baprs]-[a-z0-9-]{16,}\b/i },
    { kind: 'stripe_secret_key', pattern: /\bsk_(?:live|test)_[a-z0-9]{16,}\b/i },
    { kind: 'jwt', pattern: /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i },
    { kind: 'url_credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
];

const assignment_pattern = /\b(?:[a-z0-9]+[_-])*(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|api[_-]?key|access[_-]?key|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\b\s*(?:=|:)\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([^\s,;]{8,}))/gi;
// Keep this intentionally narrow. In particular, arbitrary angle-bracketed
// values are not placeholders: `password=<ActualPassword123>` must still be
// rejected. The LongMemory marker is detector-inert, but history staging
// separately requires authorization evidence whenever such a marker exists.
const safe_placeholder = /^(?:\*+|x+|redacted|masked|none|null|undefined|example|placeholder|changeme|replace[-_ ]?me|<(?:redacted|masked|placeholder|removed)>|<LMR-REDACTED-\d{6}>|\$\{[A-Z_][A-Z0-9_]{0,127}\})$/i;

function assignment_contains_secret(text: string): boolean {
    assignment_pattern.lastIndex = 0;
    for (let match = assignment_pattern.exec(text); match; match = assignment_pattern.exec(text)) {
        const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        const normalized = value.replace(/[.!?)]{1,3}$/, '');
        if (normalized && !safe_placeholder.test(normalized)) return true;
    }
    return false;
}

const overlaps = (left: obvious_credential_span, right: obvious_credential_span): boolean =>
    left.start < right.end && right.start < left.end;

const global_pattern = (pattern: RegExp): RegExp => new RegExp(
    pattern.source,
    [...new Set(`${pattern.flags}g`.split(''))].join(''),
);

/**
 * Return every non-overlapping high-signal credential span. Spans never carry
 * the matched value. Specific token detectors win over the generic assignment
 * detector so `api_key=sk-...` preserves the harmless key name.
 */
export function find_obvious_credential_spans(text: string): obvious_credential_span[] {
    const accepted: obvious_credential_span[] = [];
    for (const candidate of high_signal_patterns) {
        const pattern = global_pattern(candidate.pattern);
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
            const span = { start: match.index, end: match.index + match[0].length, kind: candidate.kind };
            if (span.end > span.start && !accepted.some((item) => overlaps(item, span))) accepted.push(span);
            if (match[0].length === 0) pattern.lastIndex += 1;
        }
    }

    assignment_pattern.lastIndex = 0;
    for (let match = assignment_pattern.exec(text); match; match = assignment_pattern.exec(text)) {
        const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        const normalized = value.replace(/[.!?)]{1,3}$/, '');
        if (!normalized || safe_placeholder.test(normalized)) continue;
        const raw_value = match[1] ?? match[2] ?? match[3] ?? '';
        const relative = match[0].lastIndexOf(raw_value);
        if (relative < 0) continue;
        const span = {
            start: match.index + relative,
            end: match.index + relative + raw_value.length,
            kind: 'secret_assignment',
        };
        if (span.end > span.start && !accepted.some((item) => overlaps(item, span))) accepted.push(span);
    }
    return accepted.sort((left, right) => left.start - right.start
        || left.end - right.end || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
}

function credential_kind(text: string): string | null {
    return find_obvious_credential_spans(text)[0]?.kind
        ?? (assignment_contains_secret(text) ? 'secret_assignment' : null);
}

const safe_path_component = (key: string): string => /^[a-z_][a-z0-9_-]{0,63}$/i.test(key)
    && credential_kind(key) === null
    ? key
    : '<key>';

type string_scan_item =
    | { kind: 'value'; path: string; value: unknown }
    | { kind: 'text'; path: string; text: string };

/**
 * Walk JSON-shaped values without a recursion depth cutoff. A fixed depth
 * limit is unsafe here: every value that will later be serialized must be
 * inspected, even when it is nested more deeply than ordinary metadata.
 * The explicit stack also avoids making the scanner itself vulnerable to a
 * JavaScript call-stack overflow. Cyclic/shared objects are visited once;
 * authoritative write paths normalize inputs to acyclic JSON first.
 */
function* string_values(
    value: unknown,
    path: string,
    seen: Set<object>,
): Generator<{ path: string; text: string }> {
    const stack: string_scan_item[] = [{ kind: 'value', path, value }];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.kind === 'text') {
            yield { path: current.path, text: current.text };
            continue;
        }
        if (typeof current.value === 'string') {
            yield { path: current.path, text: current.value };
            continue;
        }
        if (current.value === null || typeof current.value !== 'object' || seen.has(current.value)) {
            continue;
        }
        seen.add(current.value);
        if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
                stack.push({
                    kind: 'value',
                    path: `${current.path}[${index}]`,
                    value: current.value[index],
                });
            }
            continue;
        }
        const entries = Object.entries(current.value as Record<string, unknown>);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, item] = entries[index]!;
            // Push the value first so the LIFO traversal yields the persisted
            // object key before descending into that value, matching the old
            // deterministic depth-first order. Unsafe key bytes never appear
            // in the structural path or in a rejection message.
            stack.push({
                kind: 'value',
                path: `${current.path}.${safe_path_component(key)}`,
                value: item,
            });
            stack.push({ kind: 'text', path: `${current.path}.<key>`, text: key });
        }
    }
}

/**
 * Find high-signal credential material without ever returning the matched value.
 * Callers may safely use the structural path and kind in local audit reports.
 */
export function find_obvious_credentials(
    fields: Record<string, unknown>,
): obvious_credential_finding[] {
    const seen = new Set<object>();
    const findings: obvious_credential_finding[] = [];
    for (const [label, value] of Object.entries(fields)) {
        for (const candidate of string_values(value, label, seen)) {
            for (const span of find_obvious_credential_spans(candidate.text)) {
                findings.push({ path: candidate.path, kind: span.kind });
            }
        }
    }
    return findings;
}

/** Reject obvious credentials without copying the matched secret into errors or logs. */
export function assert_no_obvious_credentials(fields: Record<string, unknown>): void {
    const finding = find_obvious_credentials(fields)[0];
    if (finding) {
        throw new Error(`formal memory ${finding.path} contains prohibited credential material (${finding.kind})`);
    }
}
