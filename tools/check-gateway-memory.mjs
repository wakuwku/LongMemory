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
 *  file  : tools/check-gateway-memory.mjs
 *  usage : supports LongMemory check gateway memory
 */

// Three real stdio clients; database is always read-only. No history or memory writes.
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const dbPath=process.argv[2];
if(!dbPath)throw new Error('Usage: node tools/check-gateway-memory.mjs ABSOLUTE_DB_PATH');
const moduleUrl=new URL('../dist/mcp/transports/stdio.js',import.meta.url).href;
const childCode=`import {create_stdio_mcp} from ${JSON.stringify(moduleUrl)};
const mcp=create_stdio_mcp({db_path:${JSON.stringify(dbPath)},profile:'codex-memory-gateway',read_only:true,audit_path:null,env:{}});
await mcp.start();
process.stderr.write('METRICS '+JSON.stringify({pid:process.pid,memory:process.memoryUsage()})+'\\n');`;
const expected=['longmemory_codex_memory','longmemory_history_backfill','longmemory_history_publication'];
const holders=[];
try{
 const results=await Promise.all(Array.from({length:3},async(_,i)=>{
    const client=new Client({name:`gateway-load-test-${i}`,version:'1.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',childCode],cwd:fileURLToPath(new URL('..',import.meta.url)),stderr:'pipe'});
    holders.push({client,transport});
    let diagnostics='';transport.stderr.on('data',chunk=>{diagnostics+=chunk.toString();if(diagnostics.length>4096)diagnostics=diagnostics.slice(-4096);});
    const started=performance.now();
    await client.connect(transport,{timeout:15000});
    const names=(await client.listTools()).tools.map(t=>t.name);
    if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error('gateway tool surface changed');
    await client.ping();
    const entry=diagnostics.split('\n').find(line=>line.startsWith('METRICS '));
    return {client:i,pid:transport.pid,handshake_ms:Math.round(performance.now()-started),tools:names,metrics:entry?JSON.parse(entry.slice(8)):null};
 }));
 console.log(JSON.stringify({clients:results,total_child_rss_bytes:results.reduce((n,r)=>n+(r.metrics?.memory.rss??0),0)},null,2));
}finally{
 await Promise.allSettled(holders.map(async({client,transport})=>{await client.close();await transport.close();}));
}
