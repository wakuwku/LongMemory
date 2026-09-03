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
 *  file  : src/cli/porter/adapters/codex.ts
 *  usage : implements the LongMemory codex component
 */


import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { derive_session_preview } from '../preview.js';
import { is_directory, is_file, is_readable, walk_files } from '../filesystem.js';
import { find_obvious_credentials } from '../../../core/central_memory/sensitive_content.js';
import {
    build_history_source_snapshot,
    parse_history_source_snapshot,
    type history_snapshot_capture_error,
    type history_source_snapshot,
    type history_source_snapshot_file,
} from '../history_snapshot.js';
import type { harness_capability, import_adapter, portable_session, portable_turn, session_ref, source_reconciliation } from '../types.js';

type json = Record<string, any>;
const codex_root = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
const session_roots = (env: NodeJS.ProcessEnv): string[] => env.LONGMEMORY_CODEX_SESSIONS
    ? [env.LONGMEMORY_CODEX_SESSIONS]
    : [join(codex_root(env), 'sessions'), join(codex_root(env), 'archived_sessions')];
const source_files = (env: NodeJS.ProcessEnv): string[] => session_roots(env)
    .flatMap((root) => walk_files(root, (path) => /\.jsonl$/i.test(path)));
const epoch = (value: unknown): number | undefined => typeof value === 'number' ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const object = (value: unknown): json => value && typeof value === 'object' ? value as json : {};
const text_parts = (content: unknown, type: string): string => Array.isArray(content)
    ? content.flatMap((item) => item?.type === type && typeof item.text === 'string' ? [item.text] : []).join('\n').trim()
    : '';
const message_text_parts = (content: unknown): string => Array.isArray(content)
    ? content.flatMap((item) => ['input_text', 'output_text', 'text'].includes(item?.type) && typeof item.text === 'string'
        ? [item.text]
        : []).join('\n').trim()
    : '';
const skipped_line_detail_limit = 20;

const synthetic_user_blocks = [
    'app-context',
    'skills_instructions',
    'permissions instructions',
    'environment_context',
    'recommended_plugins',
    'apps_instructions',
    'plugins_instructions',
    'collaboration_mode',
    'multi_agent_mode',
] as const;

const regex_escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip_synthetic_user_blocks = (value: string): string => {
    let result = value;
    for (const name of synthetic_user_blocks) {
        result = result.replace(new RegExp(`<${regex_escape(name)}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${regex_escape(name)}>`, 'gi'), '');
    }
    return result.trim();
};

const tool_output_text_limit = 8_192;
const data_uri_pattern = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s]+)*;base64,[a-z0-9+/=_-]+/gi;
const encrypted_json_pattern = /("encrypted_content"\s*:\s*")[^"]*(")/gi;
const encrypted_xml_pattern = /<encrypted_content(?:\s[^>]*)?>[\s\S]*?<\/encrypted_content>/gi;

type attachment_reference = {
    type: string;
    source_line: number;
    block_index: number;
    source_sha256: string;
    media_type?: string;
};
type attachment_parts = { count: number; markers: string[]; references: attachment_reference[] };
type tool_call_ref = { name: string };
type safe_tool_output = { text: string; truncated: boolean; omitted_binary_blocks: number; attachment_blocks: number };
type turn_source = 'response_item' | 'event_msg' | 'agent_message' | 'tool_output';
type captured_turn = { turn: portable_turn; line: number; source: turn_source; identity_text: string };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const data_uri_media_type = (value: string): string | undefined => {
    if (!value.toLowerCase().startsWith('data:')) return undefined;
    const end = value.indexOf(',');
    const header = end >= 0 ? value.slice(5, end) : value.slice(5, 256);
    const media_type = header.split(';', 1)[0];
    return media_type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(media_type) ? media_type : undefined;
};
const message_attachments = (content: unknown, line: number, collect_hashes: boolean): attachment_parts => {
    const result: attachment_parts = { count: 0, markers: [], references: [] };
    if (!Array.isArray(content)) return result;
    content.forEach((block, block_index) => {
        if (!block || typeof block !== 'object' || typeof block.type !== 'string'
            || ['input_text', 'output_text', 'text', 'encrypted_content'].includes(block.type)) return;
        result.count++;
        const safe_type = block.type.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64) || 'unknown';
        if (block.type !== 'input_image' || typeof block.image_url !== 'string') {
            result.markers.push(`[Codex attachment omitted: type=${safe_type}; source_line=${line}; block=${block_index}]`);
            return;
        }
        const media_type = data_uri_media_type(block.image_url);
        if (!collect_hashes) {
            result.markers.push(`[Codex attachment omitted: type=input_image; source_line=${line}; block=${block_index}]`);
            return;
        }
        const reference: attachment_reference = {
            type: 'input_image',
            source_line: line,
            block_index,
            source_sha256: sha256(block.image_url),
            ...(media_type ? { media_type } : {}),
        };
        result.references.push(reference);
        result.markers.push(`[Codex attachment omitted: type=input_image${media_type ? `; media_type=${media_type}` : ''}; source_sha256=${reference.source_sha256}; source_line=${line}; block=${block_index}]`);
    });
    return result;
};

