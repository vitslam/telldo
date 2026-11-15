import { DateTime } from "luxon";
import {
  parseContextQuery,
  type ContextQuery,
  type SearchContextQuery,
} from "../shared/context-query";
import type { Task, Occurrence } from "../shared/types";
import type { MemoAttachment } from "../shared/memo";
import { taskFromOccurrence } from "../shared/dates";
import type { TaskService } from "./task-service";
import type { MemoService } from "./memo-service";

export interface ContextQueryResult {
  entity: "tasks" | "memos" | "schedule";
  filters: {
    keywords?: string;
    status?: string;
    list_id?: string;
    from?: string;
    to?: string;
  };
  total: number;
  returned: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
  truncated: boolean;
  coverage: string;
}
export interface ContextMemo {
  id: string;
  title: string;
  body: string;
  summary: string;
  created_at: string;
  attachments: MemoAttachment[];
}
export interface ContextRecurrence {
  task_id: string;
  expected_version: number;
  title: string;
  list_id: string;
  rrule: string;
  dtstart: string;
  tzid: string;
  until: string | null;
  count: number | null;
  reminder_at: string | null;
}
export interface ContextScheduleItem {
  task_id: string;
  title: string;
  list_id: string;
  status: Task["status"];
  due_kind: Task["due_kind"];
  due_date: string | null;
  due_at: string | null;
  time_zone: string | null;
  planned_date: string | null;
  series_id?: string;
  occurrence_key?: string;
}
export interface ContextResult {
  queryResult: ContextQueryResult;
  tasks?: Task[];
  memoInventory?: { total: number; included: number };
  memoSearchResults?: ContextMemo[];
  readOnlyRecurrences?: {
    total: number;
    included: number;
    series: ContextRecurrence[];
  };
  readOnlySchedule?: {
    from: string;
    to: string;
    total: number;
    included: number;
    coverage: string;
    instances: ContextScheduleItem[];
  };
}
type Parameters = Record<string, string | number | null>;
const cut = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + "…" : text;
const queryTerms = (query: SearchContextQuery) =>
  query.keywords?.trim().split(/\s+/).filter(Boolean).slice(0, 8) || [];
