import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../src/main/sqlite";
import { TaskService } from "../src/main/task-service";
import { ScheduleService } from "../src/main/schedule-service";
import { parseProposal } from "../src/shared/proposal";
import type { ProposalAction } from "../src/shared/types";

const opened: TaskService[] = [];
const folders: string[] = [];
function service(path = ":memory:") {
  const s = new TaskService(path);
  opened.push(s);
  return s;
}
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "telldo-test-"));
  folders.push(dir);
  return dir;
}
function proposal(actions: ProposalAction[], key = "once") {
  return {
    version: 1 as const,
    summary: "Apply selected changes",
    idempotency_key: key,
    risk: "low" as const,
    actions,
  };
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("unified task schedule saving", () => {
  it("creates, updates and removes repeat with task fields, preserving completed instances", () => {
    const s = service(), schedules = new ScheduleService(s.db);
    const list = s.createList("Work");
    const original = s.createTask({ title: "Schedule", list_id: list.id });
    const spec = { rrule: "FREQ=DAILY", dtstart: "2031-02-10", tzid: "Asia/Shanghai", count: 3, until: null, exdates: [] };
    const created = s.saveTaskSchedule(original.id, original.version, { due_kind: "date", due_date: "2031-02-10", reminder_at: "2031-02-10T02:00:00.000Z" }, spec);
    const series = schedules.listRecurrences()[0];
    schedules.materializeRange("2031-02-01", "2031-03-01", "Asia/Shanghai");
    const first = schedules.listOccurrences()[0];
    schedules.updateOccurrence(series.id, first.occurrence_key, { status: "done" }, first.version ?? 1);
    const updated = s.saveTaskSchedule(created.id, created.version, { title: "Edited" }, { ...spec, rrule: "FREQ=WEEKLY;BYDAY=MO,FR" });
    expect(schedules.listRecurrences()[0].rrule).toBe("FREQ=WEEKLY;BYDAY=MO,FR");
    expect(schedules.listOccurrences().find(o => o.occurrence_key === first.occurrence_key)?.status).toBe("done");
    expect(updated.reminder_at).toBe(created.reminder_at);
    s.saveTaskSchedule(updated.id, updated.version, { due_kind: "none", due_date: null, reminder_at: null }, null);
    expect(schedules.listRecurrences()).toHaveLength(0);
    expect(s.getTask(updated.id).due_kind).toBe("none");
  });
  it("rolls back invalid recurrence and failed removal edits, and rejects stale versions", () => {
    const s = service(), schedules = new ScheduleService(s.db), list = s.createList("Work");
    const task = s.createTask({ title: "Original", list_id: list.id });
    const spec = { rrule: "FREQ=DAILY", dtstart: "2031-02-10", tzid: "UTC", count: 2, until: null, exdates: [] };
    expect(() => s.saveTaskSchedule(task.id, task.version, { title: "Lost" }, spec)).toThrow();
    expect(s.getTask(task.id)).toMatchObject({ title: "Original", version: task.version });
    expect(schedules.listRecurrences()).toHaveLength(0);
    const saved = s.saveTaskSchedule(task.id, task.version, { due_kind: "date", due_date: "2031-02-10" }, spec);
    expect(() => s.saveTaskSchedule(task.id, saved.version, { title: "" }, null)).toThrow();
    expect(schedules.listRecurrences()).toHaveLength(1);
    expect(() => s.saveTaskSchedule(task.id, task.version, { title: "Stale" }, null)).toThrow();
    expect(schedules.listRecurrences()).toHaveLength(1);
  });
});

describe("manual task service without any Codex dependency", () => {
  it("restores older preferences with portable local transport defaults", () => {
    const s = service();
    s.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(
      "preferences",
      JSON.stringify({
        language: "en",
        timeZone: "UTC",
        codexPath: "/usr/local/bin/codex",
        alwaysConfirm: true,
        closeToTray: false,
      }),
    );
    expect(s.getSettings()).toMatchObject({
      language: "en",
      aiTransport: "local",
      sshHost: "",
      sshUser: "",
      sshPort: 22,
      sshCodexPath: "",
      sshRunnerPath: "",
      sshProxyUrl: "",
    });
    expect(s.setSettings({ language: "zh" }).alwaysConfirm).toBe(true);
  });
  it("persists valid SSH settings without changing manual task access", () => {
    const s = service();
    const config = {
      aiTransport: "ssh" as const,
      sshHost: "198.51.100.10",
      sshUser: "developer",
      sshPort: 2222,
      sshCodexPath: "/home/developer/.local/bin/codex",
      sshRunnerPath: "/opt/telldo/resources/ssh-codex-runner.py",
      sshProxyUrl: "http://192.0.2.10:3128",
    };
    expect(s.setSettings(config)).toMatchObject(config);
    expect(s.getSettings()).toMatchObject(config);
    const task = s.createTask({ title: "Manual still works" });
    expect(s.updateTask(task.id, task.version, { status: "done" }).status).toBe(
      "done",
    );
    expect(s.setSettings({ sshHost: "codex.internal.example" }).sshHost).toBe(
      "codex.internal.example",
    );
    expect(s.setSettings({ sshHost: "2001:db8::1" }).sshHost).toBe(
      "2001:db8::1",
    );
    expect(
      s.setSettings({
        aiTransport: "local",
        sshHost: "",
        sshUser: "",
        sshRunnerPath: "",
      }).aiTransport,
    ).toBe("local");
  });
  it("rejects malicious SSH settings, invalid ports and credential-bearing proxies atomically", () => {
    const s = service();
    const original = s.getSettings();
    for (const patch of [
      { sshHost: "host; touch /tmp/injected" },
      { sshHost: "$(whoami)" },
      { sshHost: "-oProxyCommand=evil" },
      { sshHost: "host\nother" },
      { sshUser: "user;id" },
      { sshUser: "user@host" },
      { sshUser: "-option" },
      { sshPort: 0 },
      { sshPort: 65536 },
      { sshPort: 22.5 },
      { sshPort: "22" },
      { sshRunnerPath: "relative/runner.py" },
      { sshRunnerPath: "~/runner.py" },
      { sshRunnerPath: "/tmp/run;id.py" },
      { sshRunnerPath: "/tmp/$(id).py" },
      { sshCodexPath: "$HOME/bin/codex" },
      { sshCodexPath: "/tmp/codex`id`" },
      { sshProxyUrl: "http://user:secret@proxy:3128" },
      { sshProxyUrl: "https://user@proxy" },
      { sshProxyUrl: "socks5://proxy:1080" },
      { sshProxyUrl: "http://proxy\n:3128" },
      { aiTransport: "ssh" },
      { aiTransport: "arbitrary" },
    ]) {
      expect(() => s.setSettings(patch as any)).toThrow();
      expect(s.getSettings()).toEqual(original);
    }
  });

  it("persists language and timezone overrides and rejects invalid settings", () => {
    const s = service();
    expect(s.getSettings().timeZone).toBe("");
    expect(s.getSettings().language).toBe("system");
    s.setSettings({
      timeZone: "America/New_York",
      language: "en",
      alwaysConfirm: true,
    });
    expect(s.getSettings()).toMatchObject({
      timeZone: "America/New_York",
      language: "en",
      alwaysConfirm: true,
    });
    expect(() => s.setSettings({ timeZone: "Not/AZone" })).toThrow();
    expect(() => s.setSettings({ alwaysConfirm: "false" } as any)).toThrow();
    expect(s.getSettings().timeZone).toBe("America/New_York");
  });

  it("supports lists, tasks, tags, notes, one-level subtasks, search and completion", () => {
    const s = service();
    expect(s.listLists()).toHaveLength(3);
    const list = s.createList("Project", "#123abc");
    s.updateList(list.id, { name: "Work" });
    const top = s.createTask({
      list_id: list.id,
      title: "Review release",
      notes: "Read acceptance report",
      priority: "high",
      tags: ["release", "team", "release"],
    });
    const child = s.createTask({
      list_id: list.id,
      parent_id: top.id,
      title: "Verify build",
    });
    expect(s.search("acceptance")[0].id).toBe(top.id);
    expect(s.search("team")[0].id).toBe(top.id);
    expect(s.getTask(top.id).tags).toEqual(["release", "team"]);
    expect(() =>
      s.createTask({
        list_id: list.id,
        parent_id: child.id,
        title: "Too deep",
      }),
    ).toThrow(/one level/);
    const done = s.updateTask(top.id, top.version, { status: "done" });
    expect(done.completed_at).toBeTruthy();
    expect(done.version).toBe(2);
    expect(() => s.updateTask(top.id, 1, { title: "stale" })).toThrow(
      /conflict/,
    );
    const undone = s.updateTask(top.id, 2, { status: "todo" });
    expect(undone.completed_at).toBeNull();
    s.deleteList(list.id);
    expect(s.listTasks()).toHaveLength(0);
    expect(s.listLists()).toHaveLength(3);
  });
  it("validates calendar days and keeps date and instant semantics separate", () => {
    const s = service();
    const date = s.createTask({
      title: "Date",
      due_kind: "date",
      due_date: "2026-11-14",
    });
    expect(date.due_at).toBeNull();
    expect(date.time_zone).toBeNull();
    const timed = s.createTask({
      title: "Time",
      due_kind: "datetime",
      due_date: "2026-11-15",
      due_at: "2026-11-14T16:00:00Z",
      time_zone: "Asia/Shanghai",
    });
    expect(timed.due_date).toBe("2026-11-15");
    expect(() =>
      s.createTask({ title: "bad", due_kind: "date", due_date: "2026-02-30" }),
    ).toThrow();
    expect(() =>
      s.createTask({
        title: "bad",
        due_kind: "date",
        due_date: "2026-11-14",
        due_at: "2026-11-14T00:00:00Z",
      }),
    ).toThrow();
    expect(() =>
      s.createTask({
        title: "bad",
        due_kind: "datetime",
        due_date: "2026-11-14",
        due_at: "2026-11-14T16:00:00Z",
        time_zone: "Asia/Shanghai",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      s.createTask({ title: "bad", due_at: "2026-11-14T00:00:00Z" }),
    ).toThrow();
  });
  it("protects recurring template dates and status while allowing ordinary edits", () => {
    const s = service();
    const t = s.createTask({
      title: "Daily",
      due_kind: "date",
      due_date: "2026-11-14",
    });
    s.schedules.setRecurrence(t.id, {
      rrule: "FREQ=DAILY",
      dtstart: t.due_date,
      tzid: "UTC",
      count: 3,
    });
    expect(() =>
      s.updateTask(t.id, t.version, { due_date: "2026-11-15" }),
    ).toThrow(/recurring occurrence/);
    expect(() => s.updateTask(t.id, t.version, { status: "done" })).toThrow(
      /recurring occurrence/,
    );
    expect(s.updateTask(t.id, t.version, { title: "Renamed" }).title).toBe(
      "Renamed",
    );
  });
  it("moves children with their parent and rejects cross-list nesting", () => {
    const s = service();
    const [a, b] = s.listLists();
    const parent = s.createTask({ list_id: a.id, title: "P" });
    const child = s.createTask({
      list_id: a.id,
      parent_id: parent.id,
      title: "C",
    });
    s.updateTask(parent.id, parent.version, { list_id: b.id });
    expect(s.getTask(child.id).list_id).toBe(b.id);
    expect(s.getTask(child.id).version).toBe(2);
    expect(() => s.updateTask(child.id, 2, { list_id: a.id })).toThrow();
  });
});

describe("validated proposals, transactions and audit undo", () => {
  it("normalizes strict schema wire patches and rejects duplicate or unknown keys", () => {
    const wire = {
      version: 1,
      summary: "Create",
      idempotency_key: "wire",
      risk: "low",
      actions: [
        {
          type: "create",
          target_id: null,
          temp_id: "one",
          expected_version: null,
          patch: [
            { key: "title", value: "Read" },
            { key: "list_id", value: "list" },
          ],
        },
      ],
    };
    const normalized = parseProposal(wire);
    expect(normalized.actions[0].patch).toEqual({
      title: "Read",
      list_id: "list",
    });
    expect(normalized.actions[0].target_id).toBeUndefined();
    expect(() =>
      parseProposal({
        ...wire,
        actions: [
          {
            ...wire.actions[0],
            patch: [
              { key: "title", value: "one" },
              { key: "title", value: "two" },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseProposal({
        ...wire,
        actions: [
          {
            ...wire.actions[0],
            patch: [{ key: "database_path", value: "/tmp/private" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseProposal({
        ...wire,
        actions: [
          {
            type: "complete",
            target_id: "task",
            temp_id: null,
            expected_version: null,
            patch: [],
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects targets outside explicitly supplied model context", () => {
    const s = service();
    const a = s.createTask({ title: "Visible" }),
      b = s.createTask({ title: "Private" });
    expect(() =>
      s.saveProposal(
        proposal([
          { type: "delete", target_id: b.id, expected_version: 1, patch: {} },
        ]),
        "",
        "",
        [a.id],
      ),
    ).toThrow(/outside/);
    expect(s.listTasks()).toHaveLength(2);
  });

  it("rejects missing versions, unknown targets, unsafe patches, invalid enums and oversized deletes", () => {
    const s = service();
    const t = s.createTask({ title: "Task" });
    expect(() =>
      parseProposal(
        proposal([
          { type: "update", target_id: t.id, patch: { title: "new" } },
        ]),
      ),
    ).toThrow();
    expect(() =>
      s.saveProposal(
        proposal([
          {
            type: "complete",
            target_id: "missing",
            expected_version: 1,
            patch: {},
          },
        ]),
        "",
        "",
      ),
    ).toThrow(/not found/);
    expect(() =>
      parseProposal(
        proposal([
          {
            type: "complete",
            target_id: t.id,
            expected_version: 1,
            patch: { title: "hidden edit" },
          },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseProposal({
        ...proposal([]),
        actions: [
          {
            type: "create",
            patch: { title: "x", list_id: t.list_id, priority: "critical" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseProposal(
        proposal(
          Array.from({ length: 51 }, (_, i) => ({
            type: "delete",
            target_id: String(i),
            expected_version: 1,
            patch: {},
          })),
        ),
      ),
    ).toThrow();
  });
  it("auto-applies only a single low-risk create, is idempotent, and can undo once", () => {
    const s = service();
    const body = proposal([
      {
        type: "create",
        temp_id: "new",
        patch: {
          list_id: s.listLists()[0].id,
          title: "Buy tea",
          tags: ["z", "a"],
        },
      },
    ]);
    const p = s.saveProposal(body, "buy tea", JSON.stringify(body));
    expect(p.risk).toBe("low");
    expect(s.applyProposal(p.id).status).toBe("applied");
    expect(s.applyProposal(p.id).status).toBe("applied");
    expect(s.listTasks()).toHaveLength(1);
    expect(s.saveProposal(body, "buy tea", "").id).toBe(p.id);
    expect(s.undoProposal(p.id).status).toBe("undone");
    expect(s.listTasks()).toHaveLength(0);
    expect(s.undoProposal(p.id).status).toBe("undone");
    expect(() => s.applyProposal(p.id)).toThrow(/no longer/);
    expect(
      s.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE undo_of IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it("forces confirmation regardless of model risk for bulk changes and deletes", () => {
    const s = service();
    const p = s.createTask({ title: "Parent" });
    s.createTask({ title: "Child", list_id: p.list_id, parent_id: p.id });
    const saved = s.saveProposal(
      proposal([
        {
          type: "delete",
          target_id: p.id,
          expected_version: p.version,
          patch: {},
        },
      ]),
      "",
      "",
    );
    expect(saved.risk).toBe("high");
    expect(() => s.applyProposal(saved.id)).toThrow(/confirmation/);
    expect(s.listTasks()).toHaveLength(2);
    s.applyProposal(saved.id, true);
    expect(s.listTasks()).toHaveLength(0);
    s.undoProposal(saved.id);
    expect(s.listTasks()).toHaveLength(2);
    expect(s.getTask(p.id).version).toBe(3);
  });
  it("preflights versions and rolls back every earlier write on later validation failure", () => {
    const s = service();
    const a = s.createTask({ title: "A" }),
      b = s.createTask({ title: "B" });
    const p = s.saveProposal(
      proposal([
        {
          type: "update",
          target_id: a.id,
          expected_version: 1,
          patch: { title: "updated" },
        },
        {
          type: "update",
          target_id: b.id,
          expected_version: 1,
          patch: { list_id: "missing" },
        },
      ]),
      "",
      "",
    );
    expect(() => s.applyProposal(p.id, true)).toThrow();
    expect(s.getTask(a.id).title).toBe("A");
    expect(s.getTask(a.id).version).toBe(1);
    expect(s.listProposals()[0].status).toBe("failed");
    const stale = s.saveProposal(
      proposal(
        [{ type: "complete", target_id: b.id, expected_version: 1, patch: {} }],
        "stale",
      ),
      "",
      "",
    );
    s.updateTask(b.id, 1, { title: "manual edit" });
    expect(() => s.applyProposal(stale.id, true)).toThrow(/conflict/);
    expect(s.getTask(b.id).status).toBe("todo");
  });
  it("rejects parent deletion if subtasks changed after preview", () => {
    const s = service();
    const parent = s.createTask({ title: "Parent" }),
      child = s.createTask({
        title: "Child",
        parent_id: parent.id,
        list_id: parent.list_id,
      });
    const pending = s.saveProposal(
      proposal([
        {
          type: "delete",
          target_id: parent.id,
          expected_version: parent.version,
          patch: {},
        },
      ]),
      "",
      "",
    );
    s.updateTask(child.id, child.version, { notes: "new work" });
    expect(() => s.applyProposal(pending.id, true)).toThrow(/subtasks changed/);
    expect(s.listTasks()).toHaveLength(2);
    const pending2 = s.saveProposal(
      proposal(
        [
          {
            type: "delete",
            target_id: parent.id,
            expected_version: parent.version,
            patch: {},
          },
        ],
        "new-child",
      ),
      "",
      "",
    );
    s.createTask({
      title: "Another child",
      parent_id: parent.id,
      list_id: parent.list_id,
    });
    expect(() => s.applyProposal(pending2.id, true)).toThrow(
      /subtasks changed/,
    );
    expect(s.listTasks()).toHaveLength(3);
  });
  it("refuses undo after concurrent changes, preserving the current task", () => {
    const s = service();
    const p = s.saveProposal(
      proposal([
        {
          type: "create",
          patch: { title: "New", list_id: s.listLists()[0].id },
        },
      ]),
      "",
      "",
    );
    s.applyProposal(p.id);
    const t = s.listTasks()[0];
    s.updateTask(t.id, t.version, { notes: "manual change" });
    expect(() => s.undoProposal(p.id)).toThrow(/changed/);
    expect(s.getTask(t.id).notes).toBe("manual change");
  });
  it("rejects reusing an idempotency key for a different action", () => {
    const s = service();
    const list_id = s.listLists()[0].id;
    s.saveProposal(
      proposal([{ type: "create", patch: { title: "First", list_id } }]),
      "",
      "",
    );
    expect(() =>
      s.saveProposal(
        proposal([{ type: "create", patch: { title: "Second", list_id } }]),
        "",
        "",
      ),
    ).toThrow(/Idempotency/);
  });
});

describe("consistent backup and JSON transfer", () => {
  it("backs up a live WAL database and refuses overwriting it", async () => {
    const dir = temp(),
      path = join(dir, "live.db"),
      backup = join(dir, "backup.db");
    const s = service(path);
    s.createTask({ title: "Persisted", tags: ["safe"] });
    await expect(s.backup(path)).rejects.toThrow(/active database/);
    await s.backup(backup);
    const db = new Database(backup);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.prepare("SELECT title FROM tasks").get()).toEqual({
      title: "Persisted",
    });
    db.close();
    s.createTask({ title: "Still live" });
    expect(s.listTasks()).toHaveLength(2);
  });
  it("protects the live database and aliases during export and backup", async () => {
    const dir = temp(),
      path = join(dir, "live.sqlite"),
      s = service(path);
    s.createTask({ title: "Keep safe" });
    const symlink = join(dir, "symlink.json"),
      hardlink = join(dir, "hardlink.json");
    symlinkSync(path, symlink);
    linkSync(path, hardlink);
    for (const destination of [
      path,
      path + "-wal",
      path + "-shm",
      symlink,
      hardlink,
    ]) {
      await expect(s.exportToFile(destination)).rejects.toThrow(
        /active database/,
      );
      await expect(s.backup(destination)).rejects.toThrow(/active database/);
    }
    expect(s.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(s.listTasks()[0].title).toBe("Keep safe");
    const output = join(dir, "export.json");
    await s.exportToFile(output);
    const exported = JSON.parse(readFileSync(output, "utf8"));
    expect(exported.tasks[0].title).toBe("Keep safe");
    s.createTask({ title: "Second" });
    await s.exportToFile(output);
    expect(JSON.parse(readFileSync(output, "utf8")).tasks).toHaveLength(2);
    expect(
      readdirSync(dir).some((name) => name.startsWith(".telldo-export-")),
    ).toBe(false);
  });
  it("round trips lists, child tasks, tags and recurrence state with new IDs", () => {
    const s = service();
    const parent = s.createTask({
      title: "Repeat",
      tags: ["daily"],
      due_kind: "date",
      due_date: "2026-01-01",
    });
    const child = s.createTask({
      title: "Step",
      list_id: parent.list_id,
      parent_id: parent.id,
    });
    const schedules = new ScheduleService(s.db);
    const series = schedules.setRecurrence(parent.id, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-01-01",
      tzid: "UTC",
      until: null,
      count: 5,
      exdates: [],
    });
    s.db
      .prepare(
        "INSERT OR REPLACE INTO occurrences(series_id,occurrence_key,status,due_date,due_at,override_date,completed_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        series.id,
        "2026-01-01",
        "done",
        "2026-01-01",
        null,
        null,
        "2026-01-01T12:00:00Z",
      );
    const exported = s.exportData();
    const result = s.importData(JSON.parse(JSON.stringify(exported)));
    expect(result.tasks).toBe(2);
    expect(s.listTasks()).toHaveLength(4);
    const newParent = s
      .listTasks()
      .find((t) => t.title === "Repeat" && t.id !== parent.id)!;
    const newChild = s
      .listTasks()
      .find((t) => t.title === "Step" && t.id !== child.id)!;
    expect(newChild.parent_id).toBe(newParent.id);
    expect(newParent.tags).toEqual(["daily"]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM recurrences").get()).toEqual(
      { n: 2 },
    );
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE status='done'")
        .get(),
    ).toEqual({ n: 2 });
  });
  it("round trips spring DST gap instances with their original wall-time identity", () => {
    const s = service();
    const t = s.createTask({
      title: "DST",
      due_kind: "datetime",
      due_date: "2026-03-07",
      due_at: "2026-03-07T07:30:00Z",
      time_zone: "America/New_York",
    });
    s.schedules.setRecurrence(t.id, {
      rrule: "FREQ=DAILY",
      dtstart: "2026-03-07T02:30:00",
      tzid: "America/New_York",
      count: 3,
    });
    const exported = s.exportData();
    expect(s.importData(exported).tasks).toBe(1);
    const occurrences = s.schedules
      .listOccurrences()
      .filter((o) => o.occurrence_key === "2026-03-08T02:30:00");
    expect(occurrences).toHaveLength(2);
    expect(
      occurrences.every((o) => o.due_at === "2026-03-08T07:30:00.000Z"),
    ).toBe(true);
  });
  it("rolls the entire import back for dangling references", () => {
    const s = service();
    s.createTask({ title: "Keep" });
    const data = s.exportData() as any;
    data.tasks[0].list_id = "missing";
    const before = s.listLists().length;
    expect(() => s.importData(data)).toThrow(/missing list/);
    expect(s.listLists()).toHaveLength(before);
    expect(s.listTasks()).toHaveLength(1);
  });
});
