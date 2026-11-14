import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "../src/main/task-service";
import { CalendarService } from "../src/main/calendar-service";
import { ScheduleService } from "../src/main/schedule-service";
import Database from "../src/main/sqlite";
import { taskFromOccurrence } from "../src/shared/dates";
import {
  projectCalendar,
  type CalendarChangeRequest,
} from "../src/shared/calendar";
import type { Task, TaskPatch, Occurrence } from "../src/shared/types";

describe("calendar transactions", () => {
  let service: TaskService, calendar: CalendarService;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T04:00:00Z"));
    service = new TaskService(":memory:");
    calendar = new CalendarService(service);
  });
  afterEach(() => {
    service.close();
    vi.useRealTimers();
  });
  const add = (patch: TaskPatch = {}) =>
    service.createTask({
      title: "Date test",
      due_kind: "date",
      due_date: "2026-11-20",
      ...patch,
    });
  const request = (
    task: Task,
    field: "planned" | "due",
    date: string | null,
    extra: Partial<CalendarChangeRequest> = {},
  ): CalendarChangeRequest => ({
    target: { taskId: task.id, expectedVersion: task.version },
    field,
    date,
    displayZone: "Asia/Shanghai",
    ...extra,
  });
  function repeat(task: Task, extra: Record<string, unknown> = {}) {
    const series = service.schedules.setRecurrence(task.id, {
      rrule: "FREQ=DAILY",
      dtstart:
        task.due_kind === "datetime" ? "2026-11-20T09:00:00" : task.due_date,
      tzid: "Asia/Shanghai",
      count: 3,
      ...extra,
    });
    const occurrence = service.schedules
      .listOccurrences()
      .find((o) => o.series_id === series.id)!;
    const target = {
      taskId: task.id,
      seriesId: series.id,
      occurrenceKey: occurrence.occurrence_key,
      expectedVersion: occurrence.version!,
      expectedTaskVersion: task.version,
    };
    return { series, occurrence, target };
  }
  it("moves only planned date, preserves reminder state, and durably undoes", () => {
    const t = add({
      planned_date: "2026-11-16",
      reminder_at: "2026-11-13T01:00:00Z",
    });
    const changed = calendar.apply(request(t, "planned", "2026-11-18"));
    expect(changed.task).toMatchObject({
      planned_date: "2026-11-18",
      due_date: t.due_date,
      reminder_at: t.reminder_at,
      version: 2,
    });
    expect(
      service.db.prepare("SELECT * FROM notification_log").all(),
    ).toHaveLength(0);
    expect(service.schedules.dueNotifications()).toHaveLength(1);
    const restored = new CalendarService(service).undo(changed.undoId);
    expect(restored.task).toMatchObject({
      planned_date: t.planned_date,
      version: 3,
    });
    expect(() => calendar.undo(changed.undoId)).toThrow();
  });
  it("moves a date-only deadline without inventing a plan or time", () => {
    const t = add(),
      r = calendar.apply(request(t, "due", "2026-12-01"));
    expect(r.task).toMatchObject({
      due_kind: "date",
      due_date: "2026-12-01",
      due_at: null,
      time_zone: null,
      planned_date: null,
    });
    expect(() => calendar.apply(request(t, "due", "2026-12-02"))).toThrow(
      /Version conflict/,
    );
  });
  it("requires explicit reminder choice and preserves absolute keep choice", () => {
    const t = add({ reminder_at: "2026-11-20T01:00:00Z" }),
      req = request(t, "due", "2026-11-22");
    expect(calendar.preview(req).requiresReminderChoice).toBe(true);
    expect(() => calendar.apply(req)).toThrow(/choices/);
    expect(
      calendar.preview({ ...req, reminderPolicy: "follow" }).after?.reminder_at,
    ).toBe("2026-11-22T01:00:00.000Z");
    expect(
      calendar.apply({ ...req, reminderPolicy: "keep" }).task.reminder_at,
    ).toBe(t.reminder_at);
  });
  it("rejects undo after a newer task edit without losing either change", () => {
    const t = add(),
      r = calendar.apply(request(t, "due", "2026-11-22"));
    service.updateTask(t.id, r.task.version, { notes: "later edit" });
    expect(() => calendar.undo(r.undoId)).toThrow(/Cannot undo/);
    expect(service.getTask(t.id)).toMatchObject({
      due_date: "2026-11-22",
      notes: "later edit",
    });
  });
  it("changes only one repeat instance with stable key and reminder keep override", () => {
    const t = add({ reminder_at: "2026-11-20T01:00:00Z" }),
      { series, occurrence, target } = repeat(t);
    const r = calendar.apply({
      target,
      field: "due",
      date: "2026-11-25",
      displayZone: "Asia/Shanghai",
      reminderPolicy: "keep",
    });
    expect(r.occurrence).toMatchObject({
      occurrence_key: occurrence.occurrence_key,
      override_date: "2026-11-25",
      version: 2,
      reminder_override: "explicit",
      override_reminder_at: t.reminder_at,
    });
    expect(
      service.schedules
        .listOccurrences()
        .filter((o) => o.series_id === series.id && o.override_date),
    ).toHaveLength(1);
    expect(service.getTask(t.id)).toEqual(t);
    expect(calendar.undo(r.undoId).occurrence).toMatchObject({
      occurrence_key: occurrence.occurrence_key,
      override_date: null,
      reminder_override: "inherit",
      version: 3,
    });
  });
  it("rejects instance undo after completion or template edits", () => {
    const t = add(),
      { target, occurrence } = repeat(t);
    const r = calendar.apply({
      target,
      field: "due",
      date: "2026-11-25",
      displayZone: "UTC",
    });
    service.schedules.updateOccurrence(
      occurrence.series_id,
      occurrence.occurrence_key,
      { status: "done" },
      r.occurrence!.version,
    );
    expect(() => calendar.undo(r.undoId)).toThrow(/Cannot undo/);
    expect(() =>
      calendar.apply({
        target,
        field: "due",
        date: "2026-11-26",
        displayZone: "UTC",
      }),
    ).toThrow(/Version conflict/);
    service.updateTask(t.id, t.version, { title: "Changed template" });
    expect(() =>
      calendar.apply({
        target: { ...target, expectedVersion: 3 },
        field: "due",
        date: "2026-11-26",
        displayZone: "UTC",
      }),
    ).toThrow(/Version conflict/);
  });
  it("preserves displayed wall time across original-zone DST by storing explicit instant", () => {
    const t = add({
      due_kind: "datetime",
      due_date: "2026-11-20",
      due_at: "2026-11-20T01:00:00Z",
      time_zone: "Asia/Shanghai",
    });
    const { target, series } = repeat(t);
    // November 19 at 17:00 Los Angeles -> July 4 at 17:00 = July 5 00:00Z.
    const req: CalendarChangeRequest = {
      target,
      field: "due",
      date: "2026-07-04",
      displayZone: "America/Los_Angeles",
    };
    const r = calendar.apply(req);
    expect(r.occurrence?.override_due_at).toBe("2026-07-05T00:00:00.000Z");
    expect(taskFromOccurrence(t, r.occurrence!, series.tzid).due_at).toBe(
      "2026-07-05T00:00:00.000Z",
    );
    const exportData = service.exportData() as any;
    const imported = new TaskService(":memory:");
    try {
      imported.importData(exportData);
      expect(
        imported.schedules.listOccurrences().find((o) => o.override_due_at)
          ?.override_due_at,
      ).toBe(r.occurrence?.override_due_at);
    } finally {
      imported.close();
    }
  });
  it("does not commit nonexistent or ambiguous local times without resolving them", () => {
    const t = add({
      due_kind: "datetime",
      due_date: "2026-03-07",
      due_at: "2026-03-07T07:30:00Z",
      time_zone: "America/New_York",
    });
    const req = request(t, "due", "2026-03-08", {
      displayZone: "America/New_York",
    });
    expect(calendar.preview(req)).toMatchObject({
      after: null,
      requiresTimeChoice: true,
    });
    expect(() => calendar.apply(req)).toThrow();
    const fixed = calendar.preview({ ...req, wallTime: "03:30" });
    expect(fixed.after?.due_at).toBe("2026-03-08T07:30:00.000Z");
    const overlap = { ...req, date: "2026-11-01", wallTime: "01:30" };
    const choices = calendar.preview(overlap);
    expect(choices.candidates).toHaveLength(2);
    expect(() => calendar.apply(overlap)).toThrow();
    expect(
      calendar.apply({ ...overlap, chosenDueAt: choices.candidates[1].dueAt })
        .task.due_at,
    ).toBe(choices.candidates[1].dueAt);
  });
  it("suppresses explicitly moved past reminders and does not replay them after undo", () => {
    const t = add({ reminder_at: "2026-11-20T01:00:00Z" });
    const r = calendar.apply(
      request(t, "due", "2026-11-10", { reminderPolicy: "follow" }),
    );
    expect(service.schedules.dueNotifications()).toEqual([]);
    calendar.undo(r.undoId);
    expect(
      service.schedules.dueNotifications("2026-11-20T02:00:00Z"),
    ).toHaveLength(1);
    expect(
      service.schedules.dueNotifications("2026-11-20T03:00:00Z"),
    ).toHaveLength(0);
  });
  it("keeps date-only follow reminders at wall time through DST", () => {
    const t = add({
      due_date: "2026-03-07",
      reminder_at: "2026-03-07T14:00:00Z",
    });
    const result = calendar.preview(
      request(t, "due", "2026-03-08", {
        displayZone: "America/New_York",
        reminderPolicy: "follow",
      }),
    );
    expect(result.after?.reminder_at).toBe("2026-03-08T13:00:00.000Z");
  });
  it("imports and exports explicit per-instance reminder overrides", () => {
    const t = add({ reminder_at: "2026-11-20T01:00:00Z" }),
      { target } = repeat(t);
    calendar.apply({
      target,
      field: "due",
      date: "2026-11-25",
      displayZone: "UTC",
      reminderPolicy: "keep",
    });
    const copy = new TaskService(":memory:");
    try {
      copy.importData(service.exportData());
      const o = copy.schedules.listOccurrences().find((o) => o.override_date);
      expect(o).toMatchObject({
        reminder_override: "explicit",
        override_reminder_at: t.reminder_at,
      });
      expect(
        copy.schedules.dueNotifications("2026-11-20T02:00:00Z"),
      ).toHaveLength(1);
    } finally {
      copy.close();
    }
  });
  it("generates a far month without filling intervening history and merges moved-in instances", () => {
    const t = add({ due_date: "2020-01-01" }),
      { series } = repeat(t, { dtstart: "2020-01-01", count: null });
    service.db.prepare("DELETE FROM occurrences").run();
    expect(
      service.schedules.materializeRange(
        "2040-02-01",
        "2040-03-01",
        "Asia/Shanghai",
      ),
    ).toBe(29);
    expect(service.schedules.listOccurrences()).toHaveLength(29);
    const o = service.schedules.listOccurrences()[0];
    calendar.apply({
      target: {
        taskId: t.id,
        seriesId: series.id,
        occurrenceKey: o.occurrence_key,
        expectedVersion: o.version!,
        expectedTaskVersion: t.version,
      },
      field: "due",
      date: "2040-03-15",
      displayZone: "Asia/Shanghai",
    });
    service.schedules.materializeRange(
      "2040-03-01",
      "2040-04-01",
      "Asia/Shanghai",
    );
    const projected = projectCalendar(
      {
        tasks: service.listTasks(),
        recurrences: service.schedules.listRecurrences(),
        occurrences: service.schedules.listOccurrences(),
      },
      { month: "2040-03", displayZone: "Asia/Shanghai" },
    );
    expect(projected.rows).toHaveLength(32);
    expect(
      projected.rows.find(
        (r) => r.occurrence?.occurrence_key === o.occurrence_key,
      )?.dueDate,
    ).toBe("2040-03-15");
  });
  it("range generation honors clamped month days, COUNT and exclusions", () => {
    const t = add({ due_date: "2026-01-31" });
    repeat(t, {
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
      dtstart: "2026-01-31",
      count: 4,
      exdates: ["2026-03-31"],
    });
    service.db.prepare("DELETE FROM occurrences").run();
    expect(
      service.schedules.materializeRange("2026-02-01", "2026-03-01", "UTC"),
    ).toBe(1);
    expect(service.schedules.listOccurrences()[0].due_date).toBe("2026-02-28");
    expect(
      service.schedules.materializeRange("2026-03-01", "2026-04-01", "UTC"),
    ).toBe(0);
    expect(
      service.schedules.materializeRange("2026-05-01", "2026-06-01", "UTC"),
    ).toBe(0);
  });
  it("range browsing never creates overdue notifications", () => {
    const t = add({
      due_date: "2026-01-01",
      reminder_at: "2026-01-01T01:00:00Z",
    });
    repeat(t, { dtstart: "2026-01-01", count: 3 });
    service.db.prepare("DELETE FROM occurrences").run();
    service.schedules.materializeRange("2026-01-01", "2026-02-01", "UTC");
    expect(service.schedules.dueNotifications()).toHaveLength(0);
  });
  it("migrates legacy occurrence rows without losing identity or completion", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE recurrences(id TEXT PRIMARY KEY,task_id TEXT,rrule TEXT,dtstart TEXT,tzid TEXT,until TEXT,count INTEGER,exdates TEXT); CREATE TABLE occurrences(series_id TEXT,occurrence_key TEXT,status TEXT,due_date TEXT,due_at TEXT,override_date TEXT,completed_at TEXT,PRIMARY KEY(series_id,occurrence_key)); INSERT INTO occurrences VALUES('series','2026-11-20','done','2026-11-20',NULL,'2026-11-21','2026-11-21T00:00:00Z')",
      );
      const schedules = new ScheduleService(db);
      expect(schedules.listOccurrences()[0]).toMatchObject({
        occurrence_key: "2026-11-20",
        status: "done",
        override_date: "2026-11-21",
        version: 1,
        override_due_at: null,
        reminder_override: "inherit",
        override_reminder_at: null,
      });
      new ScheduleService(db);
      expect(schedules.listOccurrences()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