function filters(query: SearchContextQuery): ContextQueryResult["filters"] {
  return Object.fromEntries(
    ["keywords", "status", "list_id", "from", "to"]
      .filter((key) => (query as any)[key] !== undefined)
      .map((key) => [key, (query as any)[key]]),
  );
}
function page(
  query: SearchContextQuery,
  total: number,
  returned: number,
  limit: number,
  coverage: string,
  contentTruncated = false,
): ContextQueryResult {
  const offset = query.offset || 0;
  const hasMore = offset + returned < total;
  return {
    entity: query.entity,
    filters: filters(query),
    total,
    returned,
    limit,
    offset,
    nextOffset: hasMore ? offset + returned : null,
    hasMore,
    truncated: hasMore || offset > 0 || contentTruncated,
    coverage,
  };
}
/** SQL filters/count/limit are applied before any task or memo body is hydrated. */
export class ContextRepository {
  constructor(
    private readonly service: TaskService,
    private readonly memos: MemoService,
    private readonly getZone: () => string = () =>
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    service.db.function("telldo_context_day", (iso: unknown, zone: unknown) => {
      if (typeof iso !== "string" || typeof zone !== "string") return null;
      return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toISODate();
    });
    service.db.function(
      "telldo_context_occurrence_at",
      (
        original: unknown,
        movedDay: unknown,
        override: unknown,
        zone: unknown,
      ) => {
        if (typeof override === "string") return override;
        if (typeof original !== "string" || typeof zone !== "string")
          return null;
        let date = DateTime.fromISO(original).setZone(zone);
        if (typeof movedDay === "string")
          date = DateTime.fromISO(movedDay, { zone }).set({
            hour: date.hour,
            minute: date.minute,
            second: date.second,
            millisecond: date.millisecond,
          });
        return date.toUTC().toISO();
      },
    );
  }
  inventory() {
    const counts = this.service.db
      .prepare(
        "SELECT COUNT(*) AS total,COALESCE(SUM(status='todo'),0) AS todo,COALESCE(SUM(status='done'),0) AS done FROM tasks WHERE deleted_at IS NULL",
      )
      .get()!;
    const recurring = this.service.db
      .prepare(
        "SELECT COUNT(*) AS n FROM recurrences r JOIN tasks t ON t.id=r.task_id WHERE t.deleted_at IS NULL",
      )
      .get()!;
    return {
      ordinaryTotal: Number(counts.total),
      ordinaryTodo: Number(counts.todo),
      ordinaryDone: Number(counts.done),
      recurringSeries: Number(recurring.n),
      includesSubtasks: true,
    };
  }
  memoInventory() {
    return {
      total: Number(
        this.memos.db
          .prepare(
            "SELECT COUNT(*) AS n FROM memos WHERE staged=0 AND deleted_at IS NULL",
          )
          .get()!.n,
      ),
      included: 0,
    };
  }
  lists(limit = 30): { id: string; name: string }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("Invalid list metadata limit");
    return this.service.db
      .prepare(
        "SELECT id,name FROM lists WHERE archived_at IS NULL ORDER BY sort_order,created_at,id LIMIT ?",
      )
      .all(limit) as { id: string; name: string }[];
  }
  retrieve(value: ContextQuery): ContextResult {
    const query = parseContextQuery(value);
    if (query.entity === "record")
      throw Error("Record references must be resolved explicitly by the host");
    if (query.entity === "tasks") return this.tasks(query);
    if (query.entity === "memos") return this.memoPage(query);
    return this.schedule(query);
  }
  private taskConditions(
    query: SearchContextQuery,
    params: Parameters,
    statusExpression = "t.status",
  ) {
    const conditions = ["t.deleted_at IS NULL"];
    if (query.status && query.status !== "all") {
      conditions.push(`${statusExpression}=:status`);
      params.status = query.status;
    }
    if (query.list_id) {
      conditions.push("t.list_id=:listId");
      params.listId = query.list_id;
    }
    queryTerms(query).forEach((term, index) => {
      const key = `term${index}`;
      params[key] = term.toLocaleLowerCase();
      conditions.push(
        `(instr(lower(t.title),:${key})>0 OR instr(lower(t.notes),:${key})>0 OR EXISTS(SELECT 1 FROM task_tags tt JOIN tags g ON g.id=tt.tag_id WHERE tt.task_id=t.id AND instr(lower(g.name),:${key})>0) OR EXISTS(SELECT 1 FROM lists l WHERE l.id=t.list_id AND instr(lower(l.name),:${key})>0))`,
      );
    });
    return conditions;
  }
  private boundedTasks(ids: string[]) {
    return [...new Set(ids)].map((id) => {
      const task = this.service.getTask(id);
      return {
        ...task,
        title: cut(task.title, 200),
        notes: cut(task.notes, 140),
        tags: task.tags.slice(0, 2).map((tag) => cut(tag, 30)),
      };
    });
  }
  private rules(taskIds: string[]): ContextRecurrence[] {
    if (!taskIds.length) return [];
    return this.service.db
      .prepare(
        `SELECT r.task_id,t.version AS expected_version,substr(t.title,1,300) AS title,t.list_id,r.rrule,r.dtstart,r.tzid,r.until,r.count,t.reminder_at FROM recurrences r JOIN tasks t ON t.id=r.task_id WHERE t.deleted_at IS NULL AND r.task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY r.task_id LIMIT 30`,
      )
      .all(...taskIds) as ContextRecurrence[];
  }
  private tasks(query: SearchContextQuery): ContextResult {
    const params: Parameters = {
      limit: query.limit || 12,
      offset: query.offset || 0,
      zone: this.getZone(),
    };
    const where = this.taskConditions(query, params);
    const due =
      "CASE WHEN t.due_kind='datetime' THEN telldo_context_day(t.due_at,:zone) ELSE t.due_date END";
    if (query.from) {
      params.from = query.from;
      where.push(`(t.planned_date>=:from OR ${due}>=:from)`);
    }
    if (query.to) {
      params.to = query.to;
      where.push(`(t.planned_date<=:to OR ${due}<=:to)`);
    }
    if (query.from && query.to) {
      where.splice(
        where.length - 2,
        2,
        `((t.planned_date BETWEEN :from AND :to) OR (${due} BETWEEN :from AND :to))`,
      );
    }
    const condition = where.join(" AND ");
    const total = Number(
      this.service.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${condition}`)
        .get(params)!.n,
    );
    const ids = (
      this.service.db
        .prepare(
          `SELECT t.id FROM tasks t WHERE ${condition} ORDER BY t.created_at DESC,t.id DESC LIMIT :limit OFFSET :offset`,
        )
        .all(params) as { id: string }[]
    ).map((row) => row.id);
    const tasks = this.boundedTasks(ids),
      rules = this.rules(ids);
    return {
      queryResult: page(
        query,
        total,
        tasks.length,
        Number(params.limit),
        "Matching task records only; recurring templates count once. Notes/titles are bounded excerpts.",
        tasks.some((t) => t.notes.endsWith("…") || t.title.endsWith("…")),
      ),
      tasks,
      readOnlyRecurrences: {
        total: rules.length,
        included: rules.length,
        series: rules,
      },
    };
  }
  private memoPage(query: SearchContextQuery): ContextResult {
    if (query.status && query.status !== "all")
      throw Error("Task status filters do not apply to retained records");
    const limit = Math.min(query.limit || 4, 6),
      params: Parameters = { limit, offset: query.offset || 0 };
    const where = ["m.staged=0", "m.deleted_at IS NULL"];
    if (query.list_id) {
      where.push("m.list_id=:listId");
      params.listId = query.list_id;
    }
    const zone = this.getZone();
    if (query.from) {
      where.push("m.created_at>=:fromInstant");
      params.fromInstant = DateTime.fromISO(query.from, { zone })
        .startOf("day")
        .toUTC()
        .toISO()!;
    }
    if (query.to) {
      where.push("m.created_at<:toInstant");
      params.toInstant = DateTime.fromISO(query.to, { zone })
        .plus({ days: 1 })
        .startOf("day")
        .toUTC()
        .toISO()!;
    }
    queryTerms(query).forEach((term, index) => {
      const key = `term${index}`;
      params[key] = term.toLocaleLowerCase();
      where.push(
        `(instr(lower(m.title),:${key})>0 OR instr(lower(m.body),:${key})>0 OR instr(lower(m.summary),:${key})>0 OR instr(lower(m.extracted_text),:${key})>0 OR EXISTS(SELECT 1 FROM memo_attachments a WHERE a.memo_id=m.id AND instr(lower(a.name),:${key})>0))`,
      );
    });
    const condition = where.join(" AND ");
    const total = Number(
      this.memos.db
        .prepare(`SELECT COUNT(*) AS n FROM memos m WHERE ${condition}`)
        .get(params)!.n,
    );
    // Matching text is found in SQLite; even a million-character memo is not loaded wholesale.
    const first = queryTerms(query)[0]?.toLocaleLowerCase() || "";
    params.needle = first;
    const content = "(m.body || char(10) || m.extracted_text)";
    const start = `CASE WHEN :needle!='' AND instr(lower(${content}),:needle)>300 THEN instr(lower(${content}),:needle)-300 ELSE 1 END`;
    const rows = this.memos.db
      .prepare(
        `SELECT m.id,substr(m.title,1,200) AS title,substr(m.summary,1,500) AS summary,m.created_at,length(${content}) AS content_length,${start} AS excerpt_start,substr(${content},${start},2001) AS excerpt FROM memos m WHERE ${condition} ORDER BY m.created_at DESC,m.id DESC LIMIT :limit OFFSET :offset`,
      )
      .all(params);
    let budget = 8000;
    const memos = rows.map((row) => {
      const max = Math.min(2000, Math.floor(8000 / Math.max(1, rows.length))),
        raw = String(row.excerpt);
      const body = (Number(row.excerpt_start) > 1 ? "…" : "") + cut(raw, max);
      budget -= Math.min(raw.length, max);
      const attachments = this.memos.db
        .prepare(
          "SELECT id,substr(name,1,160) AS name,mime,bytes,kind FROM memo_attachments WHERE memo_id=? ORDER BY rowid LIMIT 4",
        )
        .all(row.id) as MemoAttachment[];
      return {
        id: String(row.id),
        title: String(row.title),
        body,
        summary: String(row.summary),
        created_at: String(row.created_at),
        attachments,
      };
    });
    const truncated = rows.some(
      (row) =>
        Number(row.content_length) > 2000 || Number(row.excerpt_start) > 1,
    );
    return {
      queryResult: page(
        query,
        total,
        memos.length,
        limit,
        "Matching saved record excerpts only; original files are not opened until an explicit record reference is requested.",
        truncated,
      ),
      memoInventory: {
        total: this.memoInventory().total,
        included: memos.length,
      },
      memoSearchResults: memos,
    };
  }
  private schedule(query: SearchContextQuery): ContextResult {
    const from = query.from!,
      to = query.to!,
      limit = query.limit || 20;
    const params: Parameters = {
      from,
      to,
      limit,
      offset: query.offset || 0,
      zone: this.getZone(),
    };
    const ordinaryWhere = this.taskConditions(query, params);
    ordinaryWhere.push(
      "NOT EXISTS(SELECT 1 FROM recurrences r WHERE r.task_id=t.id)",
    );
    const day =
      "CASE WHEN t.planned_date BETWEEN :from AND :to THEN t.planned_date WHEN t.due_kind='datetime' THEN telldo_context_day(t.due_at,:zone) ELSE t.due_date END";
    ordinaryWhere.push(`(${day} BETWEEN :from AND :to)`);
    const recurringWhere = this.taskConditions(query, params, "o.status");
    recurringWhere.push("o.status!='skipped'");
    const occurrenceAt =
      "telldo_context_occurrence_at(o.due_at,o.override_date,o.override_due_at,r.tzid)";
    const occurrenceDay = `CASE WHEN o.due_at IS NOT NULL OR o.override_due_at IS NOT NULL THEN telldo_context_day(${occurrenceAt},:zone) ELSE COALESCE(o.override_date,o.due_date) END`;
    recurringWhere.push(`(${occurrenceDay} BETWEEN :from AND :to)`);
    const source = `SELECT 'task' AS record_kind,t.id AS task_id,NULL AS series_id,NULL AS occurrence_key,${day} AS scheduled_day,CASE WHEN t.due_kind='datetime' THEN t.due_at ELSE ${day} END AS sort_at FROM tasks t WHERE ${ordinaryWhere.join(" AND ")} UNION ALL SELECT 'occurrence' AS record_kind,t.id AS task_id,r.id AS series_id,o.occurrence_key,${occurrenceDay} AS scheduled_day,${occurrenceAt} AS sort_at FROM occurrences o JOIN recurrences r ON r.id=o.series_id JOIN tasks t ON t.id=r.task_id WHERE ${recurringWhere.join(" AND ")}`;
    const total = Number(
      this.service.db
        .prepare(`SELECT COUNT(*) AS n FROM (${source})`)
        .get(params)!.n,
    );
    const rows = this.service.db
      .prepare(
        `SELECT * FROM (${source}) ORDER BY scheduled_day,sort_at,task_id,occurrence_key LIMIT :limit OFFSET :offset`,
      )
      .all(params);
    const tasks = this.boundedTasks(rows.map((row) => String(row.task_id)));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const instances = rows.map((row) => {
      const task = byId.get(String(row.task_id))!;
      if (row.record_kind === "task") return this.scheduleItem(task);
      const occurrence = this.service.db
        .prepare(
          "SELECT * FROM occurrences WHERE series_id=? AND occurrence_key=?",
        )
        .get(row.series_id, row.occurrence_key) as unknown as Occurrence;
      const rule = this.service.db
        .prepare("SELECT tzid FROM recurrences WHERE id=?")
        .get(row.series_id)!;
      return {
        ...this.scheduleItem(
          taskFromOccurrence(task, occurrence, String(rule.tzid)),
        ),
        series_id: String(row.series_id),
        occurrence_key: String(row.occurrence_key),
      };
    });
    const rules = this.rules(tasks.map((t) => t.id));
    const coverage =
      "Stored instances only; this read does not generate missing recurrence dates. Absence beyond stored materialization is not proof that the schedule is empty.";
    return {
      queryResult: page(query, total, instances.length, limit, coverage),
      tasks,
      readOnlyRecurrences: {
        total: rules.length,
        included: rules.length,
        series: rules,
      },
      readOnlySchedule: {
        from,
        to,
        total,
        included: instances.length,
        coverage,
        instances,
      },
    };
  }
  private scheduleItem(task: Task): ContextScheduleItem {
    return {
      task_id: task.id,
      title: task.title,
      list_id: task.list_id,
      status: task.status,
      due_kind: task.due_kind,
      due_date:
        task.due_kind === "datetime" && task.due_at
          ? DateTime.fromISO(task.due_at).setZone(this.getZone()).toISODate()
          : task.due_date,
      due_at: task.due_at,
      time_zone: task.due_kind === "datetime" ? this.getZone() : task.time_zone,
      planned_date: task.planned_date,
    };
  }
}
