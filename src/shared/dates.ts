import {DateTime, IANAZone} from 'luxon'
import type {Task, TaskPatch, View, Occurrence} from './types'
export type Clock = Date | string | number
export function instant(now:Clock = new Date()):DateTime {return typeof now === 'string' ? DateTime.fromISO(now,{setZone:true}) : typeof now === 'number' ? DateTime.fromMillis(now) : DateTime.fromJSDate(now)}
export function validZone(zone:string):boolean {return zone === 'UTC' || IANAZone.isValidZone(zone)}
export function localDay(zone:string,now:Clock=new Date()):string {if(!validZone(zone)) throw new Error('Invalid time zone / 时区无效'); return instant(now).setZone(zone).toISODate()!}
export function validDate(value:unknown):value is string {return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value,{zone:'UTC'}).isValid}
export function taskInView(task:Task,view:View,zone:string,now:Clock=new Date(),includeCompleted=false):boolean {
  if((!includeCompleted&&task.status!=='todo')||task.deleted_at) return false
  if(!['today','planned','anytime'].includes(view)) return task.list_id===view
  const day=localDay(zone,now)
  const dueDay=task.due_kind==='datetime'&&task.due_at ? DateTime.fromISO(task.due_at).setZone(zone).toISODate() : task.due_kind==='date' ? task.due_date : null
  const overdue=isOverdue(task,zone,now)
  const today=overdue||dueDay===day||task.planned_date===day
  if(view==='today') return today
  if(view==='planned') return (!!dueDay&&dueDay>day)||!!task.planned_date&&task.planned_date>day
  return task.due_kind==='none'&&!task.planned_date
}
export function isOverdue(task:Task,zone:string,now:Clock=new Date()):boolean {
  return task.due_kind==='datetime'&&task.due_at ? DateTime.fromISO(task.due_at).toMillis()<instant(now).toMillis() : task.due_kind==='date'&&!!task.due_date&&task.due_date<localDay(zone,now)
}
// A moved timed occurrence retains its original wall-clock time in its series zone.
// All views, counters and labels consume this same projected task.
export function taskFromOccurrence(task:Task,occurrence:Occurrence,zone:string):Task {
  let dueAt=occurrence.due_at
  if(dueAt&&occurrence.override_date){
    const original=DateTime.fromISO(dueAt).setZone(zone)
    dueAt=DateTime.fromISO(occurrence.override_date,{zone}).set({hour:original.hour,minute:original.minute,second:original.second,millisecond:original.millisecond}).toUTC().toISO()
  }
  return {...task,status:occurrence.status==='todo'?'todo':'done',due_kind:dueAt?'datetime':'date',due_date:occurrence.override_date||occurrence.due_date,due_at:dueAt,time_zone:dueAt?zone:null,completed_at:occurrence.completed_at,planned_date:occurrence.due_date===task.due_date?task.planned_date:null}
}
export function formatTaskDate(task:Pick<Task,'due_kind'|'due_date'|'due_at'|'time_zone'>,locale='zh'):string {
  if(task.due_kind==='none') return ''
  if(task.due_kind==='date') return DateTime.fromISO(task.due_date!,{zone:'UTC'}).setLocale(locale).toLocaleString(DateTime.DATE_MED)
  return DateTime.fromISO(task.due_at!).setZone(task.time_zone!).setLocale(locale).toFormat('yyyy-MM-dd HH:mm ZZZZ')
}
export function parseNaturalDate(text:string,zone:string,now:Clock=new Date()):TaskPatch&{title:string} {
  if(!validZone(zone)) throw new Error('Invalid time zone / 时区无效')
  let title=text.trim(),base=instant(now).setZone(zone).startOf('day'), day:DateTime|null=null
  const iso=title.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?/)
  if(iso){
    day=DateTime.fromISO(iso[0].replace(' ','T'),{zone})
    if(!day.isValid) throw new Error('Invalid date / 日期无效')
    title=title.replace(iso[0],'').trim()
    if(iso[0].includes(':')) return {title,due_kind:'datetime',due_date:day.toISODate(),due_at:day.toUTC().toISO(),time_zone:zone}
  }else{
    const relative=title.match(/大后天|后天|明天|今天|今日|本月底|这个月底|月底|下周[一二三四五六日天1-7]|(?:本周|这周|周|星期)[一二三四五六日天1-7]|\btomorrow\b|\btoday\b|\bend of (?:the )?month\b/i)
    if(relative){
      const word=relative[0].toLowerCase()
      if(/大后天/.test(word)) day=base.plus({days:3})
      else if(/后天/.test(word)) day=base.plus({days:2})
      else if(/明天|tomorrow/.test(word)) day=base.plus({days:1})
      else if(/月底|month/.test(word)) day=base.endOf('month').startOf('day')
      else if(/周|星期/.test(word)){
        const n=word.at(-1)!,weekday='一二三四五六日'.indexOf(n)+1||('天'===n?7:Number(n))
        day=word.startsWith('下周') ? base.startOf('week').plus({weeks:1,days:weekday-1}) : base.plus({days:(weekday-base.weekday+7)%7})
      }else day=base
      title=title.replace(relative[0],'').trim()
    }
  }
  const time=title.match(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2}|[一二三四五六七八九十两]+)\s*(?:点|:|：)(?:(\d{1,2})\s*分?|半)?|凌晨|早上|上午|中午|下午|傍晚|晚上/)
  if(time){
    day=day||base
    let hour:number,minute=Number(time[3]||0)
    const period=time[1]||time[0],defaults:Record<string,number>={凌晨:1,早上:8,上午:9,中午:12,下午:15,傍晚:18,晚上:20}
    if(time[2]){
      const n=time[2],digits:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}
      hour=/^\d+$/.test(n)?Number(n):n.includes('十')?(n.startsWith('十')?10:digits[n[0]]*10)+(n.endsWith('十')?0:digits[n.at(-1)!]):digits[n]
      if(/下午|傍晚|晚上/.test(period)&&hour<12) hour+=12
      if(/凌晨|上午|早上/.test(period)&&hour===12) hour=0
      if(/中午/.test(period)&&hour<11)hour+=12
      if(time[0].endsWith('半'))minute=30
    }else hour=defaults[period]
    if(!Number.isFinite(hour)||hour>23||minute>59) throw new Error('Invalid time / 时间无效')
    day=day.set({hour,minute,second:0,millisecond:0}); title=title.replace(time[0],'').trim()
    return {title,due_kind:'datetime',due_date:day.toISODate(),due_at:day.toUTC().toISO(),time_zone:zone}
  }
  return day ? {title,due_kind:'date',due_date:day.toISODate(),due_at:null,time_zone:null} : {title,due_kind:'none',due_date:null,due_at:null,time_zone:null}
}
