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
 *  file  : src/cli/porter/adapters/codex.test.ts
 *  usage : tests the LongMemory codex component
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verify_sessions } from '../orchestrator.js';
import { capture_codex_history_snapshot, codex_adapter, reconcile_codex_sessions } from './codex.js';

const write_session = (path: string, id: string, parent_session_id: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const records = [
        {
            type: 'session_meta',
            timestamp: '2026-09-01T00:00:00.000Z',
            payload: {
                id,
                session_id: parent_session_id,
                cwd: 'C:\\work',
                originator: 'Codex Desktop',
                model_provider: 'openai',
            },
        },
        {
            type: 'response_item',
            timestamp: '2026-09-01T00:00:01.000Z',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `Task for ${id}` }],
            },
        },
        {
            type: 'response_item',
            timestamp: '2026-09-01T00:00:02.000Z',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: `Result for ${id}` }],
            },
        },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
};

const write_records = (path: string, records: unknown[], extra_lines: string[] = []): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${[...records.map((record) => JSON.stringify(record)), ...extra_lines].join('\n')}\n`, 'utf8');
};

test('discovers active and archived Codex sessions without collapsing child threads', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const parent_session_id = 'parent-session';
    write_session(join(root, 'sessions', '2026', 'active.jsonl'), 'thread-active', parent_session_id);
    write_session(join(root, 'archived_sessions', 'archived.jsonl'), 'thread-archived', parent_session_id);

    const refs = await codex_adapter.discover({ CODEX_HOME: root });

    assert.deepEqual(refs.map((ref) => ref.source_session_id).sort(), ['thread-active', 'thread-archived']);
    const parsed = await Promise.all(refs.map((ref) => codex_adapter.parse(ref)));
    assert.deepEqual(parsed.map((session) => session.source_metadata.parent_session_id), [parent_session_id, parent_session_id]);
});

test('keeps LONGMEMORY_CODEX_SESSIONS as an exact single-root override', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-override-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const selected = join(root, 'selected');
    write_session(join(selected, 'selected.jsonl'), 'selected-thread', 'selected-thread');
    write_session(join(root, 'archived_sessions', 'ignored.jsonl'), 'ignored-thread', 'ignored-thread');

    const refs = await codex_adapter.discover({ LONGMEMORY_CODEX_SESSIONS: selected });

    assert.deepEqual(refs.map((ref) => ref.source_session_id), ['selected-thread']);
});

test('snapshot includes a complete final JSONL record even when the file has no trailing newline', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-no-final-lf-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'no-final-lf.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
        JSON.stringify({ type: 'session_meta', payload: { id: 'no-final-lf' } }),
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'complete' }] },
        }),
    ].join('\n'), 'utf8');

    const captured = await capture_codex_history_snapshot({ CODEX_HOME: root });

    assert.equal(captured.reconciliation.importable_tasks, 1);
    assert.equal(captured.sessions[0]?.turns[0]?.text, 'complete');
    assert.equal(captured.source_snapshot.files[0]?.cutoff_bytes, statSync(path).size);
});

test('snapshot capture rejects credential-bearing source paths before persisting locators', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-locator-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const secret = 'ActualPassword123';
    const unsafe_root = join(root, `password=${secret}`);
    write_session(join(unsafe_root, 'history.jsonl'), 'unsafe-locator', 'unsafe-locator');

    let failure: Error | undefined;
    try {
        await capture_codex_history_snapshot({ LONGMEMORY_CODEX_SESSIONS: unsafe_root });
    } catch (error) { failure = error as Error; }
    assert.ok(failure);
    assert.match(failure.message, /source locator contains prohibited credential material/i);
    assert.doesNotMatch(failure.message, new RegExp(secret));
});

test('reconciliation reports a valid JSONL task without portable turns as empty', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-empty-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'empty.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'empty-thread' } })}\n`, 'utf8');

    const result = await reconcile_codex_sessions({ CODEX_HOME: root });

    assert.deepEqual({
        source_files: result.source_files,
        importable_tasks: result.importable_tasks,
        empty_tasks: result.empty_tasks,
        parse_failures: result.parse_failures,
    }, { source_files: 1, importable_tasks: 0, empty_tasks: 1, parse_failures: 0 });
    assert.deepEqual(result.empty.map((entry) => entry.source_session_id), ['empty-thread']);
});

