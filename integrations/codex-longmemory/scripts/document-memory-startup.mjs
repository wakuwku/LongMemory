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
 *  file  : integrations/codex-longmemory/scripts/document-memory-startup.mjs
 *  usage : supports the LongMemory document memory startup integration
 */

// Optional machine-local document-memory pilot. No legacy CLI/hook invocation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readBounded,resolvePluginRuntime} from './plugin-runtime.mjs';

let output={continue:true};
try{
  const input=await readBounded(process.stdin,65536),event=JSON.parse(input.toString('utf8'));
  if(event.hook_event_name==='SessionStart'&&event.source==='startup'){
    const runtime=resolvePluginRuntime({env:process.env,scriptPath:fileURLToPath(import.meta.url)});
    const config=JSON.parse(fs.readFileSync(path.join(runtime.pluginData,'document-memory-startup.json'),'utf8'));
    if(config.enabled===true&&typeof config.entry==='string'&&path.isAbsolute(config.entry)&&fs.statSync(config.entry).isFile()){
      const child=spawnSync(process.execPath,[config.entry],{input,encoding:'utf8',windowsHide:true,timeout:7000,maxBuffer:65536});
      if(child.status===0){
        const result=JSON.parse(child.stdout),hook=result.hookSpecificOutput;
        if(result.continue===true&&(!hook||(hook.hookEventName==='SessionStart'&&typeof hook.additionalContext==='string'&&hook.additionalContext.length<=2400)))output=result;
      }
    }
  }
}catch{/* Missing local install, invalid input, or runtime failure must not block a task. */}
process.stdout.write(JSON.stringify(output));
