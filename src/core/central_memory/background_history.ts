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
 *  file  : src/core/central_memory/background_history.ts
 *  usage : implements the LongMemory background history component
 */

import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import type { SqliteStore } from '../../stores/sqlite/sqlite_store.js';
import { history_backfill_schema } from '../../mcp/schemas/history_backfill_schema.js';
import { history_publication_schema } from '../../mcp/schemas/history_publication_schema.js';
import { run_history_action, type history_tool_input } from '../../mcp/tools/history_backfill.js';
import { run_publication_action, type publication_tool_input } from '../../mcp/tools/history_publication.js';
import { HistoryBackfillService } from './history_backfill_service.js';
import { HistoryPublicationService } from './history_publication_service.js';
import { HistoryWorkerAuthorizationService } from './history_worker_authorization.js';
import type { history_worker_context } from './history_backfill_types.js';
import { count_tokens } from '../recall/context_builder.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const extract_schema = z.object(history_backfill_schema).omit({ session_id:true, capability:true, turn_id:true }).strict();
const publication_schema = z.object(history_publication_schema).omit({ session_id:true, capability:true, turn_id:true }).strict();

/** Trusted local-owner runner, not an unauthenticated network/MCP endpoint.
 * A separate, explicit background grant is required. Internal job IDs occupy
 * the legacy worker_turn_id audit column but are NOT Codex conversation turns.
 */
export class BackgroundHistoryWorker {
    constructor(readonly store: SqliteStore, readonly project_id: string, readonly authorization_id: string) {}

    private grant() {
        const grant = new HistoryWorkerAuthorizationService(this.store.database, {
            tenant_id:this.store.tenant_id, user_id:this.store.user_id,
        }).list(this.project_id, {status:'active'}).find(item=>item.authorization_id===this.authorization_id);
        if (!grant || grant.authorize_evidence.execution_mode !== 'local_background_v1'
            || (!grant.plan_id && !grant.run_id)) throw new Error('active scoped background authorization required');
        const thread=this.store.central_memory.require_thread(grant.worker_session_id);
        if (thread.project_id!==this.project_id || thread.status!=='active') throw new Error('background worker binding is inactive or mismatched');
        return grant;
    }

    private assert_run(run_id: string): void {
        const grant=this.grant();
        const run=this.store.database.prepare(`SELECT project_id,plan_id FROM cm_history_backfill_runs
            WHERE tenant_id=? AND user_id=? AND run_id=?`)
            .get(this.store.tenant_id,this.store.user_id,run_id) as {project_id:string;plan_id:string}|undefined;
        if (!run || run.project_id!==this.project_id || (grant.run_id && grant.run_id!==run_id)
            || (grant.plan_id && grant.plan_id!==run.plan_id)) throw new Error('run is outside background authorization');
    }

