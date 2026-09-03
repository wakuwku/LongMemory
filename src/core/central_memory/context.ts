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
 *  file  : src/core/central_memory/context.ts
 *  usage : implements the LongMemory context component
 */

import { count_tokens } from '../recall/context_builder.js';
import type { central_memory_context_entry, central_thread } from './types.js';

export type central_context_packet = {
    text: string;
    tokens_used: number;
    token_budget: number;
    included: Array<{ memory_id: string; version: number }>;
    omitted: Array<{
        memory_id: string;
        version: number;
        reason: 'already_consumed' | 'token_budget' | 'higher_level_priority';
    }>;
    retractions_included: Array<{ memory_id: string; synced_version: number | null }>;
    retractions_omitted: Array<{ memory_id: string; synced_version: number | null }>;
    within_budget: boolean;
};

export type central_retraction_notice = {
    memory_id: string;
    synced_version: number | null;
    consumed_version: number | null;
    title: string;
    reason: string;
};

export type central_context_options = {
    token_budget: number;
    include_consumed?: boolean;
    retractions?: readonly central_retraction_notice[];
};

function map_line(entry: central_memory_context_entry): string {
    const updated = entry.workset.consumed_version !== null
        && entry.workset.consumed_version !== entry.version.version
        ? ` UPDATED_FROM_v${entry.workset.consumed_version}`
        : '';
    const source = entry.workset.origin === 'own_thread'
        ? 'SELF'
        : entry.workset.origin === 'linked_project'
            ? `LINKED:${entry.memory.project_id}`
            : 'SHARED';
    return `- [${entry.memory.memory_id}@v${entry.version.version} L${entry.memory.level} ${source}${updated}] ${entry.version.title}: ${entry.version.summary}`;
}

function compact_map_line(entry: central_memory_context_entry): string {
    return `- [${entry.memory.memory_id}@v${entry.version.version} L${entry.memory.level}] ${entry.version.title}`;
}

function identity_map_line(entry: central_memory_context_entry): string {
    return `- [${entry.memory.memory_id}@v${entry.version.version} L${entry.memory.level}]`;
}

function detail_block(entry: central_memory_context_entry): string {
    const prior = entry.workset.consumed_version !== null
        && entry.workset.consumed_version !== entry.version.version
        ? `; replaces the version previously consumed as v${entry.workset.consumed_version}`
        : '';
    const project_source = entry.workset.origin === 'linked_project'
        ? `; linked from project ${entry.memory.project_id}`
        : '';
    return [
        `### ${entry.version.title} (${entry.memory.memory_id}@v${entry.version.version}${prior}${project_source})`,
        entry.version.body,
    ].join('\n');
}

function requires_detail(entry: central_memory_context_entry): boolean {
    return entry.memory.level === 4
        || (entry.workset.consumed_version !== null
            && entry.workset.consumed_version !== entry.version.version)
        || entry.version.status === 'locked'
        || entry.version.importance >= 0.85;
}

function prioritized(entries: central_memory_context_entry[]): central_memory_context_entry[] {
    return [...entries].sort((left, right) => {
        // The hierarchy is the primary budget boundary.  A high-relevance or
        // own-thread task memory must never jump ahead of the project/role map.
        if (left.memory.level !== right.memory.level) return left.memory.level - right.memory.level;
        const left_linked = left.workset.origin === 'linked_project' ? 1 : 0;
        const right_linked = right.workset.origin === 'linked_project' ? 1 : 0;
        if (left_linked !== right_linked) return left_linked - right_linked;
        const left_changed = left.workset.consumed_version !== null
            && left.workset.consumed_version !== left.version.version ? 1 : 0;
        const right_changed = right.workset.consumed_version !== null
            && right.workset.consumed_version !== right.version.version ? 1 : 0;
        if (left_changed !== right_changed) return right_changed - left_changed;
        const left_self = left.workset.origin === 'own_thread' ? 1 : 0;
        const right_self = right.workset.origin === 'own_thread' ? 1 : 0;
        if (left_self !== right_self) return right_self - left_self;
        if (left.workset.relevance !== right.workset.relevance) return right.workset.relevance - left.workset.relevance;
        if (left.version.importance !== right.version.importance) return right.version.importance - left.version.importance;
        return left.memory.memory_id.localeCompare(right.memory.memory_id);
    });
}

