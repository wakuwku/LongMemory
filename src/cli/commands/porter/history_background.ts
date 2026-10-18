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
 *  file  : src/cli/commands/porter/history_background.ts
 *  usage : implements the LongMemory history background component
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BackgroundHistoryWorker } from '../../../core/central_memory/background_history.js';
import { HistoryWorkerAuthorizationService, codex_history_worker_id } from '../../../core/central_memory/history_worker_authorization.js';
import { SqliteStore } from '../../../stores/sqlite/sqlite_store.js';
import { command_flags, flag, positional, require_value, type cli_command } from '../../context/cli_context.js';
import { emit } from '../../output/pretty.js';

/** Local-owner interface only. Never register this command as an unauthenticated tool/server. */
export const history_background_command: cli_command = async context => {
    command_flags(context,['action-id','confirm-human','session-id','role-id','role-name','responsibility','plan-id','run-id','authorization-id','input','kind','offset']);
    const action=require_value(positional(context,0),'<enable|checkpoint|work|revoke>');
    if (!['enable','checkpoint','work','revoke'].includes(action) || context.args.positionals.length!==1)
        throw new Error('expected history background <enable|checkpoint|work|revoke>');
    const project_id=require_value(flag(context,'project'),'explicit --project');
    const db=require_value(flag(context,'db'),'explicit --db');
    if (db===':memory:' || project_id==='current' || !existsSync(context.db_path)) throw new Error('existing persistent database and exact project required');
    if (context.dry_run) throw new Error('background command does not support --dry-run');
    const management=action==='enable'||action==='revoke';
    if (management && context.args.flags.get('confirm-human')!==true) throw new Error('one-time management authorization requires --confirm-human');
    const action_id=management?require_value(flag(context,'action-id'),'--action-id'):null;
    const store=new SqliteStore(context.db_path,{tenant_id:context.env.LONGMEMORY_TENANT_ID?.trim()||'default',user_id:context.user_id,file_must_exist:true,startup_integrity_check:false});
    try {
        const service=new HistoryWorkerAuthorizationService(store.database,{tenant_id:store.tenant_id,user_id:store.user_id});
        let result:unknown;
        if (action==='enable') {
            const worker_session_id=require_value(flag(context,'session-id'),'--session-id');
            const plan_id=flag(context,'plan-id')||null,run_id=flag(context,'run-id')||null;
            if (!plan_id&&!run_id) throw new Error('background enable requires a frozen --plan-id or --run-id');
            result=store.database.transaction(()=>{
                const existing=store.central_memory.get_thread(worker_session_id);
                if (existing && (existing.project_id!==project_id || existing.status!=='active')) throw new Error('cannot rebind an existing foreign or inactive task');
                if (!existing) {
                    const responsibility=require_value(flag(context,'responsibility'),'--responsibility for new worker');
                    const role_id=require_value(flag(context,'role-id'),'--role-id for new worker');
                    const role=store.central_memory.get_role(role_id);
                    if (role && role.project_id!==project_id) throw new Error('choose a role in the exact project');
                    if (!role) store.central_memory.register_role({role_id,project_id,
                        name:require_value(flag(context,'role-name'),'--role-name for explicitly registering a new role'),
                        responsibility,metadata:{source:'local_background_manager',action_id}});
                    store.central_memory.register_thread({thread_id:worker_session_id,project_id,role_id,responsibility,
                        metadata:{source:'local_background_manager',action_id}});
                }
                const evidence={execution_mode:'local_background_v1',source:'local_owner_cli',explicit_human_confirmation:true,action_id};
                // Explicit opt-in replaces only the same worker's identical legacy scope.
                for (const old of service.list(project_id,{worker_session_id,status:'active'})) {
                    if (old.plan_id===plan_id && old.run_id===run_id && old.authorize_evidence.execution_mode!=='local_background_v1')
                        service.revoke({authorization_id:old.authorization_id,project_id,actor_id:context.user_id,
                            action_id:`background-replace:${createHash('sha256').update(action_id!+old.authorization_id).digest('hex')}`,evidence});
                }
                return service.authorize({project_id,worker_session_id,worker_id:codex_history_worker_id(store.tenant_id,store.user_id,worker_session_id),
                    plan_id,run_id,actor_id:context.user_id,action_id:action_id!,evidence});
            }).immediate();
        } else {
            const authorization_id=require_value(flag(context,'authorization-id'),'--authorization-id');
            if (action==='revoke') result=service.revoke({authorization_id,project_id,actor_id:context.user_id,action_id:action_id!,
                evidence:{source:'local_owner_cli',explicit_human_confirmation:true}});
            else {
                const worker=new BackgroundHistoryWorker(store,project_id,authorization_id);
                if (action==='checkpoint') result=worker.checkpoint(Number(flag(context,'offset')??0));
                else {
                    const kind=flag(context,'kind');
                    if (kind!=='extract'&&kind!=='publication') throw new Error('--kind must be extract or publication');
                    const path=require_value(flag(context,'input'),'--input <JSON file>');
                    if (statSync(path).size>262144) throw new Error('input exceeds 256 KiB');
                    result=worker.execute(kind,JSON.parse(readFileSync(path,'utf8')));
                }
            }
        }
        emit(context,{ok:true,command:`history background ${action}`,result},()=>JSON.stringify(result,null,2));
    } finally {store.close();}
};
