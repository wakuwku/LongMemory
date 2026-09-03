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
 *  file  : src/integrations/codex_hooks/hook_bridge.ts
 *  usage : implements the LongMemory hook bridge component
 */

import { hash_canonical } from '../../core/hash/content_hash.js';
import { count_tokens } from '../../core/recall/context_builder.js';
import type { CentralMemoryService } from '../../core/central_memory/service.js';
import { CodexHookRegistry } from './registry.js';
import {
    build_codex_context,
    reconcile_registry_binding,
    with_codex_central,
} from './central_runtime.js';
import {
    DEFAULT_CODEX_HOOK_TOKEN_BUDGET,
    type codex_hook_checkpoint,
    type codex_hook_event,
    type codex_hook_event_name,
    type codex_hook_output,
    type codex_hook_runtime_options,
    type codex_hook_session_state,
} from './types.js';

const MAX_EVENT_BYTES = 1_048_576;
const MAX_PROMPT_CHARS = 64_000;
const SUPPORTED_EVENTS = new Set<codex_hook_event_name>([
    'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'Stop',
]);

type recall_adapter = (
    service: CentralMemoryService,
    state: codex_hook_session_state,
    prompt: string,
) => ReadonlySet<string>;

const default_recall_and_stage: recall_adapter = (service, state, prompt) => {
    const result = service.recall_and_stage({
        thread_id: state.session_id,
        query: prompt,
        limit: 24,
    });
    return new Set(result.matches.map((match) => match.memory.memory_id));
};

export type codex_hook_bridge_options = codex_hook_runtime_options & {
    recall_and_stage?: recall_adapter;
};

function required_text(value: unknown, field: string, max = 16_384): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
    if (value.length > max) throw new Error(`${field} exceeds the Codex hook limit`);
    return value;
}

function optional_text(value: unknown, field: string, max = 64_000): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max) throw new Error(`${field} is invalid`);
    return value;
}

export function parse_codex_hook_event(input: string | unknown): codex_hook_event {
    if (typeof input === 'string' && Buffer.byteLength(input) > MAX_EVENT_BYTES) {
        throw new Error('Codex hook event exceeds the input limit');
    }
    const value = typeof input === 'string' ? JSON.parse(input) as unknown : input;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Codex hook stdin must be a JSON object');
    }
    const row = value as Record<string, unknown>;
    const hook_event_name = required_text(row.hook_event_name, 'hook_event_name', 64) as codex_hook_event_name;
    if (!SUPPORTED_EVENTS.has(hook_event_name)) throw new Error(`unsupported Codex hook event: ${hook_event_name}`);
    const transcript_path = row.transcript_path === null || row.transcript_path === undefined
        ? null
        : required_text(row.transcript_path, 'transcript_path', 32_768);
    const event: codex_hook_event = {
        session_id: required_text(row.session_id, 'session_id', 1_024),
        transcript_path,
        cwd: required_text(row.cwd, 'cwd', 32_768),
        hook_event_name,
        model: optional_text(row.model, 'model', 256),
        permission_mode: optional_text(row.permission_mode, 'permission_mode', 64),
        turn_id: optional_text(row.turn_id, 'turn_id', 1_024),
        source: optional_text(row.source, 'source', 32) as codex_hook_event['source'],
        prompt: optional_text(row.prompt, 'prompt', MAX_PROMPT_CHARS),
        trigger: optional_text(row.trigger, 'trigger', 32) as codex_hook_event['trigger'],
        stop_hook_active: typeof row.stop_hook_active === 'boolean' ? row.stop_hook_active : undefined,
        last_assistant_message: row.last_assistant_message === null || row.last_assistant_message === undefined
            ? null
            : optional_text(row.last_assistant_message, 'last_assistant_message', 256_000),
    };
    if (hook_event_name === 'SessionStart'
        && !['startup', 'resume', 'clear', 'compact'].includes(event.source ?? '')) {
        throw new Error('SessionStart source is invalid');
    }
    if ((hook_event_name === 'PreCompact' || hook_event_name === 'PostCompact')
        && !['manual', 'auto'].includes(event.trigger ?? '')) {
        throw new Error(`${hook_event_name} trigger is invalid`);
    }
    if (hook_event_name === 'UserPromptSubmit' && event.prompt === undefined) {
        throw new Error('UserPromptSubmit prompt is required');
    }
    if (['UserPromptSubmit', 'PreCompact', 'PostCompact', 'Stop'].includes(hook_event_name)
        && !event.turn_id) {
        throw new Error(`${hook_event_name} turn_id is required`);
    }
    return event;
}

