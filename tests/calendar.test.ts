import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  calendarDueDay,
  calendarMonthRange,
  getCalendarTarget,
  projectCalendar,
  resolveCalendarTime,
} from "../src/shared/calendar";
import type { Occurrence, Recurrence, Task } from "../src/shared/types";

const zone = "Asia/Shanghai";
const base: Task = {
  id: "task",
  list_id: "work",
  parent_id: null,
  title: "Task",
  notes: "",
  status: "todo",
  priority: "none",
  due_kind: "date",
  due_date: "2026-11-14",
  due_at: null,
  time_zone: null,
  planned_date: null,
  reminder_at: null,
  completed_at: null,
  version: 4,
  sort_order: 0,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  deleted_at: null,
  tags: [],
};
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  ...base,
  id,
  ...patch,
});
const project = (
  tasks: Task[],
  extra: Partial<Parameters<typeof projectCalendar>[1]> = {},
) =>
  projectCalendar(
    { tasks, recurrences: [], occurrences: [] },
    {
      month: "2026-11",
      displayZone: zone,
      ...extra,
    },
  );
const timed = (instant: string): Task =>
  task("timed", {
    due_kind: "datetime",
    due_at: instant,
    time_zone: "America/New_York",
  });

describe("shared Planned month projection", () => {
  it("keeps list and month entity sets identical across both-date month boundaries", () => {
    const tasks = [
      task("both", { planned_date: "2026-11-16", due_date: "2026-11-20" }),
      task("deadline-only", {
        planned_date: "2026-10-30",
        due_date: "2026-11-25",
      }),
      task("planned-only", {
        planned_date: "2026-11-30",
        due_date: "2026-12-02",
      }),
      task("same-day", { planned_date: "2026-11-18", due_date: "2026-11-18" }),
      task("outside", { planned_date: "2026-10-31", due_date: "2026-12-01" }),
      task("past", { due_date: "2026-11-01" }),
    ];
    const original = JSON.stringify(tasks),
      result = project(tasks);
    expect(result.rows).toHaveLength(5);
    expect(result.entries).toHaveLength(6);
    expect(
      [...new Set(result.entries.map((entry) => entry.row.key))].sort(),
    ).toEqual(result.rows.map((row) => row.key).sort());
    expect(
      result.rows.find((row) => row.task.id === "deadline-only")?.groupDate,
    ).toBe("2026-11-25");
    expect(
      result.entries.filter((entry) => entry.row.task.id === "deadline-only"),
    ).toMatchObject([{ date: "2026-11-25", kind: "deadline" }]);
    expect(
      result.entries.filter((entry) => entry.row.task.id === "same-day"),
    ).toMatchObject([{ date: "2026-11-18", kind: "task" }]);
    expect(
      result.days
        .filter((day) => !day.inMonth)
        .every((day) => day.entries.length === 0),
    ).toBe(true);
    expect(result.days[0].date).toBe("2026-10-26");
    expect(result.days).toHaveLength(42);
    expect(JSON.stringify(tasks)).toBe(original);
  });

  it("shares completed/list filters and top-level task semantics with the pending drawer", () => {
    const tasks = [
      task("done", { status: "done" }),
      task("other", { list_id: "life" }),
      task("child", { parent_id: "done" }),
      task("deleted", { deleted_at: "2026-11-01T00:00:00Z" }),
      task("pending", { due_kind: "none", due_date: null }),
      task("done-pending", {
        due_kind: "none",
        due_date: null,
        status: "done",
      }),
      task("child-pending", {
        due_kind: "none",
        due_date: null,
        parent_id: "pending",
      }),
    ];
    const hidden = project(tasks, { listId: "work" });
    expect(hidden.rows).toHaveLength(0);
    expect(hidden.unscheduled.map((row) => row.task.id)).toEqual(["pending"]);
    const all = project(tasks, { listId: "work", includeCompleted: true });
    expect(all.rows.map((row) => row.task.id)).toEqual(["done"]);
    expect(all.unscheduled.map((row) => row.task.id).sort()).toEqual([
      "done-pending",
      "pending",
    ]);
  });

  it("places instants by display timezone while keeping pure and planned dates stable", () => {
    const tasks = [
      timed("2026-12-01T00:30:00Z"),
      task("date", { due_date: "2026-11-30" }),
      task("plan", {
        due_kind: "none",
        due_date: null,
        planned_date: "2026-11-30",
      }),
    ];
    const west = project(tasks, { displayZone: "America/Los_Angeles" });
    const east = project(tasks, { displayZone: "Asia/Tokyo" });
    expect(west.rows.map((row) => row.task.id).sort()).toEqual([
      "date",
      "plan",
      "timed",
    ]);
    expect(east.rows.map((row) => row.task.id).sort()).toEqual([
      "date",
      "plan",
    ]);
    expect(calendarDueDay(tasks[0], "America/Los_Angeles")).toBe("2026-11-30");
    expect(calendarDueDay(tasks[1], "Pacific/Kiritimati")).toBe("2026-11-30");
  });

  it("uses original recurrence keys, hides templates/skips, and ignores template planned dates", () => {
    const template = task("repeat", {
      due_date: "2026-10-30",
      planned_date: "2026-11-12",
    });
    const series: Recurrence = {
      id: "series",
      task_id: template.id,
      rrule: "FREQ=DAILY",
      dtstart: "2026-10-30",
      tzid: zone,
      until: null,
      count: null,
      exdates: [],
    };
    const instance = (
      date: string,
      patch: Partial<Occurrence> = {},
    ): Occurrence => ({
      series_id: series.id,
      occurrence_key: date,
      status: "todo",
      due_date: date,
      due_at: null,
      override_date: null,
      completed_at: null,
      version: 3,
      ...patch,
    });
    const data = {
      tasks: [template],
      recurrences: [series],
      occurrences: [
        instance("2026-10-30", { override_date: "2026-11-06" }),
        instance("2026-11-01"),
        instance("2026-11-02", { status: "done" }),
        instance("2026-11-03", { status: "skipped" }),
        instance("2026-11-04", { override_date: "2026-12-04" }),
      ],
    };
    const result = projectCalendar(data, {
      month: "2026-11",
      displayZone: zone,
    });
    expect(result.rows).toHaveLength(2);
    const moved = result.rows.find(
      (row) => row.occurrence?.occurrence_key === "2026-10-30",
    )!;
    expect(moved.key).toBe("occurrence:series:2026-10-30");
    expect(moved.task.planned_date).toBeNull();
    expect(moved.primaryDate).toBe("2026-11-06");
    expect(getCalendarTarget(moved)).toEqual({
      taskId: "repeat",
      seriesId: "series",
      occurrenceKey: "2026-10-30",
      expectedVersion: 3,
      expectedTaskVersion: 4,
    });
    expect(result.unscheduled).toEqual([]);
    expect(result.entries.every((entry) => entry.kind === "task")).toBe(true);
    expect(
      projectCalendar(data, {
        month: "2026-11",
        displayZone: zone,
        includeCompleted: true,
      }).rows,
    ).toHaveLength(3);
    expect(
      projectCalendar(
        { ...data, occurrences: [] },
        { month: "2026-11", displayZone: zone },
      ).rows,
    ).toEqual([]);
  });

  it("validates month boundaries including leap years and year transitions", () => {
    expect(calendarMonthRange("2024-02")).toEqual({
      start: "2024-02-01",
      end: "2024-03-01",
    });
    expect(calendarMonthRange("2026-12")).toEqual({
      start: "2026-12-01",
      end: "2027-01-01",
    });
    for (const invalid of [
      "2026-13",
      "2026-2",
      "2026-00",
      "2026-11-01",
      "9999-12",
    ])
      expect(() => calendarMonthRange(invalid)).toThrow();
    expect(() => project([], { displayZone: "invalid-zone" })).toThrow();
  });
});

