import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskService } from "../src/main/task-service";
import { MemoService } from "../src/main/memo-service";
import { ContextRepository } from "../src/main/context-repository";
import { parseContextQuery } from "../src/shared/context-query";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "telldo-context-"));
  const tasks = new TaskService(":memory:");
  const memos = new MemoService(dir);
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => tasks.close(),
    () => memos.close(),
  );
  const repo = new ContextRepository(tasks, memos, () => "Asia/Shanghai");
  const list = tasks.listLists()[0];
  return { tasks, memos, repo, list };
}
function duplicateTasks(tasks: TaskService, sourceId: string, count: number) {
  const raw = tasks.db.prepare("SELECT * FROM tasks WHERE id=?").get(sourceId)!;
  const keys = Object.keys(raw);
  const put = tasks.db.prepare(
    `INSERT INTO tasks(${keys.join(",")}) VALUES(${keys.map((k) => "@" + k).join(",")})`,
  );
  tasks.db.transaction(() => {
    for (let i = 0; i < count; i++)
      put.run({ ...raw, id: randomUUID(), title: `Unrelated ${i}` });
  })();
}
describe("bounded, read-only AI context queries", () => {
  it("filters and pages in SQL despite thousands of unrelated records, without loading task lists", () => {
    const { tasks, memos, repo, list } = fixture();
    const noise = tasks.createTask({
      title: "Noise",
      list_id: list.id,
      notes: "x".repeat(20000),
    });
    duplicateTasks(tasks, noise.id, 1500);
    const wanted = Array.from({ length: 3 }, (_, i) =>
      tasks.createTask({
        title: `Project Quartz ${i}`,
        list_id: list.id,
        notes: "q".repeat(20000),
      }),
    );
    vi.spyOn(tasks, "listTasks").mockImplementation(() => {
      throw Error("Unbounded task list read");
    });
    vi.spyOn(memos, "list").mockImplementation(() => {
      throw Error("Unbounded memo list read");
    });
    const read = vi.spyOn(tasks, "getTask");
    const page = repo.retrieve({
      entity: "tasks",
      keywords: "Quartz",
      status: "todo",
      limit: 2,
    });
    expect(page.queryResult).toMatchObject({
      total: 3,
      returned: 2,
      limit: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.tasks!.every((t) => t.notes.length <= 141)).toBe(true);
    const next = repo.retrieve({
      entity: "tasks",
      keywords: "Quartz",
      status: "todo",
      limit: 2,
      offset: 2,
    });
    expect(next.queryResult).toMatchObject({
      returned: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(new Set([...page.tasks!, ...next.tasks!].map((t) => t.id))).toEqual(
      new Set(wanted.map((t) => t.id)),
    );
    expect(JSON.stringify(page).length).toBeLessThan(6000);
  });
  it("uses exact aggregate counts without hydrating task bodies", () => {
    const { tasks, memos, repo, list } = fixture();
    const t = tasks.createTask({ title: "One", list_id: list.id });
    tasks.createTask({ title: "Two", list_id: list.id, status: "done" });
    duplicateTasks(tasks, t.id, 100);
    vi.spyOn(tasks, "getTask").mockImplementation(() => {
      throw Error("Body loaded");
    });
    vi.spyOn(tasks, "listTasks").mockImplementation(() => {
      throw Error("List loaded");
    });
    vi.spyOn(memos, "list").mockImplementation(() => {
      throw Error("Memos loaded");
    });
    expect(repo.inventory()).toMatchObject({
      ordinaryTotal: 102,
      ordinaryTodo: 101,
      ordinaryDone: 1,
      recurringSeries: 0,
    });
    expect(repo.lists(1)).toEqual([{ id: list.id, name: list.name }]);
  });
  it("combines task status, list and calendar filters without cross-field date matches", () => {
    const { tasks, repo, list } = fixture();
    const other = tasks.createList("Other");
    tasks.createTask({
      title: "Wanted",
      list_id: list.id,
      due_kind: "date",
      due_date: "2026-11-16",
    });
    tasks.createTask({
      title: "Crossed dates",
      list_id: list.id,
      planned_date: "2026-11-10",
      due_kind: "date",
      due_date: "2026-11-20",
    });
    tasks.createTask({
      title: "Wrong list",
      list_id: other.id,
      due_kind: "date",
      due_date: "2026-11-16",
    });
    tasks.createTask({
      title: "Done",
      list_id: list.id,
      status: "done",
      due_kind: "date",
      due_date: "2026-11-16",
    });
    const result = repo.retrieve({
      entity: "tasks",
      status: "todo",
      list_id: list.id,
      from: "2026-11-16",
      to: "2026-11-16",
    });
    expect(result.tasks!.map((t) => t.title)).toEqual(["Wanted"]);
  });
  it("returns limited memo excerpts near the searched content and never decodes every memo", async () => {
    const { memos, tasks, repo } = fixture();
    const source = await memos.create({ text: "n".repeat(50000) });
    const raw = memos.db
      .prepare("SELECT * FROM memos WHERE id=?")
      .get(source.id)!;
    const keys = Object.keys(raw);
    const put = memos.db.prepare(
      `INSERT INTO memos(${keys.join(",")}) VALUES(${keys.map((k) => "@" + k).join(",")})`,
    );
    memos.db.transaction(() => {
      for (let i = 0; i < 200; i++)
        put.run({ ...raw, id: randomUUID(), idempotency_key: null });
    })();
    for (let i = 0; i < 8; i++)
      await memos.create({
        text:
          "start ".repeat(6000) + "needle-silver " + i + " tail ".repeat(1000),
        attachments: [
          {
            name: `source-${i}.txt`,
            bytes: Buffer.from("needle-silver is genuine file content"),
          },
        ],
      });
    vi.spyOn(memos, "list").mockImplementation(() => {
      throw Error("Unbounded memo read");
    });
    vi.spyOn(tasks, "listTasks").mockImplementation(() => {
      throw Error("Unbounded task read");
    });
    const result = repo.retrieve({
      entity: "memos",
      keywords: "needle-silver",
      limit: 30,
    });
    expect(result.queryResult).toMatchObject({
      total: 8,
      returned: 6,
      limit: 6,
      hasMore: true,
    });
    expect(result.memoInventory).toEqual({ total: 209, included: 6 });
    expect(
      result.memoSearchResults!.every((m) => m.body.includes("needle-silver")),
    ).toBe(true);
    expect(
      result.memoSearchResults!.reduce((n, m) => n + m.body.length, 0),
    ).toBeLessThanOrEqual(8012);
    expect(JSON.stringify(result)).not.toContain("n".repeat(2000));
    expect(JSON.stringify(result)).not.toContain(memos.fileDir);
  });
  it("treats wildcard and SQL-like input as literal search data", () => {
    const { tasks, repo, list } = fixture();
    tasks.createTask({ title: "100% ready", list_id: list.id });
    tasks.createTask({ title: "Other", list_id: list.id });
    expect(
      repo
        .retrieve({ entity: "tasks", keywords: "%" })
        .tasks!.map((t) => t.title),
    ).toEqual(["100% ready"]);
    expect(
      repo.retrieve({ entity: "tasks", keywords: "' OR 1=1 --" }).tasks,
    ).toEqual([]);
  });
  it("queries stored dates in the display zone and preserves moved occurrence semantics without generating anything", () => {
    const { tasks, repo, list } = fixture();
    tasks.createTask({
      title: "UTC late",
      list_id: list.id,
      due_kind: "datetime",
      due_date: "2026-11-15",
      due_at: "2026-11-15T16:30:00Z",
      time_zone: "UTC",
    });
    const recurring = tasks.createTask({
      title: "Run",
      list_id: list.id,
      due_kind: "datetime",
      due_date: "2026-11-15",
      due_at: "2026-11-14T23:30:00Z",
      time_zone: "Asia/Shanghai",
    });
    const rule = tasks.schedules.setRecurrence(recurring.id, {
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      dtstart: "2026-11-15T07:30:00",
      tzid: "Asia/Shanghai",
      count: 2,
      until: null,
      exdates: [],
    });
    const original = tasks.schedules
      .listOccurrences()
      .find((o) => o.series_id === rule.id)!;
    tasks.schedules.updateOccurrence(rule.id, original.occurrence_key, {
      override_date: "2026-11-16",
    });
    vi.spyOn(tasks.schedules, "materialize").mockImplementation(() => {
      throw Error("Must not generate dates");
    });
    vi.spyOn(tasks.schedules, "materializeRange").mockImplementation(() => {
      throw Error("Must not generate dates");
    });
    vi.spyOn(tasks.schedules, "listOccurrences").mockImplementation(() => {
      throw Error("Must not read all occurrences");
    });
    vi.spyOn(tasks, "listTasks").mockImplementation(() => {
      throw Error("Must not read all tasks");
    });
    const before = tasks.db.prepare("SELECT total_changes() AS n").get()!.n;
    const result = repo.retrieve({
      entity: "schedule",
      from: "2026-11-16",
      to: "2026-11-16",
      status: "todo",
    });
    expect(
      result.readOnlySchedule!.instances.map((t) => t.title).sort(),
    ).toEqual(["Run", "UTC late"]);
    expect(
      result.readOnlySchedule!.instances.every(
        (t) => t.due_date === "2026-11-16",
      ),
    ).toBe(true);
    expect(result.readOnlyRecurrences!.series).toHaveLength(1);
    expect(result.queryResult.coverage).toContain("Stored instances only");
    expect(tasks.db.prepare("SELECT total_changes() AS n").get()!.n).toBe(
      before,
    );
  });
  it("does not suggest an unmaterialized future recurring range is exhaustive", () => {
    const { repo } = fixture();
    const result = repo.retrieve({
      entity: "schedule",
      from: "2099-01-01",
      to: "2099-01-31",
    });
    expect(result.queryResult.total).toBe(0);
    expect(result.readOnlySchedule!.coverage).toContain("not proof");
  });
  it("rejects unsafe bounds, unknown fields and generic record resolution", () => {
    const { repo } = fixture();
    for (const query of [
      { entity: "tasks", limit: 999 },
      { entity: "memos", offset: -1 },
      { entity: "schedule" },
      { entity: "schedule", from: "2026-01-01", to: "2026-02-01" },
      { entity: "tasks", from: "2026-02-30" },
      { entity: "tasks", sql: "DROP TABLE tasks" },
    ])
      expect(() => parseContextQuery(query)).toThrow();
    expect(() =>
      repo.retrieve({ entity: "record", kind: "memo", id: "owned" }),
    ).toThrow(/host/);
    expect(
      parseContextQuery({
        entity: "schedule",
        from: "2026-01-01",
        to: "2026-01-31",
      }),
    ).toBeTruthy();
  });
});
