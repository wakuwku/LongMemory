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
 *  file  : src/integrations/codex_hooks/participation.ts
 *  usage : implements the LongMemory participation component
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { codex_hook_session_state } from './types.js';

const policy_schema = z.object({
    mode: z.enum(['all', 'allowlist']),
    project_ids: z.array(z.string()).default([]),
    session_ids: z.array(z.string()).default([]),
    cwd_roots: z.array(z.string()).default([]),
}).strict();

/** Local operator policy selects rollout scope, never infers a project binding. */
export function participation_allowed(root: string, state: codex_hook_session_state): boolean {
    const file = join(root, 'participation.json');
    if (!existsSync(file)) return true;
    const policy = policy_schema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (policy.mode === 'all') return true;
    if (policy.session_ids.includes(state.session_id)) return true;
    if ((state.bound || state.project_was_configured) && policy.project_ids.includes(state.project_id)) return true;
    const cwd = resolve(state.cwd).replace(/\\/g, '/').toLowerCase();
    return policy.cwd_roots.some(root => {
        const normalized = resolve(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        return cwd === normalized || cwd.startsWith(normalized + '/');
    });
}

export function participation_command(prompt: string): 'off' | 'skip' | 'on' | null {
    const value = prompt.trim().replace(/[。！!]+$/, '');
    if (/^(此任务不使用记忆|本任务不使用记忆|拒绝绑定|关闭记忆|关闭本任务记忆)$/i.test(value)) return 'off';
    if (/^(本次跳过|本次跳过记忆|跳过记忆|先不管这个记忆skill|先不管这个记忆 skill)$/i.test(value)) return 'skip';
    if (/^(启用记忆|恢复记忆|启用本任务记忆)$/i.test(value)) return 'on';
    return null;
}

export function assert_participating(root: string, state: codex_hook_session_state, turn_id: string): void {
    if (!participation_allowed(root, state) || state.memory_disabled || state.memory_skipped_turn === turn_id) {
        throw new Error('Central memory is disabled for this task or turn; continue the user request without memory.');
    }
}