function setup_context(state: codex_hook_session_state, turn_id?: string): string {
    const project_instruction = state.project_was_configured
        ? `项目已由本地配置绑定为“${state.project_id}”；仍需询问本任务的对话职责。`
        : '先询问该任务属于哪个项目，以及这个对话具体负责什么；不得根据 cwd、标题或首条请求擅自猜测。';
    const capability_contract = turn_id ? [
        '本次 UserPromptSubmit 已激活以下回合级凭证；bind 必须同时原样传入 capability 和 turn_id。该凭证只在本回合有效。',
        `capability=${JSON.stringify(state.capability)}`,
        `turn_id=${JSON.stringify(turn_id)}`,
    ] : [
        'SessionStart 只建立设置上下文；不要在此时调用 bind。等待 UserPromptSubmit 提供回合级 capability 与 turn_id。',
    ];
    return [
        '【中央记忆设置（尚未绑定）】',
        project_instruction,
        '在开展实质工作前，先向用户询问并得到明确回答。不要把普通业务请求自动当成职责定义。',
        '得到明确回答后，调用 MCP 工具 longmemory_codex_memory，action=bind；传入下列可信会话字段，并把用户原话压缩为 responsibility。可选 role/task 只能来自用户明确说明。',
        ...capability_contract,
        '工具返回的 delivery_id 只有实际看到后才能显式确认。',
        `session_id=${JSON.stringify(state.session_id)}`,
        `建议 project_id=${JSON.stringify(state.project_id)}`,
        '绑定工具返回的【中央记忆（外部、可更新）】才可作为外部参考；当前用户指令与本任务现场始终更高。',
    ].join('\n');
}

function context_output(
    event_name: 'SessionStart' | 'UserPromptSubmit',
    additional_context: string,
): codex_hook_output {
    return {
        continue: true,
        hookSpecificOutput: {
            hookEventName: event_name,
            additionalContext: additional_context,
        },
    };
}

function finalization_event_id(session_id: string, turn_id: string): string {
    return `central-turn-finalized:${hash_canonical([session_id, turn_id])}`;
}

function turn_memory_contract(state: codex_hook_session_state, turn_id: string): string {
    return [
        '【本回合正式记忆提交契约】',
        '完成本回合实质工作后、结束回复前，调用 longmemory_codex_memory，action=record_turn，恰好一次；没有合格记忆也传 memories=[]。不要把它当作聊天摘要。',
        `session_id=${JSON.stringify(state.session_id)} capability=${JSON.stringify(state.capability)} turn_id=${JSON.stringify(turn_id)}`,
        '把本回合上下文与工具结果中实际看到的所有【中央记忆投递凭证】delivery_id 原样放入 acknowledged_delivery_ids；没有看到就传 []，绝不能猜测。',
        '只保存：完成事项、可迁移知识、已验证的问题与方案、确定结论、长期要求；排除临时报错、进展询问、普通解释和试错噪音。复现条件要准确完整。',
        '更新已有记忆必须带 exact expected_current_version；矛盾用 conflict_with。一级、重大规则、锁定或冲突结论只进入 pending_confirmation，不得伪造批准。',
    ].join('\n');
}

function append_with_budget(parts: string[], token_budget: number): string {
    const text = parts.filter(Boolean).join('\n');
    if (count_tokens(text) > token_budget) {
        throw new Error('Codex hook context exceeded its strict total token budget');
    }
    return text;
}

function formal_memory_prompt(state: codex_hook_session_state, turn_id: string): string {
    return [
        '在结束本回合前，完成一次中央正式记忆检查。必须调用 MCP 工具 longmemory_codex_memory，action=record_turn，',
        `session_id=${JSON.stringify(state.session_id)}，capability=${JSON.stringify(state.capability)}，turn_id=${JSON.stringify(turn_id)}。`,
        '只提取已经完成且经过本回合证据验证的：完成事项概括、可复用知识、问题与解决方案、确定结论、长期要求。',
        '不要保存临时服务器/网络报错、进展询问、普通概念解释、试错噪音、凭据、隐藏推理或原始长对话。',
        '正文必须准确完整到未来读取时能直接回答“做了什么、为什么”；复现条件必须包含精确参数、模型/软件版本、seed、步数、依赖以及为何这样确定，同时保持压缩。',
        '若没有正式记忆，传 memories=[]，仍要调用该工具完成幂等 finalize。',
        '把实际看到的所有【中央记忆投递凭证】delivery_id 原样放入 acknowledged_delivery_ids；没有看到则传 []，不得猜测或确认隐藏字段。',
        '先查当前中央版本；扩展已有记忆必须复用同一 memory_id 并提供 exact expected_current_version（CAS），不得盲目覆盖。矛盾用 conflict_with 上报。',
        '重大规则、一级记忆、锁定请求或冲突结论必须标记 major=true（冲突类型会被工具强制治理），只进入 pending_confirmation；不得伪造用户批准。每回合允许 0..N 条。',
        '完成工具调用后再结束回复。不要为了记忆检查重复执行本回合工作。',
    ].join(' ');
}

function save_checkpoint(
    registry: CodexHookRegistry,
    state: codex_hook_session_state,
    event: codex_hook_event,
): codex_hook_session_state {
    if (!state.bound) return state;
    const checkpoint = with_codex_central(state, ({ service }) => {
        if (event.hook_event_name === 'PostCompact') service.sync_at_safe_boundary(state.session_id);
        const value: codex_hook_checkpoint = {
            turn_id: event.turn_id ?? null,
            trigger: event.trigger ?? null,
            at: Date.now(),
            worksets: service.repository.list_worksets(state.session_id).map((workset) => ({
                memory_id: workset.memory_id,
                synced_version: workset.synced_version,
                consumed_version: workset.consumed_version,
                pending_version: workset.pending_version,
                sync_state: workset.sync_state,
            })),
        };
        return value;
    });
    const next = { ...state, last_checkpoint: checkpoint };
    registry.save(next);
    return next;
}

