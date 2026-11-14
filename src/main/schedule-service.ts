import type Database from "./sqlite";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { RRule } from "rrule";
import type { Task, Recurrence, Occurrence } from "../shared/types";
import {
  instant,
  validZone,
  validDate,
  occurrenceReminderAt,
  type Clock,
} from "../shared/dates";
export type RecurrenceSpec = Omit<Recurrence, "id" | "task_id">;
export interface Reminder {
  taskId: string;
  title: string;
  body?: string;
  seriesId?: string;
  occurrenceKey?: string;
}
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
export class ScheduleService {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS recurrences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),rrule TEXT NOT NULL,dtstart TEXT NOT NULL,tzid TEXT NOT NULL,until TEXT,count INTEGER,exdates TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS occurrences(series_id TEXT NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,occurrence_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'todo',due_date TEXT NOT NULL,due_at TEXT,override_date TEXT,completed_at TEXT,PRIMARY KEY(series_id,occurrence_key));
      CREATE TABLE IF NOT EXISTS notification_log(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,fire_at TEXT NOT NULL,fired_at TEXT,suppressed INTEGER NOT NULL DEFAULT 0,UNIQUE(target_id,fire_at));`);
    this.migrateOccurrences();
  }
  private migrateOccurrences() {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(occurrences)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, definition] of Object.entries({
      version: "INTEGER NOT NULL DEFAULT 1",
      override_due_at: "TEXT",
      reminder_override: "TEXT NOT NULL DEFAULT 'inherit'",
      override_reminder_at: "TEXT",
    }))
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE occurrences ADD COLUMN ${name} ${definition}`,
        );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS occurrence_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,series_id TEXT NOT NULL,occurrence_key TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL)",
    );
  }
  listRecurrences(): Recurrence[] {
    return (
      this.db.prepare("SELECT * FROM recurrences").all() as (Omit<
        Recurrence,
        "exdates"
      > & { exdates: string })[]
    ).map((x) => ({ ...x, exdates: JSON.parse(x.exdates) }));
  }
  listOccurrences(): Occurrence[] {
    return this.db
      .prepare("SELECT * FROM occurrences ORDER BY due_date,occurrence_key")
      .all() as Occurrence[];
  }
  setRecurrence(taskId: string, value: unknown): Recurrence {
    const spec = validateRecurrence(value),
      task = this.db
        .prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL")
        .get(taskId) as Task | undefined;
    if (!task) throw new Error("Task not found / 任务不存在");
    if (task.status === "done")
      throw new Error(
        "Reopen the task before making it recurring / 请先恢复任务再设置重复",
      );
    if (task.due_kind === "none" || task.parent_id)
      throw new Error(
        "Recurring tasks need a date and must be top-level / 重复任务必须是有日期的顶层任务",
      );
    const existing = this.listRecurrences().find((x) => x.task_id === taskId);
    if (existing) {
      if (
        JSON.stringify({ ...existing, id: undefined, task_id: undefined }) ===
        JSON.stringify({ ...spec, id: undefined, task_id: undefined })
      )
        return existing;
      if (
        this.db
          .prepare("SELECT 1 FROM occurrences WHERE series_id=? LIMIT 1")
          .get(existing.id)
      )
        throw new Error(
          "Remove the existing series before replacing its rule / 请先移除现有系列再设置新规则",
        );
    }
    const r = { ...spec, id: existing?.id ?? randomUUID(), task_id: taskId };
    return this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO recurrences(id,task_id,rrule,dtstart,tzid,until,count,exdates) VALUES(@id,@task_id,@rrule,@dtstart,@tzid,@until,@count,@exdates) ON CONFLICT(id) DO UPDATE SET rrule=excluded.rrule,dtstart=excluded.dtstart,tzid=excluded.tzid,until=excluded.until,count=excluded.count,exdates=excluded.exdates",
        )
        .run({ ...r, exdates: JSON.stringify(r.exdates) });
      this.materialize();
      return r;
    })();
  }
  removeRecurrence(taskId: string): void {
    this.db.transaction(() => {
      const r = this.listRecurrences().find((x) => x.task_id === taskId);
      if (!r) return;
      this.db.prepare("DELETE FROM occurrences WHERE series_id=?").run(r.id);
      this.db.prepare("DELETE FROM recurrences WHERE id=?").run(r.id);
    })();
  }
  materialize(now: Clock = new Date(), horizonDays = 90): number {
    if (!Number.isInteger(horizonDays) || horizonDays < 0 || horizonDays > 3660)
      throw new Error("Invalid horizon");
    return this.db.transaction(() => {
      let inserted = 0;
      const put = this.db.prepare(
        "INSERT OR IGNORE INTO occurrences(series_id,occurrence_key,status,due_date,due_at,override_date,completed_at) VALUES(?,?,'todo',?,?,NULL,NULL)",
      );
      for (const series of this.listRecurrences()) {
        const task = this.db
          .prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL")
          .get(series.task_id) as Task | undefined;
        if (!task || task.status === "done") continue;
        const start = DateTime.fromISO(series.dtstart, {
            zone: series.tzid,
          }).setZone(series.tzid),
          end = instant(now)
            .setZone(series.tzid)
            .plus({ days: horizonDays })
            .endOf("day");
        // Keep a first reachable instance even when the series starts beyond the rolling window.
        // One year after the last exclusion covers every supported monthly weekday pattern.
        const excluded = (d: DateTime) =>
          series.exdates.includes(d.toISODate()!) ||
          series.exdates.includes(
            `${d.toISODate()}T${start.toFormat("HH:mm:ss")}`,
          );
        const anchor = series.exdates.reduce(
          (latest, x) => {
            const d = DateTime.fromISO(x, { zone: series.tzid });
            return d > latest ? d : latest;
          },
          start > end ? start : end,
        );
        const searchEnd = anchor.plus({ years: 1 }).endOf("day"),
          stop = series.until
            ? DateTime.fromISO(series.until, { zone: series.tzid }).endOf("day")
            : searchEnd,
          limit = stop < searchEnd ? stop : searchEnd;
        if (start > limit) continue;
        let finished = false,
          hasWindowOccurrence = false;
        const accept = (d: DateTime) => {
          if (finished) return false;
          if (d <= end) {
            if (
              d >= instant(now).setZone(series.tzid).startOf("day") &&
              !excluded(d)
            )
              hasWindowOccurrence = true;
            return true;
          }
          if (hasWindowOccurrence) return false;
          if (!excluded(d)) finished = true;
          return true;
        };
        const opts = RRule.parseString(series.rrule),
          wall = (d: DateTime) =>
            new Date(
              Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second),
            );
        const fromWall = (d: Date) =>
          DateTime.fromObject(
            {
              year: d.getUTCFullYear(),
              month: d.getUTCMonth() + 1,
              day: d.getUTCDate(),
              hour: d.getUTCHours(),
              minute: d.getUTCMinutes(),
              second: d.getUTCSeconds(),
            },
            { zone: series.tzid },
          );
        let dates: DateTime[] = [];
        if (opts.freq === RRule.MONTHLY && !opts.byweekday) {
          // RFC RRULE skips short months. Telldo's explicit policy clamps a monthly day.
          const requested = Array.isArray(opts.bymonthday)
            ? opts.bymonthday[0]
            : (opts.bymonthday ?? start.day);
          for (
            let month = start.startOf("month"), n = 0;
            month <= limit;
            month = month.plus({ months: 1 })
          ) {
            const d = month.set({
              day: Math.min(requested, month.daysInMonth!),
              hour: start.hour,
              minute: start.minute,
              second: start.second,
            });
            if (d < start || d > limit) continue;
            if (series.count !== null && n >= series.count) break;
            if (!accept(d)) break;
            dates.push(d);
            n++;
            if (dates.length > 10000)
              throw new Error("Recurrence window is too large");
          }
        } else {
          const rule = new RRule({
            ...opts,
            dtstart: wall(start),
            count: series.count ?? undefined,
          });
          dates = rule
            .between(
              wall(start),
              wall(limit),
              true,
              (d, i) => i < 10000 && accept(fromWall(d)),
            )
            .map(fromWall);
        }
        for (const date of dates) {
          const timed = task.due_kind === "datetime",
            key = timed
              ? `${date.toISODate()}T${start.toFormat("HH:mm:ss")}`
              : date.toISODate()!;
          if (
            series.exdates.includes(key) ||
            series.exdates.includes(date.toISODate()!)
          )
            continue;
          inserted += put.run(
            series.id,
            key,
            date.toISODate(),
            timed ? date.toUTC().toISO() : null,
          ).changes;
        }
      }
      return inserted;
    })();
  }
  /** Generate only the requested month-sized window; stored overrides are never replaced. */
  materializeRange(
    startDay: string,
    endDay: string,
    displayZone: string,
  ): number {
    if (!validDate(startDay) || !validDate(endDay) || !validZone(displayZone))
      throw Error("Invalid calendar range");
    const startRange = DateTime.fromISO(startDay, { zone: displayZone }),
      endRange = DateTime.fromISO(endDay, { zone: displayZone });
    if (endRange <= startRange || endRange.diff(startRange, "days").days > 62)
      throw Error("Calendar range must be at most 62 days");
    return this.db.transaction(() => {
      let inserted = 0;
      const put = this.db.prepare(
        "INSERT OR IGNORE INTO occurrences(series_id,occurrence_key,status,due_date,due_at,override_date,completed_at) VALUES(?,?,'todo',?,?,NULL,NULL)",
      );
      for (const series of this.listRecurrences()) {
        const task = this.db
          .prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL")
          .get(series.task_id) as Task | undefined;
        if (!task || task.status === "done") continue;
        const start = DateTime.fromISO(series.dtstart, {
          zone: series.tzid,
        }).setZone(series.tzid);
        const timed = task.due_kind === "datetime";
        const lo = timed
          ? startRange.setZone(series.tzid).startOf("day")
          : DateTime.fromISO(startDay, { zone: series.tzid });
        const hi = timed
          ? endRange.setZone(series.tzid).endOf("day")
          : DateTime.fromISO(endDay, { zone: series.tzid });
        const until = series.until
          ? DateTime.fromISO(series.until, { zone: series.tzid }).endOf("day")
          : hi;
        if (start > hi || until < lo) continue;
        const opts = RRule.parseString(series.rrule),
          dates: DateTime[] = [];
        const wall = (d: DateTime) =>
          new Date(
            Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second),
          );
        const fromWall = (d: Date) =>
          DateTime.fromObject(
            {
              year: d.getUTCFullYear(),
              month: d.getUTCMonth() + 1,
              day: d.getUTCDate(),
              hour: d.getUTCHours(),
              minute: d.getUTCMinutes(),
              second: d.getUTCSeconds(),
            },
            { zone: series.tzid },
          );
        if (opts.freq === RRule.MONTHLY && !opts.byweekday) {
          const requested = Array.isArray(opts.bymonthday)
            ? opts.bymonthday[0]
            : (opts.bymonthday ?? start.day);
          const first = start
            .startOf("month")
            .set({
              day: Math.min(requested, start.daysInMonth!),
              hour: start.hour,
              minute: start.minute,
              second: start.second,
            });
          const skippedFirst = first < start ? 1 : 0;
          for (
            let month = lo.startOf("month");
            month <= hi;
            month = month.plus({ months: 1 })
          ) {
            const n =
              (month.year - start.year) * 12 +
              month.month -
              start.month -
              skippedFirst;
            if (n < 0 || (series.count !== null && n >= series.count)) continue;
            dates.push(
              month.set({
                day: Math.min(requested, month.daysInMonth!),
                hour: start.hour,
                minute: start.minute,
                second: start.second,
              }),
            );
          }
        } else {
          // With no COUNT there is no reason to iterate every historical occurrence.
          // A weekly anchor retains the original weekday when BYDAY was omitted.
          let anchor = start;
          if (series.count === null && lo > start) {
            anchor = (
              opts.freq === RRule.WEEKLY
                ? lo.startOf("week")
                : lo.startOf("month")
            ).set({
              hour: start.hour,
              minute: start.minute,
              second: start.second,
            });
            if (opts.freq === RRule.DAILY)
              anchor = lo.set({
                hour: start.hour,
                minute: start.minute,
                second: start.second,
              });
            if (opts.freq === RRule.WEEKLY && !opts.byweekday)
              opts.byweekday = [start.weekday - 1];
            if (anchor < start) anchor = start;
          }
          const rule = new RRule({
            ...opts,
            dtstart: wall(anchor),
            count: series.count ?? undefined,
          });
          dates.push(...rule.between(wall(lo), wall(hi), true).map(fromWall));
        }
        for (const date of dates) {
          if (date < start || date > until) continue;
          const visibleDay = timed
            ? date.setZone(displayZone).toISODate()!
            : date.toISODate()!;
          if (visibleDay < startDay || visibleDay >= endDay) continue;
          const key = timed
            ? `${date.toISODate()}T${start.toFormat("HH:mm:ss")}`
            : date.toISODate()!;
          if (
            series.exdates.includes(key) ||
            series.exdates.includes(date.toISODate()!)
          )
            continue;
          const changes = put.run(
            series.id,
            key,
            date.toISODate(),
            timed ? date.toUTC().toISO() : null,
          ).changes;
          inserted += changes;
          // Browsing history must not enqueue previously unseen overdue notifications.
          if (changes) {
            const occurrence = this.db
              .prepare(
                "SELECT * FROM occurrences WHERE series_id=? AND occurrence_key=?",
              )
              .get(series.id, key) as Occurrence;
            const reminder = occurrenceReminderAt(
              task,
              occurrence,
              series.tzid,
            );
            if (reminder && DateTime.fromISO(reminder).toMillis() < Date.now())
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO notification_log VALUES(?,?,?,?,1)",
                )
                .run(
                  randomUUID(),
                  `${series.id}:${key}`,
                  DateTime.fromISO(reminder).toUTC().toISO(),
                  new Date().toISOString(),
                );
          }
        }
      }
      return inserted;
    })();
  }
  updateOccurrence(
    seriesId: string,
    key: string,
    patch: {
      status?: Occurrence["status"];
      override_date?: string | null;
      override_due_at?: string | null;
      reminder_override?: "inherit" | "explicit";
      override_reminder_at?: string | null;
    },
    expectedVersion?: number,
  ): Occurrence {
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some(
        (k) =>
          ![
            "status",
            "override_date",
            "override_due_at",
            "reminder_override",
            "override_reminder_at",
          ].includes(k),
      ) ||
      (patch.status !== undefined &&
        !["todo", "done", "skipped"].includes(patch.status)) ||
      (patch.override_date !== undefined &&
        patch.override_date !== null &&
        !validDate(patch.override_date)) ||
      (patch.reminder_override !== undefined &&
        !["inherit", "explicit"].includes(patch.reminder_override)) ||
      [patch.override_due_at, patch.override_reminder_at].some(
        (x) =>
          x !== undefined &&
          x !== null &&
          (typeof x !== "string" ||
            !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(x) ||
            !DateTime.fromISO(x).isValid),
      )
    )
      throw Error("Invalid occurrence update / 重复实例修改无效");
    return this.db.transaction(() => {
      const o = this.db
        .prepare(
          "SELECT * FROM occurrences WHERE series_id=? AND occurrence_key=?",
        )
        .get(seriesId, key) as Occurrence | undefined;
      if (!o) throw Error("Occurrence not found / 重复实例不存在");
      if (
        expectedVersion !== undefined &&
        (!Number.isSafeInteger(expectedVersion) ||
          expectedVersion !== o.version)
      )
        throw Error("Version conflict / 实例已改变，请刷新后重试");
      if (!o.due_at && patch.override_due_at)
        throw Error("Date-only occurrence cannot have a timed override");
      const after: Occurrence = {
        ...o,
        ...patch,
        version: (o.version ?? 1) + 1,
      };
      if (
        patch.override_date !== undefined &&
        patch.override_due_at === undefined
      )
        after.override_due_at = null;
      after.completed_at =
        after.status === "done"
          ? (o.completed_at ?? new Date().toISOString())
          : null;
      this.db
        .prepare(
          "UPDATE occurrences SET status=@status,override_date=@override_date,completed_at=@completed_at,version=@version,override_due_at=@override_due_at,reminder_override=@reminder_override,override_reminder_at=@override_reminder_at WHERE series_id=@series_id AND occurrence_key=@occurrence_key",
        )
        .run(after);
      this.db
        .prepare("INSERT INTO occurrence_audit VALUES(?,?,?,?,?,?)")
        .run(
          randomUUID(),
          new Date().toISOString(),
          seriesId,
          key,
          JSON.stringify(o),
          JSON.stringify(after),
        );
      return after;
    })();
  }
  dueNotifications(now: Clock = new Date(), startup = false): Reminder[] {
    this.materialize(now);
    return this.db.transaction(() => {
      const at = instant(now),
        result: Reminder[] = [],
        series = this.listRecurrences(),
        recurring = new Set(series.map((x) => x.task_id)),
        tasks = this.db
          .prepare(
            "SELECT * FROM tasks WHERE deleted_at IS NULL AND status='todo' ",
          )
          .all() as Task[];
      const log = this.db.prepare(
        "INSERT OR IGNORE INTO notification_log(id,target_id,fire_at,fired_at,suppressed) VALUES(?,?,?,?,?)",
      );
      const fire = (target: string, time: DateTime, reminder: Reminder) => {
        if (
          time.isValid &&
          time <= at &&
          log.run(
            randomUUID(),
            target,
            time.toUTC().toISO(),
            at.toUTC().toISO(),
            startup ? 1 : 0,
          ).changes
        )
          result.push(reminder);
      };
      for (const task of tasks) {
        if (!recurring.has(task.id)) {
          if (!task.reminder_at) continue;
          fire(task.id, DateTime.fromISO(task.reminder_at), {
            taskId: task.id,
            title: task.title,
          });
          continue;
        }
        const s = series.find((x) => x.task_id === task.id)!;
        for (const o of this.db
          .prepare(
            "SELECT * FROM occurrences WHERE series_id=? AND status='todo'",
          )
          .all(s.id) as Occurrence[]) {
          const reminderAt = occurrenceReminderAt(task, o, s.tzid);
          if (!reminderAt) continue;
          const fireAt = DateTime.fromISO(reminderAt);
          fire(`${s.id}:${o.occurrence_key}`, fireAt, {
            taskId: task.id,
            title: task.title,
            body: o.override_date ?? o.due_date,
            seriesId: s.id,
            occurrenceKey: o.occurrence_key,
          });
        }
      }
      return result;
    })();
  }
}
