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
 *  file  : src/cli/porter/history_safety.ts
 *  usage : implements the LongMemory history safety component
 */

import {
    find_obvious_credentials,
    type obvious_credential_finding,
} from '../../core/central_memory/sensitive_content.js';
import type { portable_session } from './types.js';

export type history_credential_issue = {
    /** Safe id, or a report-local ordinal alias if the id itself matched. */
    source_session_ref: string;
    match_count: number;
    credential_kinds: string[];
    locations: string[];
};

export type history_credential_report = {
    scanned_sessions: number;
    affected_sessions: number;
    match_count: number;
    credential_kinds: string[];
    issues: history_credential_issue[];
};

const safe_session_ref = (
    session: portable_session,
    findings: readonly obvious_credential_finding[],
    affected_ordinal: number,
): string => findings.some((finding) => finding.path === 'session.source_session_id')
    ? `affected-session:${affected_ordinal}`
    : session.source_session_id;

/**
 * Scan the exact snapshot that would enter immutable history staging. Reports
 * contain only safe ids/report-local aliases, structural paths, and detector kinds; never
 * the credential value or surrounding source text.
 */
export function inspect_history_credentials(
    sessions: readonly portable_session[],
): history_credential_report {
    const issues: history_credential_issue[] = [];
    for (const session of sessions) {
        const findings = find_obvious_credentials({ session });
        if (findings.length === 0) continue;
        issues.push({
            source_session_ref: safe_session_ref(session, findings, issues.length + 1),
            match_count: findings.length,
            credential_kinds: [...new Set(findings.map((finding) => finding.kind))].sort(),
            locations: [...new Set(findings.map((finding) => finding.path))].sort(),
        });
    }
    return {
        scanned_sessions: sessions.length,
        affected_sessions: issues.length,
        match_count: issues.reduce((sum, issue) => sum + issue.match_count, 0),
        credential_kinds: [...new Set(issues.flatMap((issue) => issue.credential_kinds))].sort(),
        issues,
    };
}

export class history_credential_preflight_error extends Error {
    readonly code = 'HISTORY_CREDENTIAL_PREFLIGHT_BLOCKED';
    readonly report: history_credential_report;

    constructor(report: history_credential_report) {
        const kinds = report.credential_kinds.join(', ') || 'unknown';
        const visible_references = report.issues.slice(0, 12)
            .map((issue) => issue.source_session_ref).join(', ');
        const hidden_reference_count = Math.max(0, report.issues.length - 12);
        const references = hidden_reference_count === 0
            ? visible_references
            : `${visible_references} (+${hidden_reference_count} more in the structured report)`;
        super(
            `Codex history import blocked before database writes: ${report.affected_sessions} selected session(s) `
            + `contain ${report.match_count} prohibited credential occurrence(s) (${kinds}); `
            + `session refs: ${references}. Immutable raw staging cannot safely retain these snapshots; `
            + 'exclude the affected sessions or use an approved redaction workflow, then regenerate and reconfirm the inventory.',
        );
        this.name = 'history_credential_preflight_error';
        this.report = report;
    }
}

export function assert_history_credentials_safe(
    sessions: readonly portable_session[],
): history_credential_report {
    const report = inspect_history_credentials(sessions);
    if (report.affected_sessions > 0) throw new history_credential_preflight_error(report);
    return report;
}
