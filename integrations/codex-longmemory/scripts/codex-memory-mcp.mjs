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
 *  file  : integrations/codex-longmemory/scripts/codex-memory-mcp.mjs
 *  usage : supports the LongMemory codex memory mcp integration
 */

import { fileURLToPath } from 'node:url';
import {
    codexMemoryMcpArgs,
    resolvePluginRuntime,
    spawnLongMemory,
    waitForChild,
} from './plugin-runtime.mjs';

try {
    const runtime = resolvePluginRuntime({
        env: process.env,
        scriptPath: fileURLToPath(import.meta.url),
    });
    const child = spawnLongMemory(codexMemoryMcpArgs(), {
        env: runtime.env,
        stdio: 'inherit',
    });
    const exit = await waitForChild(child);
    if (exit.error) throw exit.error;
    process.exitCode = exit.code;
} catch (error) {
    process.stderr.write(`[longmemory] MCP launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
