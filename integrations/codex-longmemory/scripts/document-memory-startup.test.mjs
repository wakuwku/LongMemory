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
 *  file  : integrations/codex-longmemory/scripts/document-memory-startup.test.mjs
 *  usage : tests the LongMemory document memory startup component
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const launcher=fileURLToPath(new URL('document-memory-startup.mjs',import.meta.url));
const startup={hook_event_name:'SessionStart',source:'startup',session_id:'fixture-startup'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'longmemory-startup-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const entry=join(root,'adapter.mjs');
 const env={...process.env,PLUGIN_DATA:root,CLAUDE_PLUGIN_DATA:root,LONGMEMORY_PLUGIN_DATA:root,LONGMEMORY_DB_PATH:join(root,'unused.db')};
 const configure=(config)=>writeFileSync(join(root,'document-memory-startup.json'),JSON.stringify(config));
 const run=(event=startup)=>{
  const result=spawnSync(process.execPath,[launcher],{env,input:typeof event==='string'?event:JSON.stringify(event),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
 };
 return{root,entry,configure,run};
}

test('missing local setup returns continue without creating a memory database',t=>{
 const f=fixture(t);assert.deepEqual(f.run(),{continue:true});
 assert(!existsSync(join(f.root,'unused.db')));assert(!existsSync(join(f.root,'sessions')));
});

test('disabled, relative and missing adapters leave the task running',t=>{
 const f=fixture(t);
 writeFileSync(f.entry,'process.stdout.write(JSON.stringify({continue:false}));');
 for(const config of [{enabled:false,entry:f.entry},{enabled:true,entry:'relative.mjs'},{enabled:true,entry:join(f.root,'missing.mjs')}]){
  f.configure(config);assert.deepEqual(f.run(),{continue:true});
 }
});

test('resume, compaction, prompt and Stop never execute the local adapter',t=>{
 const f=fixture(t),marker=join(f.root,'invoked.txt');
 writeFileSync(f.entry,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'invoked');process.stdout.write(JSON.stringify({continue:true}));`);
 f.configure({enabled:true,entry:f.entry});
 for(const event of [{hook_event_name:'SessionStart',source:'resume'},{hook_event_name:'SessionStart',source:'compact'},{hook_event_name:'UserPromptSubmit'},{hook_event_name:'Stop'},{hook_event_name:'PreCompact'},{hook_event_name:'PostCompact'}])assert.deepEqual(f.run(event),{continue:true});
 assert(!existsSync(marker));
});

test('configured startup adapter receives the event and returns a bounded invitation',t=>{
 const f=fixture(t),received=join(f.root,'received.json');
 const invitation={continue:true,hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'Would you like to connect this task to project memory? You may decline.'}};
 writeFileSync(f.entry,`import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;fs.writeFileSync(${JSON.stringify(received)},input);process.stdout.write(${JSON.stringify(JSON.stringify(invitation))});`);
 f.configure({enabled:true,entry:f.entry});assert.deepEqual(f.run(),invitation);
 assert.deepEqual(JSON.parse(readFileSync(received,'utf8')),startup);
 assert(!existsSync(join(f.root,'unused.db')));
});

test('invalid and oversized hook input fail open',t=>{
 const f=fixture(t);
 for(const input of ['not json','null','x'.repeat(65537)])assert.deepEqual(f.run(input),{continue:true});
});

test('invalid configuration and failing adapter fail open',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'document-memory-startup.json'),'not json');
 assert.deepEqual(f.run(),{continue:true});
 writeFileSync(f.entry,'process.exit(1);');f.configure({enabled:true,entry:f.entry});
 assert.deepEqual(f.run(),{continue:true});
});

test('malformed, wrong-event, blocking and oversized adapter responses are rejected',t=>{
 const f=fixture(t);f.configure({enabled:true,entry:f.entry});
 for(const result of ['not json',JSON.stringify({continue:false}),JSON.stringify({continue:true,hookSpecificOutput:{hookEventName:'Stop',additionalContext:'wrong'}}),JSON.stringify({continue:true,hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'x'.repeat(2401)}})]){
  writeFileSync(f.entry,`process.stdout.write(${JSON.stringify(result)});`);
  assert.deepEqual(f.run(),{continue:true});
 }
});