const truncate_tool_output = (value: string): { text: string; truncated: boolean } => {
    if (value.length <= tool_output_text_limit) return { text: value, truncated: false };
    const marker = `\n\n[Codex tool output truncated: original_text_chars=${value.length}; limit=${tool_output_text_limit}; middle_omitted]\n\n`;
    const retained = tool_output_text_limit - marker.length;
    const head = Math.ceil(retained / 2);
    const tail = Math.floor(retained / 2);
    return { text: `${value.slice(0, head)}${marker}${value.slice(-tail)}`, truncated: true };
};
const binary_marker = (line: number, kind: string, block?: number): string =>
    `[Codex tool output ${kind} omitted: source_line=${line}${block === undefined ? '' : `; block=${block}`}]`;
const sanitize_tool_text = (value: string, line: number): { text: string; omitted_binary_blocks: number } => {
    if (value.includes('\0')) return { text: binary_marker(line, 'binary/NUL payload'), omitted_binary_blocks: 1 };
    const compact = value.replace(/\s+/g, '');
    if (compact.length > 4_096 && /^[A-Za-z0-9+/=_-]+$/.test(compact)) {
        return { text: binary_marker(line, 'base64 payload'), omitted_binary_blocks: 1 };
    }
    let omitted_binary_blocks = 0;
    let text = value.replace(data_uri_pattern, () => {
        omitted_binary_blocks++;
        return binary_marker(line, 'data URI');
    });
    text = text.replace(encrypted_json_pattern, (_match, prefix: string, suffix: string) => {
        omitted_binary_blocks++;
        return `${prefix}[encrypted content omitted]${suffix}`;
    });
    text = text.replace(encrypted_xml_pattern, () => {
        omitted_binary_blocks++;
        return binary_marker(line, 'encrypted content');
    });
    return { text: text.trim(), omitted_binary_blocks };
};
const safe_tool_output_text = (output: unknown, line: number): safe_tool_output => {
    const parts: string[] = [];
    let omitted_binary_blocks = 0;
    let attachment_blocks = 0;
    if (typeof output === 'string') {
        const safe = sanitize_tool_text(output, line);
        if (safe.text) parts.push(safe.text);
        omitted_binary_blocks += safe.omitted_binary_blocks;
    } else if (Array.isArray(output)) {
        output.forEach((block, block_index) => {
            if (!block || typeof block !== 'object') return;
            if (block.type === 'input_text' && typeof block.text === 'string') {
                const safe = sanitize_tool_text(block.text, line);
                if (safe.text) parts.push(safe.text);
                omitted_binary_blocks += safe.omitted_binary_blocks;
            } else if (block.type === 'input_image' && typeof block.image_url === 'string') {
                attachment_blocks++;
                omitted_binary_blocks++;
                parts.push(binary_marker(line, 'attachment type=input_image', block_index));
            } else if (block.type === 'encrypted_content') {
                omitted_binary_blocks++;
                parts.push(binary_marker(line, 'encrypted content', block_index));
            }
        });
    }
    const truncated = truncate_tool_output(parts.join('\n\n').trim());
    return { ...truncated, omitted_binary_blocks, attachment_blocks };
};

type parse_state = {
    turns: captured_turn[];
    skipped_lines: Array<{ line: number; reason: string }>;
    skipped_line_count: number;
    meta: json;
    cwd: string;
    dropped_turns: number;
    portable_turn_count: number;
    message_turns: number;
    event_turns: number;
    agent_message_turns: number;
    duplicate_turns: number;
    attachment_count: number;
    attachment_references: attachment_reference[];
    system_message_count: number;
    current_model: string;
    models: Set<string>;
    assistant_phases: Record<string, number>;
    task_events: Record<string, number>;
    last_task_event: string;
    unknown_response_items: Record<string, number>;
    tool_calls: Map<string, tool_call_ref>;
    tool_output_turns: number;
    truncated_tool_outputs: number;
    unlinked_tool_outputs: number;
    omitted_binary_tool_output_blocks: number;
    omitted_tool_output_attachment_blocks: number;
    source_digest: string;
    capture_turns: boolean;
    collect_attachment_hashes: boolean;
};

