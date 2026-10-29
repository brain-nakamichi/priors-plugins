#!/usr/bin/env node
'use strict';
// Requires user-reviewed isolated hooks. Reads trust through hooks/list; never changes it.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const checkpoint=require('../hooks/compact-checkpoint.js');
async function run(base,exe) {
 base=path.resolve(base);const fixture=JSON.parse(fs.readFileSync(path.join(base,'fixture.json')));
 if(fixture.schema!==1 || !path.basename(base).startsWith('priors-compact-native-'))throw Error('not_isolated_fixture');
 const configFile=path.join(base,'home/config.toml'),before=fs.readFileSync(configFile),hooksBefore=fs.readFileSync(path.join(base,'home/hooks.json'));
 const eventFile=path.join(base,'events.jsonl');
 const initialEvents=fs.existsSync(eventFile)?fs.readFileSync(eventFile,'utf8').trim().split(/\r?\n/).filter(Boolean).length:0;
 let requests=0,noticeReached=false;
 const server=http.createServer(async(req,res)=>{
   if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);res.end();return;}
   let raw='';for await(const b of req){raw+=b;if(raw.length>2*1024*1024){req.destroy();return;}}
   requests++;if(raw.includes('コンパクト前の期間'))noticeReached=true;
   // Synthetic in-memory model only, no request logging or external provider.
   const id='resp_'+crypto.randomUUID(),item={id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic compact summary. No real conversation.',annotations:[]}]};
   res.writeHead(200,{'content-type':'text/event-stream'});
   for(const [type,data]of [['response.created',{response:{id,object:'response',status:'in_progress',output:[]}}],['response.output_item.added',{output_index:0,item}],['response.output_item.done',{output_index:0,item}],['response.completed',{response:{id,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}]])res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
   res.end();
 });
 await new Promise((resolve,reject)=>{server.once('error',()=>reject(Error('loopback_port_unavailable')));server.listen(18871,'127.0.0.1',resolve);});
 try {
 const env={CODEX_HOME:path.join(base,'home'),PLUGIN_DATA:path.join(base,'data')};
 for(const k of ['PATH','Path','SystemRoot','WINDIR','PATHEXT','TEMP','TMP','COMSPEC','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(exe,['--no-daemon','app-server','--stdio'],{cwd:path.join(base,'workspace'),env,windowsHide:true});
  let tail='',done=false,thread,stage='catalog';
  const timer=setTimeout(()=>finish(Error('native_compact_timeout')),45000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);const end=()=>error?reject(error):resolve(value);if(child.exitCode!==null)end();else{child.once('close',end);child.kill();}}
  const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  child.once('error',()=>finish(Error('native_spawn_failed')));child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.stdout.on('data',bytes=>{tail+=bytes;if(tail.length>1048576)return finish(Error('native_output_limit'));
   for(;;){const n=tail.indexOf('\n');if(n<0)break;let p;try{p=JSON.parse(tail.slice(0,n));}catch{}tail=tail.slice(n+1);if(!p)continue;
    if(p.error)return finish(Error('native_rpc_failed'));
    if(p.id===1)send(2,'hooks/list',{cwds:[path.join(base,'workspace')]});
    if(p.id===2){const rows=(p.result?.data||[]).flatMap(x=>x.hooks||[]);const selected=rows.filter(x=>['preCompact','sessionStart'].includes(x.eventName));
     if(selected.length!==2||selected.some(x=>x.trustStatus!=='trusted'||x.enabled===false))return finish(Error('user_hook_review_required'));
     send(3,'thread/start',{cwd:path.join(base,'workspace'),ephemeral:true,model:'compact-local-test',modelProvider:'loopback',sandbox:'read-only'});
    }
    if(p.id===3){thread=p.result?.thread?.id;if(!thread)return finish(Error('native_thread_missing'));
     checkpoint.recordSave('codex',thread,['ZZ-1@1'],[],env);stage='compact';send(4,'thread/compact/start',{threadId:thread});
    }
    if(stage==='compact' && p.method==='turn/completed'){stage='continuation';send(5,'turn/start',{threadId:thread,input:[{type:'text',text:'Synthetic continuation only.'}]});}
    else if(stage==='continuation' && p.method==='turn/completed')finish(null,{requests,noticeReached});
   }
  });
  send(1,'initialize',{clientInfo:{name:'priors-compact-native-test',version:'1'},capabilities:{experimentalApi:true}});
 });
 if(!fs.readFileSync(configFile).equals(before)||!fs.readFileSync(path.join(base,'home/hooks.json')).equals(hooksBefore))throw Error('fixture_settings_changed');
 const events=fs.existsSync(eventFile)?fs.readFileSync(eventFile,'utf8').trim().split(/\r?\n/).filter(Boolean).slice(initialEvents).map(x=>JSON.parse(x)):[];
 if(!result.noticeReached || events.filter(x=>x.event==='PreCompact').length!==1 || events.filter(x=>x.event==='SessionStart'&&x.source==='compact').length!==1)throw Error('native_compact_assertion_failed');
 return {...result,preCompact:events.filter(x=>x.event==='PreCompact').length,compactSessionStart:events.filter(x=>x.event==='SessionStart'&&x.source==='compact').length,settingsUnchanged:true};
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)run(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[a-z_]+$/.test(e.message)?e.message:'native_test_failed');process.exitCode=1;});
module.exports={run};
