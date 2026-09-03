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
 *  file  : src/cli/porter/history_source.ts
 *  usage : implements the LongMemory history source component
 */

import {
    assert_history_reconciliation,
    build_history_inventory,
    type history_inventory,
} from './history_plan.js';
import { discover_sessions, parse_sessions } from './orchestrator.js';
import { get_import_adapter } from './detect.js';
import type { harness_id, session_ref, source_reconciliation } from './types.js';
import type { portable_session } from './types.js';
import {
    capture_codex_history_snapshot,
    load_codex_history_snapshot,
} from './adapters/codex.js';
import type { history_source_snapshot } from './history_snapshot.js';

export type history_inventory_load = {
    inventory: history_inventory;
    discovered: number;
    selected: number;
    complete_source_scan: boolean;
    parse_failures: Array<{ source_session_id: string; error: string }>;
    reconciliation: source_reconciliation | null;
    sessions: portable_session[];
    source_snapshot?: history_source_snapshot;
    deferred_source_files: number;
};

export const load_history_inventory = async (
    harness: harness_id,
    options: {
        ids?: string[];
        env?: NodeJS.ProcessEnv;
        source_snapshot?: history_source_snapshot;
        include_source_snapshot?: boolean;
    } = {},
): Promise<history_inventory_load> => {
    const env = options.env ?? process.env;
    const adapter = get_import_adapter(harness);
    if (options.source_snapshot && harness !== 'codex') {
        throw new Error('frozen source snapshots are only supported for Codex history');
    }
    if (harness === 'codex') {
        const capability = await adapter.detect(env);
        if (!capability.can_import) throw new Error(capability.note ?? 'codex is not available as a session source');
        const captured = options.source_snapshot
            ? await load_codex_history_snapshot(options.source_snapshot, env)
            : await capture_codex_history_snapshot(env);
        const requested = new Set(options.ids ?? []);
        if (requested.size) {
            const found = new Set(captured.discovered_source_session_ids);
            const missing = [...requested].filter((id) => !found.has(id));
            if (missing.length) throw new Error(`session ids were not found in ${harness}: ${missing.join(', ')}`);
        }
        const sessions = requested.size
            ? captured.sessions.filter((session) => requested.has(session.source_session_id))
            : captured.sessions;
        const include_source_snapshot = Boolean(options.source_snapshot) || options.include_source_snapshot !== false;
        return {
            inventory: build_history_inventory(
                sessions,
                'codex',
                captured.reconciliation,
                include_source_snapshot ? captured.source_snapshot : undefined,
            ),
            discovered: captured.discovered_source_session_ids.length,
            selected: sessions.length,
            complete_source_scan: requested.size === 0,
            parse_failures: [],
            reconciliation: captured.reconciliation,
            sessions,
            ...(include_source_snapshot ? { source_snapshot: captured.source_snapshot } : {}),
            deferred_source_files: captured.deferred_source_files,
        };
    }
    const reconciliation = await adapter.reconcile?.(env) ?? null;
    if (reconciliation) assert_history_reconciliation(reconciliation);
    const discovered = await discover_sessions(harness, env);
    const requested = new Set(options.ids ?? []);
    const selected_refs: session_ref[] = requested.size
        ? discovered.filter((ref) => requested.has(ref.source_session_id))
        : discovered;
    if (requested.size) {
        const found = new Set(selected_refs.map((ref) => ref.source_session_id));
        const missing = [...requested].filter((id) => !found.has(id));
        if (missing.length) throw new Error(`session ids were not found in ${harness}: ${missing.join(', ')}`);
    }
    const non_importable_paths = new Set(reconciliation ? [
        ...reconciliation.empty,
        ...reconciliation.failures,
        ...reconciliation.excluded,
    ].map((entry) => entry.source_path) : []);
    const selected = selected_refs.filter((ref) => !non_importable_paths.has(ref.source_path));
    const parse_failures: history_inventory_load['parse_failures'] = [];
    const sessions = await parse_sessions(harness, selected, env, (event) => {
        if (event.type === 'error' && event.source_session_id) parse_failures.push({
            source_session_id: event.source_session_id,
            error: event.message ?? 'session parse failed',
        });
    });
    return {
        inventory: build_history_inventory(sessions, harness, reconciliation ?? undefined),
        discovered: discovered.length,
        selected: selected.length,
        complete_source_scan: requested.size === 0,
        parse_failures,
        reconciliation,
        sessions,
        deferred_source_files: 0,
    };
};
