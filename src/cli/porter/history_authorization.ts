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
 *  file  : src/cli/porter/history_authorization.ts
 *  usage : implements the LongMemory history authorization component
 */

import {
    assert_history_reconciliation,
    build_history_inventory,
    build_history_project_plan,
    history_reconciliation_digest,
    type history_override_manifest,
    type history_project_plan,
} from './history_plan.js';
import { hash_canonical } from '../../core/hash/content_hash.js';
import { portable_session_revision } from './history_revision.js';
import type { history_inventory_load } from './history_source.js';
import type { portable_session } from './types.js';
import { assert_history_credentials_safe } from './history_safety.js';
import {
    derive_redacted_history_session,
    type history_redaction_binding,
} from './history_redaction.js';
import { find_obvious_credentials } from '../../core/central_memory/sensitive_content.js';

export type history_import_evidence = {
    inventory_id: string;
    reconciliation_digest: string;
    plan_id: string;
    manifest_hash: string;
    target_db_path: string;
    target_project_id: string;
    /** Present only for an explicitly confirmed deterministic redaction. */
    redaction_policy_hash?: string;
    redaction_bindings?: history_redaction_binding[];
};

export type authorized_history_import = {
    sessions: portable_session[];
    plan: history_project_plan;
    evidence: history_import_evidence;
};

export const history_redaction_binding_for_session = (
    evidence: history_import_evidence,
    source_session_id: string,
): history_redaction_binding | undefined => evidence.redaction_bindings
    ?.find((binding) => binding.source_session_id === source_session_id);

/** Keep immutable run evidence bounded to the exact derived session. */
export const history_import_evidence_for_session = (
    authorization: authorized_history_import,
    session: portable_session,
): history_import_evidence => {
    assert_issued_history_authorization(
        authorization, authorization.sessions, authorization.evidence.target_project_id,
    );
    const evidence = authorization.evidence;
    const binding = history_redaction_binding_for_session(evidence, session.source_session_id);
    if (!binding) {
        const {
            redaction_policy_hash: _redaction_policy_hash,
            redaction_bindings: _redaction_bindings,
            ...base
        } = evidence;
        return base;
    }
    if (binding.derived_source_revision !== portable_session_revision(session)) {
        throw new Error('history redaction evidence does not match the exact derived session snapshot');
    }
    const scoped = freeze_authorization({
        ...evidence,
        redaction_bindings: [binding],
    });
    issued_redaction_evidence.set(scoped, {
        evidence_hash: hash_canonical(scoped),
        source_session_id: session.source_session_id,
        derived_source_revision: portable_session_revision(session),
        target_project_id: evidence.target_project_id,
    });
    return scoped;
};

type issued_history_authorization = {
    authorization_hash: string;
    sessions: portable_session[];
    target_project_id: string;
};

const issued_authorizations = new WeakMap<authorized_history_import, issued_history_authorization>();
const issued_redaction_evidence = new WeakMap<history_import_evidence, {
    evidence_hash: string;
    source_session_id: string;
    derived_source_revision: string;
    target_project_id: string;
}>();

/** Redacted immutable queue snapshots accept only evidence scoped from a live issued authorization. */
export const assert_issued_history_redaction_evidence = (
    evidence: history_import_evidence,
    session: portable_session,
    target_project_id: string,
): void => {
    const issued = issued_redaction_evidence.get(evidence);
    if (!issued) throw new Error('redacted Codex history requires live issued redaction evidence');
    if (issued.evidence_hash !== hash_canonical(evidence)
        || issued.source_session_id !== session.source_session_id
        || issued.derived_source_revision !== portable_session_revision(session)
        || issued.target_project_id !== target_project_id) {
        throw new Error('issued history redaction evidence does not match the exact derived session');
    }
};

/**
 * An authorization is a capability, not a mutable result DTO. Clone it away
 * from the inventory objects first, then recursively freeze every JSON-shaped
 * child so later callers cannot change what the manifest actually approved.
 */
const freeze_authorization = <T>(value: T): T => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) freeze_authorization(child);
    return Object.freeze(value);
};

