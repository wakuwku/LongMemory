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
 *  file  : src/core/create_gateway_memory.ts
 *  usage : implements the LongMemory create gateway memory component
 */

import { create_memory, type long_memory, type memory_config } from './create_memory.js';
import { CentralMemoryService } from './central_memory/service.js';
import { hydrograph_invariants } from './invariants.js';
import { SqliteStore } from '../stores/sqlite/sqlite_store.js';

/** Central SQL operations do not need to hydrate the legacy Hydrograph.
 * Keep the original engine as an on-demand fallback, not an alternate search.
 * Full graph integrity checks still run when that engine is explicitly used.
 */
export function create_gateway_memory(
    config: memory_config,
    engine_factory: (config: memory_config) => long_memory = create_memory,
): long_memory {
    // Separate SQLite :memory: connections cannot share state; keep its old behavior.
    if (config.store !== 'sqlite' || !config.db_path || config.db_path === ':memory:') {
        return engine_factory(config);
    }
    const store = new SqliteStore(config.db_path, {
        tenant_id: config.tenant_id,
        user_id: config.user_id,
        readonly: config.readonly ?? false,
        file_must_exist: config.readonly ?? false,
        startup_integrity_check: false,
    });
    store.database.pragma('cache_size = -8192');
    const central = new CentralMemoryService(store.central_memory, { readonly: config.readonly === true });
    let engine: long_memory | undefined;
    let closed = false;
    const legacy = (): long_memory => {
        if (closed) throw new Error('longmemory instance is closed');
        return engine ??= engine_factory(config);
    };
    return {
        ingest: async (event) => legacy().ingest(event),
        recall: async (query) => legacy().recall(query),
        explain: async (id) => legacy().explain(id),
        getWorld: async (id) => legacy().getWorld(id),
        listWorlds: async (params) => legacy().listWorlds(params),
        getEntity: async (id) => legacy().getEntity(id),
        resolveEntity: async (input) => legacy().resolveEntity(input),
        getTimeline: async (params) => legacy().getTimeline(params),
        // Preserve closed statistics for a previously used legacy engine. A cold,
        // closed gateway cannot reconstruct graph statistics; status() is its
        // lightweight health API and getStats is not exposed by this MCP profile.
        getStats: async () => engine ? engine.getStats() : legacy().getStats(),
        recallMultilingual: async (query) => legacy().recallMultilingual(query),
        applyImportPlan: async (plan) => legacy().applyImportPlan(plan),
        runDecay: async (params) => legacy().runDecay(params),
        reinforce: async (id, params) => legacy().reinforce(id, params),
        centralMemory: () => central,
        status: () => ({ name: 'longmemory-hydrograph', phase: 'phase-19-public-api', ready: !closed, store: 'sqlite' }),
        invariants: () => hydrograph_invariants,
        async close() {
            if (closed) return;
            closed = true;
            try { await engine?.close(); } finally { store.close(); }
        },
    };
}
