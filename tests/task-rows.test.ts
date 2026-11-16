import { describe, expect, it } from "vitest";
import { projectTaskRows } from "../src/shared/task-rows";
import { taskInView } from "../src/shared/dates";
import type { Occurrence, Recurrence, Task } from "../src/shared/types";
const zone = "Asia/Shanghai", now = "2026-11-16T09:00:00+08:00";
const task: Task = {
  id: "run", list_id: "life", parent_id: null, title: "Morning run", notes: "", status: "todo", priority: "none",
  due_kind: "date", due_date: "2026-11-15", due_at: null, time_zone: null, planned_date: null, reminder_at: null,
  completed_at: null, version: 1, sort_order: 0, created_at: now, updated_at: now, deleted_at: null, tags: [],
};
const series: Recurrence = { id: "weekly", task_id: task.id, rrule: "FREQ=WEEKLY;BYDAY=SU", dtstart: "2026-11-15", tzid: zone, until: "2026-12-31", count: null, exdates: [] };
const occurrences: Occurrence[] = Array.from({ length: 7 }, (_, i) => ({
  series_id: series.id, occurrence_key: String(i), due_date: ["2026-11-15", "2026-11-22", "2026-11-29", "2026-12-06", "2026-12-13", "2026-12-20", "2026-12-27"][i],
  due_at: null, override_date: null, completed_at: now, status: "done",
}));
describe("task rows shared with sidebar counts", () => {
  it("counts zero after all seven repeats are completed, even when the template remains todo", () => {
    const rows = projectTaskRows({ tasks: [task], recurrences: [series], occurrences }, zone, now);
    expect(task.status).toBe("todo");
    expect(rows).toHaveLength(1);
    expect(rows.filter(row => taskInView(row.task, "life", zone, now))).toHaveLength(0);
    expect(rows[0].task.status).toBe("done");
  });
  it("counts a repeat series once when a future occurrence remains and uses the current instance status", () => {
    const remaining = occurrences.map((item, i) => i === 6 ? { ...item, status: "todo" as const, completed_at: null } : item);
    const rows = projectTaskRows({ tasks: [task], recurrences: [series], occurrences: remaining }, zone, now);
    expect(rows.filter(row => taskInView(row.task, "life", zone, now))).toHaveLength(1);
    expect(rows[0].task.due_date).toBe("2026-12-27");
  });
  it("doesn't count subtasks, deleted tasks, or completed ordinary tasks as unfinished list records", () => {
    const tasks = [task, { ...task, id: "child", parent_id: task.id }, { ...task, id: "deleted", deleted_at: now }, { ...task, id: "done", status: "done" as const }];
    const rows = projectTaskRows({ tasks, recurrences: [], occurrences: [] }, zone, now);
    expect(rows.filter(row => taskInView(row.task, "life", zone, now))).toHaveLength(1);
  });
});
