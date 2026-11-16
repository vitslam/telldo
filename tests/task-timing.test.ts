import { describe,it,expect } from "vitest";
import { TaskService } from "../src/main/task-service";
import { moveTiming,readTiming,timingPatch,reminderForTimeChange,type TimingSelection } from "../src/shared/task-timing";
const zone="Asia/Shanghai";
const empty: TimingSelection={date:"",time:"",reminder:"none",custom:""};
describe("one task time and reminder",()=>{
  it("keeps date-only tasks quiet and defaults a newly selected time to an at-time reminder",()=>{
    const date=moveTiming(empty,"2026-11-20","",zone);
    expect(timingPatch(date,zone)).toMatchObject({due_kind:"date",due_at:null,planned_date:null,reminder_at:null});
    const timed=moveTiming(date,date.date,"15:00",zone);
    expect(timingPatch(timed,zone)).toMatchObject({due_at:"2026-11-20T07:00:00.000Z",reminder_at:"2026-11-20T07:00:00.000Z"});
  });
  it("moves a relative reminder with its time and retains an explicit off choice",()=>{
    const original={date:"2026-11-20",time:"15:00",reminder:"10",custom:""} as TimingSelection;
    const next=timingPatch(moveTiming(original,"2026-11-21","16:00",zone),zone);
    expect(next.reminder_at).toBe("2026-11-21T07:50:00.000Z");
    expect(moveTiming({...original,reminder:"none"},"2026-11-21","16:00",zone).reminder).toBe("none");
    expect(moveTiming(empty,"2026-11-21","16:00",zone,true).reminder).toBe("none");
  });
  it("moves a custom reminder by the same offset and clears standard reminders when time is removed",()=>{
    const original={date:"2026-11-20",time:"15:00",reminder:"custom",custom:"2026-11-19T11:00"} as TimingSelection;
    expect(moveTiming(original,"2026-11-21","16:00",zone).custom).toBe("2026-11-20T12:00");
    expect(timingPatch(moveTiming({...original,reminder:"at"},original.date,"",zone),zone).reminder_at).toBeNull();
  });
  it("reads legacy planned-only dates without changing them until an edit is applied",()=>{
    expect(readTiming({due_kind:"none",planned_date:"2026-11-20"},zone).date).toBe("2026-11-20");
    expect(timingPatch({...empty,date:"2026-11-21"},zone)).toMatchObject({planned_date:null,due_date:"2026-11-21"});
  });
  it("rejects DST gaps and repeated hours instead of silently moving the time",()=>{
    expect(()=>timingPatch({...empty,date:"2026-03-08",time:"02:30"},"America/New_York")).toThrow(/does not exist/);
    expect(()=>timingPatch({...empty,date:"2026-11-01",time:"01:30"},"America/New_York")).toThrow(/occurs twice/);
  });
  it("doesn't alter reminders for non-date edits and honors an explicit override",()=>{
    const old={due_kind:"datetime",due_date:"2026-11-20",due_at:"2026-11-20T07:00:00Z",time_zone:zone,reminder_at:"2026-11-20T06:50:00Z"} as const;
    expect(reminderForTimeChange(old,{},zone)).toBeUndefined();
    expect(reminderForTimeChange(old,{due_at:"2026-11-20T08:00:00Z",reminder_at:null},zone)).toBeNull();
  });
  it("uses the same defaults and follow behavior for AI/manual service writes",()=>{
    const service=new TaskService(":memory:");
    try{
      let task=service.createTask({title:"Review",due_kind:"datetime",due_date:"2026-11-20",due_at:"2026-11-20T07:00:00Z",time_zone:zone});
      expect(task.reminder_at).toBe(task.due_at);
      task=service.updateTask(task.id,task.version,{due_date:"2026-11-21",due_at:"2026-11-21T07:00:00Z"});
      expect(task.reminder_at).toBe("2026-11-21T07:00:00.000Z");
      task=service.updateTask(task.id,task.version,{reminder_at:null});
      task=service.updateTask(task.id,task.version,{due_at:"2026-11-21T08:00:00Z"});
      expect(task.reminder_at).toBeNull();
    }finally{service.close();}
  });
});
