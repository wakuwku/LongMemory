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
 *  file  : src/mcp/security/tool_allowlist.ts
 *  usage : implements the LongMemory tool allowlist component
 */


export const mcp_tool_names = [
    'longmemory_project_context',
    'longmemory_recall',
    'longmemory_ingest',
    'longmemory_remember_decision',
    'longmemory_update_task_state',
    'longmemory_explain',
    'longmemory_report_conflicts',
    'longmemory_sync_connector',
    'longmemory_match_skills',
    'longmemory_manage_skill',
    'longmemory_code_graph',
    'longmemory_asset_catalog',
    'longmemory_manage_asset',
    'longmemory_codex_memory',
    'longmemory_history_backfill',
    'longmemory_history_publication',
    'longmemory_history_governance',
    'longmemory_central_register_thread',
    'longmemory_central_context',
    'longmemory_central_publish',
    'longmemory_central_confirmation',
    'longmemory_central_conflict',
    'longmemory_central_project_link',
    'longmemory_central_usage',
    'longmemory_central_finalize_turn',
] as const;

export type mcp_tool_name = typeof mcp_tool_names[number];

export const mcp_profile_names = [
    'default',
    'codex-memory-gateway',
] as const;

export type mcp_profile = typeof mcp_profile_names[number];

/**
 * The Codex lifecycle integration handles untrusted task and historical
 * transcript content.  Its server surface must therefore stay capability
 * gated instead of inheriting the general-purpose MCP write tools.
 *
 * Every tool in this profile must validate the same locked session + turn
 * capability scope before reading or mutating the central store.
 */
export const codex_memory_gateway_tool_names = [
    'longmemory_codex_memory',
    'longmemory_history_backfill',
    'longmemory_history_publication',
] as const satisfies readonly mcp_tool_name[];

export const central_thread_scoped_tool_names = [
    'longmemory_central_register_thread',
    'longmemory_central_context',
    'longmemory_central_publish',
    'longmemory_central_usage',
    'longmemory_central_finalize_turn',
] as const satisfies readonly mcp_tool_name[];

export const default_mcp_tool_names = mcp_tool_names.filter((name) =>
    name !== 'longmemory_central_confirmation'
    && name !== 'longmemory_history_governance'
    && name !== 'longmemory_central_project_link') as readonly mcp_tool_name[];

export function parse_mcp_profile(value: string | undefined): mcp_profile {
    const normalized = value?.trim() || 'default';
    if (!(mcp_profile_names as readonly string[]).includes(normalized)) {
        throw new Error(`unknown MCP profile: ${normalized}`);
    }
    return normalized as mcp_profile;
}

export function mcp_profile_tools(profile: mcp_profile): readonly mcp_tool_name[] | null {
    return profile === 'codex-memory-gateway' ? codex_memory_gateway_tool_names : null;
}

export function create_tool_allowlist(names: readonly string[] = default_mcp_tool_names): ReadonlySet<mcp_tool_name> {
    const known = new Set<string>(mcp_tool_names);
    const invalid = names.filter((name) => !known.has(name));
    if (invalid.length) throw new Error(`unknown MCP tool in allowlist: ${invalid[0]}`);
    return new Set(names as readonly mcp_tool_name[]);
}