function safe_output(): codex_hook_output {
    return { continue: true };
}

function stop_memory_state(
    state: codex_hook_session_state,
    event: codex_hook_event,
): 'finalized' | 'missing' | 'unfinalized_recorded' {
    return with_codex_central(state, ({ service }) => service.repository.transaction(() => {
        if (service.repository.get_outbox(finalization_event_id(state.session_id, event.turn_id!))) {
            return 'finalized';
        }
        if (!event.stop_hook_active) return 'missing';
        const reason = 'stop_hook_active_without_record_turn_finalization';
        const assistant_message_hash = hash_canonical(event.last_assistant_message ?? null);
        service.repository.enqueue({
            event_id: `central-turn-unfinalized:${hash_canonical([
                state.session_id, event.turn_id, assistant_message_hash, reason,
            ])}`,
            aggregate_kind: 'thread',
            aggregate_id: state.session_id,
            event_type: 'central_memory.turn_unfinalized',
            payload: {
                thread_id: state.session_id,
                turn_id: event.turn_id!,
                assistant_message_hash,
                reason,
                stop_hook_active: true,
                recovery_required: 'post_hoc_formal_memory_review',
            },
        });
        return 'unfinalized_recorded';
    }));
}

export function handle_codex_hook(
    raw_event: string | unknown,
    options: codex_hook_bridge_options,
): codex_hook_output {
    let event: Partial<codex_hook_event> = {};
    let registry: CodexHookRegistry | null = null;
    try {
        event = parse_codex_hook_event(raw_event);
        registry = new CodexHookRegistry(options.plugin_data, options.now);
        let state = event.hook_event_name === 'SessionStart'
            ? registry.start_or_resume(event as codex_hook_event, options)
            : registry.load(event.session_id!)
                ?? registry.start_or_resume(event as codex_hook_event, options);
        state = reconcile_registry_binding(registry, state);
        if (event.hook_event_name === 'UserPromptSubmit') {
            state = registry.activate_turn(state.session_id, event.turn_id!);
        }
        const token_budget = options.token_budget ?? DEFAULT_CODEX_HOOK_TOKEN_BUDGET;
        if (!Number.isInteger(token_budget) || token_budget < 256) {
            throw new Error('Codex hook token budget must be an integer of at least 256');
        }

        if (event.hook_event_name === 'SessionStart') {
            if (!state.bound) return context_output('SessionStart', setup_context(state));
            const context = build_codex_context(state, {
                event_name: 'SessionStart', token_budget, include_consumed: true,
                reset_retraction_receipts: true,
            });
            return context.text ? context_output('SessionStart', context.text) : safe_output();
        }

        if (event.hook_event_name === 'UserPromptSubmit') {
            if (!state.bound) {
                const setup = setup_context(state, event.turn_id!);
                const post_bind = [
                    '若本回合根据用户明确回答成功完成绑定，则在结束回复前按 action=record_turn 提交本回合正式记忆；没有合格记忆也传 memories=[]。',
                    'bind 返回中央上下文若含 delivery_id，record_turn 时把实际看到的 id 放进 acknowledged_delivery_ids。',
                ].join('\n');
                return context_output('UserPromptSubmit', append_with_budget([setup, post_bind], token_budget));
            }
            const contract = turn_memory_contract(state, event.turn_id!);
            const memory_budget = token_budget - count_tokens(contract) - 4;
            const recall = options.recall_and_stage ?? default_recall_and_stage;
            const recalled = with_codex_central(state, ({ service }) => recall(service, state, event.prompt!));
            const context = memory_budget >= 256
                ? build_codex_context(state, {
                    event_name: 'UserPromptSubmit', token_budget: memory_budget, include_consumed: true,
                    turn_id: event.turn_id,
                    recalled_memory_ids: recalled,
                })
                : null;
            return context_output('UserPromptSubmit', append_with_budget([
                context?.text ?? '', contract,
            ], token_budget));
        }

        if (event.hook_event_name === 'PreCompact' || event.hook_event_name === 'PostCompact') {
            save_checkpoint(registry, state, event as codex_hook_event);
            // Official Codex wire format does not accept additionalContext for these
            // events. SessionStart(source=compact) performs the actual reinjection.
            return safe_output();
        }

        if (event.hook_event_name === 'Stop') {
            if (!state.bound) return safe_output();
            const stop_state = stop_memory_state(state, event as codex_hook_event);
            if (stop_state !== 'missing') return safe_output();
            if (state.capability_turn_id !== event.turn_id) {
                state = registry.activate_turn(state.session_id, event.turn_id!);
            }
            return { decision: 'block', reason: formal_memory_prompt(state, event.turn_id!) };
        }
        return safe_output();
    } catch (error) {
        registry?.record_failure(event, error);
        return safe_output();
    }
}
