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
 *  file  : integrations/codex-longmemory/scripts/codex-memory-hook.mjs
 *  usage : supports the LongMemory codex memory hook integration
 */

import { fileURLToPath } from 'node:url';
import {
    MAX_HOOK_IO_BYTES,
    collectBounded,
    readBounded,
    resolvePluginRuntime,
    spawnLongMemory,
    terminateChild,
    waitForChild,
} from './plugin-runtime.mjs';

const failOpen = () => process.stdout.write(JSON.stringify({ continue: true }));
let child = null;

try {
    const input = await readBounded(process.stdin, MAX_HOOK_IO_BYTES);
    const runtime = resolvePluginRuntime({
        env: process.env,
        scriptPath: fileURLToPath(import.meta.url),
    });
    child = spawnLongMemory(['codex-hook'], { env: runtime.env });
    child.stdin.on('error', () => { /* a failed CLI is handled through its exit result */ });
    child.stderr.pipe(process.stderr);
    child.stdin.end(input);
    const outputPromise = collectBounded(
        child.stdout,
        MAX_HOOK_IO_BYTES,
        () => terminateChild(child),
    );
    const [exit, output] = await Promise.all([waitForChild(child), outputPromise]);
    if (exit.code === 0 && output.toString('utf8').trim()) {
        process.stdout.write(output.toString('utf8').trim());
    } else {
        if (exit.error) process.stderr.write(`[longmemory] Codex hook launcher failed: ${exit.error.message}\n`);
        failOpen();
    }
} catch (error) {
    terminateChild(child);
    process.stderr.write(`[longmemory] Codex hook launcher failed open: ${error instanceof Error ? error.message : String(error)}\n`);
    failOpen();
}
