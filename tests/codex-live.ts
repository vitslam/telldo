import { CodexAdapter } from '../src/main/codex-adapter'
import {DateTime} from 'luxon'
const started=Date.now()
async function main(){
 const adapter=new CodexAdapter({resourceDir:process.cwd()+'/resources',timeoutMs:120000})
 const caps=await adapter.probe(process.env.TELLDO_CODEX_PATH)
 console.log(JSON.stringify({phase:'probe',version:caps.version,available:caps.available,loggedIn:caps.loggedIn,schema:caps.schema,readOnly:caps.readOnly,ignoreUserConfig:caps.ignoreUserConfig,reason:caps.reason}))
 if(!caps.available)throw new Error(caps.reason)
 const zone=process.env.TELLDO_TIME_ZONE??Intl.DateTimeFormat().resolvedOptions().timeZone
 const today=DateTime.now().setZone(zone).toISODate()
 const result=await adapter.run('明天下午交周报',{today,timeZone:zone,currentListId:'synthetic-work',lists:[{id:'synthetic-work',name:'工作'}],tasks:[]},message=>console.log(JSON.stringify({phase:'progress',message})))
 const action=result.proposal.actions[0]
 if(result.proposal.actions.length!==1||action.type!=='create'||action.patch.list_id!=='synthetic-work'||action.patch.due_kind!=='datetime')throw new Error('Unexpected synthetic proposal')
 if(action.patch.due_date!==DateTime.now().setZone(zone).plus({days:1}).toISODate())throw new Error('Incorrect tomorrow date')
 console.log(JSON.stringify({phase:'success',elapsedMs:Date.now()-started,proposal:result.proposal,databaseWrites:0}))
}
main().catch(e=>{console.error(JSON.stringify({phase:'failed',elapsedMs:Date.now()-started,error:e.message,databaseWrites:0}));process.exitCode=1})