function one_line(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function retraction_line(notice: central_retraction_notice): string {
    const version = notice.synced_version === null ? 'unknown-version' : `v${notice.synced_version}`;
    const reason = one_line(notice.reason) || 'reason not recorded';
    const title = one_line(notice.title) || notice.memory_id;
    return `- [RETRACTED ${notice.memory_id}@${version}] ${title}; reason: ${reason}. 已撤回，不得再使用 / MUST NOT USE.`;
}

function compact_retraction_line(notice: central_retraction_notice): string {
    const version = notice.synced_version === null ? '?' : `v${notice.synced_version}`;
    return `- [RETRACTED ${notice.memory_id}@${version}] 已撤回，不得再使用 / MUST NOT USE.`;
}

export function build_central_thread_context(
    thread: central_thread,
    all_entries: central_memory_context_entry[],
    options: central_context_options,
): central_context_packet {
    if (!Number.isInteger(options.token_budget) || options.token_budget < 64) {
        throw new Error('central context token_budget must be an integer of at least 64');
    }
    const entries: central_memory_context_entry[] = [];
    const omitted: central_context_packet['omitted'] = [];
    for (const entry of all_entries) {
        if (!options.include_consumed && entry.workset.consumed_version === entry.version.version) {
            omitted.push({ memory_id: entry.memory.memory_id, version: entry.version.version, reason: 'already_consumed' });
        } else {
            entries.push(entry);
        }
    }
    const retractions = options.retractions ?? [];
    if (entries.length === 0 && retractions.length === 0) {
        return {
            text: '', tokens_used: 0, token_budget: options.token_budget, included: [], omitted,
            retractions_included: [], retractions_omitted: [], within_budget: true,
        };
    }

    const chunks = [
        '[CENTRAL MEMORY — external reference; the current user request and this task\'s live state remain authoritative]',
    ];
    const included = new Map<string, { memory_id: string; version: number }>();
    const retractions_included: central_context_packet['retractions_included'] = [];
    const retractions_omitted: central_context_packet['retractions_omitted'] = [];
    const mapped = new Set<string>();
    const omitted_keys = new Set(omitted.map((entry) => `${entry.memory_id}@${entry.version}`));
    const fits = (chunk: string): boolean => count_tokens([...chunks, chunk].join('\n')) <= options.token_budget;
    const responsibility = `Thread responsibility: ${thread.responsibility || 'not specified'}`;
    const omit = (
        entry: central_memory_context_entry,
        reason: central_context_packet['omitted'][number]['reason'],
    ): void => {
        const key = `${entry.memory.memory_id}@${entry.version.version}`;
        if (omitted_keys.has(key)) return;
        omitted_keys.add(key);
        omitted.push({ memory_id: entry.memory.memory_id, version: entry.version.version, reason });
    };

    if (retractions.length > 0 && fits('Retracted memory notices (authoritative):')) {
        chunks.push('Retracted memory notices (authoritative):');
    }
    for (const notice of retractions) {
        let line = retraction_line(notice);
        if (!fits(line)) line = compact_retraction_line(notice);
        if (!fits(line)) {
            retractions_omitted.push({
                memory_id: notice.memory_id,
                synced_version: notice.synced_version,
            });
            continue;
        }
        chunks.push(line);
        retractions_included.push({
            memory_id: notice.memory_id,
            synced_version: notice.synced_version,
        });
    }

    if (fits(responsibility)) {
        chunks.push(responsibility);
    } else if (fits('Thread responsibility: omitted to fit token budget')) {
        chunks.push('Thread responsibility: omitted to fit token budget');
    }

    const local_entries = entries.filter((entry) => entry.workset.origin !== 'linked_project');
    if (local_entries.length > 0) {
        if (fits('Project memory map:')) {
            chunks.push('Project memory map:');
        } else {
            for (const entry of entries) {
                omitted.push({ memory_id: entry.memory.memory_id, version: entry.version.version, reason: 'token_budget' });
            }
            const text = chunks.join('\n');
            const tokens_used = count_tokens(text);
            return {
                text, tokens_used, token_budget: options.token_budget, included: [], omitted,
                retractions_included, retractions_omitted, within_budget: tokens_used <= options.token_budget,
            };
        }
    }

    const ordered = prioritized(entries);
    let linked_map_heading_added = false;
    const map_entry = (entry: central_memory_context_entry, preserve_identity: boolean): boolean => {
        let line = map_line(entry);
        if (!fits(line)) line = compact_map_line(entry);
        if (!fits(line) && preserve_identity) line = identity_map_line(entry);
        const linked_heading = entry.workset.origin === 'linked_project' && !linked_map_heading_added
            ? 'Linked project memory (relevant L4 only; lower priority than current and project memory):'
            : null;
        const candidate = linked_heading ? `${linked_heading}\n${line}` : line;
        if (!fits(candidate)) {
            omit(entry, 'token_budget');
            return false;
        }
        if (linked_heading) {
            chunks.push(linked_heading);
            linked_map_heading_added = true;
        }
        chunks.push(line);
        mapped.add(entry.memory.memory_id);
        if (!requires_detail(entry)) {
            included.set(entry.memory.memory_id, { memory_id: entry.memory.memory_id, version: entry.version.version });
        }
        return true;
    };

    const mandatory_maps = ordered.filter((candidate) => candidate.memory.level <= 2);
    let mandatory_map_overflow = false;
    for (const entry of mandatory_maps) {
        if (!map_entry(entry, true)) mandatory_map_overflow = true;
    }

    const level_three = ordered.filter((candidate) => candidate.memory.level === 3);
    const level_four = ordered.filter((candidate) => candidate.memory.level === 4);
    let level_three_overflow = false;
    if (!mandatory_map_overflow) {
        for (const entry of level_three) {
            if (!map_entry(entry, false)) level_three_overflow = true;
        }
    } else {
        for (const entry of [...level_three, ...level_four]) omit(entry, 'higher_level_priority');
        const marker = '[MEMORY MAP TRUNCATED: L1/L2 exhausted the token budget; L3/L4 were intentionally omitted.]';
        if (fits(marker)) chunks.push(marker);
    }

    if (level_three_overflow) {
        for (const entry of level_four) omit(entry, 'higher_level_priority');
        const marker = '[MEMORY MAP TRUNCATED: L3 exhausted the token budget; L4 was intentionally omitted.]';
        if (fits(marker)) chunks.push(marker);
    }

    const maximum_detail_level = mandatory_map_overflow ? 0 : level_three_overflow ? 2 : 4;
    const details = ordered.filter((entry) => requires_detail(entry)
        && entry.memory.level <= maximum_detail_level);
    const detail_headings = new Set<'local' | 'linked'>();
    let blocked_detail_level: number | null = null;
    for (const entry of details) {
        if (blocked_detail_level !== null && entry.memory.level > blocked_detail_level) {
            omit(entry, 'higher_level_priority');
            continue;
        }
        const block = detail_block(entry);
        const scope = entry.workset.origin === 'linked_project' ? 'linked' : 'local';
        const heading = scope === 'linked'
            ? 'Detailed linked-project memory (external L4 reference):'
            : 'Detailed project memory:';
        const candidate = detail_headings.has(scope) ? block : `${heading}\n${block}`;
        if (!fits(candidate)) {
            if (!mapped.has(entry.memory.memory_id)) {
                const fallback = map_line(entry);
                if (fits(fallback)) {
                    chunks.push(fallback);
                    mapped.add(entry.memory.memory_id);
                }
            }
            omit(entry, 'token_budget');
            blocked_detail_level ??= entry.memory.level;
            continue;
        }
        chunks.push(candidate);
        detail_headings.add(scope);
        included.set(entry.memory.memory_id, { memory_id: entry.memory.memory_id, version: entry.version.version });
    }

    for (const entry of ordered.filter((candidate) => requires_detail(candidate)
        && candidate.memory.level > maximum_detail_level)) {
        omit(entry, 'higher_level_priority');
    }

    const text = chunks.join('\n');
    const tokens_used = count_tokens(text);
    return {
        text,
        tokens_used,
        token_budget: options.token_budget,
        included: [...included.values()],
        omitted,
        retractions_included,
        retractions_omitted,
        within_budget: tokens_used <= options.token_budget,
    };
}
