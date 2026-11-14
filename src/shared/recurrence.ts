import { DateTime } from "luxon";
import { RRule } from "rrule";
import { validDate, validZone } from "./dates";
import type { Recurrence, RecurringTaskPatch, TaskPatch } from "./types";

export type RecurrenceSpec = Omit<Recurrence, "id" | "task_id">;

export function validateRecurrence(value: unknown): RecurrenceSpec {
  if (!value || typeof value !== "object")
    throw new Error("Invalid recurrence / 重复规则无效");
  const v = value as Record<string, unknown>;
  if (
    typeof v.rrule !== "string" ||
    v.rrule.length > 200 ||
    typeof v.dtstart !== "string" ||
    typeof v.tzid !== "string" ||
    !validZone(v.tzid)
  )
    throw new Error("Invalid recurrence / 重复规则或时区无效");
  const start = DateTime.fromISO(v.dtstart, { zone: v.tzid });
  if (!start.isValid || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v.dtstart))
    throw new Error("Invalid recurrence start / 重复开始日期无效");
  const parts = v.rrule
      .toUpperCase()
      .replace(/^RRULE:/, "")
      .split(";"),
    map: Record<string, string> = {};
  for (const part of parts) {
    const [k, val, ...rest] = part.split("=");
    if (!val || rest.length || map[k] !== undefined)
      throw new Error("Invalid recurrence rule");
    map[k] = val;
  }
  const allowed = [
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYMONTHDAY",
    "BYSETPOS",
    "COUNT",
    "UNTIL",
    "WKST",
  ];
  if (
    Object.keys(map).some((k) => !allowed.includes(k)) ||
    !["DAILY", "WEEKLY", "MONTHLY"].includes(map.FREQ)
  )
    throw new Error(
      "Only daily, weekly and monthly recurrence is supported / 仅支持日、周、月重复",
    );
  if (map.INTERVAL && map.INTERVAL !== "1")
    throw new Error("MVP recurrence interval must be 1");
  if (map.WKST && map.WKST !== "MO") throw new Error("Week starts Monday");
  if (
    map.BYMONTHDAY &&
    (!/^([1-9]|[12]\d|3[01])$/.test(map.BYMONTHDAY) ||
      map.FREQ !== "MONTHLY" ||
      map.BYDAY)
  )
    throw new Error("Choose one monthly day / 每月只能选一个日期");
  if (
    map.BYDAY &&
    (!/^(?:[1-5]|-1)?(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:[1-5]|-1)?(?:MO|TU|WE|TH|FR|SA|SU))*$/.test(
      map.BYDAY,
    ) ||
      map.FREQ === "DAILY" ||
      (map.FREQ === "WEEKLY" && /[0-9]/.test(map.BYDAY)))
  )
    throw new Error("Invalid weekdays / 星期规则无效");
  if (
    map.BYSETPOS &&
    (!/^(?:[1-5]|-1)$/.test(map.BYSETPOS) ||
      map.FREQ !== "MONTHLY" ||
      !map.BYDAY ||
      /[0-9]/.test(map.BYDAY))
  )
    throw new Error("Invalid monthly weekday position");
  if (map.FREQ === "MONTHLY" && map.BYDAY && map.BYDAY.split(",").length > 1)
    throw new Error("Choose one monthly weekday");
  if (
    map.FREQ === "MONTHLY" &&
    map.BYDAY &&
    !/[0-9]/.test(map.BYDAY) &&
    !map.BYSETPOS
  )
    throw new Error("Monthly weekday requires position");
  let count = v.count ?? (map.COUNT ? Number(map.COUNT) : null),
    until = v.until ?? null;
  if (map.UNTIL) {
    const d = DateTime.fromFormat(map.UNTIL, "yyyyMMdd'T'HHmmss'Z'", {
      zone: "UTC",
    });
    const date = DateTime.fromFormat(map.UNTIL, "yyyyMMdd", { zone: v.tzid });
    if (!d.isValid && !date.isValid) throw new Error("Invalid RRULE end date");
    until = (d.isValid ? d.setZone(v.tzid) : date).toISODate();
  }
  if (
    count !== null &&
    (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 10000)
  )
    throw new Error("Count must be 1–10000");
  if (until !== null && (!validDate(until) || until < start.toISODate()!))
    throw new Error("Invalid recurrence end date");
  if (count !== null && until !== null)
    throw new Error("Choose until or count, not both");
  const exdates = v.exdates ?? [];
  if (
    !Array.isArray(exdates) ||
    exdates.length > 10000 ||
    exdates.some(
      (x) =>
        typeof x !== "string" ||
        !DateTime.fromISO(x, { zone: v.tzid as string }).isValid,
    )
  )
    throw new Error("Invalid excluded dates");
  delete map.COUNT;
  delete map.UNTIL;
  const rrule = Object.entries(map)
    .map(([k, x]) => `${k}=${x}`)
    .join(";");
  RRule.fromString(rrule);
  return {
    rrule,
    dtstart: v.dtstart,
    tzid: v.tzid,
    until: until as string | null,
    count: count as number | null,
    exdates: exdates as string[],
  };
}