describe("calendar wall-time resolution", () => {
  it("preserves display-zone wall time, not a fixed UTC offset or the task zone clock", () => {
    const result = resolveCalendarTime(
      timed("2026-03-07T14:00:00Z"),
      "2026-03-08",
      "Europe/Paris",
    );
    expect(result.chosenDueAt).toBe("2026-03-08T14:00:00.000Z");
    expect(result.wallTime).toBe("15:00");
    expect(result.gap).toBe(false);
    expect(result.ambiguous).toBe(false);
    expect(
      DateTime.fromISO(result.chosenDueAt!).setZone("America/New_York").hour,
    ).toBe(10);
  });

  it("does not normalize a nonexistent DST time and allows an explicit valid replacement", () => {
    const current = timed("2026-03-07T07:30:00Z");
    const gap = resolveCalendarTime(current, "2026-03-08", "America/New_York");
    expect(gap).toMatchObject({
      gap: true,
      ambiguous: false,
      candidates: [],
      chosenDueAt: null,
      wallTime: "02:30",
    });
    const replacement = resolveCalendarTime(
      current,
      "2026-03-08",
      "America/New_York",
      "03:30",
    );
    expect(replacement.chosenDueAt).toBe("2026-03-08T07:30:00.000Z");
    expect(() =>
      resolveCalendarTime(
        current,
        "2026-03-08",
        "America/New_York",
        undefined,
        "2026-03-08T07:30:00Z",
      ),
    ).toThrow();
  });

  it("requires an explicit instant in a repeated DST hour", () => {
    const current = timed("2026-10-31T05:30:00Z");
    const overlap = resolveCalendarTime(
      current,
      "2026-11-01",
      "America/New_York",
    );
    expect(overlap.ambiguous).toBe(true);
    expect(overlap.chosenDueAt).toBeNull();
    expect(overlap.candidates.map((candidate) => candidate.dueAt)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
    const later = resolveCalendarTime(
      current,
      "2026-11-01",
      "America/New_York",
      undefined,
      "2026-11-01T06:30:00Z",
    );
    expect(later.chosenDueAt).toBe("2026-11-01T06:30:00.000Z");
    expect(() =>
      resolveCalendarTime(
        current,
        "2026-11-01",
        "America/New_York",
        undefined,
        "2026-11-01T07:30:00Z",
      ),
    ).toThrow();
  });

  it("preserves seconds and milliseconds and rejects malformed values", () => {
    const result = resolveCalendarTime(
      timed("2026-11-14T03:04:05.678Z"),
      "2026-11-15",
      zone,
    );
    expect(result.chosenDueAt).toBe("2026-11-15T03:04:05.678Z");
    expect(
      resolveCalendarTime(
        timed("2026-11-14T03:00:00Z"),
        "2026-11-15",
        zone,
        "12:01:02.5",
      ).chosenDueAt,
    ).toBe("2026-11-15T04:01:02.500Z");
    expect(() => resolveCalendarTime(base, "2026-11-15", zone)).toThrow();
    expect(() =>
      resolveCalendarTime(timed("2026-11-14T03:00:00Z"), "2026-02-30", zone),
    ).toThrow();
    expect(() =>
      resolveCalendarTime(
        timed("2026-11-14T03:00:00Z"),
        "2026-11-15",
        "bad-zone",
      ),
    ).toThrow();
    for (const bad of ["24:00", "12:60", "12:01:60", "1:00", "12:01junk"])
      expect(() =>
        resolveCalendarTime(
          timed("2026-11-14T03:00:00Z"),
          "2026-11-15",
          zone,
          bad,
        ),
      ).toThrow();
  });
});
