import { DateTime } from "luxon";
import { validDate, validZone, taskFromOccurrence } from "./dates";
import type { Occurrence, Recurrence, Snapshot, Task } from "./types";

/** References an existing entity. Moving an occurrence never changes its key. */
export interface CalendarTarget {
  taskId: string;
  seriesId?: string;
  occurrenceKey?: string;
  expectedVersion: number;
  expectedTaskVersion?: number;
}
export interface CalendarChangeRequest {
  target: CalendarTarget;
  field: "planned" | "due";
  date: string | null;
  displayZone: string;
  reminderPolicy?: "keep" | "follow";
  wallTime?: string;
  chosenDueAt?: string;
}
export interface CalendarTimeCandidate {
  dueAt: string;
  label: string;
}
export interface CalendarChangePreview {
  request: CalendarChangeRequest;
  before: Task;
  after: Task | null;
  candidates: CalendarTimeCandidate[];
  warnings: string[];
  requiresConfirmation: boolean;
  requiresTimeChoice: boolean;
  requiresReminderChoice: boolean;
}
export interface CalendarApplyResult {
  undoId: string;
  task: Task;
  occurrence?: Occurrence;
}
export interface CalendarUndoResult {
  task: Task;
  occurrence?: Occurrence;
}
export interface CalendarRow {
  key: string;
  task: Task;
  occurrence?: Occurrence;
  series?: Recurrence;
  primaryDate: string | null;
  dueDate: string | null;
  /** Single list group, even when this entity has two month-grid marks. */
  groupDate: string | null;
}
export interface CalendarEntry {
  key: string;
  row: CalendarRow;
  date: string;
  kind: "task" | "deadline";
}
export interface CalendarDay {
  date: string;
  inMonth: boolean;
  entries: CalendarEntry[];
}
export interface CalendarOptions {
  month: string;
  displayZone: string;
  listId?: string;
  includeCompleted?: boolean;
}
export interface CalendarProjection {
  month: string;
  start: string;
  end: string;
  rows: CalendarRow[];
  entries: CalendarEntry[];
  days: CalendarDay[];
  unscheduled: CalendarRow[];
}

export function calendarMonthRange(month: string): {
  start: string;
  end: string;
} {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || !validDate(`${month}-01`))
    throw new Error("Invalid calendar month / 月份无效");
  const start = DateTime.fromISO(`${month}-01`, { zone: "UTC" });
  const end = start.plus({ months: 1 }).toISODate();
  if (!end || !validDate(end))
    throw new Error("Calendar month out of range / 月份超出范围");
  return { start: start.toISODate()!, end };
}

/** Date-only fields do not undergo timezone conversion. */
export function calendarDueDay(task: Task, displayZone: string): string | null {
  if (!validZone(displayZone)) throw new Error("Invalid time zone / 时区无效");
  if (task.due_kind === "date") return task.due_date;
  if (task.due_kind === "datetime" && task.due_at)
    return DateTime.fromISO(task.due_at, { setZone: true })
      .setZone(displayZone)
      .toISODate();
  return null;
}
export function getCalendarTarget(row: CalendarRow): CalendarTarget {
  return row.occurrence
    ? {
        taskId: row.task.id,
        seriesId: row.occurrence.series_id,
        occurrenceKey: row.occurrence.occurrence_key,
        expectedVersion: row.occurrence.version ?? 1,
        expectedTaskVersion: row.task.version,
      }
    : { taskId: row.task.id, expectedVersion: row.task.version };
}

/**
 * The single query shared by Planned list and month presentations.
 * Counts use rows; a deadline entry is a reference to its row, not a second task.
 */
