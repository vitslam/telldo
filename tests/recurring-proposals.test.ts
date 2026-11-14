import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "../src/main/task-service";
import type {
  CreateRecurringAction,
  ProposalAction,
} from "../src/shared/types";

const opened: TaskService[] = [];
function service() {
  const s = new TaskService(":memory:");
  opened.push(s);
  return s;
}
function action(
  s: TaskService,
  patch: Partial<CreateRecurringAction["patch"]> = {},
): CreateRecurringAction {
  return {
    type: "create_recurring",
    temp_id: "morning-run",
    patch: {
      title: "晨跑",
      list_id: s.listLists()[1].id,
      due_kind: "datetime",
      due_date: "2026-11-15",
      due_at: "2026-11-14T23:00:00.000Z",
      time_zone: "Asia/Shanghai",
      reminder_at: "2026-11-14T23:00:00.000Z",
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      dtstart: "2026-11-15T07:00:00",
      tzid: "Asia/Shanghai",
      until: "2026-12-31",
      count: null,
      ...patch,
    },
  };
}
function save(
  s: TaskService,
  actions: ProposalAction[] = [action(s)],
  key = "recurring-plan",
) {
  return s.saveProposal(
    {
      version: 1,
      summary: "每周日 7 点提醒晨跑，直到年底",
      risk: "low",
      idempotency_key: key,
      actions,
    },
    "今年剩下每周日早晨7点提醒晨跑",
    "",
    [],
  );
}
function apply(
  s: TaskService,
  patch: Partial<CreateRecurringAction["patch"]> = {},
) {
  const proposal = save(s, [action(s, patch)]);
  s.applyProposal(proposal.id, true);
  return proposal;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T16:00:00Z"));
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AI recurring task proposals", () => {
  it("saves without creating a task or schedule, requires confirmation and creates seven year-end Sundays idempotently", () => {
    const s = service();
    const p = save(s);
    expect(p.risk).toBe("high");
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
    expect(s.schedules.listOccurrences()).toEqual([]);
    expect(() => s.applyProposal(p.id)).toThrow(/confirmation/);
    s.applyProposal(p.id, true);
    s.applyProposal(p.id, true);
    expect(s.listTasks()).toHaveLength(1);
    expect(s.schedules.listRecurrences()).toHaveLength(1);
    expect(s.schedules.listOccurrences().map((o) => o.due_date)).toEqual([
      "2026-11-15",
      "2026-11-22",
      "2026-11-29",
      "2026-12-06",
      "2026-12-13",
      "2026-12-20",
      "2026-12-27",
    ]);
    expect(s.schedules.listOccurrences()[0].due_at).toBe(
      "2026-11-14T23:00:00.000Z",
    );
    expect(s.getTask(s.listTasks()[0].id)).not.toHaveProperty("rrule");
  });

  it("uses existing per-occurrence reminder offsets and does not emit reminders after the end date", () => {
    const s = service();
    apply(s, { reminder_at: "2026-11-14T22:45:00.000Z" });
    expect(
      s.schedules.dueNotifications(new Date("2026-11-14T22:44:59Z")),
    ).toHaveLength(0);
    const first = s.schedules.dueNotifications(
      new Date("2026-11-14T22:45:00Z"),
    );
    expect(first).toHaveLength(1);
    expect(first[0].occurrenceKey).toBe("2026-11-15T07:00:00");
    expect(
      s.schedules.dueNotifications(new Date("2026-11-14T22:45:00Z")),
    ).toHaveLength(0);
    expect(
      s.schedules.dueNotifications(new Date("2026-11-21T22:45:00Z")),
    ).toHaveLength(1);
    s.schedules.dueNotifications(new Date("2026-12-31T23:59:59Z"));
    expect(
      s.schedules.dueNotifications(new Date("2027-01-03T07:00:00+08:00")),
    ).toHaveLength(0);
  });

  it("supports date-only monthly tasks using the existing short-month clamp policy", () => {
    const s = service();
    const p = save(s, [
      action(s, {
        due_kind: "date",
        due_date: "2027-01-31",
        due_at: null,
        time_zone: null,
        reminder_at: null,
        rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
        dtstart: "2027-01-31",
        until: null,
        count: 3,
      }),
    ]);
    s.applyProposal(p.id, true);
    s.schedules.materializeRange("2027-01-01", "2027-03-01", "Asia/Shanghai");
    s.schedules.materializeRange("2027-03-01", "2027-04-01", "Asia/Shanghai");
    expect(s.schedules.listOccurrences().map((o) => o.due_date)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    expect(s.schedules.listOccurrences().every((o) => o.due_at === null)).toBe(
      true,
    );
  });

  it("rolls back task creation when the schedule service rejects it", () => {
    const s = service();
    const p = save(s);
    vi.spyOn(s.schedules, "setRecurrence").mockImplementation(() => {
      throw new Error("Schedule rejected");
    });
    expect(() => s.applyProposal(p.id, true)).toThrow(/Schedule rejected/);
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE proposal_id=?")
        .get(p.id)!.n,
    ).toBe(0);
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM proposal_created_recurrences")
        .get()!.n,
    ).toBe(0);
    expect(s.listProposals()[0].status).toBe("failed");
  });

  it("rolls back the rule and generated instances if a later action fails", () => {
    const s = service();
    const p = save(s, [
      action(s),
      {
        type: "create",
        patch: {
          title: "Invalid",
          list_id: s.listLists()[0].id,
          due_kind: "date",
        },
      },
    ]);
    expect(() => s.applyProposal(p.id, true)).toThrow();
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
    expect(s.schedules.listOccurrences()).toEqual([]);
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM proposal_created_recurrences")
        .get()!.n,
    ).toBe(0);
  });

  it("allows undo after untouched instances are materialized in a later window", () => {
    const s = service();
    const p = apply(s, { until: null });
    const before = s.schedules.listOccurrences().length;
    s.schedules.materializeRange("2027-06-01", "2027-07-01", "Asia/Shanghai");
    expect(s.schedules.listOccurrences().length).toBeGreaterThan(before);
    expect(s.undoProposal(p.id).status).toBe("undone");
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
    expect(s.schedules.listOccurrences()).toEqual([]);
    expect(s.undoProposal(p.id).status).toBe("undone");
  });

  it("refuses undo after an occurrence is completed then reopened", () => {
    const s = service();
    const p = apply(s);
    const o = s.schedules.listOccurrences()[0];
    const done = s.schedules.updateOccurrence(
      o.series_id,
      o.occurrence_key,
      { status: "done" },
      o.version,
    );
    s.schedules.updateOccurrence(
      o.series_id,
      o.occurrence_key,
      { status: "todo" },
      done.version,
    );
    expect(() => s.undoProposal(p.id)).toThrow(/changed/);
    expect(s.listTasks()).toHaveLength(1);
    expect(s.schedules.listOccurrences()).toHaveLength(7);
    expect(s.listProposals()[0].status).toBe("applied");
  });

  it.each(["skipped", "date", "reminder"])(
    "refuses undo after an instance %s edit",
    (kind) => {
      const s = service();
      const p = apply(s);
      const o = s.schedules.listOccurrences()[0];
      const patch =
        kind === "skipped"
          ? { status: "skipped" as const }
          : kind === "date"
            ? { override_date: "2026-11-16" }
            : {
                reminder_override: "explicit" as const,
                override_reminder_at: null,
              };
      s.schedules.updateOccurrence(
        o.series_id,
        o.occurrence_key,
        patch,
        o.version,
      );
      expect(() => s.undoProposal(p.id)).toThrow(/changed/);
      expect(s.listTasks()).toHaveLength(1);
    },
  );

  it("refuses undo after the repeat rule is removed and recreated, or changed then restored", () => {
    const s = service();
    const p = apply(s);
    const rule = s.schedules.listRecurrences()[0];
    s.schedules.removeRecurrence(rule.task_id);
    s.schedules.setRecurrence(rule.task_id, rule);
    expect(() => s.undoProposal(p.id)).toThrow(/changed/);
    const other = service();
    const otherProposal = apply(other);
    const otherRule = other.schedules.listRecurrences()[0];
    other.db
      .prepare("UPDATE recurrences SET until=? WHERE id=?")
      .run("2026-12-20", otherRule.id);
    other.db
      .prepare("UPDATE recurrences SET until=? WHERE id=?")
      .run(otherRule.until, otherRule.id);
    expect(() => other.undoProposal(otherProposal.id)).toThrow(/changed/);
  });

  it("refuses undo after task metadata changes and keeps later manual work intact", () => {
    const s = service();
    const p = apply(s);
    const task = s.listTasks()[0];
    s.updateTask(task.id, task.version, { notes: "Keep this" });
    expect(() => s.undoProposal(p.id)).toThrow(/task changed/);
    expect(s.getTask(task.id).notes).toBe("Keep this");
    expect(s.schedules.listOccurrences()).toHaveLength(7);
  });

  it("resolves a generic proposed list reference and reverses list, recurring task and instances together", () => {
    const s = service();
    const p = save(s, [
      { type: "create_list", temp_id: "fitness", patch: { name: "Fitness" } },
      action(s, { list_id: "fitness" }),
    ]);
    expect(s.listLists()).toHaveLength(3);
    s.applyProposal(p.id, true);
    expect(s.listTasks()[0].list_id).toBe(
      s.listLists().find((l) => l.name === "Fitness")!.id,
    );
    s.undoProposal(p.id);
    expect(s.listLists()).toHaveLength(3);
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
  });

  it("rejects a missing destination list before saving without side effects", () => {
    const s = service();
    expect(() => save(s, [action(s, { list_id: "missing-list" })])).toThrow(
      /List not found/,
    );
    expect(s.listProposals()).toEqual([]);
    expect(s.listTasks()).toEqual([]);
    expect(s.schedules.listRecurrences()).toEqual([]);
  });
});
