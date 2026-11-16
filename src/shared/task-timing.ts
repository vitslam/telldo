import { DateTime } from "luxon";
import type { TaskPatch } from "./types";
export type TimingFields = Pick<TaskPatch,"due_kind"|"due_date"|"due_at"|"time_zone"|"planned_date"|"reminder_at">;
export interface TimingSelection { date: string; time: string; reminder: "none"|"at"|"10"|"60"|"custom"; custom: string; }
export function readTiming(value: TimingFields, zone: string): TimingSelection {
  const timed = value.due_kind === "datetime" && value.due_at ? DateTime.fromISO(value.due_at).setZone(zone) : null;
  const date = timed?.toISODate() || value.due_date || value.planned_date || "";
  let reminder: TimingSelection["reminder"] = "none";
  if(value.reminder_at) {
    const lead = timed ? timed.toMillis()-DateTime.fromISO(value.reminder_at).toMillis() : NaN;
    reminder = lead === 0 ? "at" : lead === 600000 ? "10" : lead === 3600000 ? "60" : "custom";
  }
  return { date, time: timed?.toFormat("HH:mm") || "", reminder,
    custom: value.reminder_at ? DateTime.fromISO(value.reminder_at).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm") : "" };
}
function wall(value: string, zone: string) {
  const date = DateTime.fromISO(value,{zone});
  if(!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value)
    throw Error("这个时间不存在，请选择其他时刻 / This local time does not exist. Choose another time.");
  if(date.getPossibleOffsets().length > 1)
    throw Error("这个时刻因夏令时出现两次，请选择其他时刻 / This local time occurs twice. Choose another time.");
  return date;
}
export function timingPatch(selection: TimingSelection, zone: string): TimingFields {
  const {date,time,reminder,custom} = selection;
  if(time && !date) throw Error("请先选择日期 / Choose a date first");
  const at = date && time ? wall(`${date}T${time}`,zone) : null;
  if(date && !DateTime.fromISO(date,{zone}).isValid) throw Error("日期无效 / Invalid date");
  let reminderAt: string|null = null;
  if(reminder === "custom") {
    if(!custom) throw Error("请选择提醒时间 / Choose a reminder time");
    reminderAt = wall(custom,zone).toUTC().toISO();
  } else if(reminder !== "none") {
    if(!at) throw Error("请先选择具体时间，或使用自定义提醒 / Choose a time, or use a custom reminder");
    reminderAt = at.minus({minutes:reminder === "at" ? 0 : Number(reminder)}).toUTC().toISO();
  }
  return {due_kind: at ? "datetime" : date ? "date" : "none",due_date:date || null,due_at:at?.toUTC().toISO() || null,time_zone:at ? zone : null,planned_date:null,reminder_at:reminderAt};
}
export function moveTiming(previous: TimingSelection, date: string, time: string, zone: string, reminderTouched=false): TimingSelection {
  const next = {...previous,date,time};
  if(!time && previous.reminder !== "custom") next.reminder="none";
  else if(time && !previous.time && !reminderTouched && previous.reminder === "none") next.reminder="at";
  if(previous.reminder === "custom" && previous.custom && previous.date && date) {
    const original = DateTime.fromISO(`${previous.date}T${previous.time || "00:00"}`,{zone});
    const changed = DateTime.fromISO(`${date}T${time || "00:00"}`,{zone});
    const reminder = DateTime.fromISO(previous.custom,{zone});
    if(original.isValid && changed.isValid && reminder.isValid)
      next.custom = previous.time && time
        ? reminder.plus({milliseconds:changed.toMillis()-original.toMillis()}).toFormat("yyyy-MM-dd'T'HH:mm")
        : reminder.plus({days:DateTime.fromISO(date,{zone}).diff(DateTime.fromISO(previous.date,{zone}),"days").days}).toFormat("yyyy-MM-dd'T'HH:mm");
  }
  return next;
}

/** Omitted reminder means follow the task's time; an explicit null means off. */
export function reminderForTimeChange(before: TimingFields, patch: TimingFields, zone: string): string|null|undefined {
  if(patch.reminder_at !== undefined) return patch.reminder_at;
  if(!["due_kind","due_date","due_at","planned_date"].some(key=>Object.prototype.hasOwnProperty.call(patch,key))) return undefined;
  const next={...before,...patch};
  const previous=readTiming(before,zone), selected=readTiming(next,zone);
  if(previous.date===selected.date && previous.time===selected.time) return undefined;
  if(!selected.date) return null;
  if(next.due_kind === "datetime" && next.due_at) {
    if(before.due_kind === "datetime" && before.due_at) {
      if(!before.reminder_at) return null;
      return DateTime.fromISO(next.due_at).plus({milliseconds:DateTime.fromISO(before.reminder_at).toMillis()-DateTime.fromISO(before.due_at).toMillis()}).toUTC().toISO();
    }
    if(!before.reminder_at) return next.due_at;
  }
  return timingPatch(moveTiming(previous,selected.date,selected.time,zone),zone).reminder_at;
}
