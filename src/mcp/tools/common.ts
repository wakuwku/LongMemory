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
 *  file  : src/mcp/tools/common.ts
 *  usage : implements the LongMemory common component
 */


import type { CallToolResult as call_tool_result } from '@modelcontextprotocol/sdk/types.js';
import type { mcp_runtime } from '../runtime.js';
import { assert_tool_allowed } from '../security/permissions.js';
import type { mcp_tool_name } from '../security/tool_allowlist.js';
import {
    assert_no_obvious_credentials,
    find_obvious_credentials,
} from '../../core/central_memory/sensitive_content.js';

export const json_tool_result = (value: unknown): call_tool_result => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
});

function safe_audit_project_id(runtime: mcp_runtime, input: Record<string, unknown>): string | null {
    const requested = typeof input.project_id === 'string' ? input.project_id : runtime.access.project_id;
    for (const candidate of [requested, runtime.access.project_id]) {
        if (candidate !== null && find_obvious_credentials({ mcp_audit_project_id: candidate }).length === 0) {
            return candidate;
        }
    }
    return null;
}

const safe_error_message = (message: string): string =>
    find_obvious_credentials({ mcp_tool_error: message }).length > 0
        ? 'request rejected: prohibited credential material'
        : message;

export async function run_audited_tool(
    runtime: mcp_runtime,
    tool: mcp_tool_name,
    input: Record<string, unknown>,
    operation: () => Promise<unknown>,
): Promise<call_tool_result> {
    const started_at = Date.now();
    const project_id = safe_audit_project_id(runtime, input);
    try {
        // Every MCP operation shares this boundary. It runs before permission,
        // identity, or idempotency errors can interpolate caller-controlled
        // identifiers into a response or persistent audit entry.
        assert_no_obvious_credentials({ mcp_tool_input: input });
        assert_tool_allowed(runtime.access, tool);
        const value = await operation();
        const completed_at = Date.now();
        runtime.audit.record({
            tool, user_id: runtime.access.user_id,
            project_id,
            outcome: 'allowed', dry_run: typeof input.dry_run === 'boolean' ? input.dry_run : null,
            started_at, completed_at, error: null,
        });
        return json_tool_result(value);
    } catch (error) {
        const original_message = error instanceof Error ? error.message : String(error);
        const message = safe_error_message(original_message);
        const denied = /not allowed|read-only|permission denied/i.test(message);
        runtime.audit.record({
            tool, user_id: runtime.access.user_id,
            project_id,
            outcome: denied ? 'denied' : 'error', dry_run: typeof input.dry_run === 'boolean' ? input.dry_run : null,
            started_at, completed_at: Date.now(), error: message,
        });
        if (message !== original_message) throw new Error(message);
        throw error;
    }
}