test('reconciliation reports malformed JSONL without portable turns as a parse failure', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-malformed-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'malformed.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not-json}\n', 'utf8');

    const result = await reconcile_codex_sessions({ CODEX_HOME: root });
    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];

    assert.deepEqual({
        source_files: result.source_files,
        importable_tasks: result.importable_tasks,
        empty_tasks: result.empty_tasks,
        parse_failures: result.parse_failures,
    }, { source_files: 1, importable_tasks: 0, empty_tasks: 0, parse_failures: 1 });
    assert.match(result.failures[0]?.error ?? '', /invalid JSON at line 1/i);
    assert.ok(ref);
    await assert.rejects(async () => codex_adapter.parse(ref), /invalid JSON at line 1/i);
});

test('excludes guardian review parent-history copies from reconciliation and discovery', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-guardian-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'guardian.jsonl');
    write_records(path, [
        {
            type: 'session_meta',
            payload: {
                id: 'guardian-file-id',
                session_id: 'parent-id',
                parent_thread_id: 'parent-id',
                source: { subagent: { other: 'guardian' } },
                thread_source: 'guardian_review',
            },
        },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicated parent task' }] },
        },
    ]);

    const reconciliation = await reconcile_codex_sessions({ CODEX_HOME: root });
    const refs = await codex_adapter.discover({ CODEX_HOME: root });

    assert.equal(reconciliation.source_files, 1);
    assert.equal(reconciliation.importable_tasks, 0);
    assert.equal(reconciliation.excluded_tasks, 1);
    assert.deepEqual(reconciliation.excluded, [{
        source_session_id: 'guardian-file-id',
        source_path: path,
        reason: 'guardian_review_parent_history_duplicate',
    }]);
    assert.deepEqual(refs, []);
});

test('keeps the first stable source path and excludes later duplicate source session ids', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-duplicate-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const first = join(root, 'sessions', 'a-first.jsonl');
    const second = join(root, 'sessions', 'z-second.jsonl');
    write_session(first, 'same-thread', 'same-thread');
    write_session(second, 'same-thread', 'same-thread');

    const reconciliation = await reconcile_codex_sessions({ CODEX_HOME: root });
    const refs = await codex_adapter.discover({ CODEX_HOME: root });

    assert.equal(reconciliation.source_files, 2);
    assert.equal(reconciliation.importable_tasks, 1);
    assert.equal(reconciliation.excluded_tasks, 1);
    assert.equal(
        reconciliation.source_files,
        reconciliation.importable_tasks + reconciliation.empty_tasks
            + reconciliation.parse_failures + reconciliation.excluded_tasks,
    );
    assert.deepEqual(reconciliation.excluded, [{
        source_session_id: 'same-thread',
        source_path: second,
        reason: 'duplicate_source_session_id',
    }]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.source_path, first);
});

test('reconciliation blocks duplicate source ids when their file contents diverge', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-divergent-duplicate-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const first = join(root, 'sessions', 'a-first.jsonl');
    const second = join(root, 'sessions', 'z-second.jsonl');
    write_session(first, 'same-thread', 'same-thread');
    write_records(second, [
        { type: 'session_meta', payload: { id: 'same-thread', session_id: 'same-thread' } },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Different task content.' }] },
        },
    ]);

    const reconciliation = await reconcile_codex_sessions({ CODEX_HOME: root });

    assert.equal(reconciliation.importable_tasks, 1);
    assert.equal(reconciliation.excluded_tasks, 0);
    assert.equal(reconciliation.parse_failures, 1);
    assert.equal(reconciliation.failures[0]?.source_path, second);
    assert.match(reconciliation.failures[0]?.error ?? '', /duplicate source session id has divergent file content/i);
});

