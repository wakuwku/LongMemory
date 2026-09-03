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
 *  file  : src/cli/porter/history_revision.ts
 *  usage : implements the LongMemory history revision component
 */

import { hash_canonical } from '../../core/hash/content_hash.js';
import type { portable_session } from './types.js';

/**
 * Hash every portable field consumed by the importer or retained as source
 * provenance. A history approval is therefore tied to the exact parsed
 * snapshot, not merely to its native session id or working directory.
 */
export const portable_session_revision = (session: portable_session): string => hash_canonical({
    schema_version: session.schema_version,
    source_harness: session.source_harness,
    source_session_id: session.source_session_id,
    source_path: session.source_path,
    cwd: session.cwd,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    turns: session.turns,
    dropped_turns: session.dropped_turns,
    source_metadata: session.source_metadata,
});