    checkpoint(offset = 0) {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid checkpoint offset');
        const grant=this.grant();
        const runs=this.store.database.prepare(`SELECT run_id,status,chunk_count,completed_chunks,consolidated_candidate_count
            FROM cm_history_backfill_runs WHERE tenant_id=? AND user_id=? AND project_id=?
            AND (? IS NULL OR run_id=?) AND (? IS NULL OR plan_id=?) AND status!='superseded'
            ORDER BY chunk_count,run_id LIMIT 11 OFFSET ?`).all(this.store.tenant_id,this.store.user_id,this.project_id,
                grant.run_id,grant.run_id,grant.plan_id,grant.plan_id,offset);
        const recent_jobs=this.store.database.prepare(`SELECT worker_turn_id AS job_id,lease_id,operation_kind,run_id,status,lease_expires_at
            FROM cm_history_backfill_turn_usage WHERE tenant_id=? AND user_id=? AND worker_session_id=?
            AND capability_epoch_hash=? ORDER BY rowid DESC LIMIT 4`)
            .all(this.store.tenant_id,this.store.user_id,grant.worker_session_id,digest(`background-grant:${grant.authorization_id}`)) as Array<Record<string,unknown>>;
        // Reconstruct original claim arguments for process-loss recovery. Only
        // compact IDs are scanned locally; history content is never loaded here.
        const predecessors=new Map<string,string|null>([
            [`background-job:${digest(`${grant.authorization_id}:claim:root`)}`,null],
        ]);
        for (const row of this.store.database.prepare(`SELECT lease_id FROM cm_history_backfill_turn_usage
            WHERE tenant_id=? AND user_id=? AND worker_session_id=? AND capability_epoch_hash=?`)
            .all(this.store.tenant_id,this.store.user_id,grant.worker_session_id,digest(`background-grant:${grant.authorization_id}`)) as {lease_id:string}[]) {
            predecessors.set(`background-job:${digest(`${grant.authorization_id}:claim:${row.lease_id}`)}`,row.lease_id);
        }
        for (const job of recent_jobs) job.claim_input={action:job.operation_kind==='chunk'?'claim_extract':'claim_reduce',
            run_id:job.run_id,...(predecessors.get(String(job.job_id))?{after_lease_id:predecessors.get(String(job.job_id))}:{})};
        const latest=recent_jobs[0];
        // Explicit continuation hints survive a new chat turn or a run switch.
        // These are read-only suggestions; claim still validates current state.
        const next_claims=latest?.status==='active' && Number(latest.lease_expires_at)>Date.now()
            ? [latest.claim_input]
            : (runs.slice(0,10) as Array<{run_id:string;status:string}>).filter(run=>
                ['pending','extracting','ready_for_consolidation','consolidating'].includes(run.status))
                .map(run=>({action:['pending','extracting'].includes(run.status)?'claim_extract':'claim_reduce',
                    run_id:run.run_id,...(latest?{after_lease_id:latest.lease_id}:{})}));
        return {execution_mode:'local_background_v1',authorization_id:grant.authorization_id,
            execution_contract:{authorization_scope:'frozen_plan_or_run',identity_unit:'durable_job',
                requires_hook_capability:false,requires_user_message_per_job:false,
                max_active_leases:1,memory_service_units_per_chat_turn:null,
                memory_service_evidence_tokens_per_chat_turn:null,response_token_limit:8192,
                continuation:'checkpoint.next_claims; executor context and platform limits still apply'},
            runs:runs.slice(0,10),next_offset:runs.length>10?offset+10:null,recent_jobs,next_claims};
    }

    execute(kind: 'extract'|'publication', raw: unknown): unknown {
        const input=kind==='extract' ? extract_schema.parse(raw) : publication_schema.parse(raw);
        // Services own their transactions; guards repeat scope checks inside them.
        return this.execute_locked(kind,input as Record<string,unknown>);
    }