test('keeps importable files with malformed lines and reports them as partial', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-partial-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'partial.jsonl');
    write_records(path, [
        { type: 'session_meta', payload: { id: 'partial-thread' } },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'usable turn' }] },
        },
    ], ['{not-json}']);

    const reconciliation = await reconcile_codex_sessions({ CODEX_HOME: root });
    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.equal(reconciliation.importable_tasks, 1);
    assert.equal(reconciliation.parse_failures, 0);
    assert.equal(reconciliation.partial_tasks, 1);
    assert.deepEqual(reconciliation.partial, [{
        source_session_id: 'partial-thread',
        source_path: path,
        skipped_line_count: 1,
    }]);
    assert.equal(session.turns.length, 1);
    assert.equal(session.source_metadata.skipped_line_count, 1);
});

test('deduplicates nearby mixed-format messages and keeps richer response item fields', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-dedupe-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'dedupe.jsonl');
    write_records(path, [
        { type: 'session_meta', payload: { id: 'dedupe-thread' } },
        { type: 'turn_context', payload: { model: 'context-model' } },
        {
            type: 'response_item', timestamp: '2026-09-01T00:00:01.000Z',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello\nworld' }] },
        },
        {
            type: 'event_msg', timestamp: '2026-09-01T00:00:01.400Z',
            payload: { type: 'user_message', message: 'Hello world' },
        },
        {
            type: 'event_msg', timestamp: '2026-09-01T00:00:02.000Z',
            payload: { type: 'agent_message', message: 'Same answer' },
        },
        {
            type: 'response_item', timestamp: '2026-09-01T00:00:02.500Z',
            payload: {
                type: 'message', role: 'assistant', model: 'richer-model', phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Same answer' }],
            },
        },
        {
            type: 'response_item', timestamp: '2026-09-01T00:01:02.500Z',
            payload: {
                type: 'message', role: 'assistant', model: 'later-model', phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Same answer' }],
            },
        },
        {
            type: 'response_item', timestamp: '2026-09-01T00:01:03.000Z',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Repeated request' }] },
        },
        {
            type: 'response_item', timestamp: '2026-09-01T00:01:04.000Z',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Intervening answer' }] },
        },
        {
            type: 'event_msg', timestamp: '2026-09-01T00:01:05.000Z',
            payload: { type: 'user_message', message: 'Repeated request' },
        },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.equal(session.turns.length, 6);
    assert.deepEqual(session.turns.map((turn) => [turn.role, turn.text]), [
        ['user', 'Hello\nworld'],
        ['assistant', 'Same answer'],
        ['assistant', 'Same answer'],
        ['user', 'Repeated request'],
        ['assistant', 'Intervening answer'],
        ['user', 'Repeated request'],
    ]);
    assert.equal(session.turns[1]?.model, 'richer-model');
    assert.equal(session.turns[1]?.name, 'codex_final_answer');
    assert.equal(session.source_metadata.duplicate_turns_removed, 2);
});

test('removes synthetic user wrappers while retaining text outside the wrappers', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-wrappers-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'wrappers.jsonl');
    write_records(path, [
        { type: 'session_meta', payload: { id: 'wrappers-thread' } },
        {
            type: 'response_item',
            payload: {
                type: 'message', role: 'user',
                content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>\n<recommended_plugins>hidden</recommended_plugins>' }],
            },
        },
        {
            type: 'response_item',
            payload: {
                type: 'message', role: 'user',
                content: [{
                    type: 'input_text',
                    text: '<app-context>hidden</app-context>\nKeep this request\n<skills_instructions>hidden</skills_instructions>\n<permissions instructions>hidden</permissions instructions>',
                }],
            },
        },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.deepEqual(session.turns.map((turn) => turn.text), ['Keep this request']);
});

