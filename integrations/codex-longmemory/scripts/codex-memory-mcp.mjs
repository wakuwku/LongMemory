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

import { resolve } from 'node:path';

function parentIsAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) {
        // Access-denied or an unknown OS error is not evidence of parent death.
        return error?.code !== 'ESRCH';
    }
}

export function watchMcpChild(child, {
    owner = process,
    parentPid = owner.ppid,
    parentAlive = parentIsAlive,
    intervalMs = 2000,
    killAfterMs = 5000,
} = {}) {
    let disposed = false;
    let stopping = false;
    let watchdog;
    let forceTimer;
    const running = () => child.exitCode === null && child.signalCode === null;
    const kill = (signal) => {
        if (!running()) return;
        // Only the ChildProcess we spawned is targeted; never kill a process
        // tree or an unrelated PID. Windows batch-command descendants require
        // a separate OS job object for an absolute orphan guarantee.
        try { child.kill(signal); } catch { /* best effort */ }
    };
    const stop = (signal = 'SIGTERM') => {
        if (disposed || stopping || !running()) return;
        stopping = true;
        kill(signal);
        forceTimer = setTimeout(() => kill('SIGKILL'), killAfterMs);
        forceTimer.unref?.();
    };
    const onSigint = () => stop('SIGINT');
    const onSigterm = () => stop('SIGTERM');
    const onExit = () => kill('SIGTERM');
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(watchdog);
        clearTimeout(forceTimer);
        owner.off('SIGINT', onSigint);
        owner.off('SIGTERM', onSigterm);
        owner.off('exit', onExit);
        child.off('close', dispose);
        child.off('error', dispose);
    };
    owner.on('SIGINT', onSigint);
    owner.on('SIGTERM', onSigterm);
    owner.on('exit', onExit);
    child.once('close', dispose);
    child.once('error', dispose);
    if (parentPid > 1) {
        watchdog = setInterval(() => {
            if (owner.ppid !== parentPid || !parentAlive(parentPid)) stop();
        }, intervalMs);
        watchdog.unref?.();
    }
    return { dispose, stop };
}

export async function runMcpLauncher({
    env = process.env,
    scriptPath = fileURLToPath(import.meta.url),
} = {}) {
    const runtime = resolvePluginRuntime({
        env,
        scriptPath,
    });
    const child = spawnLongMemory(codexMemoryMcpArgs(), {
        env: runtime.env,
        stdio: 'inherit',
        scriptPath,
    });
    const guardian = watchMcpChild(child);
    try {
        const exit = await waitForChild(child);
        if (exit.error) throw exit.error;
        return exit.code;
    } finally {
        guardian.dispose();
    }
}

// Importing lifecycle helpers in tests must not launch a real MCP backend.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = await runMcpLauncher();
    } catch (error) {
        process.stderr.write(`[longmemory] MCP launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
