import { z } from 'zod'
import { DateTime, IANAZone } from 'luxon'
import type { ProposalInput, TaskPatch } from './types'

export const MAX_ACTIONS = 50
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => DateTime.fromISO(v).isValid, 'Invalid calendar date')
const instant = z.string().refine(v => /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && DateTime.fromISO(v).isValid, 'Timestamp must include a UTC offset').transform(v=>DateTime.fromISO(v).toUTC().toISO()!)
export const taskPatchSchema = z.object({
  list_id:z.string().min(1).max(200).optional(), parent_id:z.string().min(1).max(200).nullable().optional(),
  title:z.string().trim().min(1).max(500).optional(), notes:z.string().max(20000).optional(),
  status:z.enum(['todo','done']).optional(), priority:z.enum(['none','low','medium','high']).optional(),
  due_kind:z.enum(['none','date','datetime']).optional(), due_date:day.nullable().optional(), due_at:instant.nullable().optional(),
  time_zone:z.string().refine(v => IANAZone.isValidZone(v), 'Invalid IANA time zone').nullable().optional(),
  planned_date:day.nullable().optional(), reminder_at:instant.nullable().optional(),
  sort_order:z.number().finite().optional(), tags:z.array(z.string().trim().min(1).max(80)).max(30).optional()
}).strict()
export function parseTaskPatch(value:unknown):TaskPatch { return taskPatchSchema.parse(value) }
const actionSchema=z.object({
  type:z.enum(['create','update','complete','uncomplete','reschedule','delete','add_subtask','set_tags']),
  target_id:z.string().min(1).max(200).optional(),temp_id:z.string().min(1).max(200).optional(),
  expected_version:z.number().int().positive().optional(),patch:taskPatchSchema
}).strict().superRefine((a,ctx)=>{
  if(a.type==='create') {
    if(!a.patch.title || !a.patch.list_id) ctx.addIssue({code:'custom',message:'Create requires title and list_id'})
    if(a.target_id) ctx.addIssue({code:'custom',message:'Create cannot target an existing task'})
  } else if(!a.target_id || !a.expected_version) ctx.addIssue({code:'custom',message:'Updates require target_id and expected_version'})
  if(a.type==='add_subtask' && !a.patch.title) ctx.addIssue({code:'custom',message:'Subtask requires title'})
  const allowed:Record<string,string[]>={complete:[],uncomplete:[],delete:[],reschedule:['due_kind','due_date','due_at','time_zone','planned_date','reminder_at'],set_tags:['tags']}
  if(allowed[a.type] && Object.keys(a.patch).some(k=>!allowed[a.type].includes(k))) ctx.addIssue({code:'custom',message:'Patch contains fields outside action scope'})
  if(a.type==='set_tags' && !a.patch.tags) ctx.addIssue({code:'custom',message:'set_tags requires tags'})
  if(a.type==='reschedule' && !Object.keys(a.patch).length) ctx.addIssue({code:'custom',message:'Reschedule patch is empty'})
})
export const proposalSchema=z.object({version:z.literal(1),summary:z.string().min(1).max(2000),idempotency_key:z.string().min(1).max(200),risk:z.enum(['low','high']),actions:z.array(actionSchema).min(1).max(MAX_ACTIONS)}).strict()
export function parseProposal(value:unknown):ProposalInput {
  // Structured-output transport uses a key/value array so every schema property
  // can be required without confusing an omitted field with an explicit null.
  if(value && typeof value==='object' && Array.isArray((value as any).actions)) {
    value={...value,actions:(value as any).actions.map((raw:any)=>{
      if(!raw || typeof raw!=='object')return raw
      const action={...raw}
      for(const key of ['target_id','temp_id','expected_version'])if(action[key]===null)delete action[key]
      if(Array.isArray(action.patch)) {
        const patch:Record<string,unknown>={}
        for(const entry of action.patch){
          if(!entry || typeof entry!=='object' || Object.keys(entry).sort().join(',')!=='key,value' || typeof entry.key!=='string' || Object.hasOwn(patch,entry.key)) throw new Error('Invalid or duplicate patch field')
          Object.defineProperty(patch,entry.key,{value:entry.value,enumerable:true,writable:true,configurable:true})
        }
        action.patch=patch
      }
      return action
    })}
  }
  const result=proposalSchema.parse(value)
  const targets=result.actions.filter(a=>a.type!=='create').map(a=>a.target_id)
  if(new Set(targets).size!==targets.length) throw new Error('A proposal may change each existing task only once')
  const temps=result.actions.map(a=>a.temp_id).filter(Boolean)
  if(new Set(temps).size!==temps.length) throw new Error('Duplicate temporary task ID')
  if(result.actions.length!==1 || result.actions[0].type!=='create' || result.actions[0].patch.parent_id) result.risk='high'
  return result
}