const create_state = (capture_turns = true, collect_attachment_hashes = capture_turns): parse_state => ({
    turns: [], skipped_lines: [], skipped_line_count: 0, meta: {}, cwd: '', dropped_turns: 0,
    portable_turn_count: 0, message_turns: 0, event_turns: 0, agent_message_turns: 0,
    duplicate_turns: 0, attachment_count: 0, system_message_count: 0, current_model: '',
    models: new Set<string>(), assistant_phases: {}, task_events: {}, last_task_event: '',
    unknown_response_items: {}, attachment_references: [], tool_calls: new Map<string, tool_call_ref>(),
    tool_output_turns: 0, truncated_tool_outputs: 0, unlinked_tool_outputs: 0,
    omitted_binary_tool_output_blocks: 0, omitted_tool_output_attachment_blocks: 0,
    source_digest: '',
    capture_turns, collect_attachment_hashes,
});

const source_priority: Record<turn_source, number> = { event_msg: 1, agent_message: 2, response_item: 3, tool_output: 4 };
const duplicate_line_window = 12;
const duplicate_time_window_ms = 15_000;
const normalized_turn_text = (value: string): string => value.replace(/\s+/g, ' ').trim();
const nearby_duplicate = (existing: captured_turn, turn: portable_turn, identity_text: string, line: number, source: turn_source): boolean => {
    const mixed_message_sources = (existing.source === 'response_item' && source === 'event_msg')
        || (existing.source === 'event_msg' && source === 'response_item');
    if (!mixed_message_sources || existing.turn.role !== turn.role) return false;
    if (normalized_turn_text(existing.identity_text) !== normalized_turn_text(identity_text)) return false;
    if (Math.abs(existing.line - line) > duplicate_line_window) return false;
    if (existing.turn.timestamp !== undefined && turn.timestamp !== undefined
        && Math.abs(existing.turn.timestamp - turn.timestamp) > duplicate_time_window_ms) return false;
    return true;
};

const add_turn = (state: parse_state, turn: portable_turn, line: number, source: turn_source, identity_text = turn.text): void => {
    state.portable_turn_count++;
    if (!state.capture_turns) return;
    const index = state.turns.length - 1;
    const existing = state.turns[index];
    if (existing && nearby_duplicate(existing, turn, identity_text, line, source)) {
        state.duplicate_turns++;
        if (source_priority[source] > source_priority[existing.source]) {
            state.turns[index] = { turn: { ...existing.turn, ...turn }, line: Math.min(existing.line, line), source, identity_text };
        }
        return;
    }
    state.turns.push({ turn, line, source, identity_text });
};

const increment = (target: Record<string, number>, key: string): void => {
    target[key] = (target[key] ?? 0) + 1;
};

const payload_call_id = (payload: json): string => typeof payload.call_id === 'string' ? payload.call_id : '';
const has_portable_tool_output = (output: unknown): boolean => typeof output === 'string'
    ? Boolean(output.trim())
    : Array.isArray(output) && output.some((block) => block && typeof block === 'object'
        && ((block.type === 'input_text' && typeof block.text === 'string' && Boolean(block.text.trim()))
            || (block.type === 'input_image' && typeof block.image_url === 'string')
            || block.type === 'encrypted_content'));
const capture_tool_output = (state: parse_state, payload: json, timestamp: unknown, line: number): void => {
    const call_id = payload_call_id(payload);
    const call = call_id ? state.tool_calls.get(call_id) : undefined;
    if (!call_id || !call) {
        state.unlinked_tool_outputs++;
        state.dropped_turns++;
        return;
    }
    state.tool_calls.delete(call_id);
    if (!has_portable_tool_output(payload.output)) {
        state.dropped_turns++;
        return;
    }
    if (!state.capture_turns) {
        state.tool_output_turns++;
        add_turn(state, { role: 'tool', name: call.name, tool_call_id: call_id, text: '' }, line, 'tool_output');
        return;
    }
    const output = safe_tool_output_text(payload.output, line);
    if (!output.text) {
        state.dropped_turns++;
        return;
    }
    state.tool_output_turns++;
    if (output.truncated) state.truncated_tool_outputs++;
    state.omitted_binary_tool_output_blocks += output.omitted_binary_blocks;
    state.omitted_tool_output_attachment_blocks += output.attachment_blocks;
    add_turn(state, {
        role: 'tool',
        name: call.name,
        tool_call_id: call_id,
        text: output.text,
        timestamp: epoch(timestamp),
    }, line, 'tool_output');
};

