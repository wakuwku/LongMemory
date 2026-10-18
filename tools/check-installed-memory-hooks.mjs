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
 *  file  : tools/check-installed-memory-hooks.mjs
 *  usage : supports LongMemory check installed memory hooks
 */

// Installed-plugin smoke test; writes only a fresh temporary test registry.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexHookRegistry } from '../dist/integrations/codex_hooks/registry.js';
import { bind_codex_task, record_codex_turn } from '../dist/integrations/codex_hooks/gateway.js';

const plugin = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'longmemory-hooks-install-'));
writeFileSync(join(root, 'participation.json'), JSON.stringify({
    mode: 'allowlist', session_ids: ['novel-smoke'],
}));
function hook(session, name, extra = {}) {
    const result = spawnSync(process.execPath, [join(plugin, 'scripts/codex-memory-hook.mjs')], {
        cwd: plugin, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PLUGIN_DATA: root, CLAUDE_PLUGIN_DATA: root,
            LONGMEMORY_PLUGIN_DATA: root, LONGMEMORY_DB_PATH: join(root, 'test.db') },
        input: JSON.stringify({ session_id: session, cwd: root, transcript_path: null,
            hook_event_name: name, ...extra }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
const text = value => JSON.stringify(value);
assert.match(text(hook('unrelated-smoke', 'SessionStart', {source:'startup'})), /中央记忆未启用/);
assert.match(text(hook('unrelated-smoke', 'UserPromptSubmit', {turn_id:'u1',prompt:'简单问题'})), /中央记忆未启用/);
assert.match(text(hook('unrelated-smoke', 'UserPromptSubmit', {turn_id:'u2',prompt:'检查停用边界'})), /不撤销用户另行明确授权/);
assert.doesNotMatch(text(hook('unrelated-smoke', 'UserPromptSubmit', {turn_id:'u3',prompt:'检查停用边界'})), /不检索或提交中央记忆/);
assert.equal(hook('unrelated-smoke', 'Stop', {turn_id:'u1',stop_hook_active:false}).decision, undefined);
assert.match(text(hook('novel-smoke', 'SessionStart', {source:'startup'})), /尚未绑定/);
assert.match(text(hook('novel-smoke', 'UserPromptSubmit', {turn_id:'n1',prompt:'本次跳过'})), /中央记忆未启用/);
assert.match(text(hook('novel-smoke', 'SessionStart', {source:'compact'})), /中央记忆未启用/);
assert.equal(hook('novel-smoke', 'Stop', {turn_id:'n1',stop_hook_active:false}).decision, undefined);
assert.match(text(hook('novel-smoke', 'UserPromptSubmit', {turn_id:'n2',prompt:'继续'})), /尚未绑定/);
assert.match(text(hook('novel-smoke', 'UserPromptSubmit', {turn_id:'n3',prompt:'此任务不使用记忆'})), /中央记忆未启用/);
assert.match(text(hook('novel-smoke', 'SessionStart', {source:'resume'})), /中央记忆未启用/);
assert.match(text(hook('novel-smoke', 'UserPromptSubmit', {turn_id:'n4',prompt:'继续'})), /中央记忆未启用/);
assert.match(text(hook('novel-smoke', 'UserPromptSubmit', {turn_id:'n5',prompt:'启用记忆'})), /尚未绑定/);
const registry = new CodexHookRegistry(root);
let state = registry.load('novel-smoke');
bind_codex_task(registry, state, {session_id:state.session_id, capability:state.capability,
    turn_id:'n5', project_id:'novel-smoke-project', project_name:'Isolated smoke project',
    responsibility:'Validate installed memory delta delivery.'});
state = registry.load('novel-smoke');
record_codex_turn(state, {session_id:state.session_id, capability:state.capability, turn_id:'n5',
    memories:[{memory_id:'smoke-memory',level:4,memory_kind:'fact',title:'Installed delta evidence',
        summary:'Preserve exact parameters.',body:'Exact parameters: seed 42, Euler, 25 steps; these define the verified reproduction case.'}]});
const first = hook('novel-smoke','UserPromptSubmit',{turn_id:'n6',prompt:'Installed delta evidence'});
assert.match(text(first), /seed 42/);
const ids = [...first.hookSpecificOutput.additionalContext.matchAll(/delivery_id="([^"]+)"/g)].map(m=>m[1]);
assert.equal(ids.length,1);
state=registry.load('novel-smoke');
record_codex_turn(state,{session_id:state.session_id,capability:state.capability,turn_id:'n6',memories:[],acknowledged_delivery_ids:ids});
assert.deepEqual(hook('novel-smoke','Stop',{turn_id:'n6',stop_hook_active:false}),{continue:true});
const delta=hook('novel-smoke','UserPromptSubmit',{turn_id:'n7',prompt:'Installed delta evidence'});
assert.doesNotMatch(text(delta),/seed 42/);
assert.doesNotMatch(text(delta),/delivery_id=/);
assert.ok(text(delta).length<text(first).length);
const fallback=hook('novel-smoke','Stop',{turn_id:'n7',stop_hook_active:false});
assert.equal(fallback.decision,'block');
assert.match(fallback.reason,/中央记忆补交/);
assert.deepEqual(hook('novel-smoke','Stop',{turn_id:'n7',stop_hook_active:true}),{continue:true});
assert.match(text(hook('novel-smoke','SessionStart',{source:'compact'})),/seed 42/);
console.log(JSON.stringify({passed:true, assertions:24, isolatedData:root,
    initialContextChars:first.hookSpecificOutput.additionalContext.length,
    unchangedContextChars:delta.hookSpecificOutput.additionalContext.length}));
