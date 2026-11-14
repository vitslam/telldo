import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { TaskService } from "./task-service";
import type { Task, TaskPatch, Occurrence, Recurrence } from "../shared/types";
import { taskFromOccurrence, validDate, validZone } from "../shared/dates";
import {
  calendarDueDay,
  resolveCalendarTime,
  type CalendarChangeRequest,
  type CalendarChangePreview,
  type CalendarApplyResult,
  type CalendarUndoResult,
} from "../shared/calendar";

/** Manual date edits share one transaction and a durable, conflict-checked inverse. */
export class CalendarService {
  constructor(private readonly service: TaskService) {
    service.db.exec(
      `CREATE TABLE IF NOT EXISTS calendar_changes(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,target_json TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,task_version INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0)`,
    );
  }
  private target(request: CalendarChangeRequest): {
    task: Task;
    occurrence?: Occurrence;
    series?: Recurrence;
    projected: Task;
  } {
    if (
      !request ||
      typeof request !== "object" ||
      !request.target ||
      typeof request.target !== "object" ||
      !["planned", "due"].includes(request.field) ||
      (request.date !== null && !validDate(request.date)) ||
      !validZone(request.displayZone) ||
      (request.reminderPolicy !== undefined &&
        !["keep", "follow"].includes(request.reminderPolicy)) ||
      Object.keys(request).some(
        (k) =>
          ![
            "target",
            "field",
            "date",
            "displayZone",
            "reminderPolicy",
            "wallTime",
            "chosenDueAt",
          ].includes(k),
      )
    )
      throw Error("Invalid calendar change / 日历改期参数无效");
    const target = request.target;
    if (
      typeof target.taskId !== "string" ||
      !Number.isSafeInteger(target.expectedVersion) ||
      target.expectedVersion < 1
    )
      throw Error("Expected version required / 缺少任务版本");
    const task = this.service.getTask(target.taskId);
    if (task.parent_id)
      throw Error(
        "Calendar dates are for top-level tasks / 请在父任务中编辑子任务",
      );
    const series = this.service.schedules
      .listRecurrences()
      .find((s) => s.task_id === task.id);
    if (target.seriesId || target.occurrenceKey) {
      if (
        !series ||
        series.id !== target.seriesId ||
        typeof target.occurrenceKey !== "string"
      )
        throw Error("Recurring series changed / 重复系列已改变");
      if (target.expectedTaskVersion !== task.version)
        throw Error("Version conflict / 重复模板已改变，请刷新后重试");
      const occurrence = this.service.schedules
        .listOccurrences()
        .find(
          (o) =>
            o.series_id === series.id &&
            o.occurrence_key === target.occurrenceKey,
        );
      if (!occurrence || occurrence.version !== target.expectedVersion)
        throw Error("Version conflict / 重复实例已改变，请刷新后重试");
      if (request.field !== "due" || request.date === null)
        throw Error(
          "Recurring instances require a due date / 重复实例只能修改本次截止日期",
        );
      return {
        task,
        occurrence,
        series,
        projected: {
          ...taskFromOccurrence(task, occurrence, series.tzid),
          planned_date: null,
        },
      };
    }
    if (series)
      throw Error("Choose an individual instance / 请选择单个重复实例");
    if (task.version !== target.expectedVersion)
      throw Error("Version conflict / 任务已改变，请刷新后重试");
    return { task, projected: task };
  }
  preview(request: CalendarChangeRequest): CalendarChangePreview {
    const { projected: before, series } = this.target(request);
    const result: CalendarChangePreview = {
      request,
      before,
      after: { ...before },
      candidates: [],
      warnings: [],
      requiresConfirmation: false,
      requiresTimeChoice: false,
      requiresReminderChoice: false,
    };
    const after = result.after!;
    if (request.field === "planned") after.planned_date = request.date;
    else if (request.date === null) {
      Object.assign(after, {
        due_kind: "none",
        due_date: null,
        due_at: null,
        time_zone: null,
      });
      result.warnings.push("Remove the deadline / 将移除截止日期");
      result.requiresConfirmation = true;
    } else if (before.due_kind === "datetime") {
      const time = resolveCalendarTime(
        before,
        request.date,
        request.displayZone,
        request.wallTime,
        request.chosenDueAt,
      );
      result.candidates = time.candidates;
      if (!time.chosenDueAt) {
        result.after = null;
        result.requiresTimeChoice = true;
        result.requiresConfirmation = true;
        result.warnings.push(
          time.gap
            ? "This local time does not exist; choose another time / 该当地时间不存在，请选择其他时刻"
            : "This local time occurs twice; choose an offset / 该当地时间出现两次，请选择时区偏移",
        );
      } else {
        after.due_at = time.chosenDueAt;
        after.due_date = DateTime.fromISO(time.chosenDueAt)
          .setZone(before.time_zone!)
          .toISODate();
        const oldLocal = DateTime.fromISO(before.due_at!)
          .setZone(before.time_zone!)
          .toFormat("HH:mm:ss ZZZZ");
        const newLocal = DateTime.fromISO(after.due_at)
          .setZone(before.time_zone!)
          .toFormat("HH:mm:ss ZZZZ");
        if (oldLocal !== newLocal) {
          result.requiresConfirmation = true;
          result.warnings.push(
            `Original time zone / 原时区 ${before.time_zone}: ${oldLocal} → ${newLocal}`,
          );
        }
      }
    } else
      Object.assign(after, {
        due_kind: "date",
        due_date: request.date,
        due_at: null,
        time_zone: null,
      });
    if (request.field === "due" && before.reminder_at) {
      result.requiresConfirmation = true;
      result.requiresReminderChoice = !request.reminderPolicy;
      if (result.after && request.reminderPolicy === "follow") {
        if (!request.date) after.reminder_at = null;
        else if (before.due_kind === "datetime" && after.due_at)
          after.reminder_at = DateTime.fromISO(after.due_at)
            .plus({
              milliseconds: DateTime.fromISO(before.reminder_at)
                .diff(DateTime.fromISO(before.due_at!))
                .toMillis(),
            })
            .toUTC()
            .toISO();
        else if (before.due_kind === "date" && before.due_date) {
          const reminder = DateTime.fromISO(before.reminder_at).setZone(
            request.displayZone,
          );
          const days = reminder
            .startOf("day")
            .diff(
              DateTime.fromISO(before.due_date, { zone: request.displayZone }),
              "days",
            ).days;
          const reminderDay = DateTime.fromISO(request.date, {
            zone: request.displayZone,
          })
            .plus({ days })
            .toISODate()!;
          const resolved = resolveCalendarTime(
            { due_kind: "datetime", due_at: before.reminder_at },
            reminderDay,
            request.displayZone,
          );
          if (!resolved.chosenDueAt)
            throw Error(
              "Reminder crosses an ambiguous or missing local time; keep its original time or edit the reminder first / 提醒落入不存在或重复的当地时间，请保持原提醒或先编辑提醒",
            );
          after.reminder_at = resolved.chosenDueAt;
        } else
          throw Error(
            "No original deadline to follow / 原任务没有截止日期，请选择保持提醒",
          );
      }
      if (result.after && after.reminder_at) {
        if (DateTime.fromISO(after.reminder_at).toMillis() < Date.now())
          result.warnings.push(
            "Past reminders will be recorded without an immediate notification / 过去的提醒将记录为已处理，不会立即补发",
          );
        const due = after.due_at
          ? DateTime.fromISO(after.due_at)
          : after.due_date
            ? DateTime.fromISO(after.due_date, {
                zone: request.displayZone,
              }).endOf("day")
            : null;
        if (due && DateTime.fromISO(after.reminder_at) > due)
          result.warnings.push(
            "Reminder is later than the new deadline / 提醒晚于新的截止时间",
          );
      }
    }
    if (result.after) {
      const due = calendarDueDay(after, request.displayZone);
      if (after.planned_date && due && after.planned_date > due) {
        result.warnings.push(
          "Planned date is after the deadline / 安排日期晚于截止日期",
        );
        result.requiresConfirmation = true;
      }
      if (series) after.planned_date = null;
    }
    return result;
  }
  private suppressPast(target: string, reminder: string | null) {
    if (reminder && DateTime.fromISO(reminder).toMillis() <= Date.now())
      this.service.db
        .prepare("INSERT OR IGNORE INTO notification_log VALUES(?,?,?,?,1)")
        .run(
          randomUUID(),
          target,
          DateTime.fromISO(reminder).toUTC().toISO(),
          new Date().toISOString(),
        );
  }
  apply(request: CalendarChangeRequest): CalendarApplyResult {
    return this.service.db.transaction(() => {
      const preview = this.preview(request);
      if (
        !preview.after ||
        preview.requiresTimeChoice ||
        preview.requiresReminderChoice
      )
        throw Error(
          "Complete the date preview choices first / 请先完成日期和提醒选项",
        );
      const target = this.target(request),
        after = preview.after;
      let task: Task, occurrence: Occurrence | undefined;
      if (target.occurrence) {
        const before = target.occurrence;
        occurrence = this.service.schedules.updateOccurrence(
          before.series_id,
          before.occurrence_key,
          {
            override_date: after.due_date,
            override_due_at: after.due_at,
            reminder_override: preview.before.reminder_at
              ? "explicit"
              : (before.reminder_override ?? "inherit"),
            override_reminder_at: preview.before.reminder_at
              ? after.reminder_at
              : (before.override_reminder_at ?? null),
          },
          before.version,
        );
        task = {
          ...taskFromOccurrence(target.task, occurrence, target.series!.tzid),
          planned_date: null,
        };
      } else {
        const patch: TaskPatch =
          request.field === "planned"
            ? { planned_date: after.planned_date }
            : {
                due_kind: after.due_kind,
                due_date: after.due_date,
                due_at: after.due_at,
                time_zone: after.time_zone,
                reminder_at: after.reminder_at,
              };
        task = this.service.updateTask(
          target.task.id,
          target.task.version,
          patch,
        );
      }
      const undoId = randomUUID();
      this.service.db
        .prepare(
          "INSERT INTO calendar_changes(id,created_at,target_json,before_json,after_json,task_version) VALUES(?,?,?,?,?,?)",
        )
        .run(
          undoId,
          new Date().toISOString(),
          JSON.stringify({ ...request.target, field: request.field }),
          JSON.stringify(target.occurrence ?? target.task),
          JSON.stringify(occurrence ?? task),
          target.task.version,
        );
      if (request.field === "due")
        this.suppressPast(
          occurrence
            ? `${occurrence.series_id}:${occurrence.occurrence_key}`
            : task.id,
          task.reminder_at,
        );
      return { undoId, task, ...(occurrence ? { occurrence } : {}) };
    })();
  }
  undo(undoId: string): CalendarUndoResult {
    if (typeof undoId !== "string") throw Error("Invalid undo ID");
    return this.service.db.transaction(() => {
      const entry = this.service.db
        .prepare("SELECT * FROM calendar_changes WHERE id=? AND undone=0")
        .get(undoId);
      if (!entry) throw Error("Undo unavailable / 此改期已撤销或不存在");
      const target = JSON.parse(entry.target_json),
        before = JSON.parse(entry.before_json),
        after = JSON.parse(entry.after_json);
      const currentTask = this.service.getTask(target.taskId);
      let task: Task, occurrence: Occurrence | undefined;
      if (target.seriesId) {
        const series = this.service.schedules
          .listRecurrences()
          .find((s) => s.id === target.seriesId && s.task_id === target.taskId);
        const current = this.service.schedules
          .listOccurrences()
          .find(
            (o) =>
              o.series_id === target.seriesId &&
              o.occurrence_key === target.occurrenceKey,
          );
        if (
          !series ||
          !current ||
          current.version !== after.version ||
          currentTask.version !== entry.task_version
        )
          throw Error(
            "Cannot undo: task or instance changed / 无法撤销：任务或实例已有后续修改",
          );
        occurrence = this.service.schedules.updateOccurrence(
          current.series_id,
          current.occurrence_key,
          {
            override_date: before.override_date,
            override_due_at: before.override_due_at ?? null,
            reminder_override: before.reminder_override ?? "inherit",
            override_reminder_at: before.override_reminder_at ?? null,
          },
          current.version,
        );
        task = {
          ...taskFromOccurrence(currentTask, occurrence, series.tzid),
          planned_date: null,
        };
      } else {
        if (currentTask.version !== after.version)
          throw Error("Cannot undo: task changed / 无法撤销：任务已有后续修改");
        task = this.service.updateTask(currentTask.id, currentTask.version, {
          planned_date: before.planned_date,
          due_kind: before.due_kind,
          due_date: before.due_date,
          due_at: before.due_at,
          time_zone: before.time_zone,
          reminder_at: before.reminder_at,
        });
      }
      this.service.db
        .prepare("UPDATE calendar_changes SET undone=1 WHERE id=?")
        .run(undoId);
      if (target.field === "due")
        this.suppressPast(
          occurrence
            ? `${occurrence.series_id}:${occurrence.occurrence_key}`
            : task.id,
          task.reminder_at,
        );
      return { task, ...(occurrence ? { occurrence } : {}) };
    })();
  }
}