/** Split a new recurring task into the same inputs the calendar uses. */
export function splitRecurringTask(patch: RecurringTaskPatch): {
  task: TaskPatch;
  recurrence: RecurrenceSpec;
} {
  const { rrule, dtstart, tzid, until, count, ...task } = patch;
  // End conditions live in explicit fields, never two competing representations.
  if (/(?:^|;)(?:COUNT|UNTIL)=/i.test(rrule.replace(/^RRULE:/i, "")))
    throw new Error("Use separate until/count fields for recurrence bounds");
  const recurrence = validateRecurrence({ rrule, dtstart, tzid, until, count });
  const start = DateTime.fromISO(recurrence.dtstart, {
    zone: recurrence.tzid,
  }).setZone(recurrence.tzid);
  if (
    task.parent_id ||
    (task.status && task.status !== "todo") ||
    !task.title ||
    !task.list_id
  )
    throw new Error("Recurring creation requires a new top-level todo task");
  if (task.due_date !== start.toISODate())
    throw new Error("Task date must match the recurrence start date");
  if (task.due_kind === "date") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dtstart) ||
      task.due_at != null ||
      task.time_zone != null
    )
      throw new Error(
        "Date-only recurrence requires a date-only start and no instant",
      );
  } else if (task.due_kind === "datetime") {
    if (
      !dtstart.includes("T") ||
      !task.due_at ||
      task.time_zone !== recurrence.tzid
    )
      throw new Error(
        "Timed recurrence requires matching start, instant and time zone",
      );
    const due = DateTime.fromISO(task.due_at, { setZone: true });
    if (!due.isValid || due.toMillis() !== start.toMillis())
      throw new Error("Task time must match the recurrence start instant");
    // Reject a nonexistent wall time instead of accepting Luxon's DST shift.
    const localPrefix = dtstart.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/,
    );
    if (
      !localPrefix ||
      start.toFormat("yyyy-MM-dd'T'HH:mm") !== localPrefix[1] ||
      (localPrefix[2] && start.second !== Number(localPrefix[2]))
    )
      throw new Error("Recurrence start is not a valid wall time in this zone");
  } else throw new Error("Recurring tasks require a date");
  const opts = RRule.parseString(recurrence.rrule);
  let matchesStart = false;
  if (opts.freq === RRule.MONTHLY && !opts.byweekday) {
    const requested = Array.isArray(opts.bymonthday)
      ? opts.bymonthday[0]
      : (opts.bymonthday ?? start.day);
    matchesStart = start.day === Math.min(requested, start.daysInMonth!);
  } else {
    const wall = new Date(
      Date.UTC(
        start.year,
        start.month - 1,
        start.day,
        start.hour,
        start.minute,
        start.second,
      ),
    );
    const rule = new RRule({ ...opts, dtstart: wall });
    matchesStart = rule.between(wall, wall, true).length === 1;
  }
  if (!matchesStart)
    throw new Error("Recurrence start must match its repeat rule");
  return { task, recurrence };
}
