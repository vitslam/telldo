import {beforeEach,afterEach,describe,it,expect} from 'vitest'
import Database from '../src/main/sqlite'
import {DateTime} from 'luxon'
import {parseNaturalDate,taskInView,localDay,formatTaskDate,taskFromOccurrence,isOverdue} from '../src/shared/dates'
import {ScheduleService,validateRecurrence} from '../src/main/schedule-service'
import type {Task} from '../src/shared/types'
const now='2026-11-14T04:00:00Z',zone='Asia/Shanghai'
const template:Task={id:'task',list_id:'list',parent_id:null,title:'Example',notes:'',status:'todo',priority:'none',due_kind:'date',due_date:'2026-11-14',due_at:null,time_zone:null,planned_date:null,reminder_at:null,completed_at:null,version:1,sort_order:0,created_at:now,updated_at:now,deleted_at:null,tags:[]}
describe('dates and views',()=>{
  it('parses Chinese embedded dates without mixing dates and instants',()=>{
    expect(parseNaturalDate('明天下午 3 点交周报',zone,now)).toEqual({title:'交周报',due_kind:'datetime',due_date:'2026-11-15',due_at:'2026-11-15T07:00:00.000Z',time_zone:zone})
    expect(parseNaturalDate('明天下午交周报',zone,now).due_at).toBe('2026-11-15T07:00:00.000Z')
    expect(parseNaturalDate('下周五提交',zone,now)).toMatchObject({title:'提交',due_kind:'date',due_date:'2026-11-20',due_at:null,time_zone:null})
    expect(parseNaturalDate('本月底整理',zone,now).due_date).toBe('2026-11-30')
    expect(parseNaturalDate('明天下午三点半复盘',zone,now).due_at).toBe('2026-11-15T07:30:00.000Z')
    expect(()=>parseNaturalDate('2026-02-30',zone,now)).toThrow()
  })
  it('uses calendar comparisons for dates and absolute comparisons for times',()=>{
    expect(taskInView({...template,due_date:'2026-11-13'},'today',zone,now)).toBe(true)
    expect(taskInView({...template,due_date:'2026-11-15'},'planned',zone,now)).toBe(true)
    expect(taskInView({...template,due_kind:'none',due_date:null},'anytime',zone,now)).toBe(true)
    expect(taskInView({...template,due_kind:'none',due_date:null,planned_date:'2026-11-14'},'today',zone,now)).toBe(true)
    expect(taskInView({...template,status:'done'},'today',zone,now)).toBe(false)
    expect(taskInView({...template,due_date:'2026-11-16',planned_date:'2026-11-14'},'today',zone,now)).toBe(true)
    expect(taskInView({...template,due_date:'2026-11-16',planned_date:'2026-11-14'},'planned',zone,now)).toBe(true)
    expect(taskInView({...template,due_kind:'datetime',due_at:'2026-11-14T03:00:00Z',time_zone:'America/Los_Angeles'},'today',zone,now)).toBe(true)
  })
  it('projects a moved timed occurrence consistently for views and labels',()=>{
    const timed={...template,due_kind:'datetime' as const,due_date:'2026-11-13',due_at:'2026-11-13T01:00:00.000Z',time_zone:zone}
    const moved=taskFromOccurrence(timed,{series_id:'series',occurrence_key:'2026-11-13T09:00:00',status:'todo',due_date:'2026-11-13',due_at:'2026-11-13T01:00:00.000Z',override_date:'2026-11-16',completed_at:null},zone)
    expect(moved.due_at).toBe('2026-11-16T01:00:00.000Z')
    expect(taskInView(moved,'today',zone,now)).toBe(false)
    expect(taskInView(moved,'planned',zone,now)).toBe(true)
    expect(formatTaskDate(moved)).toContain('2026-11-16 09:00')
    expect(isOverdue(moved,zone,now)).toBe(false)
    expect(isOverdue({...timed,due_date:'2026-11-14',due_at:'2026-11-14T01:00:00.000Z'},zone,now)).toBe(true)
    expect(taskInView({...moved,status:'done'},'planned',zone,now,true)).toBe(true)
    const later=taskFromOccurrence({...timed,planned_date:'2026-11-14'},{series_id:'series',occurrence_key:'2026-11-16T09:00:00',status:'todo',due_date:'2026-11-16',due_at:'2026-11-16T01:00:00.000Z',override_date:null,completed_at:null},zone)
    expect(later.planned_date).toBeNull()
    expect(taskInView(later,'today',zone,now)).toBe(false)
  })
  it('honors overridden/system zones while date-only values remain invariant',()=>{
    const at='2026-11-14T01:00:00Z',timed={...template,due_kind:'datetime' as const,due_at:'2026-11-14T12:00:00Z',time_zone:'America/New_York'}
    expect(localDay('America/Los_Angeles',at)).toBe('2026-11-13')
    expect(taskInView(template,'today','America/Los_Angeles',at)).toBe(false)
    expect(taskInView(template,'today',zone,at)).toBe(true)
    expect(formatTaskDate(timed,'en')).toContain('07:00')
    expect(taskInView(timed,'planned','America/Los_Angeles',at)).toBe(true)
    expect(taskInView(timed,'today',zone,at)).toBe(true)
  })
})
describe('recurrence and notifications',()=>{
 let db:Database.Database,schedules:ScheduleService
 beforeEach(()=>{db=new Database(':memory:');db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,deleted_at TEXT,parent_id TEXT,due_kind TEXT,due_date TEXT,due_at TEXT,time_zone TEXT,reminder_at TEXT)`);schedules=new ScheduleService(db)})
 afterEach(()=>db?.close())
 function add(task:Partial<Task>={}){const t={...template,...task};db.prepare('INSERT INTO tasks(id,title,status,deleted_at,parent_id,due_kind,due_date,due_at,time_zone,reminder_at) VALUES(@id,@title,@status,@deleted_at,@parent_id,@due_kind,@due_date,@due_at,@time_zone,@reminder_at)').run(t);return t}
 it('clamps monthly 31st to short-month end and does not generate duplicates',()=>{
   add({due_date:'2026-01-31'})
   const r=schedules.setRecurrence('task',{rrule:'FREQ=MONTHLY;BYMONTHDAY=31',dtstart:'2026-01-31',tzid:zone,count:4})
   schedules.materialize(now)
   expect(schedules.listOccurrences().map(x=>x.due_date)).toEqual(['2026-01-31','2026-02-28','2026-03-31','2026-04-30'])
   expect(schedules.materialize(now)).toBe(0)
   schedules.updateOccurrence(r.id,'2026-02-28',{status:'done'})
   schedules.updateOccurrence(r.id,'2026-03-31',{override_date:'2026-04-02'})
   schedules.updateOccurrence(r.id,'2026-04-30',{status:'skipped'})
   schedules.materialize(now)
   expect(schedules.listOccurrences().map(x=>x.occurrence_key)).toEqual(['2026-01-31','2026-02-28','2026-03-31','2026-04-30'])
   expect(schedules.listOccurrences()[2].override_date).toBe('2026-04-02')
 })
 it('keeps far-future series visible while respecting exclusions and count',()=>{
   add({due_date:'2038-01-01'})
   schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2038-01-01',tzid:zone,count:3,exdates:['2038-01-01']})
   schedules.materialize(now)
   expect(schedules.listOccurrences().map(x=>x.due_date)).toEqual(['2038-01-02'])
   schedules.removeRecurrence('task')
   schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2038-01-01',tzid:zone,count:1,exdates:['2038-01-01']})
   expect(schedules.listOccurrences()).toEqual([])
 })
 it('keeps timed recurrence at wall-clock time across daylight saving',()=>{
   add({due_kind:'datetime',due_date:'2026-03-07',due_at:'2026-03-07T14:00:00Z',time_zone:'America/New_York'})
   schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2026-03-07T09:00:00',tzid:'America/New_York',count:3})
   expect(schedules.listOccurrences().map(x=>x.due_at)).toEqual(['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z'])
 })
 it('preserves original occurrence keys when DST skips a local clock time',()=>{
   add({due_kind:'datetime',due_date:'2026-03-07',due_at:'2026-03-07T07:30:00Z',time_zone:'America/New_York'})
   schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2026-03-07T02:30:00',tzid:'America/New_York',count:3})
   expect(schedules.listOccurrences().map(x=>x.occurrence_key)).toEqual(['2026-03-07T02:30:00','2026-03-08T02:30:00','2026-03-09T02:30:00'])
   expect(DateTime.fromISO(schedules.listOccurrences()[1].due_at!).setZone('America/New_York').hour).toBe(3)
 })
 it('supports weekdays, nth weekday, until and exclusions',()=>{
   add({due_date:'2026-01-01'})
   schedules.setRecurrence('task',{rrule:'FREQ=MONTHLY;BYDAY=2MO',dtstart:'2026-01-01',tzid:'UTC',until:'2026-03-31',exdates:['2026-02-09']})
   expect(schedules.listOccurrences().map(x=>x.due_date)).toEqual(['2026-01-12','2026-03-09'])
   schedules.removeRecurrence('task')
   schedules.setRecurrence('task',{rrule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',dtstart:'2026-11-13',tzid:'UTC',count:3})
   expect(schedules.listOccurrences().map(x=>x.due_date)).toEqual(['2026-11-13','2026-11-16','2026-11-17'])
 })
 it('fires normal and startup overdue reminders only once, even after restart',()=>{
   add({reminder_at:'2026-11-14T03:00:00Z'})
   expect(schedules.dueNotifications('2026-11-14T02:00:00Z')).toHaveLength(0)
   expect(schedules.dueNotifications(now)).toHaveLength(1)
   expect(new ScheduleService(db).dueNotifications(now,true)).toHaveLength(0)
   add({id:'second',reminder_at:'2026-11-12T03:00:00Z'})
   add({id:'third',reminder_at:'2026-11-13T03:00:00Z'})
   expect(schedules.dueNotifications(now,true)).toHaveLength(2)
   expect(new ScheduleService(db).dueNotifications(now,true)).toHaveLength(0)
   expect(db.prepare('SELECT count(*) n FROM notification_log WHERE suppressed=1').get()).toEqual({n:2})
 })
 it('reminds once per recurring instance and excludes done/skipped instances',()=>{
   add({due_date:'2026-11-12',reminder_at:'2026-11-12T01:00:00Z'})
   const r=schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2026-11-12',tzid:zone,count:3})
   schedules.updateOccurrence(r.id,'2026-11-12',{status:'done'})
   schedules.updateOccurrence(r.id,'2026-11-13',{status:'skipped'})
   expect(schedules.dueNotifications(now,true)).toMatchObject([{taskId:'task',occurrenceKey:'2026-11-14'}])
   expect(schedules.dueNotifications(now,true)).toHaveLength(0)
 })
 it('keeps date-only recurring reminders at local wall time through DST',()=>{
   add({due_date:'2026-03-07',reminder_at:'2026-03-07T14:00:00Z'})
   schedules.setRecurrence('task',{rrule:'FREQ=DAILY',dtstart:'2026-03-07',tzid:'America/New_York',count:3})
   schedules.dueNotifications('2026-03-09T20:00:00Z')
   const times=db.prepare('SELECT fire_at FROM notification_log ORDER BY fire_at').all() as {fire_at:string}[]
   expect(times.map(x=>DateTime.fromISO(x.fire_at).setZone('America/New_York').hour)).toEqual([9,9,9])
 })
 it('rejects unsupported or ambiguous recurrence',()=>{
   for(const rrule of ['FREQ=YEARLY','FREQ=MONTHLY;BYMONTHDAY=32','FREQ=MONTHLY;BYDAY=MO','FREQ=WEEKLY;BYDAY=2MO','FREQ=DAILY;INTERVAL=0','FREQ=DAILY;UNTIL=notadate','FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=2'])expect(()=>validateRecurrence({rrule,dtstart:'2026-01-01',tzid:'UTC'})).toThrow()
   expect(()=>validateRecurrence({rrule:'FREQ=DAILY',dtstart:'2026-01-01',tzid:'UTC',count:2,until:'2026-12-31'})).toThrow()
 })
})