const apply_line = (state: parse_state, line: string, line_number: number): void => {
    if (!line.trim()) return;
    let record: json;
    try { record = JSON.parse(line) as json; }
    catch (error) {
        state.skipped_line_count++;
        if (state.skipped_lines.length < skipped_line_detail_limit) state.skipped_lines.push({ line: line_number, reason: error instanceof Error ? error.message : String(error) });
        return;
    }
    const payload = object(record.payload);
    if (record.type === 'session_meta' && !Object.keys(state.meta).length) state.meta = payload;
    if (record.type === 'turn_context') {
        if (typeof payload.cwd === 'string') state.cwd ||= payload.cwd;
        if (typeof payload.model === 'string') {
            state.current_model = payload.model;
            state.models.add(payload.model);
        }
    }
    if (record.type === 'event_msg' && typeof payload.type === 'string'
        && (payload.type.startsWith('task_') || payload.type.startsWith('turn_'))) {
        increment(state.task_events, payload.type);
        state.last_task_event = payload.type;
    }
    if (record.type === 'response_item') {
        if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
            const attachments = message_attachments(payload.content, line_number, state.collect_attachment_hashes);
            state.attachment_count += attachments.count;
            state.attachment_references.push(...attachments.references);
            const raw_text = text_parts(payload.content, payload.role === 'user' ? 'input_text' : 'output_text');
            const message_text = payload.role === 'user' ? strip_synthetic_user_blocks(raw_text) : raw_text;
            const text = [message_text, ...attachments.markers].filter(Boolean).join('\n\n');
            if (text) {
                state.message_turns++;
                const model = payload.role === 'assistant'
                    ? (typeof payload.model === 'string' ? payload.model : state.current_model)
                    : '';
                if (model) state.models.add(model);
                if (payload.role === 'assistant' && typeof payload.phase === 'string') {
                    increment(state.assistant_phases, payload.phase);
                }
                add_turn(state, {
                    role: payload.role,
                    text,
                    timestamp: epoch(record.timestamp),
                    ...(model ? { model } : {}),
                    ...(payload.role === 'assistant' && typeof payload.phase === 'string'
                        ? { name: `codex_${payload.phase}` }
                        : {}),
                }, line_number, 'response_item', message_text || text);
            }
        } else if (payload.type === 'agent_message') {
            const text = message_text_parts(payload.content)
                || (typeof payload.message === 'string' ? payload.message.trim() : '');
            if (text) {
                state.agent_message_turns++;
                add_turn(state, {
                    role: 'tool',
                    name: 'codex_agent_message',
                    text,
                    timestamp: epoch(record.timestamp),
                }, line_number, 'agent_message');
            }
        } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            const call_id = payload_call_id(payload);
            if (call_id && typeof payload.name === 'string' && payload.name) {
                state.tool_calls.set(call_id, { name: payload.name });
            }
            state.dropped_turns++;
        } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            capture_tool_output(state, payload, record.timestamp, line_number);
        } else if (payload.type === 'reasoning') {
            state.dropped_turns++;
        } else if (payload.type === 'message') {
            state.system_message_count++;
        } else if (typeof payload.type === 'string') {
            increment(state.unknown_response_items, payload.type);
        }
    }
    if (record.type === 'event_msg' && typeof payload.message === 'string') {
        const raw_text = payload.message.trim();
        const text = payload.type === 'user_message' ? strip_synthetic_user_blocks(raw_text) : raw_text;
        if (text && ['user_message', 'agent_message'].includes(payload.type)) {
            state.event_turns++;
            add_turn(state, {
                role: payload.type === 'user_message' ? 'user' : 'assistant',
                text,
                timestamp: epoch(record.timestamp),
                ...(payload.type === 'agent_message' && state.current_model ? { model: state.current_model } : {}),
            }, line_number, 'event_msg');
        }
    }
};

const id_from_path = (path: string): string => basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]
    ?? basename(path).replace(/\.jsonl$/i, '');

const source_session_id = (path: string, state: parse_state): string => typeof state.meta.id === 'string'
    ? state.meta.id
    : typeof state.meta.session_id === 'string'
        ? state.meta.session_id
        : id_from_path(path);

const thread_source = (state: parse_state): string => typeof state.meta.thread_source === 'string'
    ? state.meta.thread_source
    : 'unknown';
const excluded_reason = (state: parse_state): string | null => thread_source(state) === 'guardian_review'
    ? 'guardian_review_parent_history_duplicate'
    : null;

const has_portable_turns = (state: parse_state): boolean => state.portable_turn_count > 0;
const malformed_error = (state: parse_state): string | null => {
    if (has_portable_turns(state) || !state.skipped_lines.length) return null;
    const first = state.skipped_lines[0] as { line: number; reason: string };
    return `invalid JSON at line ${first.line}: ${first.reason}`;
};