    private execute_locked(kind:'extract'|'publication', input:Record<string,unknown>):unknown {
        const grant=this.grant();
        const epoch=digest(`background-grant:${grant.authorization_id}`);
        const action=String(input.action);
        let job_key='control';
        if (kind==='publication' && action==='execute' && input.publication_id) {
            const retry=this.store.database.prepare(`SELECT decision_id FROM cm_history_governance_decisions
                WHERE tenant_id=? AND user_id=? AND publication_id=? AND action='retry'
                ORDER BY created_at DESC,rowid DESC LIMIT 1`)
                .get(this.store.tenant_id,this.store.user_id,input.publication_id) as {decision_id:string}|undefined;
            // New manager-authorized retry, new attempt; transport retries retain it.
            if(retry) job_key=`control:retry:${retry.decision_id}`;
        }
        if (kind==='extract' && (action==='claim_extract'||action==='claim_reduce')) {
            if (input.after_lease_id) {
                const prior=this.usage(String(input.after_lease_id),grant.worker_session_id,epoch);
                if (prior.status==='active' && prior.lease_expires_at>Date.now())
                    throw new Error('finish the active background lease before continuing');
            }
            job_key=`claim:${String(input.after_lease_id??'root')}`;
            if (!input.run_id) throw new Error('background claims require a run_id from checkpoint');
            this.assert_run(String(input.run_id));
        }
        let job_id=`background-job:${digest(`${grant.authorization_id}:${job_key}`)}`;
        if (kind==='extract' && ['submit_extract','fail_extract','reduction_page','submit_reduce','fail_reduce'].includes(action)) {
            if (!input.lease_id) throw new Error('lease_id required');
            job_id=this.usage(String(input.lease_id),grant.worker_session_id,epoch).worker_turn_id;
        }
        if (input.run_id) this.assert_run(String(input.run_id));
        if (kind==='publication' && input.publication_id) {
            const row=this.store.database.prepare(`SELECT run_id FROM cm_history_publications
                WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                .get(this.store.tenant_id,this.store.user_id,input.publication_id) as {run_id:string}|undefined;
            if (!row) throw new Error('publication not found');
            this.assert_run(row.run_id);
        }
        const worker:history_worker_context={worker_id:grant.worker_id,worker_session_id:grant.worker_session_id,
            worker_turn_id:job_id,capability_epoch_hash:epoch};
        const guard=(candidate:history_worker_context)=>{
            this.grant(); // revocation/binding checked again inside every transaction
            if (Object.keys(worker).some(key=>candidate[key as keyof history_worker_context]!==worker[key as keyof history_worker_context]))
                throw new Error('background job identity mismatch');
            if (input.run_id) this.assert_run(String(input.run_id));
            if (kind==='publication' && input.publication_id) {
                const row=this.store.database.prepare(`SELECT run_id FROM cm_history_publications
                    WHERE tenant_id=? AND user_id=? AND publication_id=?`)
                    .get(this.store.tenant_id,this.store.user_id,input.publication_id) as {run_id:string}|undefined;
                if (!row) throw new Error('publication not found');
                this.assert_run(row.run_id);
            }
        };
        const options={tenant_id:this.store.tenant_id,user_id:this.store.user_id,capability_guard:guard,claim_transport_tokens:8192};
        let result:unknown;
        if (kind==='extract') {
            // Each background unit has its own persisted server job. This is not
            // a fabricated chat turn and needs no Hook capability or finalizer.
            const {after_lease_id: _predecessor,...job_input}=input;
            result=run_history_action(new HistoryBackfillService(this.store.database,options),worker,this.project_id,job_input as history_tool_input);
        } else if (action==='list') {
            const offset=Number(input.offset??0),limit=Math.min(Number(input.limit??10),10);
            const items=this.store.database.prepare(`SELECT p.publication_id,p.run_id,p.status,p.current_plan_version,
                p.result_memory_id,p.result_version FROM cm_history_publications p JOIN cm_history_backfill_runs r
                ON r.tenant_id=p.tenant_id AND r.user_id=p.user_id AND r.run_id=p.run_id
                WHERE p.tenant_id=? AND p.user_id=? AND r.project_id=?
                AND (? IS NULL OR r.run_id=?) AND (? IS NULL OR r.plan_id=?)
                ORDER BY p.publication_id LIMIT ? OFFSET ?`).all(this.store.tenant_id,this.store.user_id,this.project_id,
                    grant.run_id,grant.run_id,grant.plan_id,grant.plan_id,limit+1,offset);
            result={items:items.slice(0,limit),next_offset:items.length>limit?offset+limit:null};
        } else {
            result=run_publication_action(new HistoryPublicationService(this.store.database,options),worker,this.project_id,input as publication_tool_input);
        }
        const envelope={execution_mode:'local_background_v1',job_id,result};
        if (count_tokens(JSON.stringify(envelope))>8192) throw new Error('background response exceeds 8192 token budget');
        return envelope;
    }

    private usage(lease_id:string,session_id:string,epoch:string) {
        const usage=this.store.database.prepare(`SELECT worker_turn_id,run_id,status,lease_expires_at FROM cm_history_backfill_turn_usage
            WHERE tenant_id=? AND user_id=? AND lease_id=? AND worker_session_id=? AND capability_epoch_hash=?`)
            .get(this.store.tenant_id,this.store.user_id,lease_id,session_id,epoch) as {worker_turn_id:string;run_id:string;status:string;lease_expires_at:number}|undefined;
        if (!usage || !usage.worker_turn_id.startsWith('background-job:')) throw new Error('lease is outside this background grant');
        this.assert_run(usage.run_id);
        return usage;
    }
}
