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
 *  file  : src/mcp/tools/codex_memory.ts
 *  usage : implements the LongMemory codex memory component
 */

import type { McpServer as mcp_server_sdk } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CodexHookRegistry } from '../../integrations/codex_hooks/registry.js';
import {
    bind_codex_task,
    recall_codex_memory,
    record_codex_turn,
} from '../../integrations/codex_hooks/gateway.js';
import type {
    codex_bind_input,
    codex_recall_input,
    codex_record_turn_input,
} from '../../integrations/codex_hooks/types.js';
import type { mcp_runtime } from '../runtime.js';
import { codex_memory_schema } from '../schemas/tool_schemas.js';
import { assert_write_allowed } from '../security/permissions.js';
import { run_audited_tool } from './common.js';

function plugin_data(runtime: mcp_runtime): string {
    const value = runtime.env.PLUGIN_DATA?.trim()
        || runtime.env.CLAUDE_PLUGIN_DATA?.trim()
        || runtime.env.LONGMEMORY_PLUGIN_DATA?.trim();
    if (!value) throw new Error('permission denied: Codex memory gateway requires PLUGIN_DATA');
    return value;
}

export function register_codex_memory_tool(server: mcp_server_sdk, runtime: mcp_runtime): void {
    server.registerTool('longmemory_codex_memory', {
        description: 'Turn-capability-scoped bridge used by Codex memory hooks to bind a task, expand its central-memory working set, or atomically record and finalize one turn.',
        inputSchema: codex_memory_schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async (input) => run_audited_tool(runtime, 'longmemory_codex_memory', input, async () => {
        assert_write_allowed(runtime.access, 'longmemory_codex_memory');
        const registry = new CodexHookRegistry(plugin_data(runtime));
        if (!input.turn_id) throw new Error('turn_id is required for Codex memory gateway access');
        return registry.with_capability(
            input.session_id,
            input.capability,
            input.turn_id,
            (state, save_state) => {
                if (input.action === 'bind') {
                    if (!input.project_id || !input.responsibility) {
                        throw new Error('project_id and responsibility are required for Codex task binding');
                    }
                    return bind_codex_task(
                        registry,
                        state,
                        input as codex_bind_input,
                        save_state,
                    );
                }
                if (input.action === 'recall') {
                    if (!input.query) throw new Error('query is required for Codex central-memory recall');
                    return recall_codex_memory(registry, state, input as codex_recall_input);
                }
                if (!input.memories) throw new Error('memories are required for Codex turn recording');
                return record_codex_turn(state, input as codex_record_turn_input);
            }
        );
    }));
}