const finish_session = (path: string, state: parse_state): portable_session => {
    const selected = state.turns.map((entry) => entry.turn);
    const session_id = source_session_id(path, state);
    state.cwd ||= typeof state.meta.cwd === 'string' ? state.meta.cwd : '';
    const source = object(state.meta.source);
    const subagent = object(source.subagent);
    const thread_spawn = object(subagent.thread_spawn);
    const session_thread_source = thread_source(state);
    return {
        schema_version: '1.0.0', source_harness: 'codex', source_session_id: session_id, source_path: path, cwd: state.cwd,
        title: derive_session_preview(selected.filter((turn) => turn.role === 'user').map((turn) => turn.text)) || session_id,
        created_at: epoch(state.meta.timestamp) ?? selected.find((turn) => turn.timestamp !== undefined)?.timestamp,
        updated_at: [...selected].reverse().find((turn) => turn.timestamp !== undefined)?.timestamp,
        turns: selected,
        dropped_turns: state.dropped_turns,
        source_metadata: {
            cli_version: state.meta.cli_version,
            model_provider: state.meta.model_provider,
            parent_session_id: typeof state.meta.session_id === 'string' && state.meta.session_id !== session_id
                ? state.meta.session_id
                : undefined,
            forked_from_id: state.meta.forked_from_id,
            originator: state.meta.originator,
            source: state.meta.source,
            thread_source: session_thread_source,
            task_type: session_thread_source,
            parent_thread_id: typeof state.meta.parent_thread_id === 'string'
                ? state.meta.parent_thread_id
                : typeof thread_spawn.parent_thread_id === 'string'
                    ? thread_spawn.parent_thread_id
                    : state.meta.forked_from_id,
            agent_path: thread_spawn.agent_path,
            history_mode: state.meta.history_mode,
            models: [...state.models],
            assistant_phases: state.assistant_phases,
            task_events: state.task_events,
            last_task_event: state.last_task_event || undefined,
            response_message_turns: state.message_turns,
            event_message_turns: state.event_turns,
            agent_message_turns: state.agent_message_turns,
            tool_output_turns: state.tool_output_turns,
            truncated_tool_outputs: state.truncated_tool_outputs,
            unlinked_tool_outputs_omitted: state.unlinked_tool_outputs,
            binary_tool_output_blocks_omitted: state.omitted_binary_tool_output_blocks,
            tool_output_attachment_blocks_omitted: state.omitted_tool_output_attachment_blocks,
            duplicate_turns_removed: state.duplicate_turns,
            attachment_blocks: state.attachment_count,
            attachment_references: state.attachment_references,
            system_messages_omitted: state.system_message_count,
            unknown_response_items: state.unknown_response_items,
            skipped_lines: state.skipped_lines,
            skipped_line_count: state.skipped_line_count,
        },
    };
};

const scan_file = async (path: string, capture_turns: boolean, cutoff_bytes?: number): Promise<parse_state> => {
    const state = create_state(capture_turns);
    const digest = createHash('sha256');
    if (cutoff_bytes === 0) {
        state.source_digest = digest.digest('hex');
        return state;
    }
    const input = createReadStream(path, cutoff_bytes === undefined ? {} : { start: 0, end: cutoff_bytes - 1 });
    let bytes_read = 0;
    input.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes_read += bytes.length;
        digest.update(bytes);
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let line_number = 0;
    for await (const line of lines) {
        apply_line(state, line, ++line_number);
    }
    if (cutoff_bytes !== undefined && bytes_read !== cutoff_bytes) {
        throw new Error(`source was truncated while reading its frozen ${cutoff_bytes}-byte prefix`);
    }
    state.source_digest = digest.digest('hex');
    return state;
};

const parse_file = async (path: string): Promise<portable_session> => {
    const state = await scan_file(path, true);
    const malformed = malformed_error(state);
    if (malformed) throw new Error(malformed);
    return finish_session(path, state);
};

