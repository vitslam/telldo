import { reminderForTimeChange } from "../shared/task-timing";
import { nextListColor } from "../shared/list-colors";
import Database from "./sqlite";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdirSync, realpathSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { writeFile, rename, rm } from "node:fs/promises";
import { DateTime, IANAZone } from "luxon";
import type {
  List,
  Task,
  TaskPatch,
  Proposal,
  ProposalInput,
  Settings,
  Recurrence,
} from "../shared/types";
import { parseProposal, parseTaskPatch } from "../shared/proposal";
import { ScheduleService } from "./schedule-service";
import { splitRecurringTask } from "../shared/recurrence";

const now = () => new Date().toISOString();
const id = () => randomUUID();
const taskColumns = [
  "id",
  "list_id",
  "parent_id",
  "title",
  "notes",
  "status",
  "priority",
  "due_kind",
  "due_date",
  "due_at",
  "time_zone",
  "planned_date",
  "reminder_at",
  "completed_at",
  "version",
  "sort_order",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;
const nullable = [
  "parent_id",
  "due_date",
  "due_at",
  "time_zone",
  "planned_date",
  "reminder_at",
  "completed_at",
  "deleted_at",
];
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, any>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid text");
  return value.trim();
}

export class TaskService {
  readonly db: Database.Database;
  private editingSeries = false;
  readonly schedules: ScheduleService;
  private activeProposal: string | null = null;
  constructor(readonly dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lists(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,sort_order REAL NOT NULL,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,list_id TEXT NOT NULL REFERENCES lists(id),parent_id TEXT REFERENCES tasks(id),title TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('todo','done')),priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high')),due_kind TEXT NOT NULL CHECK(due_kind IN ('none','date','datetime')),due_date TEXT,due_at TEXT,time_zone TEXT,planned_date TEXT,reminder_at TEXT,completed_at TEXT,version INTEGER NOT NULL DEFAULT 1,sort_order REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_dates ON tasks(due_date,planned_date);
      CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS task_tags(task_id TEXT NOT NULL REFERENCES tasks(id),tag_id TEXT NOT NULL REFERENCES tags(id),PRIMARY KEY(task_id,tag_id));
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,source_text TEXT NOT NULL,model_raw TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected','failed','undone')),idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposal_scopes(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),child_versions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposal_created_lists(proposal_id TEXT NOT NULL REFERENCES proposals(id),list_id TEXT NOT NULL REFERENCES lists(id),snapshot_json TEXT NOT NULL,changed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(proposal_id,list_id));
      CREATE TABLE IF NOT EXISTS proposal_created_recurrences(proposal_id TEXT NOT NULL REFERENCES proposals(id),series_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),snapshot_json TEXT NOT NULL,changed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS proposal_series_edits(proposal_id TEXT NOT NULL,task_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,PRIMARY KEY(proposal_id,task_id));
      CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,before_json TEXT,after_json TEXT,proposal_id TEXT,undo_of TEXT);
    `);
    this.schedules = new ScheduleService(this.db);
    // Expanding a date window inserts untouched instances and does not invalidate
    // undo. Actual edits/removal do, even if a user later restores the old values.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS proposal_recurrence_updated AFTER UPDATE ON recurrences BEGIN
        UPDATE proposal_created_recurrences SET changed=1 WHERE series_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS proposal_recurrence_deleted AFTER DELETE ON recurrences BEGIN
        UPDATE proposal_created_recurrences SET changed=1 WHERE series_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS proposal_occurrence_updated AFTER UPDATE ON occurrences BEGIN
        UPDATE proposal_created_recurrences SET changed=1 WHERE series_id=OLD.series_id;
      END;
      CREATE TRIGGER IF NOT EXISTS proposal_occurrence_deleted AFTER DELETE ON occurrences BEGIN
        UPDATE proposal_created_recurrences SET changed=1 WHERE series_id=OLD.series_id;
      END;
    `);
    if (!this.db.prepare("SELECT id FROM lists LIMIT 1").get())
      this.db.transaction(() => {
        for (const [name, color] of [
          ["工作", "#6d74e8"],
          ["生活", "#36a18b"],
          ["随时再说", "#c99442"],
        ])
          this.createList(name, color);
      })();
  }
  close() {
    this.db.close();
  }
  getSettings(): Settings {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("preferences") as { value: string } | undefined;
    return {
      theme: "mono",
      appearance: "system",
      language: "system",
      timeZone: "",
      codexPath: "",
      aiTransport: "local",
      sshHost: "",
      sshUser: "",
      sshPort: 22,
      sshCodexPath: "",
      sshRunnerPath: "",
      sshProxyUrl: "",
      permissionMode: "confirm",
      alwaysConfirm: false,
      closeToTray: true,
      notificationsEnabled: true,
      notificationSound: true,
      notifyAIComplete: true,
      ...(row ? JSON.parse(row.value) : {}),
    };
  }
  setSettings(input: Partial<Settings>): Settings {
    if (
      Object.keys(object(input)).some(
        (k) =>
          ![
            "theme",
            "appearance",
            "language",
            "timeZone",
            "codexPath",
            "aiTransport",
            "sshHost",
            "sshUser",
            "sshPort",
            "sshCodexPath",
            "sshRunnerPath",
            "sshProxyUrl",
            "permissionMode",
            "alwaysConfirm",
            "closeToTray",
            "notificationsEnabled",
            "notificationSound",
            "notifyAIComplete",
          ].includes(k),
      )
    )
      throw new Error("Unknown settings field");
    const value = { ...this.getSettings(), ...input };
    if (
      !["mono", "forest", "ocean", "plum"].includes(value.theme) ||
      !["system", "light", "dark"].includes(value.appearance) ||
      !["system", "zh", "en"].includes(value.language) ||
      typeof value.timeZone !== "string" ||
      (value.timeZone !== "" && !IANAZone.isValidZone(value.timeZone)) ||
      typeof value.codexPath !== "string" ||
      value.codexPath.length > 4096 ||
      value.codexPath.includes("\0") ||
      !["confirm", "auto"].includes(value.permissionMode) ||
      typeof value.alwaysConfirm !== "boolean" ||
      typeof value.closeToTray !== "boolean" ||
      typeof value.notificationsEnabled !== "boolean" ||
      typeof value.notificationSound !== "boolean" ||
      typeof value.notifyAIComplete !== "boolean"
    )
      throw new Error("Invalid settings / 设置无效");
    const host = value.sshHost;
    const validHost =
      typeof host === "string" &&
      host.length <= 253 &&
      (host === "" ||
        isIP(host) !== 0 ||
        /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(
          host,
        ));
    const safePath = (path: unknown): path is string =>
      typeof path === "string" &&
      path.length <= 4096 &&
      (path === "" || /^\/[A-Za-z0-9_./-]+$/.test(path));
    if (
      !["local", "ssh"].includes(value.aiTransport) ||
      !validHost ||
      typeof value.sshUser !== "string" ||
      (value.sshUser !== "" &&
        !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.sshUser)) ||
      !Number.isInteger(value.sshPort) ||
      value.sshPort < 1 ||
      value.sshPort > 65535 ||
      !safePath(value.sshCodexPath) ||
      !safePath(value.sshRunnerPath) ||
      typeof value.sshProxyUrl !== "string" ||
      value.sshProxyUrl.length > 2048
    ) {
      throw new Error("Invalid SSH settings / SSH 设置无效");
    }
    if (
      value.aiTransport === "ssh" &&
      (!value.sshHost || !value.sshUser || !value.sshRunnerPath)
    ) {
      throw new Error(
        "SSH requires a host, user and absolute runner path / SSH 需要主机、用户名和执行器绝对路径",
      );
    }
    if (value.sshProxyUrl) {
      let proxy: URL;
      try {
        proxy = new URL(value.sshProxyUrl);
      } catch {
        throw new Error("Invalid proxy URL / 代理地址无效");
      }
      if (
        !["http:", "https:"].includes(proxy.protocol) ||
        !proxy.hostname ||
        proxy.username ||
        proxy.password ||
        /[\x00-\x20]/.test(value.sshProxyUrl)
      ) {
        throw new Error(
          "Proxy must be HTTP(S) without credentials / 代理必须是无账号密码的 HTTP(S) 地址",
        );
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
      .run("preferences", JSON.stringify(value));
    return value;
  }
  private audit(
    action: string,
    entity: string,
    before: unknown,
    after: unknown,
    undoOf: string | null = null,
  ) {
    this.db
      .prepare("INSERT INTO audit_log VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id(),
        now(),
        action,
        entity,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        this.activeProposal,
        undoOf,
      );
  }
  listLists(): List[] {
    return this.db
      .prepare(
        "SELECT * FROM lists WHERE archived_at IS NULL ORDER BY sort_order,created_at",
      )
      .all() as List[];
  }
  createList(name: string, color?: string): List {
    name = text(name);
    color ??= nextListColor(this.listLists());
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Invalid list color");
    const at = now();
    const value: List = {
      id: id(),
      name,
      color,
      sort_order: this.listLists().length,
      archived_at: null,
      created_at: at,
      updated_at: at,
    };
    this.db
      .prepare(
        "INSERT INTO lists VALUES(@id,@name,@color,@sort_order,@archived_at,@created_at,@updated_at)",
      )
      .run(value);
    return value;
  }
  updateList(
    listId: string,
    patch: Partial<Pick<List, "name" | "color" | "sort_order">>,
  ): List {
    const old = this.listLists().find((x) => x.id === listId);
    if (!old) throw new Error("List not found");
    if (
      Object.keys(object(patch)).some(
        (k) => !["name", "color", "sort_order"].includes(k),
      )
    )
      throw new Error("Unknown list field");
    const value = { ...old, ...patch, updated_at: now() };
    value.name = text(value.name);
    if (
      !/^#[0-9a-f]{6}$/i.test(value.color) ||
      !Number.isFinite(value.sort_order)
    )
      throw new Error("Invalid list");
    this.db
      .prepare(
        "UPDATE lists SET name=@name,color=@color,sort_order=@sort_order,updated_at=@updated_at WHERE id=@id",
      )
      .run(value);
    this.db
      .prepare("UPDATE proposal_created_lists SET changed=1 WHERE list_id=?")
      .run(listId);
    return value;
  }
  deleteList(listId: string): void {
    this.db.transaction(() => {
      if (!this.listLists().some((x) => x.id === listId))
        throw new Error("List not found");
      for (const task of this.listTasks().filter(
        (t) => t.list_id === listId && !t.parent_id,
      ))
        this.deleteTask(task.id, task.version);
      this.db
        .prepare("UPDATE lists SET archived_at=?,updated_at=? WHERE id=?")
        .run(now(), now(), listId);
      this.db
        .prepare("UPDATE proposal_created_lists SET changed=1 WHERE list_id=?")
        .run(listId);
    })();
  }
  private tags(taskId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT tags.name FROM tags JOIN task_tags ON tags.id=task_tags.tag_id WHERE task_tags.task_id=? ORDER BY tags.name",
        )
        .all(taskId) as { name: string }[]
    ).map((x) => x.name);
  }
  getTask(taskId: string, includeDeleted = false): Task {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
      )
      .get(taskId) as Omit<Task, "tags"> | undefined;
    if (!row) throw new Error("Task not found / 任务不存在");
    return { ...row, tags: this.tags(taskId) };
  }
  listTasks(): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY sort_order,created_at",
        )
        .all() as Omit<Task, "tags">[]
    ).map((t) => ({ ...t, tags: this.tags(t.id) }));
  }
  search(query: string): Task[] {
    const q = query.trim().toLocaleLowerCase();
    return this.listTasks().filter((t) =>
      [t.title, t.notes, ...t.tags].join("\n").toLocaleLowerCase().includes(q),
    );
  }
  private assertVersion(task: Task, version: number) {
    if (!Number.isSafeInteger(version) || task.version !== version)
      throw new Error(
        "Version conflict: reload the task / 任务已改变，请刷新后重试",
      );
  }
  private validate(task: Task) {
    parseTaskPatch(
      Object.fromEntries(
        Object.entries(task).filter(
          ([k]) =>
            ![
              "id",
              "completed_at",
              "version",
              "created_at",
              "updated_at",
              "deleted_at",
            ].includes(k),
        ),
      ),
    );
    if (!this.listLists().some((l) => l.id === task.list_id))
      throw new Error("List not found");
    if (task.parent_id) {
      const parent = this.getTask(task.parent_id);
      if (
        parent.parent_id ||
        parent.id === task.id ||
        parent.list_id !== task.list_id
      )
        throw new Error("Subtasks must be one level deep and in the same list");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM tasks WHERE parent_id=? AND deleted_at IS NULL",
          )
          .get(task.id)
      )
        throw new Error("A task with subtasks cannot become a subtask");
    }
    if (
      task.due_kind === "none" &&
      (task.due_date || task.due_at || task.time_zone)
    )
      throw new Error("Undated tasks cannot contain due fields");
    if (
      task.due_kind === "date" &&
      (!task.due_date || task.due_at || task.time_zone)
    )
      throw new Error("Date tasks require only a calendar day");
    if (task.due_kind === "datetime") {
      if (!task.due_at || !task.time_zone || !task.due_date)
        throw new Error(
          "Timed tasks need an instant, calendar day and time zone",
        );
      if (
        DateTime.fromISO(task.due_at).setZone(task.time_zone).toISODate() !==
        task.due_date
      )
        throw new Error("Calendar date does not match task time zone");
    }
  }
  private write(task: Task) {
    this.db
      .prepare(
        `INSERT INTO tasks(${taskColumns.join(",")}) VALUES(${taskColumns.map((k) => "@" + k).join(",")}) ON CONFLICT(id) DO UPDATE SET ${taskColumns
          .filter((k) => k !== "id")
          .map((k) => `${k}=excluded.${k}`)
          .join(",")}`,
      )
      .run(
        Object.fromEntries(
          taskColumns.map((k) => [
            k,
            task[k] ?? (nullable.includes(k) ? null : ""),
          ]),
        ),
      );
    this.db.prepare("DELETE FROM task_tags WHERE task_id=?").run(task.id);
    for (const name of [...new Set(task.tags)]) {
      this.db
        .prepare("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)")
        .run(id(), name);
      const tag = this.db
        .prepare("SELECT id FROM tags WHERE name=?")
        .get(name) as { id: string };
      this.db.prepare("INSERT INTO task_tags VALUES(?,?)").run(task.id, tag.id);
    }
  }
  createTask(input: TaskPatch): Task {
    return this.db.transaction(() => {
      const patch = parseTaskPatch(input);
      if (patch.due_kind === "datetime" && patch.due_at && patch.reminder_at === undefined)
        patch.reminder_at = patch.due_at;
      const at = now();
      const value: Task = {
        id: id(),
        list_id: patch.list_id || this.listLists()[0]?.id,
        parent_id: null,
        title: "",
        notes: "",
        status: "todo",
        priority: "none",
        due_kind: "none",
        due_date: null,
        due_at: null,
        time_zone: null,
        planned_date: null,
        reminder_at: null,
        completed_at: null,
        version: 1,
        sort_order: Date.now(),
        created_at: at,
        updated_at: at,
        deleted_at: null,
        tags: [],
        ...patch,
      };
      value.tags = [...new Set(value.tags)];
      if (value.status === "done") value.completed_at = at;
      this.validate(value);
      this.write(value);
      this.audit("create", value.id, null, value);
      return value;
    })();
  }
  private seriesState(taskId: string) {
    const rule = this.schedules
      .listRecurrences()
      .find((r) => r.task_id === taskId);
    return {
      rule,
      occurrences: rule
        ? this.schedules
            .listOccurrences()
            .filter((o) => o.series_id === rule.id)
        : [],
    };
  }
  updateRecurring(
    taskId: string,
    version: number,
    input: TaskPatch,
    spec: unknown,
  ): Task {
    return this.db.transaction(() => {
      const current = this.getTask(taskId);
      this.assertVersion(current, version);
      const old = this.schedules
        .listRecurrences()
        .find((r) => r.task_id === taskId);
      if (!old) throw Error("Recurring task not found / 重复任务不存在");
      const { task, recurrence } = splitRecurringTask({
        ...current,
        ...input,
        ...(spec as object),
      } as any);
      recurrence.exdates = old.exdates;
      const patch = parseTaskPatch(input);
      this.editingSeries = true;
      let updated: Task;
      try {
        updated = this.updateTask(taskId, version, patch);
      } finally {
        this.editingSeries = false;
      }
      this.schedules.replaceRecurrence(taskId, recurrence);
      return updated;
    })();
  }
  updateTask(taskId: string, expectedVersion: number, input: TaskPatch): Task {
    return this.db.transaction(() => {
      const patch = parseTaskPatch(input);
      const before = this.getTask(taskId);
      this.assertVersion(before, expectedVersion);
      const reminder = reminderForTimeChange(before, patch, patch.time_zone || before.time_zone || this.getSettings().timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (reminder !== undefined) patch.reminder_at = reminder;
      if (
        !this.editingSeries &&
        this.db
          .prepare("SELECT 1 FROM recurrences WHERE task_id=?")
          .get(taskId) &&
        (
          [
            "due_kind",
            "due_date",
            "due_at",
            "time_zone",
            "status",
            "parent_id",
          ] as const
        ).some((k) => patch[k] !== undefined && patch[k] !== before[k])
      )
        throw new Error(
          "Change the individual recurring occurrence, or remove the repeat rule first / 请修改单个重复实例，或先移除重复规则",
        );
      const after = {
        ...before,
        ...patch,
        version: before.version + 1,
        updated_at: now(),
      };
      after.tags = [...new Set(after.tags)];
      if (before.status !== after.status)
        after.completed_at = after.status === "done" ? now() : null;
      this.validate(after);
      this.write(after);
      this.audit("update", taskId, before, after);
      if (before.list_id !== after.list_id) {
        for (const child of this.listTasks().filter(
          (t) => t.parent_id === taskId,
        ))
          this.updateTask(child.id, child.version, { list_id: after.list_id });
      }
      return after;
    })();
  }
  deleteTask(taskId: string, expectedVersion: number): void {
    this.db.transaction(() => {
      const before = this.getTask(taskId);
      this.assertVersion(before, expectedVersion);
      for (const child of this.listTasks().filter(
        (t) => t.parent_id === taskId,
      ))
        this.deleteTask(child.id, child.version);
      const after = {
        ...before,
        deleted_at: now(),
        updated_at: now(),
        version: before.version + 1,
      };
      this.write(after);
      this.audit("delete", taskId, before, after);
    })();
  }
  private decode(row: any): Proposal {
    return {
      ...JSON.parse(row.body),
      id: row.id,
      source_text: row.source_text,
      model_raw: row.model_raw,
      status: row.status,
      created_at: row.created_at,
    };
  }
  listProposals(): Proposal[] {
    return this.db
      .prepare("SELECT * FROM proposals ORDER BY created_at DESC")
      .all()
      .map((row) => this.decode(row));
  }
  private proposal(proposalId: string): Proposal {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE id=?")
      .get(proposalId);
    if (!row) throw new Error("Proposal not found");
    return this.decode(row);
  }
  private preflight(value: ProposalInput) {
    const hasNewLists = value.actions.some((a) => a.type === "create_list");
    const lists = this.listLists();
    const listIds = new Set(lists.map((list) => list.id));
    const normalizeName = (name: string) =>
      name.normalize("NFKC").trim().toLocaleLowerCase();
    const listNames = new Set(lists.map((list) => normalizeName(list.name)));
    for (const action of value.actions) {
      // Temporary IDs are a separate namespace, never aliases for stored entities.
      if (
        action.temp_id &&
        (this.db
          .prepare("SELECT 1 FROM lists WHERE id=?")
          .get(action.temp_id) ||
          this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(action.temp_id))
      )
        throw new Error(
          "Temporary ID conflicts with an existing entity / 临时标识与现有任务或清单冲突",
        );
      if (action.type === "create_list") {
        const name = normalizeName(action.patch.name);
        if (listNames.has(name))
          throw new Error(
            "A list with this name already exists / 已有同名清单，请使用现有清单或换一个名称",
          );
        listNames.add(name);
        listIds.add(action.temp_id);
        continue;
      }
      // For the new compound operation, all list references must resolve before
      // saving or applying it. Existing task-only proposals retain their behavior.
      if (
        hasNewLists &&
        action.patch.list_id &&
        !listIds.has(action.patch.list_id)
      )
        throw new Error("List not found / 清单不存在或临时清单尚未定义");
      if (action.type === "create_recurring") {
        const { task } = splitRecurringTask(action.patch);
        if (!task.list_id || !listIds.has(task.list_id))
          throw new Error("List not found / 周期任务所属清单不存在");
        continue;
      }
      if (action.type === "update_recurring") {
        const current = this.getTask(action.target_id);
        this.assertVersion(current, action.expected_version);
        if (
          !this.schedules
            .listRecurrences()
            .some((r) => r.task_id === current.id)
        )
          throw Error("Recurring task not found");
        splitRecurringTask(action.patch);
        if (!listIds.has(action.patch.list_id)) throw Error("List not found");
        continue;
      }
      if (action.type !== "create") {
        const target = this.getTask(action.target_id!);
        this.assertVersion(target, action.expected_version!);
        if (action.type === "add_subtask" && target.parent_id)
          throw new Error("Subtasks cannot contain subtasks");
      }
    }
  }
  private dependencies(
    value: ProposalInput,
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {},
      affected = new Set(
        value.actions.filter((a) => a.target_id).map((a) => a.target_id),
      );
    const children = this.db.prepare(
      "SELECT id,version FROM tasks WHERE parent_id=? AND deleted_at IS NULL ORDER BY id",
    );
    for (const a of value.actions) {
      if (a.type === "create_list") continue;
      if (
        a.target_id &&
        (a.type === "delete" ||
          (a.patch.list_id &&
            a.patch.list_id !== this.getTask(a.target_id).list_id))
      ) {
        const rows = children.all(a.target_id) as {
          id: string;
          version: number;
        }[];
        result[a.target_id] = Object.fromEntries(
          rows.map((t) => [t.id, t.version]),
        );
        for (const row of rows) affected.add(row.id);
      }
    }
    if (
      affected.size +
        value.actions.filter(
          (a) =>
            a.type === "create" ||
            a.type === "create_recurring" ||
            a.type === "add_subtask",
        ).length >
      50
    )
      throw new Error(
        "Proposal affects more than 50 tasks, including subtasks / 提案及其子任务超出 50 项限制",
      );
    return result;
  }
  saveProposal(
    input: unknown,
    sourceText: string,
    modelRaw: string,
    allowedTargetIds?: string[],
  ): Proposal {
    const value = parseProposal(input);
    if (allowedTargetIds) {
      const allowed = new Set(allowedTargetIds);
      if (
        value.actions.some(
          (a) =>
            a.type !== "create_list" &&
            ((a.target_id && !allowed.has(a.target_id)) ||
              (a.patch.parent_id &&
                !allowed.has(a.patch.parent_id) &&
                !value.actions.some(
                  (x) =>
                    x.type !== "create_list" && x.temp_id === a.patch.parent_id,
                ))),
        )
      )
        throw new Error(
          "Proposal targets a task outside the supplied context / 提案超出上下文范围",
        );
    }
    if (
      typeof sourceText !== "string" ||
      sourceText.length > 20000 ||
      typeof modelRaw !== "string" ||
      modelRaw.length > 1000000
    )
      throw new Error("Proposal input too large");
    const existing = this.db
      .prepare("SELECT * FROM proposals WHERE idempotency_key=?")
      .get(value.idempotency_key) as any;
    if (existing) {
      if (existing.body !== JSON.stringify(value))
        throw new Error("Idempotency key already used for another proposal");
      return this.decode(existing);
    }
    this.preflight(value);
    const dependencies = this.dependencies(value);
    const row = {
      id: id(),
      source_text: sourceText,
      model_raw: modelRaw,
      body: JSON.stringify(value),
      status: "pending",
      idempotency_key: value.idempotency_key,
      created_at: now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO proposals VALUES(@id,@source_text,@model_raw,@body,@status,@idempotency_key,@created_at)",
        )
        .run(row);
      this.db
        .prepare("INSERT INTO proposal_scopes VALUES(?,?)")
        .run(row.id, JSON.stringify(dependencies));
    })();
    return this.decode(row);
  }
  applyProposal(proposalId: string, confirmed = false): Proposal {
    const proposal = this.proposal(proposalId);
    if (proposal.status === "applied") return proposal;
    if (proposal.status !== "pending")
      throw new Error("Proposal is no longer pending");
    if (proposal.risk === "high" && !confirmed)
      throw new Error("This proposal requires confirmation / 此提案需要确认");
    try {
      this.db.transaction(() => {
        this.preflight(proposal);
        const scope = this.db
          .prepare(
            "SELECT child_versions FROM proposal_scopes WHERE proposal_id=?",
          )
          .get(proposalId) as { child_versions: string } | undefined;
        if (
          !scope ||
          scope.child_versions !== JSON.stringify(this.dependencies(proposal))
        )
          throw new Error(
            "Version conflict: affected subtasks changed / 关联子任务已改变，请重新生成提案",
          );
        this.activeProposal = proposalId;
        const temp = new Map<string, string>();
        const tempLists = new Map<string, string>();
        for (const a of proposal.actions) {
          if (a.type === "create_list") {
            const list = this.createList(a.patch.name, a.patch.color);
            tempLists.set(a.temp_id, list.id);
            this.db
              .prepare(
                "INSERT INTO proposal_created_lists(proposal_id,list_id,snapshot_json) VALUES(?,?,?)",
              )
              .run(proposalId, list.id, JSON.stringify(list));
            continue;
          }
          if (a.type === "create_recurring") {
            const { task: patch, recurrence } = splitRecurringTask(a.patch);
            if (patch.list_id && tempLists.has(patch.list_id))
              patch.list_id = tempLists.get(patch.list_id);
            const created = this.createTask(patch);
            const series = this.schedules.setRecurrence(created.id, recurrence);
            this.db
              .prepare(
                "INSERT INTO proposal_created_recurrences(proposal_id,series_id,task_id,snapshot_json) VALUES(?,?,?,?)",
              )
              .run(proposalId, series.id, created.id, JSON.stringify(series));
            temp.set(a.temp_id, created.id);
            continue;
          }
          if (a.type === "update_recurring") {
            const before = this.seriesState(a.target_id);
            const { task, recurrence } = splitRecurringTask(a.patch);
            this.updateRecurring(
              a.target_id,
              a.expected_version,
              task,
              recurrence,
            );
            this.db
              .prepare("INSERT INTO proposal_series_edits VALUES(?,?,?,?)")
              .run(
                proposalId,
                a.target_id,
                JSON.stringify(before),
                JSON.stringify(this.seriesState(a.target_id)),
              );
            continue;
          }
          const patch = { ...a.patch };
          if (patch.list_id && tempLists.has(patch.list_id))
            patch.list_id = tempLists.get(patch.list_id);
          if (patch.parent_id && temp.has(patch.parent_id))
            patch.parent_id = temp.get(patch.parent_id);
          switch (a.type) {
            case "create": {
              const created = this.createTask(patch);
              if (a.temp_id) temp.set(a.temp_id, created.id);
              break;
            }
            case "add_subtask": {
              const parent = this.getTask(a.target_id!);
              const created = this.createTask({
                ...patch,
                parent_id: parent.id,
                list_id: parent.list_id,
              });
              this.updateTask(parent.id, parent.version, {});
              if (a.temp_id) temp.set(a.temp_id, created.id);
              break;
            }
            case "complete":
              this.updateTask(a.target_id!, a.expected_version!, {
                status: "done",
              });
              break;
            case "uncomplete":
              this.updateTask(a.target_id!, a.expected_version!, {
                status: "todo",
              });
              break;
            case "delete":
              this.deleteTask(a.target_id!, a.expected_version!);
              break;
            default:
              this.updateTask(a.target_id!, a.expected_version!, patch);
          }
        }
        this.db
          .prepare("UPDATE proposals SET status='applied' WHERE id=?")
          .run(proposalId);
      })();
    } catch (error) {
      this.db
        .prepare(
          "UPDATE proposals SET status='failed' WHERE id=? AND status='pending'",
        )
        .run(proposalId);
      throw error;
    } finally {
      this.activeProposal = null;
    }
    return this.proposal(proposalId);
  }
  rejectProposal(proposalId: string): Proposal {
    const proposal = this.proposal(proposalId);
    if (proposal.status !== "pending")
      throw new Error("Proposal is no longer pending");
    this.db
      .prepare("UPDATE proposals SET status='rejected' WHERE id=?")
      .run(proposalId);
    return this.proposal(proposalId);
  }
  undoProposal(proposalId: string): Proposal {
    const proposal = this.proposal(proposalId);
    if (proposal.status === "undone") return proposal;
    if (proposal.status !== "applied")
      throw new Error("Only an applied proposal can be undone");
    this.db.transaction(() => {
      const edits = this.db
        .prepare("SELECT * FROM proposal_series_edits WHERE proposal_id=?")
        .all(proposalId) as {
        task_id: string;
        before_json: string;
        after_json: string;
      }[];
      for (const edit of edits)
        if (JSON.stringify(this.seriesState(edit.task_id)) !== edit.after_json)
          throw Error("Cannot undo: schedule changed / 日程已改变，无法撤销");
      const entries = this.db
        .prepare(
          "SELECT * FROM audit_log WHERE proposal_id=? AND undo_of IS NULL ORDER BY rowid DESC",
        )
        .all(proposalId) as any[];
      const last = new Map<string, Task>();
      for (const entry of entries)
        if (!last.has(entry.entity))
          last.set(entry.entity, JSON.parse(entry.after_json));
      const createdSeries = this.db
        .prepare(
          "SELECT series_id,task_id,snapshot_json,changed FROM proposal_created_recurrences WHERE proposal_id=?",
        )
        .all(proposalId) as {
        series_id: string;
        task_id: string;
        snapshot_json: string;
        changed: number;
      }[];
      const currentSeries = this.schedules.listRecurrences();
      for (const record of createdSeries) {
        const expected = JSON.parse(record.snapshot_json) as Recurrence;
        const current = currentSeries.find(
          (series) => series.id === record.series_id,
        );
        if (
          record.changed ||
          !current ||
          (Object.keys(expected) as (keyof Recurrence)[]).some(
            (key) =>
              JSON.stringify(current[key]) !== JSON.stringify(expected[key]),
          )
        )
          throw new Error(
            "Cannot undo: recurring task or schedule changed / 周期规则或实例已被修改，无法撤销此提案",
          );
        if (
          this.db
            .prepare(
              `SELECT 1 FROM occurrences WHERE series_id=? AND (status!='todo' OR version!=1 OR override_date IS NOT NULL OR override_due_at IS NOT NULL OR completed_at IS NOT NULL OR reminder_override!='inherit' OR override_reminder_at IS NOT NULL) LIMIT 1`,
            )
            .get(record.series_id) ||
          this.db
            .prepare("SELECT 1 FROM occurrence_audit WHERE series_id=? LIMIT 1")
            .get(record.series_id)
        )
          throw new Error(
            "Cannot undo: recurring instances changed / 重复实例已被修改，无法撤销此提案",
          );
      }
      const createdLists = this.db
        .prepare(
          "SELECT list_id,snapshot_json,changed FROM proposal_created_lists WHERE proposal_id=?",
        )
        .all(proposalId) as {
        list_id: string;
        snapshot_json: string;
        changed: number;
      }[];
      for (const record of createdLists) {
        const expected = JSON.parse(record.snapshot_json) as List;
        const current = this.db
          .prepare("SELECT * FROM lists WHERE id=?")
          .get(record.list_id) as List | undefined;
        if (
          record.changed ||
          !current ||
          (Object.keys(expected) as (keyof List)[]).some(
            (key) => current[key] !== expected[key],
          )
        )
          throw new Error(
            "Cannot undo: a created list changed after this proposal / 清单已被修改，无法撤销此提案",
          );
        const members = this.db
          .prepare(
            "SELECT id FROM tasks WHERE list_id=? AND deleted_at IS NULL",
          )
          .all(record.list_id) as { id: string }[];
        if (members.some((task) => !last.has(task.id)))
          throw new Error(
            "Cannot undo: new tasks have been added to the list / 清单中已有新增任务，无法撤销此提案",
          );
      }
      for (const [entity, after] of last) {
        const current = this.getTask(entity, true);
        if (
          taskColumns.some((k) => current[k] !== after[k]) ||
          JSON.stringify([...current.tags].sort()) !==
            JSON.stringify([...after.tags].sort())
        )
          throw new Error("Cannot undo: a task changed after this proposal");
        if (
          entries.some(
            (e) =>
              e.entity === entity &&
              (e.before_json === null ||
                JSON.parse(e.before_json).list_id !== after.list_id ||
                JSON.parse(e.before_json).parent_id !== after.parent_id),
          ) &&
          this.listTasks().some(
            (t) => t.parent_id === entity && !last.has(t.id),
          )
        )
          throw new Error("Cannot undo: new subtasks have been added");
      }
      for (const record of createdSeries)
        this.schedules.removeRecurrence(record.task_id);
      for (const edit of edits) {
        const before = JSON.parse(edit.before_json);
        const rule = before.rule;
        this.db
          .prepare("DELETE FROM occurrences WHERE series_id=?")
          .run(rule.id);
        this.db
          .prepare(
            "UPDATE recurrences SET rrule=?,dtstart=?,tzid=?,until=?,count=?,exdates=? WHERE id=?",
          )
          .run(
            rule.rrule,
            rule.dtstart,
            rule.tzid,
            rule.until,
            rule.count,
            JSON.stringify(rule.exdates),
            rule.id,
          );
        for (const o of before.occurrences) {
          const keys = Object.keys(o);
          this.db
            .prepare(
              `INSERT INTO occurrences (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
            )
            .run(...keys.map((k) => o[k]));
        }
      }
      for (const entry of entries) {
        const current = this.getTask(entry.entity, true);
        const before = entry.before_json ? JSON.parse(entry.before_json) : null;
        if (
          before &&
          !this.listLists().some((list) => list.id === before.list_id)
        )
          throw new Error(
            "Cannot undo: the original list is no longer available / 原清单已不存在，无法恢复任务",
          );
        const restored: Task = before
          ? { ...before, version: current.version + 1, updated_at: now() }
          : {
              ...current,
              deleted_at: now(),
              version: current.version + 1,
              updated_at: now(),
            };
        this.write(restored);
        this.audit("undo", entry.entity, current, restored, entry.id);
      }
      // Task undo has removed created tasks or restored moved tasks to their old
      // lists. Archive only the lists this proposal created; never cascade-delete.
      for (const record of createdLists)
        this.db
          .prepare("UPDATE lists SET archived_at=?,updated_at=? WHERE id=?")
          .run(now(), now(), record.list_id);
      this.db
        .prepare("UPDATE proposals SET status='undone' WHERE id=?")
        .run(proposalId);
    })();
    return this.proposal(proposalId);
  }
  private hasTable(name: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }
  exportData(): object {
    return this.db.transaction(() => ({
      format: "telldo",
      version: 1,
      exported_at: now(),
      lists: this.listLists(),
      tasks: this.listTasks(),
      recurrences: this.hasTable("recurrences")
        ? this.db
            .prepare(
              "SELECT * FROM recurrences WHERE task_id IN (SELECT id FROM tasks WHERE deleted_at IS NULL)",
            )
            .all()
            .map((r: any) => ({ ...r, exdates: JSON.parse(r.exdates) }))
        : [],
      occurrences: this.hasTable("occurrences")
        ? this.db
            .prepare(
              "SELECT * FROM occurrences WHERE series_id IN (SELECT id FROM recurrences WHERE task_id IN (SELECT id FROM tasks WHERE deleted_at IS NULL))",
            )
            .all()
        : [],
    }))();
  }
  importData(input: unknown): { tasks: number } {
    const data = object(input);
    if (
      (data.recurrences !== undefined && !Array.isArray(data.recurrences)) ||
      (data.occurrences !== undefined && !Array.isArray(data.occurrences))
    )
      throw new Error("Invalid schedule arrays");
    if (
      data.format !== "telldo" ||
      data.version !== 1 ||
      !Array.isArray(data.lists) ||
      !Array.isArray(data.tasks) ||
      data.tasks.length > 10000 ||
      data.lists.length > 1000
    )
      throw new Error("Invalid Telldo export or import limit exceeded");
    return this.db.transaction(() => {
      const listMap = new Map<string, string>(),
        taskMap = new Map<string, string>(),
        seriesMap = new Map<string, string>();
      for (const row of data.lists) {
        const l = object(row);
        const old = text(l.id);
        if (listMap.has(old)) throw new Error("Duplicate list ID");
        listMap.set(old, this.createList(text(l.name), l.color).id);
      }
      const rows: Record<string, any>[] = data.tasks.map(object);
      for (const t of rows) {
        const old = text(t.id);
        if (taskMap.has(old)) throw new Error("Duplicate task ID");
        taskMap.set(old, "");
      }
      for (const t of [
        ...rows.filter((t) => !t.parent_id),
        ...rows.filter((t) => t.parent_id),
      ]) {
        if (!listMap.has(t.list_id))
          throw new Error("Import references missing list");
        if (t.parent_id && !taskMap.get(t.parent_id))
          throw new Error("Import references missing or nested parent");
        const patch = parseTaskPatch(
          Object.fromEntries(
            Object.entries(t).filter(
              ([k]) =>
                ![
                  "id",
                  "completed_at",
                  "version",
                  "created_at",
                  "updated_at",
                  "deleted_at",
                ].includes(k),
            ),
          ),
        );
        patch.list_id = listMap.get(t.list_id)!;
        patch.parent_id = t.parent_id ? taskMap.get(t.parent_id)! : null;
        taskMap.set(t.id, this.createTask(patch).id);
      }
      if (data.recurrences?.length) {
        if (!Array.isArray(data.recurrences) || data.recurrences.length > 10000)
          throw new Error("Invalid schedules");
        const schedules = this.schedules;
        for (const raw of data.recurrences) {
          const r = object(raw);
          if (!taskMap.get(r.task_id) || seriesMap.has(r.id))
            throw new Error("Invalid recurrence reference");
          const created = schedules.setRecurrence(taskMap.get(r.task_id)!, {
            rrule: r.rrule,
            dtstart: r.dtstart,
            tzid: r.tzid,
            until: r.until,
            count: r.count,
            exdates: r.exdates,
          });
          seriesMap.set(r.id, created.id);
        }
      }
      if (data.occurrences?.length) {
        if (
          !Array.isArray(data.occurrences) ||
          data.occurrences.length > 100000
        )
          throw new Error("Invalid occurrences");
        for (const raw of data.occurrences) {
          const o = object(raw);
          if (
            !seriesMap.has(o.series_id) ||
            !["todo", "done", "skipped"].includes(o.status) ||
            typeof o.occurrence_key !== "string" ||
            o.occurrence_key.length > 200
          )
            throw new Error("Invalid occurrence");
          parseTaskPatch({
            due_date: o.due_date,
            due_at: o.due_at,
            planned_date: o.override_date,
          });
          if (o.override_due_at != null)
            parseTaskPatch({ due_at: o.override_due_at });
          if (o.override_reminder_at != null)
            parseTaskPatch({ reminder_at: o.override_reminder_at });
          if (
            o.reminder_override !== undefined &&
            !["inherit", "explicit"].includes(o.reminder_override)
          )
            throw Error("Invalid reminder override");
          if (
            o.version !== undefined &&
            (!Number.isSafeInteger(o.version) || o.version < 1)
          )
            throw Error("Invalid occurrence version");
          if (o.completed_at) parseTaskPatch({ reminder_at: o.completed_at });
          const series = this.schedules
            .listRecurrences()
            .find((r) => r.id === seriesMap.get(o.series_id))!;
          const task = this.getTask(series.task_id);
          const start = DateTime.fromISO(series.dtstart, { zone: series.tzid });
          const expectedKey =
            task.due_kind === "datetime"
              ? `${o.due_date}T${start.toFormat("HH:mm:ss")}`
              : o.due_date;
          if (
            o.occurrence_key !== expectedKey ||
            (task.due_kind === "date" &&
              (o.due_at !== null || o.override_due_at != null)) ||
            (task.due_kind === "datetime" &&
              DateTime.fromISO(o.due_at ?? "")
                .setZone(series.tzid)
                .toISODate() !== o.due_date)
          )
            throw new Error(
              "Occurrence identity does not match its original schedule date",
            );
          this.db
            .prepare(
              "INSERT OR REPLACE INTO occurrences(series_id,occurrence_key,status,due_date,due_at,override_date,completed_at,version,override_due_at,reminder_override,override_reminder_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              seriesMap.get(o.series_id),
              o.occurrence_key,
              o.status,
              o.due_date,
              o.due_at,
              o.override_date,
              o.completed_at,
              1,
              o.override_due_at ?? null,
              o.reminder_override ?? "inherit",
              o.override_reminder_at ?? null,
            );
        }
      }
      return { tasks: rows.length };
    })();
  }
  private assertSafeDestination(destination: string): void {
    if (
      typeof destination !== "string" ||
      !destination.trim() ||
      destination.includes("\0")
    )
      throw new Error("Destination path required");
    if (this.dbPath === ":memory:") return;
    const absolute = resolve(destination),
      canonical = existsSync(absolute)
        ? realpathSync(absolute)
        : join(realpathSync(dirname(absolute)), basename(absolute));
    const roots = [resolve(this.dbPath), realpathSync(this.dbPath)];
    const protectedPaths = [
      ...new Set(roots.flatMap((root) => [root, root + "-wal", root + "-shm"])),
    ];
    if (protectedPaths.some((path) => path === absolute || path === canonical))
      throw new Error(
        "Cannot overwrite the active database or its journal files / 不能覆盖正在使用的数据库及日志文件",
      );
    if (existsSync(absolute)) {
      const target = statSync(absolute);
      if (
        protectedPaths.some((path) => {
          if (!existsSync(path)) return false;
          const source = statSync(path);
          return source.dev === target.dev && source.ino === target.ino;
        })
      )
        throw new Error(
          "Cannot overwrite an alias of the active database / 不能覆盖正在使用的数据库的链接",
        );
    }
  }
  async exportToFile(destination: string): Promise<void> {
    this.assertSafeDestination(destination);
    const contents = JSON.stringify(this.exportData(), null, 2);
    const temporary = join(
      dirname(resolve(destination)),
      `.telldo-export-${id()}.tmp`,
    );
    try {
      await writeFile(temporary, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      this.assertSafeDestination(destination);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async backup(destination: string): Promise<void> {
    this.assertSafeDestination(destination);
    this.db.pragma("wal_checkpoint(PASSIVE)");
    await this.db.backup(destination);
  }
}
