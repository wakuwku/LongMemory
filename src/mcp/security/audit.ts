/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/mcp/security/audit.ts
 *  usage : implements the LongMemory audit component
 */


import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { mcp_tool_name } from './tool_allowlist.js';
import { find_obvious_credentials } from '../../core/central_memory/sensitive_content.js';

export type mcp_audit_entry = {
    id: string;
    tool: mcp_tool_name;
    user_id: string;
    project_id: string | null;
    outcome: 'allowed' | 'denied' | 'error';
    dry_run: boolean | null;
    started_at: number;
    completed_at: number;
    duration_ms: number;
    error: string | null;
};

export type mcp_audit_persistence_failure = {
    entry_id: string;
    path: string;
    failed_at: number;
    error: string;
};

function safe_audit_text(value: string, replacement: string): string {
    return find_obvious_credentials({ audit_value: value }).length > 0 ? replacement : value;
}

export class mcp_audit_log {
    private readonly values: mcp_audit_entry[] = [];
    private readonly persistence_failures: mcp_audit_persistence_failure[] = [];

    constructor(private readonly path: string | null = null) {}

    record(entry: Omit<mcp_audit_entry, 'id' | 'duration_ms'>): mcp_audit_entry {
        const value: mcp_audit_entry = {
            ...entry,
            user_id: safe_audit_text(entry.user_id, '<redacted-user>'),
            project_id: entry.project_id === null
                ? null
                : safe_audit_text(entry.project_id, '<redacted-project>'),
            error: entry.error === null
                ? null
                : safe_audit_text(entry.error, 'request rejected: prohibited credential material'),
            id: `mcp-audit:${entry.started_at}:${this.values.length + 1}`,
            duration_ms: Math.max(0, entry.completed_at - entry.started_at),
        };
        this.values.push(value);
        if (this.path) {
            try {
                mkdirSync(dirname(this.path), { recursive: true });
                appendFileSync(this.path, `${JSON.stringify(value)}\n`, 'utf8');
            } catch (error) {
                this.persistence_failures.push({
                    entry_id: value.id,
                    path: safe_audit_text(this.path, '<redacted-audit-path>'),
                    failed_at: Date.now(),
                    error: safe_audit_text(
                        error instanceof Error ? error.message : String(error),
                        'audit persistence failed with prohibited credential material',
                    ),
                });
            }
        }
        return value;
    }

    entries(): readonly mcp_audit_entry[] {
        return [...this.values];
    }

    failures(): readonly mcp_audit_persistence_failure[] {
        return [...this.persistence_failures];
    }

    last_failure(): mcp_audit_persistence_failure | null {
        return this.persistence_failures.at(-1) ?? null;
    }
}