export const reconcile_codex_sessions = async (env: NodeJS.ProcessEnv = process.env): Promise<source_reconciliation> => {
    const paths = source_files(env);
    const empty: source_reconciliation['empty'] = [];
    const failures: source_reconciliation['failures'] = [];
    const excluded: source_reconciliation['excluded'] = [];
    const partial: source_reconciliation['partial'] = [];
    const seen = new Map<string, string>();
    let importable_tasks = 0;
    for (const path of paths) {
        try {
            const state = await scan_file(path, false);
            const source_session = source_session_id(path, state);
            const reason = excluded_reason(state);
            if (reason) {
                excluded.push({ source_session_id: source_session, source_path: path, reason });
                continue;
            }
            const prior_digest = seen.get(source_session);
            if (prior_digest !== undefined) {
                if (prior_digest === state.source_digest) {
                    excluded.push({ source_session_id: source_session, source_path: path, reason: 'duplicate_source_session_id' });
                } else {
                    failures.push({
                        source_session_id: source_session,
                        source_path: path,
                        error: 'duplicate source session id has divergent file content',
                    });
                }
                continue;
            }
            seen.set(source_session, state.source_digest);
            const malformed = malformed_error(state);
            if (has_portable_turns(state)) {
                importable_tasks++;
                if (state.skipped_line_count > 0) {
                    partial.push({
                        source_session_id: source_session,
                        source_path: path,
                        skipped_line_count: state.skipped_line_count,
                    });
                }
            }
            else if (malformed) failures.push({ source_session_id: source_session, source_path: path, error: malformed });
            else empty.push({ source_session_id: source_session, source_path: path });
        } catch (error) {
            failures.push({ source_session_id: id_from_path(path), source_path: path, error: error instanceof Error ? error.message : String(error) });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return {
        source_files: paths.length,
        importable_tasks,
        empty_tasks: empty.length,
        parse_failures: failures.length,
        excluded_tasks: excluded.length,
        partial_tasks: partial.length,
        empty,
        failures,
        excluded,
        partial,
    };
};

const cutoff_read_bytes = 64 * 1024;

/**
 * Treat only newline-terminated JSONL records as committed. Codex may be
 * appending the next record while an inventory starts; excluding that trailing
 * fragment makes the captured prefix deterministic without pausing Codex.
 */
const committed_jsonl_cutoff = (path: string): number => {
    const size = statSync(path).size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('source size is not a non-negative safe integer');
    if (size === 0) return 0;
    const descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(cutoff_read_bytes, size));
    try {
        let cursor = size;
        let newline_end = 0;
        while (cursor > 0) {
            const start = Math.max(0, cursor - buffer.length);
            const requested = cursor - start;
            const bytes_read = readSync(descriptor, buffer, 0, requested, start);
            if (bytes_read <= 0) throw new Error('source became unreadable while locating its committed JSONL prefix');
            const newline = buffer.lastIndexOf(0x0a, bytes_read - 1);
            if (newline >= 0) {
                newline_end = start + newline + 1;
                break;
            }
            cursor = start;
        }
        if (newline_end === size) return size;

        // A closed/static JSONL file is allowed to omit its final LF. Include
        // that tail only when it is both valid UTF-8 and one complete JSON
        // record; otherwise freeze at the preceding LF.
        const trailing_bytes = size - newline_end;
        const trailing = Buffer.allocUnsafe(trailing_bytes);
        const bytes_read = readSync(descriptor, trailing, 0, trailing.length, newline_end);
        if (bytes_read !== trailing.length) return newline_end;
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(trailing);
            JSON.parse(text);
            return size;
        } catch {
            return newline_end;
        }
    } finally {
        closeSync(descriptor);
    }
};

type frozen_codex_source = {
    source_path: string;
    cutoff_bytes: number | null;
    prefix_sha256: string | null;
    state?: parse_state;
    capture_error?: history_snapshot_capture_error;
};

type classified_frozen_sources = {
    reconciliation: source_reconciliation;
    sessions: portable_session[];
    discovered_source_session_ids: string[];
};

const classify_frozen_sources = (values: frozen_codex_source[]): classified_frozen_sources => {
    const empty: source_reconciliation['empty'] = [];
    const failures: source_reconciliation['failures'] = [];
    const excluded: source_reconciliation['excluded'] = [];
    const partial: source_reconciliation['partial'] = [];
    const sessions: portable_session[] = [];
    const discovered_source_session_ids: string[] = [];
    const seen = new Map<string, string>();
    let importable_tasks = 0;
    for (const value of values) {
        if (!value.state) {
            failures.push({
                source_session_id: id_from_path(value.source_path),
                source_path: value.source_path,
                error: value.capture_error ?? 'source snapshot capture failed',
            });
            continue;
        }
        const state = value.state;
        const source_session = source_session_id(value.source_path, state);
        const reason = excluded_reason(state);
        if (reason) {
            excluded.push({ source_session_id: source_session, source_path: value.source_path, reason });
            continue;
        }
        const prior_digest = seen.get(source_session);
        if (prior_digest !== undefined) {
            if (prior_digest === state.source_digest) {
                excluded.push({ source_session_id: source_session, source_path: value.source_path, reason: 'duplicate_source_session_id' });
            } else {
                failures.push({
                    source_session_id: source_session,
                    source_path: value.source_path,
                    error: 'duplicate source session id has divergent file content',
                });
            }
            continue;
        }
        seen.set(source_session, state.source_digest);
        discovered_source_session_ids.push(source_session);
        const malformed = malformed_error(state);
        if (has_portable_turns(state)) {
            importable_tasks++;
            if (state.skipped_line_count > 0) {
                partial.push({
                    source_session_id: source_session,
                    source_path: value.source_path,
                    skipped_line_count: state.skipped_line_count,
                });
            }
            sessions.push(finish_session(value.source_path, state));
        } else if (malformed) {
            failures.push({ source_session_id: source_session, source_path: value.source_path, error: malformed });
        } else {
            empty.push({ source_session_id: source_session, source_path: value.source_path });
        }
    }
    return {
        reconciliation: {
            source_files: values.length,
            importable_tasks,
            empty_tasks: empty.length,
            parse_failures: failures.length,
            excluded_tasks: excluded.length,
            partial_tasks: partial.length,
            empty,
            failures,
            excluded,
            partial,
        },
        sessions,
        discovered_source_session_ids,
    };
};

