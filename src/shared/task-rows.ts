import { localDay, taskFromOccurrence, type Clock } from "./dates";
import type { Occurrence, Snapshot, Task } from "./types";

export interface TaskRow { task: Task; occurrence?: Occurrence; template?: boolean }

/** One visible record per task/series, shared by task lists and navigation counts. */
export function projectTaskRows(data: Pick<Snapshot, "tasks" | "recurrences" | "occurrences">, zone: string, now: Clock = new Date()): TaskRow[] {
  const today = localDay(zone, now);
  return data.tasks.filter(task => !task.parent_id && !task.deleted_at).map(task => {
    const series = data.recurrences.find(item => item.task_id === task.id);
    if (!series) return { task };
    const ordered = data.occurrences
      .filter(item => item.series_id === series.id && item.status !== "skipped")
      .sort((a, b) => (a.override_date || a.due_date).localeCompare(b.override_date || b.due_date));
    const occurrence = ordered.find(item => item.status === "todo" && (item.override_date || item.due_date) === today)
      || ordered.find(item => item.status === "todo") || ordered.at(-1);
    return occurrence ? { task: taskFromOccurrence(task, occurrence, series.tzid), occurrence } : { task, template: true };
  });
}
