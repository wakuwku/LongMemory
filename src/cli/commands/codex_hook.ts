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
 *  file  : src/cli/commands/codex_hook.ts
 *  usage : implements the LongMemory codex hook component
 */

import { handle_codex_hook } from '../../integrations/codex_hooks/hook_bridge.js';
import type { cli_command } from '../context/cli_context.js';
import { command_flags } from '../context/cli_context.js';
import { resolve_central_storage } from '../context/central_storage.js';
import { detect_cwd_project } from '../context/cwd_project.js';
import { load_local_config } from '../context/config_loader.js';

const MAX_STDIN_BYTES = 1_048_576;

async function read_stdin(): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += value.byteLength;
        if (bytes > MAX_STDIN_BYTES) throw new Error('Codex hook stdin exceeds 1 MiB');
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export const codex_hook_command: cli_command = async (context) => {
    command_flags(context, []);
    try {
        const central = resolve_central_storage({
            env: context.env,
            explicit_db_path: context.args.flags.has('db') ? context.db_path : undefined,
            require_plugin_data_environment: true,
        });
        const raw = await read_stdin();
        const local = load_local_config(detect_cwd_project(context.cwd).root);
        const project_was_configured = context.args.flags.has('project')
            || Boolean(context.env.LONGMEMORY_PROJECT_ID?.trim())
            || Boolean(local.project_id?.trim());
        const output = handle_codex_hook(raw, {
            plugin_data: central.plugin_data,
            db_path: central.db_path,
            tenant_id: context.env.LONGMEMORY_TENANT_ID?.trim() || 'default',
            user_id: context.user_id,
            project_id: context.project_id,
            project_name: context.project_name,
            project_was_configured,
            token_budget: Number(context.env.LONGMEMORY_CODEX_HOOK_TOKEN_BUDGET ?? 1_800),
        });
        context.io.stdout(JSON.stringify(output));
    } catch (error) {
        context.io.stderr(`[longmemory] Codex hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
        context.io.stdout(JSON.stringify({ continue: true }));
    }
};
