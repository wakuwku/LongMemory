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
 *  file  : src/core/central_memory/recall.ts
 *  usage : implements the LongMemory recall component
 */

import type {
    central_memory,
    central_memory_version,
    central_subscription,
    central_thread,
    central_thread_workset,
} from './types.js';

export const central_recall_limits = {
    default_results: 8,
    max_results: 32,
    max_query_characters: 2_048,
    max_search_terms: 32,
    max_candidate_count: 512,
    max_subscriptions: 128,
    max_title_characters: 512,
    max_summary_characters: 4_096,
    max_body_characters: 16_384,
    max_metadata_characters: 4_096,
} as const;

export type central_recall_input = {
    /** A registered thread is the only trusted source of project/role/task scope. */
    thread_id: string;
    query: string;
    limit?: number;
    at?: number;
};

export type central_recall_candidate = {
    memory: central_memory;
    version: central_memory_version;
    workset: central_thread_workset | null;
    project_scope: 'local_project' | 'linked_project';
};

export type central_recall_score = {
    score: number;
    lexical_score: number;
    matched_terms: string[];
    reasons: string[];
    stage_origin: Extract<central_thread_workset['origin'],
        'shared' | 'project_map' | 'subscription' | 'linked_project'>;
};

export type central_recall_match = central_recall_candidate & central_recall_score & {
    workset: central_thread_workset;
};

export type central_recall_result = {
    thread_id: string;
    query: string;
    status: 'staged' | 'thread_inactive';
    candidates_considered: number;
    matches: central_recall_match[];
};

type recall_term = {
    value: string;
    kind: 'word' | 'cjk_ngram';
};

const stop_words = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
    'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'with',
    '什么', '怎么', '如何', '我们', '你们', '这个', '那个', '里面', '一下', '一个',
]);

function normalize_text(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function bounded_text(value: string, limit: number): string {
    return normalize_text(value.slice(0, limit));
}

function add_term(target: Map<string, recall_term>, value: string, kind: recall_term['kind']): void {
    const normalized = normalize_text(value).slice(0, 64);
    if (!normalized || stop_words.has(normalized) || target.has(normalized)) return;
    target.set(normalized, { value: normalized, kind });
}

/**
 * Produce explainable local search terms: Unicode words for English and
 * overlapping 2/3-character n-grams for unsegmented Chinese text.
 */
export function central_recall_terms(query: string): string[] {
    const normalized = normalize_text(query);
    const terms = new Map<string, recall_term>();
    const chunks = normalized.match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu) ?? [];
    for (const chunk of chunks) {
        const han = [...chunk].filter((character) => /\p{Script=Han}/u.test(character));
        if (han.length === [...chunk].length && han.length > 0) {
            if (han.length === 1) add_term(terms, han[0], 'cjk_ngram');
            for (const size of [2, 3]) {
                for (let index = 0; index + size <= han.length; index += 1) {
                    add_term(terms, han.slice(index, index + size).join(''), 'cjk_ngram');
                    if (terms.size >= 512) break;
                }
                if (terms.size >= 512) break;
            }
        } else if (chunk.length >= 2) {
            add_term(terms, chunk, 'word');
        }
        if (terms.size >= 512) break;
    }
    const values = [...terms.values()].map((term) => term.value);
    if (values.length <= central_recall_limits.max_search_terms) return values;
    const sampled: string[] = [];
    for (let index = 0; index < central_recall_limits.max_search_terms; index += 1) {
        const source_index = Math.round(index * (values.length - 1)
            / (central_recall_limits.max_search_terms - 1));
        sampled.push(values[source_index]!);
    }
    return sampled;
}

function metadata_values(metadata: central_memory['metadata']): { tags: string[]; topics: string[]; text: string } {
    const strings = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(normalize_text)
        : typeof value === 'string' ? [normalize_text(value)] : [];
    const tags = strings(metadata.tags);
    const topics = [...strings(metadata.topics), ...strings(metadata.topic)];
    let serialized = '';
    try {
        serialized = JSON.stringify(metadata);
    } catch {
        serialized = '';
    }
    return {
        tags,
        topics,
        text: bounded_text(serialized, central_recall_limits.max_metadata_characters),
    };
}

function subscription_matches(
    subscription: central_subscription,
    thread: central_thread,
    candidate: central_recall_candidate,
    tags: string[],
    topics: string[],
    searchable: string,
): boolean {
    const selector = normalize_text(subscription.selector_value);
    switch (subscription.selector_kind) {
        case 'memory': return subscription.selector_value === candidate.memory.memory_id;
        case 'project': return subscription.selector_value === thread.project_id && candidate.memory.level <= 3;
        case 'role': return subscription.selector_value === candidate.memory.role_id;
        case 'task': return subscription.selector_value === candidate.memory.task_id;
        case 'tag': return tags.includes(selector);
        case 'topic': return topics.some((topic) => topic.includes(selector) || selector.includes(topic))
            || searchable.includes(selector);
    }
}

