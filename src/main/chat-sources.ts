import type { ContextScheduleItem } from "./context-repository";
import type { ChatSource } from "../shared/conversation";
import type { Task, List } from "../shared/types";
import type { MemoAttachment } from "../shared/memo";

type RecordSource = {
  id: string;
  title: string;
  body: string;
  summary: string;
  created_at: string;
  attachments: unknown[];
};
/** Bounded display snapshots of records already retrieved in this turn. */
export function chatSources(
  tasks: Task[],
  records: RecordSource[],
  lists: Pick<List, "id" | "name">[],
  attachments: (id: string) => MemoAttachment[],
  schedule: ContextScheduleItem[] = [],
): ChatSource[] {
  const files = (values: unknown[]): NonNullable<ChatSource["attachments"]> =>
    values.slice(0, 3).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const file = value as Record<string, unknown>;
      if (typeof file.id !== "string" || typeof file.name !== "string")
        return [];
      const kind =
        file.kind === "image" ? ("image" as const) : ("file" as const);
      return [
        {
          id: file.id,
          name: file.name.slice(0, 200),
          kind,
          ...(kind === "image"
            ? {
                previewUrl: `telldo-memo://attachment/${encodeURIComponent(file.id)}`,
              }
            : {}),
        },
      ];
    });
  const scheduled = schedule
    .filter(
      (item, index, items) =>
        !tasks.some((task) => task.id === item.task_id) &&
        items.findIndex((other) => other.task_id === item.task_id) === index,
    )
    .slice(0, Math.max(0, 6 - tasks.length));
  return [
    ...tasks.slice(0, 6).map((task): ChatSource => ({
      kind: "task",
      id: task.id,
      title: task.title.slice(0, 200),
      text: task.notes.slice(0, 500),
      listName: lists.find((list) => list.id === task.list_id)?.name,
      status: task.status,
      dueDate: task.due_date || task.planned_date || undefined,
      dueAt: task.due_at || undefined,
      timeZone: task.time_zone || undefined,
      attachments: files(attachments(task.id)),
    })),
    ...scheduled.map((item): ChatSource => ({
      kind: "task",
      id: item.task_id,
      title: item.title.slice(0, 200),
      status: item.status,
      listName: lists.find((list) => list.id === item.list_id)?.name,
      dueDate: item.due_date || item.planned_date || undefined,
      dueAt: item.due_at || undefined,
      timeZone: item.time_zone || undefined,
    })),
    ...records
      .slice(0, Math.max(0, 6 - tasks.length - scheduled.length))
      .map((record): ChatSource => ({
        kind: "memo",
        id: record.id,
        title: record.title.slice(0, 200),
        text: (record.body || record.summary).slice(0, 500),
        createdAt: record.created_at,
        attachments: files(record.attachments),
      })),
  ];
}