export type codex_history_snapshot_load = classified_frozen_sources & {
    source_snapshot: history_source_snapshot;
    deferred_source_files: number;
};

/** Capture every path first, then parse only each file's committed prefix. */
export const capture_codex_history_snapshot = async (
    env: NodeJS.ProcessEnv = process.env,
): Promise<codex_history_snapshot_load> => {
    const discovered_paths = source_files(env);
    const unsafe_path = find_obvious_credentials({ codex_history_source_paths: discovered_paths })[0];
    if (unsafe_path) {
        throw new Error(`Codex history source locator contains prohibited credential material (${unsafe_path.kind})`);
    }
    const frozen: frozen_codex_source[] = discovered_paths.map((source_path) => {
        try {
            return { source_path, cutoff_bytes: committed_jsonl_cutoff(source_path), prefix_sha256: null };
        } catch {
            return {
                source_path,
                cutoff_bytes: null,
                prefix_sha256: null,
                capture_error: 'source_cutoff_failed',
            };
        }
    });
    for (const value of frozen) {
        if (value.capture_error || value.cutoff_bytes === null) continue;
        try {
            value.state = await scan_file(value.source_path, true, value.cutoff_bytes);
            value.prefix_sha256 = value.state.source_digest;
        } catch {
            value.cutoff_bytes = null;
            value.prefix_sha256 = null;
            value.capture_error = 'source_scan_failed';
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const source_snapshot = build_history_source_snapshot(frozen.map((value): history_source_snapshot_file => ({
        source_session_id: value.state ? source_session_id(value.source_path, value.state) : id_from_path(value.source_path),
        source_path: value.source_path,
        cutoff_bytes: value.cutoff_bytes,
        prefix_sha256: value.prefix_sha256,
        ...(value.capture_error ? { capture_error: value.capture_error } : {}),
    })));
    return { ...classify_frozen_sources(frozen), source_snapshot, deferred_source_files: 0 };
};

const verify_frozen_source = async (
    descriptor: history_source_snapshot_file,
    actual_path: string,
): Promise<parse_state> => {
    if (descriptor.cutoff_bytes === null || descriptor.prefix_sha256 === null) {
        throw new Error(`frozen source ${descriptor.source_path} has no verified prefix`);
    }
    const current_size = statSync(actual_path).size;
    if (current_size < descriptor.cutoff_bytes) {
        throw new Error(`frozen source ${descriptor.source_path} was truncated below its approved ${descriptor.cutoff_bytes}-byte cutoff`);
    }
    const state = await scan_file(actual_path, true, descriptor.cutoff_bytes);
    if (state.source_digest !== descriptor.prefix_sha256) {
        throw new Error(`frozen source ${descriptor.source_path} changed before its approved cutoff`);
    }
    const actual_session_id = source_session_id(descriptor.source_path, state);
    if (actual_session_id !== descriptor.source_session_id) {
        throw new Error(`frozen source ${descriptor.source_path} no longer identifies session ${descriptor.source_session_id}`);
    }
    return state;
};

/**
 * Reopen exactly the approved source prefixes. Later records and newly-created
 * files are deliberately deferred; an approved prefix changing or disappearing
 * fails closed. A session moved from active to archived storage is accepted
 * only when its basename and exact prefix hash still match.
 */
export const load_codex_history_snapshot = async (
    raw_snapshot: history_source_snapshot,
    env: NodeJS.ProcessEnv = process.env,
): Promise<codex_history_snapshot_load> => {
    const source_snapshot = parse_history_source_snapshot(raw_snapshot);
    const available_paths = source_files(env);
    const unsafe_path = find_obvious_credentials({ codex_history_source_paths: available_paths })[0];
    if (unsafe_path) {
        throw new Error(`Codex history source locator contains prohibited credential material (${unsafe_path.kind})`);
    }
    const available_path_set = new Set(available_paths);
    const by_basename = new Map<string, string[]>();
    for (const path of available_paths) {
        const key = basename(path).toLocaleLowerCase('en-US');
        by_basename.set(key, [...(by_basename.get(key) ?? []), path]);
    }
    const used_paths = new Set<string>();
    const frozen: frozen_codex_source[] = [];
    for (const descriptor of source_snapshot.files) {
        if (descriptor.capture_error) {
            if (available_path_set.has(descriptor.source_path) && is_file(descriptor.source_path)) {
                used_paths.add(descriptor.source_path);
            }
            frozen.push({
                source_path: descriptor.source_path,
                cutoff_bytes: null,
                prefix_sha256: null,
                capture_error: descriptor.capture_error,
            });
            continue;
        }
        if (available_path_set.has(descriptor.source_path) && is_file(descriptor.source_path)) {
            const state = await verify_frozen_source(descriptor, descriptor.source_path);
            used_paths.add(descriptor.source_path);
            frozen.push({
                source_path: descriptor.source_path,
                cutoff_bytes: descriptor.cutoff_bytes,
                prefix_sha256: descriptor.prefix_sha256,
                state,
            });
            continue;
        }
        let relocated: { path: string; state: parse_state } | undefined;
        for (const candidate of by_basename.get(basename(descriptor.source_path).toLocaleLowerCase('en-US')) ?? []) {
            if (used_paths.has(candidate)) continue;
            try {
                relocated = { path: candidate, state: await verify_frozen_source(descriptor, candidate) };
                break;
            } catch { /* Keep looking for the exact approved prefix. */ }
        }
        if (!relocated) throw new Error(`frozen source ${descriptor.source_path} is missing and no exact archived relocation was found`);
        used_paths.add(relocated.path);
        frozen.push({
            source_path: descriptor.source_path,
            cutoff_bytes: descriptor.cutoff_bytes,
            prefix_sha256: descriptor.prefix_sha256,
            state: relocated.state,
        });
    }
    return {
        ...classify_frozen_sources(frozen),
        source_snapshot,
        deferred_source_files: available_paths.filter((path) => !used_paths.has(path)).length,
    };
};

const discovery_bytes = 1024 * 1024;
const inspect_file = (path: string): session_ref => {
    const descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(discovery_bytes);
    let bytes_read = 0;
    try { bytes_read = readSync(descriptor, buffer, 0, buffer.length, 0); }
    finally { closeSync(descriptor); }
    const text = buffer.subarray(0, bytes_read).toString('utf8');
    const last_newline = text.lastIndexOf('\n');
    const complete_text = bytes_read === discovery_bytes && last_newline >= 0 ? text.slice(0, last_newline) : text;
    const state = create_state(true, false);
    complete_text.split(/\r?\n/).forEach((line, index) => apply_line(state, line, index + 1));
    const session = finish_session(path, state);
    return {
        harness: 'codex',
        source_session_id: session.source_session_id,
        source_path: path,
        title: session.title,
        cwd: session.cwd,
        updated_at: statSync(path).mtimeMs,
        source_kind: thread_source(state),
        ...(excluded_reason(state) ? { excluded_reason: excluded_reason(state) as string } : {}),
    };
};

export const codex_adapter: import_adapter = {
    harness: 'codex',
    detect(env = process.env): harness_capability {
        const roots = session_roots(env);
        const readable_roots = roots.filter((root) => is_directory(root) && is_readable(root));
        const can_import = readable_roots.length > 0;
        return {
            harness: 'codex',
            installed: can_import || is_directory(codex_root(env)),
            can_import,
            source_path: can_import ? (env.LONGMEMORY_CODEX_SESSIONS ?? codex_root(env)) : null,
            note: can_import ? null : 'Codex sessions and archived sessions directories were not found or are not readable',
        };
    },
    discover(env = process.env): session_ref[] {
        const discovered: session_ref[] = [];
        const seen = new Set<string>();
        for (const path of source_files(env)) {
            try {
                const session = inspect_file(path);
                if (session.excluded_reason || seen.has(session.source_session_id)) continue;
                seen.add(session.source_session_id);
                discovered.push(session);
            } catch { /* Reconciliation reports unreadable files. */ }
        }
        return discovered.sort((left, right) => (right.updated_at ?? 0) - (left.updated_at ?? 0));
    },
    parse(ref): Promise<portable_session> { return parse_file(ref.source_path); },
    reconcile(env = process.env): Promise<source_reconciliation> { return reconcile_codex_sessions(env); },
};