function round_score(value: number): number {
    return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

/** Score a bounded candidate and retain human-readable reasons for every boost. */
export function score_central_recall_candidate(input: {
    thread: central_thread;
    candidate: central_recall_candidate;
    query: string;
    terms: string[];
    subscriptions: central_subscription[];
}): central_recall_score | null {
    const { thread, candidate, terms } = input;
    const title = bounded_text(candidate.version.title, central_recall_limits.max_title_characters);
    const summary = bounded_text(candidate.version.summary, central_recall_limits.max_summary_characters);
    const body = bounded_text(candidate.version.body, central_recall_limits.max_body_characters);
    const metadata = metadata_values({ ...candidate.memory.metadata, ...candidate.version.metadata });
    const searchable = `${title}\n${summary}\n${body}\n${metadata.text}`;
    const matched_terms: string[] = [];
    let weighted_matches = 0;

    for (const term of terms) {
        let weight = 0;
        if (title.includes(term)) weight = 1;
        else if (metadata.tags.includes(term) || metadata.topics.some((topic) => topic.includes(term))) weight = 0.9;
        else if (summary.includes(term)) weight = 0.78;
        else if (body.includes(term)) weight = 0.5;
        else if (metadata.text.includes(term)) weight = 0.42;
        if (weight > 0) {
            matched_terms.push(term);
            weighted_matches += weight;
        }
    }
    if (matched_terms.length === 0) return null;

    const lexical_score = weighted_matches / Math.max(1, terms.length);
    const reasons = [`lexical:${matched_terms.join(',')}`];
    let score = lexical_score * 0.62;
    const normalized_query = normalize_text(input.query);
    if (normalized_query.length >= 2 && normalized_query.length <= 256 && searchable.includes(normalized_query)) {
        score += 0.08;
        reasons.push('exact_query');
    }
    if (candidate.memory.task_id !== null && candidate.memory.task_id === thread.task_id) {
        score += 0.1;
        reasons.push('binding:task');
    } else if (candidate.memory.role_id !== null && candidate.memory.role_id === thread.role_id) {
        score += 0.06;
        reasons.push('binding:role');
    }
    if (candidate.memory.level === 4) {
        score += 0.035;
        reasons.push('level:L4');
    }
    if (candidate.project_scope === 'linked_project') {
        // A linked project is useful evidence, not local authority.  Keep the
        // relevance score explainable while making the trust boundary visible.
        score = Math.max(0, score - 0.08);
        reasons.push(`linked_project:${candidate.memory.project_id}->${thread.project_id}`);
    }

    const matched_subscriptions = input.subscriptions.filter((subscription) => subscription_matches(
        subscription, thread, candidate, metadata.tags, metadata.topics, searchable,
    ));
    if (matched_subscriptions.length > 0) {
        const strongest = Math.max(...matched_subscriptions.map((subscription) => subscription.min_relevance));
        score += 0.045 + strongest * 0.035;
        reasons.push(`subscription:${matched_subscriptions.map((item) => item.selector_kind).join(',')}`);
    }

    score += candidate.version.importance * 0.09;
    reasons.push(`importance:${candidate.version.importance.toFixed(2)}`);
    if (candidate.workset) {
        reasons.push(`workset:${candidate.workset.origin}@${candidate.workset.relevance.toFixed(2)}`);
    }

    const stage_origin: central_recall_score['stage_origin'] = candidate.project_scope === 'linked_project'
        ? 'linked_project'
        : candidate.memory.level <= 2
        ? 'project_map'
        : matched_subscriptions.length > 0 ? 'subscription' : 'shared';
    return {
        score: round_score(score),
        lexical_score: round_score(lexical_score),
        matched_terms,
        reasons,
        stage_origin,
    };
}

export function compare_central_recall_matches(
    left: central_recall_candidate & central_recall_score,
    right: central_recall_candidate & central_recall_score,
): number {
    if (left.project_scope !== right.project_scope) {
        return left.project_scope === 'local_project' ? -1 : 1;
    }
    if (left.score !== right.score) return right.score - left.score;
    if (left.lexical_score !== right.lexical_score) return right.lexical_score - left.lexical_score;
    const origin_priority: Record<central_thread_workset['origin'], number> = {
        own_thread: 5,
        manual: 4,
        project_map: 3,
        subscription: 2,
        shared: 1,
        linked_project: 0,
    };
    const left_origin = left.workset ? origin_priority[left.workset.origin] : 0;
    const right_origin = right.workset ? origin_priority[right.workset.origin] : 0;
    if (left_origin !== right_origin) return right_origin - left_origin;
    const left_relevance = left.workset?.relevance ?? 0;
    const right_relevance = right.workset?.relevance ?? 0;
    if (left_relevance !== right_relevance) return right_relevance - left_relevance;
    if (left.version.importance !== right.version.importance) {
        return right.version.importance - left.version.importance;
    }
    if (left.memory.level !== right.memory.level) {
        if (left.memory.level === 4) return -1;
        if (right.memory.level === 4) return 1;
        return left.memory.level - right.memory.level;
    }
    return left.memory.memory_id < right.memory.memory_id
        ? -1
        : left.memory.memory_id > right.memory.memory_id ? 1 : 0;
}
