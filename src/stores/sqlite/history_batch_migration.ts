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
 *  file  : src/stores/sqlite/history_batch_migration.ts
 *  usage : implements the LongMemory history batch migration component
 */

import { history_backfill_migration_sql } from './history_backfill_migration.js';

// Reuse the immutable v7 definitions so all existing FK and audit guards survive
// the table rebuild. No historical rows are rewritten or discarded.
const start = history_backfill_migration_sql.indexOf('CREATE TABLE cm_history_backfill_turn_usage (');
const end = history_backfill_migration_sql.indexOf('CREATE TRIGGER cm_history_backfill_receipts_turn_claim_match', start);
const receiptEnd = history_backfill_migration_sql.indexOf('END;', end) + 4;
const definition = history_backfill_migration_sql.slice(start, end);
const tableEnd = definition.indexOf('\nCREATE INDEX');
const table = definition.slice(0, tableEnd)
    .replace('CREATE TABLE cm_history_backfill_turn_usage (', 'CREATE TABLE cm_history_backfill_turn_usage_v12 (')
    .replace('    PRIMARY KEY (tenant_id, user_id, worker_session_id, worker_turn_id),',
        '    previous_lease_id TEXT,\n    PRIMARY KEY (tenant_id, user_id, worker_session_id, worker_turn_id, lease_id),');
const guards = definition.slice(tableEnd)
    .replace('WHEN OLD.worker_session_id IS NOT NEW.worker_session_id',
        'WHEN OLD.previous_lease_id IS NOT NEW.previous_lease_id\n  OR OLD.worker_session_id IS NOT NEW.worker_session_id');

export const history_batch_migration_sql = `
DROP TRIGGER cm_history_backfill_receipts_turn_claim_match;
DROP TRIGGER cm_history_backfill_turn_usage_bound_thread;
DROP TRIGGER cm_history_backfill_turn_usage_identity_immutable;
DROP TRIGGER cm_history_backfill_turn_usage_valid_transition;
DROP TRIGGER cm_history_backfill_turn_usage_no_delete;
${table}
INSERT INTO cm_history_backfill_turn_usage_v12 SELECT *, NULL FROM cm_history_backfill_turn_usage;
DROP TABLE cm_history_backfill_turn_usage;
ALTER TABLE cm_history_backfill_turn_usage_v12 RENAME TO cm_history_backfill_turn_usage;
${guards}
${history_backfill_migration_sql.slice(end, receiptEnd)}
CREATE UNIQUE INDEX cm_history_batch_one_successor ON cm_history_backfill_turn_usage
    (tenant_id, user_id, worker_session_id, worker_turn_id, previous_lease_id)
    WHERE previous_lease_id IS NOT NULL;
CREATE UNIQUE INDEX cm_history_batch_one_root ON cm_history_backfill_turn_usage
    (tenant_id, user_id, worker_session_id, worker_turn_id)
    WHERE previous_lease_id IS NULL;
CREATE UNIQUE INDEX cm_history_batch_one_active ON cm_history_backfill_turn_usage
    (tenant_id, user_id, worker_session_id, worker_turn_id) WHERE status='active';
CREATE TRIGGER cm_history_batch_chain BEFORE INSERT ON cm_history_backfill_turn_usage
WHEN NEW.previous_lease_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cm_history_backfill_turn_usage AS previous
    WHERE previous.tenant_id=NEW.tenant_id AND previous.user_id=NEW.user_id
      AND previous.worker_session_id=NEW.worker_session_id AND previous.worker_turn_id=NEW.worker_turn_id
      AND previous.worker_id=NEW.worker_id AND previous.project_id=NEW.project_id
      AND previous.capability_epoch_hash=NEW.capability_epoch_hash
      AND previous.lease_id=NEW.previous_lease_id AND previous.status='consumed'
      AND EXISTS (SELECT 1 FROM cm_history_backfill_receipts AS receipt
          WHERE receipt.tenant_id=previous.tenant_id AND receipt.user_id=previous.user_id
            AND receipt.lease_id=previous.lease_id)
)
BEGIN SELECT RAISE(ABORT, 'batch continuation requires a completed receipt in the same authenticated turn'); END;
`;
