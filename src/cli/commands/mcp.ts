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
 *  file  : src/cli/commands/mcp.ts
 *  usage : implements the LongMemory mcp component
 */


import { run_mcp_stdio } from '../../mcp/transports/stdio.js';
import type { cli_command } from '../context/cli_context.js';
import { command_flags, flag, has } from '../context/cli_context.js';
import { resolve_central_storage } from '../context/central_storage.js';
import { emit } from '../output/pretty.js';
import { panel } from '../output/panel.js';
import { parse_mcp_profile } from '../../mcp/security/tool_allowlist.js';

export const mcp_command: cli_command = async (context) => {
    command_flags(context, ['read-only', 'audit', 'central-thread', 'profile']);
    const profile = parse_mcp_profile(flag(context, 'profile'));
    const central = resolve_central_storage({
        env: context.env,
        explicit_db_path: context.args.flags.has('db') ? context.db_path : undefined,
    });
    const runtime_env = {
        ...context.env,
        PLUGIN_DATA: central.plugin_data,
        CLAUDE_PLUGIN_DATA: central.plugin_data,
        LONGMEMORY_PLUGIN_DATA: central.plugin_data,
        LONGMEMORY_DB_PATH: central.db_path,
    };
    if (context.dry_run) {
        const result = { ok: true, command: 'mcp', dry_run: true, db_path: central.db_path, plugin_data: central.plugin_data, project_id: context.project_id, user_id: context.user_id, profile, read_only: true };
        emit(context, result, () => panel('MCP configuration is valid; stdio transport was not started.', context.colors, { title: 'MCP preview', kind: 'warning', width: context.terminal_width, rows: [['Database', central.db_path], ['Plugin data', central.plugin_data], ['Project', context.project_id], ['User', context.user_id], ['Profile', profile], ['Mode', 'read-only preview']] }));
        return;
    }
    await run_mcp_stdio({
        db_path: central.db_path,
        project_id: context.project_id,
        user_id: context.user_id,
        tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
        profile,
        central_thread_id: flag(context, 'central-thread')
            ?? context.env.LONGMEMORY_CENTRAL_THREAD_ID?.trim()
            ?? null,
        roles: (context.env.LONGMEMORY_MCP_ROLES ?? '')
            .split(',').map((role) => role.trim()).filter(Boolean),
        read_only: has(context, 'read-only'),
        audit_path: flag(context, 'audit') ?? (central.db_path === ':memory:'
            ? null
            : `${central.db_path}.mcp-audit.jsonl`),
        env: runtime_env,
    });
};
