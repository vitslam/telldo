import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseProposal, parseTaskPatch } from "../src/shared/proposal";
import { splitRecurringTask } from "../src/shared/recurrence";

const patch = () => ({
  title: "晨跑",
  list_id: "life",
  due_kind: "datetime",
  due_date: "2026-11-15",
  due_at: "2026-11-14T23:00:00Z",
  time_zone: "Asia/Shanghai",
  reminder_at: "2026-11-14T23:00:00Z",
  rrule: "FREQ=WEEKLY;BYDAY=SU",
  dtstart: "2026-11-15T07:00:00",
  tzid: "Asia/Shanghai",
  until: "2026-12-31",
  count: null,
});
const action = (override: Record<string, unknown> = {}) => ({
  type: "create_recurring",
  temp_id: "run",
  patch: { ...patch(), ...override },
});
const proposal = (actions: unknown[]) => ({
  version: 1,
  summary: "每周日 7 点提醒晨跑，至年底",
  idempotency_key: "recurring",
  risk: "low",
  actions,
});
const parse = (override: Record<string, unknown> = {}) =>
  parseProposal(proposal([action(override)]));

describe("recurring proposal protocol", () => {
  it("keeps a recurring task as a confirmed high-risk action with a stripped task patch", () => {
    const result = parse();
    expect(result.risk).toBe("high");
    const item = result.actions[0];
    if (item.type !== "create_recurring") throw Error("Wrong action");
    const { task, recurrence } = splitRecurringTask(item.patch);
    expect(task).toMatchObject({
      title: "晨跑",
      due_at: "2026-11-14T23:00:00.000Z",
      reminder_at: "2026-11-14T23:00:00.000Z",
    });
    expect(task).not.toHaveProperty("rrule");
    expect(task).not.toHaveProperty("parent_id");
    expect(task).not.toHaveProperty("status");
    expect(() => parseTaskPatch(task)).not.toThrow();
    expect(recurrence).toMatchObject({
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      until: "2026-12-31",
      count: null,
      exdates: [],
    });
  });
  it("decodes transport entries and keeps a date-only series date-only", () => {
    const values = {
      ...patch(),
      due_kind: "date",
      due_at: null,
      time_zone: null,
      reminder_at: null,
      dtstart: "2026-11-15",
    };
    const result = parseProposal(
      proposal([
        {
          type: "create_recurring",
          temp_id: "run",
          target_id: null,
          expected_version: null,
          patch: Object.entries(values).map(([key, value]) => ({ key, value })),
        },
      ]),
    );
    expect(result.actions[0].patch).toMatchObject({
      due_kind: "date",
      due_date: "2026-11-15",
      dtstart: "2026-11-15",
      due_at: null,
    });
  });
  it("supports an explicit count instead of an end date", () => {
    expect(parse({ until: null, count: 7 }).actions[0].patch).toMatchObject({
      until: null,
      count: 7,
    });
  });
  it("uses the calendar's monthly last-day clamp and ordinal weekdays", () => {
    expect(() =>
      parse({
        rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
        dtstart: "2026-04-30T07:00:00",
        due_date: "2026-04-30",
        due_at: "2026-04-29T23:00:00Z",
        reminder_at: null,
      }),
    ).not.toThrow();
    expect(() =>
      parse({
        rrule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1",
        dtstart: "2026-11-02T07:00:00",
        due_date: "2026-11-02",
        due_at: "2026-11-01T23:00:00Z",
        reminder_at: null,
      }),
    ).not.toThrow();
  });
  it.each([
    { parent_id: "parent" },
    { status: "done" },
    { due_kind: "none" },
    { title: "" },
    { list_id: "" },
    { rrule: "FREQ=YEARLY" },
    { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU" },
    { rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=7" },
    { rrule: "FREQ=WEEKLY;BYDAY=SU;UNTIL=20261231" },
    { until: "2026-11-14" },
    { count: 0, until: null },
    { count: 10001, until: null },
    { count: 7 },
    { due_date: "2026-11-16" },
    { time_zone: "UTC" },
    { due_at: "2026-11-15T00:00:00Z" },
    { rrule: "FREQ=WEEKLY;BYDAY=MO" },
    { dtstart: "2026-11-15" },
    { due_kind: "date", dtstart: "2026-11-15", due_at: null },
    { name: "List-only field" },
    { rrule: "FREQ=MONTHLY;BYMONTHDAY=14" },
  ])("rejects unsafe recurrence/task combinations %#", (override) => {
    expect(() => parse(override)).toThrow();
  });
  it("rejects nonexistent daylight-saving wall times", () => {
    expect(() =>
      parse({
        dtstart: "2026-03-08T02:30:00",
        due_date: "2026-03-08",
        due_at: "2026-03-08T07:30:00Z",
        tzid: "America/New_York",
        time_zone: "America/New_York",
        reminder_at: null,
      }),
    ).toThrow(/wall time/);
  });
  it.each([
    { ...action(), temp_id: undefined },
    { ...action(), target_id: "existing" },
    { ...action(), expected_version: 1 },
  ])("rejects missing temporary identity or an existing target %#", (item) => {
    expect(() => parseProposal(proposal([item]))).toThrow();
  });
  it("keeps existing task patch boundaries strict", () => {
    expect(() =>
      parseProposal(proposal([{ type: "create", patch: patch() }])),
    ).toThrow();
  });
  it("supports a preceding list reference without treating a repeating template as a parent", () => {
    const list = {
      type: "create_list",
      temp_id: "new-list",
      patch: { name: "Exercise" },
    };
    expect(
      parseProposal(proposal([list, action({ list_id: "new-list" })])).actions,
    ).toHaveLength(2);
    expect(() =>
      parseProposal(
        proposal([
          action(),
          {
            type: "create",
            temp_id: "child",
            patch: { title: "Child", list_id: "life", parent_id: "run" },
          },
        ]),
      ),
    ).toThrow(/requires a task/);
    expect(() =>
      parseProposal(proposal([action({ list_id: "new-list" }), list])),
    ).toThrow(/must follow/);
  });
  it("advertises recurring fields on both Codex transports", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../resources/proposal.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const properties = schema.properties.actions.items.properties;
    expect(properties.type.enum).toContain("create_recurring");
    expect(properties.patch.items.properties.key.enum).toEqual(
      expect.arrayContaining([
        "rrule",
        "dtstart",
        "tzid",
        "until",
        "count",
        "reminder_at",
      ]),
    );
  });
});