export const assert_issued_history_authorization = (
    authorization: authorized_history_import | undefined,
    sessions: portable_session[],
    target_project_id: string,
): authorized_history_import => {
    const issued = authorization ? issued_authorizations.get(authorization) : undefined;
    if (!authorization || !issued) throw new Error('Codex imports require validated history-manifest authorization');
    if (authorization.sessions !== issued.sessions || sessions !== issued.sessions) {
        throw new Error('Codex import must reuse the exact parsed session snapshot\'s authorized derived object');
    }
    if (target_project_id !== issued.target_project_id) throw new Error('Codex history authorization does not match the target project');
    if (hash_canonical(authorization) !== issued.authorization_hash) {
        throw new Error('Codex history authorization changed after it was issued');
    }
    return authorization;
};

/**
 * Authorize one project-sized Codex batch against a complete parsed source
 * snapshot. Other projects may remain proposals, but every selected session
 * must be an exact confirmed assignment to this destination.
 */
export const authorize_codex_history_import = (
    loaded: history_inventory_load,
    manifest: history_override_manifest,
    source_session_ids: string[],
    target_project_id: string,
    target_db_path: string,
): authorized_history_import => {
    if (loaded.inventory.source_harness !== 'codex') throw new Error('history import authorization is only valid for Codex inventories');
    if (!loaded.complete_source_scan) throw new Error('Codex history import authorization requires the complete approved inventory snapshot');
    if (!loaded.reconciliation) throw new Error('Codex history import authorization requires complete source reconciliation');
    assert_history_reconciliation(loaded.reconciliation);
    const reconciliation_digest = history_reconciliation_digest(loaded.reconciliation);
    if (loaded.inventory.source_scan.reconciliation_digest !== reconciliation_digest) {
        throw new Error('Codex history inventory does not match its source reconciliation');
    }
    if (manifest.source_snapshot
        && manifest.source_snapshot.snapshot_id !== loaded.source_snapshot?.snapshot_id) {
        throw new Error('Codex history manifest was not loaded from its exact frozen source snapshot');
    }
    const rebuilt_inventory = build_history_inventory(
        loaded.sessions,
        'codex',
        loaded.reconciliation,
        loaded.source_snapshot,
    );
    if (rebuilt_inventory.inventory_id !== loaded.inventory.inventory_id
        || hash_canonical(rebuilt_inventory) !== hash_canonical(loaded.inventory)) {
        throw new Error('Codex history inventory does not match the exact parsed session snapshot');
    }
    if (loaded.reconciliation.parse_failures > 0) {
        throw new Error(`Codex history source scan is incomplete: ${loaded.reconciliation.parse_failures} malformed or unreadable session file(s)`);
    }
    if (loaded.reconciliation.partial_tasks > 0) {
        throw new Error(`Codex history source scan is incomplete: ${loaded.reconciliation.partial_tasks} session file(s) contain skipped malformed lines`);
    }
    if (loaded.parse_failures.length) throw new Error(`Codex history inventory is incomplete: ${loaded.parse_failures.length} session(s) failed to parse`);
    const snapshot_partial = loaded.sessions.filter((session) => {
        const count = session.source_metadata.skipped_line_count;
        return typeof count === 'number' && count > 0;
    });
    if (snapshot_partial.length) {
        throw new Error(`Codex history parsed snapshot is incomplete: ${snapshot_partial.length} session file(s) contain skipped malformed lines`);
    }
    if (loaded.selected !== loaded.reconciliation.importable_tasks
        || loaded.sessions.length !== loaded.reconciliation.importable_tasks) {
        throw new Error('Codex history inventory omitted one or more importable sessions from the approved source snapshot');
    }
    if (!source_session_ids.length) throw new Error('at least one source session id is required');
    if (new Set(source_session_ids).size !== source_session_ids.length) throw new Error('duplicate --id values are not allowed in an authorized Codex import');
    if (!target_project_id.trim()) throw new Error('an explicit target project id is required');
    if (!target_db_path.trim() || target_db_path === ':memory:') throw new Error('an explicit persistent target database path is required');
    const unsafe_target = find_obvious_credentials({ history_import_target: { target_project_id, target_db_path } })[0];
    if (unsafe_target) {
        throw new Error(`history import target ${unsafe_target.path} contains prohibited credential material (${unsafe_target.kind})`);
    }

    const plan = build_history_project_plan(loaded.inventory, manifest);
    const assignments = new Map(plan.assignments.map((assignment) => [assignment.source_session_id, assignment]));
    const sessions = new Map(loaded.sessions.map((session) => [session.source_session_id, session]));
    const inventory = new Map(loaded.inventory.sessions.map((session) => [session.source_session_id, session]));
    const selected: portable_session[] = [];
    const redaction_bindings: history_redaction_binding[] = [];
    for (const source_session_id of source_session_ids) {
        const assignment = assignments.get(source_session_id);
        if (!assignment) throw new Error(`session ${source_session_id} is not present in the current complete Codex inventory`);
        if (assignment.action === 'exclude') throw new Error(`session ${source_session_id} is explicitly excluded by the history manifest`);
        if (assignment.action !== 'assign') throw new Error(`session ${source_session_id} has no resolved project assignment`);
        if (assignment.confirmation !== 'confirmed') throw new Error(`session ${source_session_id} is not confirmed by the history manifest`);
        if (assignment.project_id !== target_project_id) throw new Error(`session ${source_session_id} is confirmed for project ${assignment.project_id}, not target ${target_project_id}`);
        const parsed = sessions.get(source_session_id);
        const item = inventory.get(source_session_id);
        if (!parsed || !item) throw new Error(`session ${source_session_id} is missing from the authorized parsed snapshot`);
        const derived = derive_redacted_history_session(parsed);
        const revision = portable_session_revision(derived.session);
        if (revision !== item.source_revision || revision !== assignment.source_revision) throw new Error(`session ${source_session_id} changed during history authorization`);
        if (derived.binding) {
            const policy_entry = manifest.redaction_policy?.sessions
                .find((entry) => entry.source_session_id === source_session_id);
            if (manifest.redaction_policy?.confirmed !== true || policy_entry?.confirmed !== true) {
                // Preserve the safe, structured default-block report. No
                // authorization or database handle exists at this point.
                assert_history_credentials_safe([parsed]);
                throw new Error('credential-affected history requires an explicitly confirmed redaction policy');
            }
            if (!item.redaction || hash_canonical(item.redaction) !== hash_canonical(derived.binding)) {
                throw new Error(`session ${source_session_id} redaction evidence changed during history authorization`);
            }
            redaction_bindings.push(derived.binding);
        } else if (item.redaction) {
            throw new Error(`session ${source_session_id} no longer matches its redaction inventory evidence`);
        }
        selected.push(derived.session);
    }
    // Only the derived objects can become an issued capability. Recheck them
    // before any database is opened; the original parsed objects stay outside
    // the authorization and are never handed to staging/import.
    assert_history_credentials_safe(selected);
    if (!plan.manifest_hash) throw new Error('authorized history plan is missing a manifest hash');
    const authorization = freeze_authorization(structuredClone({
        sessions: selected,
        plan,
        evidence: {
            inventory_id: plan.inventory_id,
            reconciliation_digest,
            plan_id: plan.plan_id,
            manifest_hash: plan.manifest_hash,
            target_db_path,
            target_project_id,
            ...(redaction_bindings.length > 0 ? {
                redaction_policy_hash: hash_canonical(manifest.redaction_policy),
                redaction_bindings: redaction_bindings
                    .sort((left, right) => left.source_session_id < right.source_session_id ? -1
                        : left.source_session_id > right.source_session_id ? 1 : 0),
            } : {}),
        },
    } satisfies authorized_history_import));
    issued_authorizations.set(authorization, {
        authorization_hash: hash_canonical(authorization),
        sessions: authorization.sessions,
        target_project_id,
    });
    return authorization;
};