test('preserves response item agent messages as named tool turns', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-agent-message-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'agent-message.jsonl');
    write_records(path, [
        { type: 'session_meta', payload: { id: 'agent-message-thread' } },
        {
            type: 'response_item', timestamp: '2026-09-01T00:00:00.000Z',
            payload: { type: 'agent_message', content: [{ type: 'input_text', text: 'sub-agent result' }] },
        },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.deepEqual(session.turns, [{
        role: 'tool',
        name: 'codex_agent_message',
        text: 'sub-agent result',
        timestamp: Date.parse('2026-09-01T00:00:00.000Z'),
    }]);
});

test('preserves linked textual tool outputs while omitting binary and encrypted payloads', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-tool-output-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'tool-output.jsonl');
    write_records(path, [
        { type: 'session_meta', payload: { id: 'tool-output-thread' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'command result' } },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-2', input: 'patch' } },
        {
            type: 'response_item',
            payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: [{ type: 'input_text', text: 'patch result' }] },
        },
        { type: 'response_item', payload: { type: 'function_call', name: 'image_tool', call_id: 'call-3', arguments: '{}' } },
        {
            type: 'response_item',
            payload: {
                type: 'function_call_output', call_id: 'call-3',
                output: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJD', detail: 'original' }],
            },
        },
        { type: 'response_item', payload: { type: 'function_call', name: 'secret_tool', call_id: 'call-4', arguments: '{}' } },
        {
            type: 'response_item',
            payload: {
                type: 'function_call_output', call_id: 'call-4',
                output: '{"encrypted_content":"ciphertext-must-not-survive","message":"safe status"}',
            },
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'missing-call', output: 'unlinked result' } },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.deepEqual(session.turns.slice(0, 2).map((turn) => ({
        role: turn.role, name: turn.name, tool_call_id: turn.tool_call_id, text: turn.text,
    })), [
        { role: 'tool', name: 'exec_command', tool_call_id: 'call-1', text: 'command result' },
        { role: 'tool', name: 'apply_patch', tool_call_id: 'call-2', text: 'patch result' },
    ]);
    assert.equal(session.turns.length, 4);
    assert.equal(session.turns[2]?.name, 'image_tool');
    assert.match(session.turns[2]?.text ?? '', /attachment type=input_image omitted/i);
    assert.doesNotMatch(session.turns[2]?.text ?? '', /data:image|QUJD/i);
    assert.equal(session.turns[3]?.name, 'secret_tool');
    assert.match(session.turns[3]?.text ?? '', /encrypted content omitted/i);
    assert.doesNotMatch(session.turns[3]?.text ?? '', /ciphertext-must-not-survive/i);
    assert.equal(session.source_metadata.tool_output_turns, 4);
    assert.equal(session.source_metadata.unlinked_tool_outputs_omitted, 1);
    assert.equal(session.source_metadata.binary_tool_output_blocks_omitted, 2);
    assert.equal(session.source_metadata.tool_output_attachment_blocks_omitted, 1);
    assert.equal(session.dropped_turns, 5);
});

test('truncates oversized tool output to a bounded head and tail with the original length', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-tool-truncate-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'tool-truncate.jsonl');
    const long_output = `HEAD:${'h'.repeat(6_000)}<middle>${'t'.repeat(6_000)}:TAIL`;
    write_records(path, [
        { type: 'session_meta', payload: { id: 'tool-truncate-thread' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'long-call', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'long-call', output: long_output } },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);
    const output = session.turns[0];

    assert.equal(output?.text.length, 8_192);
    assert.ok(output?.text.startsWith('HEAD:'));
    assert.ok(output?.text.endsWith(':TAIL'));
    assert.match(output?.text ?? '', new RegExp(`original_text_chars=${long_output.length}`));
    assert.match(output?.text ?? '', /middle_omitted/);
    assert.equal(session.source_metadata.truncated_tool_outputs, 1);
});