export function projectCalendar(
  data: Pick<Snapshot, "tasks" | "recurrences" | "occurrences">,
  options: CalendarOptions,
): CalendarProjection {
  if (!validZone(options.displayZone))
    throw new Error("Invalid time zone / 时区无效");
  const { start, end } = calendarMonthRange(options.month);
  const inRange = (date: string | null): date is string =>
    !!date && date >= start && date < end;
  const visible = (task: Task) =>
    !task.deleted_at &&
    !task.parent_id &&
    (options.includeCompleted || task.status === "todo") &&
    (!options.listId ||
      options.listId === "all" ||
      task.list_id === options.listId);
  const seriesByTask = new Map(
    data.recurrences.map((series) => [series.task_id, series]),
  );
  const occurrencesBySeries = new Map<string, Occurrence[]>();
  for (const occurrence of data.occurrences) {
    const instances = occurrencesBySeries.get(occurrence.series_id) ?? [];
    instances.push(occurrence);
    occurrencesBySeries.set(occurrence.series_id, instances);
  }
  const rowsByKey = new Map<string, CalendarRow>();
  const unscheduled: CalendarRow[] = [];
  const add = (task: Task, occurrence?: Occurrence, series?: Recurrence) => {
    if (!visible(task)) return;
    const dueDate = calendarDueDay(task, options.displayZone);
    const primaryDate = task.planned_date || dueDate;
    const row: CalendarRow = {
      key: occurrence
        ? `occurrence:${occurrence.series_id}:${occurrence.occurrence_key}`
        : `task:${task.id}`,
      task,
      occurrence,
      series,
      dueDate,
      primaryDate,
      groupDate: inRange(primaryDate)
        ? primaryDate
        : inRange(dueDate)
          ? dueDate
          : null,
    };
    if (row.groupDate) rowsByKey.set(row.key, row);
    else if (!occurrence && task.due_kind === "none" && !task.planned_date)
      unscheduled.push(row);
  };
  for (const task of data.tasks) {
    if (task.parent_id || task.deleted_at) continue;
    const series = seriesByTask.get(task.id);
    if (!series) {
      add(task);
      continue;
    }
    for (const occurrence of occurrencesBySeries.get(series.id) ?? []) {
      if (occurrence.status === "skipped") continue;
      // Series planned_date is not an instance-level arrangement.
      const projected = {
        ...taskFromOccurrence(task, occurrence, series.tzid),
        planned_date: null,
      };
      add(projected, occurrence, series);
    }
  }
  const compareRows = (a: CalendarRow, b: CalendarRow) =>
    (a.groupDate || "").localeCompare(b.groupDate || "") ||
    Number(a.task.status === "done") - Number(b.task.status === "done") ||
    (a.task.due_at || "").localeCompare(b.task.due_at || "") ||
    a.task.sort_order - b.task.sort_order ||
    a.key.localeCompare(b.key);
  const rows = [...rowsByKey.values()].sort(compareRows);
  unscheduled.sort(compareRows);
  const entries: CalendarEntry[] = [];
  for (const row of rows) {
    if (inRange(row.primaryDate))
      entries.push({
        key: `${row.key}:task`,
        row,
        date: row.primaryDate,
        kind: "task",
      });
    if (inRange(row.dueDate) && row.dueDate !== row.primaryDate)
      entries.push({
        key: `${row.key}:deadline`,
        row,
        date: row.dueDate,
        kind: "deadline",
      });
  }
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(a.kind === "deadline") - Number(b.kind === "deadline") ||
      compareRows(a.row, b.row),
  );
  const monthStart = DateTime.fromISO(start, { zone: "UTC" });
  const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
  const days = Array.from({ length: 42 }, (_, index): CalendarDay => {
    const date = gridStart.plus({ days: index }).toISODate()!;
    return {
      date,
      inMonth: inRange(date),
      entries: entries.filter((entry) => entry.date === date),
    };
  });
  return { month: options.month, start, end, rows, entries, days, unscheduled };
}

export interface CalendarTimeResolution {
  candidates: CalendarTimeCandidate[];
  gap: boolean;
  ambiguous: boolean;
  chosenDueAt: string | null;
  wallTime: string;
}

/** Resolves the displayed wall clock without silently normalizing DST gaps/overlaps. */
export function resolveCalendarTime(
  task: Pick<Task, "due_kind" | "due_at">,
  targetDate: string,
  displayZone: string,
  wallTime?: string,
  chosenDueAt?: string,
): CalendarTimeResolution {
  if (!validDate(targetDate)) throw new Error("Invalid date / 日期无效");
  if (!validZone(displayZone)) throw new Error("Invalid time zone / 时区无效");
  if (task.due_kind !== "datetime" || !task.due_at)
    throw new Error("Task does not have a due time / 任务没有截止时刻");
  const original = DateTime.fromISO(task.due_at, { setZone: true }).setZone(
    displayZone,
  );
  if (!original.isValid) throw new Error("Invalid due time / 截止时刻无效");
  const desired = wallTime ?? original.toFormat("HH:mm:ss.SSS");
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(desired);
  if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59)
    throw new Error("Invalid wall time / 当地时刻无效");
  const hour = +match[1],
    minute = +match[2],
    second = +(match[3] || 0),
    millisecond = +(match[4] || "0").padEnd(3, "0");
  const local = DateTime.fromObject(
    {
      year: +targetDate.slice(0, 4),
      month: +targetDate.slice(5, 7),
      day: +targetDate.slice(8, 10),
      hour,
      minute,
      second,
      millisecond,
    },
    { zone: displayZone },
  );
  const normalizedWallTime =
    `${match[1]}:${match[2]}` +
    (second || millisecond ? `:${String(second).padStart(2, "0")}` : "") +
    (millisecond ? `.${String(millisecond).padStart(3, "0")}` : "");
  const gap =
    !local.isValid ||
    local.toISODate() !== targetDate ||
    local.hour !== hour ||
    local.minute !== minute ||
    local.second !== second ||
    local.millisecond !== millisecond;
  const possible = gap
    ? []
    : local.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
  const candidates = possible.map((candidate) => ({
    dueAt: candidate.toUTC().toISO()!,
    label: `${targetDate} ${normalizedWallTime} ${displayZone} (UTC${candidate.toFormat("ZZ")})`,
  }));
  let chosen: string | null =
    candidates.length === 1 ? candidates[0].dueAt : null;
  if (chosenDueAt !== undefined) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(chosenDueAt))
      throw new Error("Choose a valid due instant / 请选择有效截止时刻");
    const requested = DateTime.fromISO(chosenDueAt, { setZone: true });
    const selected = candidates.find(
      (candidate) =>
        DateTime.fromISO(candidate.dueAt, { setZone: true }).toMillis() ===
        requested.toMillis(),
    );
    if (!selected)
      throw new Error(
        "Due instant is not a candidate / 截止时刻不属于可选时间",
      );
    chosen = selected.dueAt;
  }
  return {
    candidates,
    gap,
    ambiguous: candidates.length > 1,
    chosenDueAt: chosen,
    wallTime: normalizedWallTime,
  };
}