test('keeps safe hashes and line locators for image attachments without copying data URIs', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-attachment-ref-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'attachment-ref.jsonl');
    const image_url = 'data:image/png;base64,QUJD';
    write_records(path, [
        { type: 'session_meta', payload: { id: 'attachment-ref-thread' } },
        {
            type: 'response_item', timestamp: '2026-09-01T00:00:00.000Z',
            payload: {
                type: 'message', role: 'user',
                content: [{ type: 'input_text', text: 'Look at this' }, { type: 'input_image', image_url, detail: 'original' }],
            },
        },
        {
            type: 'event_msg', timestamp: '2026-09-01T00:00:00.200Z',
            payload: { type: 'user_message', message: 'Look at this' },
        },
        {
            type: 'response_item', timestamp: '2026-09-01T00:00:01.000Z',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Seen' }] },
        },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);
    const expected_hash = createHash('sha256').update(image_url).digest('hex');

    assert.equal(session.turns.length, 2);
    assert.match(session.turns[0]?.text ?? '', new RegExp(`source_sha256=${expected_hash}`));
    assert.match(session.turns[0]?.text ?? '', /source_line=2; block=1/);
    assert.doesNotMatch(session.turns[0]?.text ?? '', /data:image|QUJD/i);
    assert.deepEqual(session.source_metadata.attachment_references, [{
        type: 'input_image',
        source_line: 2,
        block_index: 1,
        source_sha256: expected_hash,
        media_type: 'image/png',
    }]);
    assert.equal(session.source_metadata.attachment_blocks, 1);
    assert.equal(session.source_metadata.duplicate_turns_removed, 1);
});

test('maps payload id, parent session id, and top-level parent thread id independently', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-parent-ids-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'sessions', 'parent-ids.jsonl');
    write_records(path, [
        {
            type: 'session_meta',
            payload: {
                id: 'child-id',
                session_id: 'parent-session-id',
                parent_thread_id: 'top-level-parent-thread-id',
                source: { subagent: { thread_spawn: { parent_thread_id: 'nested-parent-thread-id' } } },
            },
        },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child task' }] },
        },
    ]);

    const ref = (await codex_adapter.discover({ CODEX_HOME: root }))[0];
    assert.ok(ref);
    const session = await codex_adapter.parse(ref);

    assert.equal(session.source_session_id, 'child-id');
    assert.equal(session.source_metadata.parent_session_id, 'parent-session-id');
    assert.equal(session.source_metadata.parent_thread_id, 'top-level-parent-thread-id');
});

test('verify keeps legacy summary fields and adds Codex source reconciliation', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'longmemory-codex-verify-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    write_session(join(root, 'sessions', 'valid.jsonl'), 'valid-thread', 'valid-thread');
    const empty_path = join(root, 'sessions', 'empty.jsonl');
    mkdirSync(dirname(empty_path), { recursive: true });
    writeFileSync(empty_path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'empty-thread' } })}\n`, 'utf8');
    writeFileSync(join(root, 'sessions', 'malformed.jsonl'), '{not-json}\n', 'utf8');

    const result = await verify_sessions('codex', 10, { CODEX_HOME: root });

    assert.equal(result.harness, 'codex');
    assert.equal(result.discovered, 3);
    assert.equal(result.verified, 1);
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.reconciliation && {
        source_files: result.reconciliation.source_files,
        importable_tasks: result.reconciliation.importable_tasks,
        empty_tasks: result.reconciliation.empty_tasks,
        parse_failures: result.reconciliation.parse_failures,
        excluded_tasks: result.reconciliation.excluded_tasks,
        partial_tasks: result.reconciliation.partial_tasks,
    }, {
        source_files: 3,
        importable_tasks: 1,
        empty_tasks: 1,
        parse_failures: 1,
        excluded_tasks: 0,
        partial_tasks: 0,
    });
});
