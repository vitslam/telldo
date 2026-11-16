import { NotificationService, notificationTarget, type NotificationTarget } from "./notification-service";
import { ChatHistory } from "./chat-history";
import { ModelRoundProgress } from "./model-round-progress";
import { chatSources } from "./chat-sources";
import type { ContextScheduleItem } from "./context-repository";
import { PermissionSession } from "./permission-session";
import { searchProgress } from "./retrieval-progress";
import { ContextRepository } from "./context-repository";
import type { ContextQuery } from "../shared/context-query";
import type { AIInputAttachment } from "../shared/ai-input";
import { MemoService } from "./memo-service";
import type { Memo } from "../shared/memo";
import type { AIActivity, AIProgress } from "../shared/ai-progress";
import { DateTime } from "luxon";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  protocol,
  powerMonitor,
} from "electron";
import { join } from "node:path";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { TaskService } from "./task-service";
import { CalendarService } from "./calendar-service";
import type { ScheduleService } from "./schedule-service";
import { CodexAdapter } from "./codex-adapter";
import { SshCodexAdapter } from "./ssh-codex-adapter";
import {
  parseNaturalDate,
  localDay,
  taskFromOccurrence,
} from "../shared/dates";
import type { Settings, Capabilities } from "../shared/types";

app.setName("Telldo");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "telldo-memo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
// Separate disposable storage for the acceptance harness; never touch a user's live data.
if (process.env.TELLDO_TEST_DATA)
  app.setPath("userData", process.env.TELLDO_TEST_DATA);
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let service: TaskService;
let chatHistory: ChatHistory;
let memos: MemoService;
let contexts: ContextRepository;
let schedules: ScheduleService;
let calendar: CalendarService;
let adapter: CodexAdapter | SshCodexAdapter;
let aiRunning = false;
let aiCancelled = false;
let aiProbing = false;
let capabilities: Capabilities | null = null;
let timer: NodeJS.Timeout;
let notifications: NotificationService;
let rendererReady = false;
let restoredNotifications: Notification[] = [];
let pendingNotification: NotificationTarget | undefined;
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const settings = (): Settings => service.getSettings();
const zone = () => settings().timeZone || systemZone();
function aiConfig(s: Settings): string {
  return JSON.stringify([
    s.aiTransport,
    s.codexPath,
    s.sshHost,
    s.sshUser,
    s.sshPort,
    s.sshCodexPath,
    s.sshRunnerPath,
    s.sshProxyUrl,
  ]);
}
function createAdapter() {
  const s = settings(),
    options = { resourceDir: join(app.getAppPath(), "resources") };
  return s.aiTransport === "ssh"
    ? new SshCodexAdapter(
        {
          host: s.sshHost,
          user: s.sshUser,
          port: s.sshPort,
          codexPath: s.sshCodexPath,
          runnerPath: s.sshRunnerPath,
          proxyUrl: s.sshProxyUrl,
        },
        options,
      )
    : new CodexAdapter(options);
}
async function probeAI() {
  if (aiRunning || aiProbing)
    throw Error("Codex is busy. / Codex 正忙，请完成或取消当前请求。");
  aiProbing = true;
  try {
    adapter = createAdapter();
    capabilities = null;
    capabilities =
      adapter instanceof SshCodexAdapter
        ? await adapter.probe()
        : await adapter.probe(settings().codexPath);
    return capabilities;
  } catch (error) {
    capabilities = {
      available: false,
      version: "",
      path: "",
      loggedIn: false,
      reason: error instanceof Error ? error.message : String(error),
      schema: false,
      outputFile: false,
      json: false,
      readOnly: false,
      ignoreUserConfig: false,
      ignoreRules: false,
      ephemeral: false,
      skipGitCheck: false,
      isolation: "Not verified / 未验证",
    };
    return capabilities;
  } finally {
    aiProbing = false;
    send("changed", null);
  }
}
function send(type: string, data: unknown) {
  win?.webContents.send("telldo:event", { type, data });
}
function show(taskId?: string) {
  if (!win) createWindow();
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
  if (taskId) {
    if (win!.webContents.isLoading())
      win!.webContents.once("did-finish-load", () => send("select", taskId));
    else send("select", taskId);
  }
}
function deliverNotificationNavigation() {
  if (!pendingNotification || !rendererReady || !win || win.isDestroyed()) return;
  const target = pendingNotification;
  pendingNotification = undefined;
  if (target.kind === "task") {
    try {
      const task = service.getTask(target.id);
      send("notification-open", { ...target, listId: task.list_id });
    } catch { /* A task may have been removed since the notification appeared. */ }
  } else send("notification-open", target);
}
function openNotification(target?: NotificationTarget) {
  pendingNotification = target;
  show();
  deliverNotificationNavigation();
}
function notify(startup = false) {
  notifications.reminders(startup);
  send("changed", null);
}
function createWindow() {
  rendererReady = false;
  win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: settings().appearance === "dark" ||
      (settings().appearance !== "light" && nativeTheme.shouldUseDarkColors)
      ? "#191919" : "#f5f5f5",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 10 },
    } : {}),
    title: "Telldo",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("did-start-loading", () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("close", (e) => {
    if (!quitting && settings().closeToTray && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}
function memoWithStatus(memo: Memo): Memo {
  const proposal = memo.proposal_id
    ? service.listProposals().find((p) => p.id === memo.proposal_id)
    : undefined;
  return { ...memo, ...(proposal ? { proposal_status: proposal.status } : {}) };
}
interface ExplicitReference {
  kind: "memo" | "task";
  id: string;
  attachmentIds?: string[];
  /** Set only by the user's explicit Make a todo entry point. */
  asTask?: boolean;
}
function parseReferences(value: unknown): ExplicitReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4)
    throw Error("最多引用 4 条记录 / Reference up to 4 records");
  return value.map((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      !["memo", "task"].includes(v.kind) ||
      typeof v.id !== "string" ||
      !v.id.length ||
      v.id.length > 200
    )
      throw Error("Invalid record reference / 记录引用无效");
    if (
      v.attachmentIds !== undefined &&
      (!Array.isArray(v.attachmentIds) ||
        v.attachmentIds.length > 12 ||
        v.attachmentIds.some(
          (id: unknown) =>
            typeof id !== "string" || !id.length || id.length > 200,
        ))
    )
      throw Error("Invalid attachment selection");
    if (v.asTask !== undefined && (typeof v.asTask !== "boolean" || v.kind !== "memo"))
      throw Error("Invalid content conversion / 转换内容无效");
    return {
      kind: v.kind,
      id: v.id,
      ...(v.asTask === true ? { asTask: true } : {}),
      ...(v.attachmentIds ? { attachmentIds: v.attachmentIds } : {}),
    };
  });
}
function resolveReference(ref: ExplicitReference) {
  if (ref.kind === "memo") {
    const memo = memos.get(ref.id);
    return {
      record: {
        kind: "memo",
        id: memo.id,
        title: memo.title,
        created_at: memo.created_at,
        text: [memo.body, memo.extracted_text].filter(Boolean).join("\n"),
        attachments: memo.attachments,
      },
      task: undefined as ReturnType<TaskService["getTask"]> | undefined,
      memo,
    };
  }
  const task = service.getTask(ref.id);
  const rule = service.db
    .prepare("SELECT * FROM recurrences WHERE task_id=?")
    .get(task.id);
  return {
    record: {
      kind: "task",
      id: task.id,
      title: task.title,
      expected_version: task.version,
      text: JSON.stringify({
        notes: task.notes,
        status: task.status,
        due_kind: task.due_kind,
        due_date: task.due_date,
        due_at: task.due_at,
        time_zone: task.time_zone,
        tags: task.tags,
        ...(rule
          ? {
              recurrence: {
                rrule: rule.rrule,
                dtstart: rule.dtstart,
                tzid: rule.tzid,
                until: rule.until,
                count: rule.count,
              },
            }
          : {}),
      }),
      attachments: memos.taskAttachments(task.id),
    },
    task,
    memo: undefined as Memo | undefined,
  };
}
function proposalTaskTargets(
  proposal: ReturnType<TaskService["applyProposal"]>,
) {
  const created = service.db
    .prepare(
      "SELECT entity FROM audit_log WHERE proposal_id=? AND action='create' AND undo_of IS NULL ORDER BY rowid",
    )
    .all(proposal.id) as { entity: string }[];
  let index = 0;
  return proposal.actions.map((action) =>
    action.type === "create" ||
    action.type === "create_recurring" ||
    action.type === "add_subtask"
      ? created[index++]?.entity
      : action.target_id,
  );
}
function bindProposalAssets(
  proposal: ReturnType<TaskService["applyProposal"]>,
) {
  const targets = proposalTaskTargets(proposal);
  const bindings = service.db
    .prepare("SELECT * FROM proposal_assets WHERE proposal_id=?")
    .all(proposal.id) as { action_index: number; attachment_id: string }[];
  const capture = memos.captureForProposal(proposal.id);
  const referenceRow = service.db.prepare("SELECT references_json FROM proposal_references WHERE proposal_id=?").get(proposal.id) as { references_json: string } | undefined;
  const converted = parseReferences(referenceRow ? JSON.parse(referenceRow.references_json) : undefined)
    .filter(ref => ref.kind === "memo" && ref.asTask)
    .map(ref => memos.get(ref.id));
  targets.forEach((taskId, index) => {
    if (!taskId || proposal.actions[index].type === "delete") return;
    const ids = bindings
      .filter((b) => b.action_index === index)
      .map((b) => b.attachment_id);
    const previous = new Set(memos.taskAttachments(taskId).map((a) => a.id));
    for (const id of ids)
      if (!previous.has(id))
        service.db
          .prepare("INSERT OR IGNORE INTO proposal_asset_effects VALUES(?,?,?)")
          .run(proposal.id, taskId, id);
    memos.attachToTask(taskId, ids);
    if (["create", "create_recurring", "add_subtask"].includes(proposal.actions[index].type)) {
      for (const source of converted) {
        // An explicit conversion reuses the source; retries cannot create another association.
        if (source.task_ids.some(id => id !== taskId && service.db.prepare("SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL").get(id))) continue;
        memos.attachToTask(taskId, source.attachments.map(file => file.id));
        memos.linkTaskCapture(source.id, taskId);
      }
    }
    if (capture && (capture.capture_kind === "task" || ids.length ||
      ["create", "create_recurring", "add_subtask"].includes(proposal.actions[index].type)))
      memos.linkTaskCapture(capture.id, taskId);
  });
  if (capture?.capture_kind === "task")
    memos.publish(capture.id, { kind: "task" });
}
async function snapshot(range?: { start: string; end: string; zone: string }) {
  if (range) schedules.materializeRange(range.start, range.end, range.zone);
  else schedules.materialize();
  return {
    lists: service.listLists(),
    tasks: service.listTasks().map((task) => ({
      ...task,
      attachments: memos.taskAttachments(task.id),
    })),
    recurrences: schedules.listRecurrences(),
    occurrences: schedules.listOccurrences(),
    proposals: service.listProposals(),
    settings: settings(),
    systemLanguage: app.getLocale(),
    systemTimeZone: systemZone(),
    capabilities,
  };
}
async function dispatch(method: string, args: any[]) {
  switch (method) {
    case "notificationReady":
      rendererReady = true;
      deliverNotificationNavigation();
      return true;
    case "notificationStatus":
      return notifications.status();
    case "notificationTest":
      if (typeof args[0] !== "boolean") throw Error("Invalid notification sound setting");
      return notifications.test(args[0]);
    case "notificationSettings":
      if (process.platform !== "darwin") return false;
      await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
      return true;
    case "chatHistoryList":
      return chatHistory.list(args[0]);
    case "chatHistoryLoad":
      return chatHistory.load(args[0]);
    case "chatHistorySave":
      return chatHistory.save(args[0], args[1]);
    case "snapshot":
      return snapshot(args[0]);
    case "memoList":
      return memos
        .list(typeof args[0] === "string" ? args[0] : undefined)
        .map(memoWithStatus);
    case "memoGet":
      return memoWithStatus(memos.get(args[0]));
    case "inputStage":
      return memos.stage({
        ...args[0],
        source: "chat",
        analysis_state: "ready",
      });
    case "inputDiscard":
      return memos.discard(args[0]);
    case "proposalAttachments": {
      const rows = service.db
        .prepare(
          "SELECT action_index,attachment_id FROM proposal_assets WHERE proposal_id=?",
        )
        .all(args[0]) as { action_index: number; attachment_id: string }[];
      const result: Record<number, unknown[]> = {};
      for (const row of rows) {
        try {
          const file = memos.getAttachment(row.attachment_id);
          (result[row.action_index] ??= []).push({
            id: row.attachment_id,
            name: file.name,
            bytes: file.bytes,
            mime: file.mime,
            kind: file.kind,
          });
        } catch {}
      }
      return result;
    }
    case "memoUpdate": {
      const memo = memos.update(args[0], args[1], args[2]);
      send("memo-changed", memo.id);
      return memo;
    }
    case "memoDelete": {
      memos.remove(args[0], args[1]);
      send("memo-changed", args[0]);
      return true;
    }
    case "memoRestore": {
      const memo = memos.restore(args[0]);
      send("memo-changed", memo.id);
      return memo;
    }
    case "memoOpen": {
      const file = memos.getAttachment(args[0]);
      const error = await shell.openPath(file.path);
      if (error) throw Error(error);
      return true;
    }

    case "createList":
      return service.createList(args[0], args[1]);
    case "updateList":
      return service.updateList(args[0], args[1]);
    case "deleteList":
      return service.deleteList(args[0]);
    case "createTask":
      return service.createTask(args[0]);
    case "updateTask":
      return service.updateTask(args[0], args[1], args[2]);
    case "deleteTask":
      return service.deleteTask(args[0], args[1]);
    case "parseDate":
      return parseNaturalDate(args[0], zone());
    case "saveTaskSchedule":
      return service.saveTaskSchedule(args[0], args[1], args[2], args[3]);
    case "updateRecurring":
      return service.updateRecurring(args[0], args[1], args[2], args[3]);
    case "setRecurrence": {
      const existing = schedules
        .listRecurrences()
        .find((r) => r.task_id === args[0]);
      if (!existing) return schedules.setRecurrence(args[0], args[1]);
      const task = service.getTask(args[0]);
      const start = DateTime.fromISO(args[1].dtstart, {
        zone: args[1].tzid,
      }).setZone(args[1].tzid);
      const patch = {
        due_kind: task.due_kind,
        due_date: start.toISODate(),
        due_at: task.due_kind === "datetime" ? start.toUTC().toISO() : null,
        time_zone: task.due_kind === "datetime" ? args[1].tzid : null,
      };
      return service.updateRecurring(task.id, task.version, patch, args[1]);
    }
    case "removeRecurrence":
      return schedules.removeRecurrence(args[0]);
    case "updateOccurrence":
      return schedules.updateOccurrence(args[0], args[1], args[2], args[3]);
    case "calendarPreview":
      return calendar.preview(args[0]);
    case "calendarApply": {
      const result = calendar.apply(args[0]);
      send("changed", null);
      return result;
    }
    case "calendarUndo": {
      const result = calendar.undo(args[0]);
      send("changed", null);
      return result;
    }
    case "applyProposal": {
      const result = service.applyProposal(args[0], true);
      bindProposalAssets(result);
      send("memo-changed", null);
      return result;
    }
    case "rejectProposal": {
      const result = service.rejectProposal(args[0]);
      const capture = memos.captureForProposal(result.id);
      if (capture) memos.publish(capture.id, { kind: "memo" });
      memos.clearProposal(result.id);
      send("memo-changed", null);
      return result;
    }
    case "undoProposal": {
      const result = service.undoProposal(args[0]);
      const effects = service.db
        .prepare(
          "SELECT task_id,attachment_id FROM proposal_asset_effects WHERE proposal_id=?",
        )
        .all(result.id) as { task_id: string; attachment_id: string }[];
      for (const effect of effects)
        memos.detachFromTask(effect.task_id, [effect.attachment_id]);
      const capture = memos.captureForProposal(result.id);
      if (capture) memos.publish(capture.id, { kind: "memo" });
      send("memo-changed", null);
      return result;
    }
    case "cancelAI":
      if (aiRunning) aiCancelled = true;
      adapter.cancel();
      return true;
    case "probe":
      return probeAI();
    case "settings": {
      const previous = settings(), before = aiConfig(previous);
      if ((aiRunning || aiProbing) && aiConfig({ ...previous, ...args[0] }) !== before)
        throw Error("Codex is busy. / Codex 正忙，请完成或取消当前请求。");
      if (!previous.notificationsEnabled && args[0]?.notificationsEnabled === true)
        schedules.dueNotifications(new Date(), true);
      const value = service.setSettings(args[0]);
      if (aiConfig(value) !== before) await probeAI();
      return value;
    }
    case "ask": {
      if (aiRunning || aiProbing) throw Error("Codex is busy. / Codex 正忙。");
      aiRunning = true;
      aiCancelled = false;
      const permissionMode = settings().permissionMode;
      const permissionSession = new PermissionSession(
        permissionMode,
        () => aiCancelled,
      );
      const appliedProposalIds = permissionSession.appliedProposalIds;
      const assertRunning = () => {
        if (aiCancelled) throw Error("已停止 / Cancelled");
      };
      const requestId =
        typeof args[3] === "string" ? args[3].slice(0, 80) : undefined;
      const chinese = (
        settings().language === "system" ? app.getLocale() : settings().language
      ).startsWith("zh");
      const activities = new Map<string, AIActivity>();
      const progress = (event: Exclude<AIProgress, string>) => {
        if (event.type === "activity") activities.set(event.id, event);
        send("progress", { ...event, requestId });
      };
      try {
        let continuation =
          args[4] === undefined
            ? undefined
            : service.listProposals().find((p) => p.id === args[4]);
        if (args[4] !== undefined && continuation?.status !== "applied")
          throw Error(
            "Only an applied proposal can be continued / 请先确认并应用提案",
          );
        const input = args[5] && typeof args[5] === "object" ? args[5] : {};
        const persisted = continuation
          ? (service.db
              .prepare(
                "SELECT references_json FROM proposal_references WHERE proposal_id=?",
              )
              .get(continuation.id) as { references_json: string } | undefined)
          : undefined;
        const explicitRefs = parseReferences(
          input.references ??
            (persisted ? JSON.parse(persisted.references_json) : undefined),
        );
        let currentCapture =
          typeof input.captureId === "string"
            ? memos.get(input.captureId, { includeStaged: true })
            : continuation
              ? memos.captureForProposal(continuation.id)
              : null;
        const readingCaptures: Memo[] = currentCapture ? [currentCapture] : [];
        const inputFiles: AIInputAttachment[] = [];
        let referenceRead = 0;
        let modelRound = 0;
        const knownRefs = new Map<string, ExplicitReference>();
        const referencedRecords: Record<string, unknown>[] = [];
        const selectedTasks = new Map<
          string,
          ReturnType<TaskService["getTask"]>
        >();
        const selectedMemos = new Map<
          string,
          {
            id: string;
            title: string;
            body: string;
            summary: string;
            created_at: string;
            attachments: unknown[];
          }
        >();
        const selectedMemoIds = new Set<string>();
        const appendFile = async (file: {
          id: string;
          name: string;
          mime: string;
          bytes: number;
          kind: "image" | "file";
        }) => {
          if (inputFiles.some((a) => a.id === file.id)) return;
          if (
            inputFiles.length >= 12 ||
            inputFiles.reduce((n, f) => n + f.bytes.byteLength, 0) +
              file.bytes >
              50 * 1024 * 1024 ||
            (file.kind === "image" &&
              inputFiles.filter((f) => f.kind === "image").length >= 8)
          )
            throw Error(
              "引用的附件超过本轮上限，请减少引用 / Select fewer attachments for this question",
            );
          const image = file.kind === "image";
          const fileProgress = (completed: boolean) =>
            progress({
              type: "activity",
              id: `attachment-${file.id}`,
              phase: "context",
              status: completed ? "completed" : "running",
              label: chinese
                ? image
                  ? completed
                    ? "已加载原图"
                    : "正在加载原图"
                  : completed
                    ? "已读取附件"
                    : "正在读取附件"
                : image
                  ? completed
                    ? "Original image loaded"
                    : "Loading original image"
                  : completed
                    ? "Attachment loaded"
                    : "Loading attachment",
              detail: file.name.slice(0, 200),
            });
          fileProgress(false);
          const owned = memos.getAttachment(file.id);
          inputFiles.push({
            id: file.id,
            name: file.name,
            mime: file.mime,
            kind: file.kind,
            bytes: new Uint8Array(await readFile(owned.path)),
          });
          fileProgress(true);
        };
        const addReference = async (ref: ExplicitReference) => {
          if (
            referencedRecords.some(
              (r) => r.kind === ref.kind && r.id === ref.id,
            )
          )
            return;
          if (referencedRecords.length >= 4)
            throw Error("本轮最多读取 4 条引用记录");
          const readId = `record-${++referenceRead}`;
          progress({
            type: "activity",
            id: readId,
            phase: "context",
            status: "running",
            label: chinese ? "正在读取记录" : "Reading record",
          });
          const resolved = resolveReference(ref);
          knownRefs.set(`${ref.kind}:${ref.id}`, ref);
          if (resolved.task) selectedTasks.set(resolved.task.id, resolved.task);
          if (resolved.memo) {
            selectedMemoIds.add(resolved.memo.id);
            selectedMemos.set(resolved.memo.id, {
              id: resolved.memo.id,
              title: resolved.memo.title,
              body: resolved.record.text,
              summary: resolved.memo.summary,
              created_at: resolved.memo.created_at,
              attachments: resolved.memo.attachments,
            });
          }
          const files = ref.attachmentIds
            ? resolved.record.attachments.filter((a) =>
                ref.attachmentIds!.includes(a.id),
              )
            : resolved.record.attachments;
          if (ref.attachmentIds?.some((id) => !files.some((a) => a.id === id)))
            throw Error("引用的附件已不存在 / Referenced attachment not found");
          const used = referencedRecords.reduce(
            (n, r) => n + String(r.text || "").length,
            0,
          );
          const keep = Math.min(12000, Math.max(0, 24000 - used));
          referencedRecords.push({
            ...resolved.record,
            text: resolved.record.text.slice(0, keep),
            truncated: resolved.record.text.length > keep,
            attachments: files,
          });
          progress({
            type: "activity",
            id: readId,
            phase: "context",
            status: "completed",
            label: chinese ? "已读取记录" : "Record read",
            detail: `${String(resolved.record.title || "").slice(0, 200)} · ${chinese ? "正文与附件信息" : "Text and attachment metadata"}`,
          });
          for (const file of files) await appendFile(file);
        };
        for (const ref of explicitRefs) await addReference(ref);
        if (currentCapture)
          for (const file of currentCapture.attachments) await appendFile(file);
        // Past upload IDs are contextual identifiers, not permission to send every old file.
        const recentReferences = parseReferences(input.recentReferences);
        for (const ref of recentReferences)
          knownRefs.set(`${ref.kind}:${ref.id}`, ref);
        const text = continuation
          ? continuation.source_text
          : String(args[0] || "").trim() ||
            (explicitRefs.length
              ? "请帮我回顾引用的内容。"
              : currentCapture
                ? "请结合这条消息中的附件内容帮我处理。"
                : "");
        if (!text || text.length > 4000)
          throw Error("Please enter text or select a reference");
        let lists = contexts.lists(30);
        const appliedHistory: { role: "assistant"; content: string }[] = [];
        let searchCount = 0;
        let retrieved: Record<string, unknown> = {};
        let retrievalReads = 0;
        const refreshContext = () => ({
          today: localDay(zone()),
          now: DateTime.now().setZone(zone()).toISO(),
          timeZone: zone(),
          currentListId: args[1],
          permissionMode,
          lists,
          contextPhase: referencedRecords.length
            ? "referenced"
            : retrievalReads || selectedTasks.size || selectedMemos.size
              ? "result"
              : "plan",
          ...retrieved,
          tasks: [...selectedTasks.values()],
          memoSearchResults: [...selectedMemos.values()].filter(
            (m) =>
              !referencedRecords.some(
                (r) => r.kind === "memo" && r.id === m.id,
              ),
          ),
          referencedRecords,
          recentReferences: recentReferences.map((ref) => ({
            kind: ref.kind,
            id: ref.id,
          })),
          inputAttachments: inputFiles.map(
            ({ id, name, mime, kind, bytes }) => ({
              id,
              name,
              mime,
              kind,
              bytes: bytes.byteLength,
            }),
          ),
          taskAttachments: [...selectedTasks.values()].map((task) => ({
            taskId: task.id,
            attachments: memos.taskAttachments(task.id),
          })),
          conversation: [
            ...(Array.isArray(args[2]) ? args[2] : []),
            ...appliedHistory,
          ],
          ...(continuation
            ? {
                continuation: {
                  proposalId: continuation.id,
                  status: "applied",
                  summary: continuation.summary,
                },
              }
            : {}),
          contextReadBudget: {
            remaining: 2 - retrievalReads,
            used: retrievalReads,
            max: 2,
          },
        });
        const runModel = async () => {
          assertRunning();
          const round = new ModelRoundProgress(++modelRound, chinese, progress);
          const result = await adapter.run(
            text,
            refreshContext(),
            round.forward,
            inputFiles,
          );
          round.complete(result.proposal.summary);
          assertRunning();
          return result;
        };
        while (true) {
          let result = await runModel();
          while (result.proposal.query) {
            if (retrievalReads >= 2)
              throw Error("请缩小查询范围后再试 / Please narrow this search");
            assertRunning();
            const query = result.proposal.query;
            retrievalReads++;
            if (query.entity === "record") {
              const key = `${query.kind}:${query.id}`;
              if (!knownRefs.has(key))
                throw Error(
                  "模型只能读取本轮检索到或你明确引用的记录 / Select a returned record to read its original",
                );
              await addReference(knownRefs.get(key)!);
            } else {
              const searchId = `search-${++searchCount}`;
              const listName = lists.find(
                (list) => list.id === query.list_id,
              )?.name;
              progress(
                searchProgress(searchId, query, chinese, undefined, listName),
              );
              const data = contexts.retrieve(query);
              progress(
                searchProgress(
                  searchId,
                  query,
                  chinese,
                  data.queryResult,
                  listName,
                ),
              );
              retrieved = { ...retrieved, ...data };
              for (const task of data.tasks || []) {
                selectedTasks.set(task.id, task);
                knownRefs.set(`task:${task.id}`, { kind: "task", id: task.id });
              }
              for (const memo of data.memoSearchResults || []) {
                selectedMemos.set(memo.id, memo);
                knownRefs.set(`memo:${memo.id}`, { kind: "memo", id: memo.id });
              }
            }
            result = await runModel();
          }
          const chosen = [...selectedTasks.values()];
          const response = result.proposal;
          const allowedAssets = new Set([
            ...inputFiles.map((f) => f.id),
            ...chosen.flatMap((t) =>
              memos.taskAttachments(t.id).map((f) => f.id),
            ),
          ]);
          for (const id of [
            ...(response.memo?.attachmentIds || []),
            ...(response.assetAssignments || []).flatMap(
              (a) => a.attachmentIds,
            ),
          ])
            if (!allowedAssets.has(id))
              throw Error("Unknown attachment reference / 附件引用无效");
          let memoId: string | undefined;
          if (response.memo) {
            const record = response.memo;
            const capture =
              currentCapture ||
              readingCaptures.find((c) =>
                c.attachments.some((a) => record.attachmentIds?.includes(a.id)),
              );
            if (capture)
              memoId = memos.publish(capture.id, {
                kind: "memo",
                title: record.title,
                summary: record.summary,
                extracted_text: record.text,
              }).id;
            else {
              const created = await memos.create({
                text: explicitRefs.length ? record.text : text,
                title: record.title,
                source: "chat",
                analysis_state: "ready",
                idempotencyKey: `ai:${response.idempotency_key}`,
              });
              if (record.summary)
                memos.setAnalysis(created.id, {
                  analysis_state: "ready",
                  summary: record.summary,
                });
              memoId = created.id;
            }
            send("memo-changed", memoId);
          }
          if (!currentCapture && !explicitRefs.some(ref => ref.asTask) &&
              response.actions.some(action => ["create", "create_recurring", "add_subtask"].includes(action.type))) {
            currentCapture = await memos.stage({ text, source: "chat", analysis_state: "ready",
              idempotencyKey: `source:${response.idempotency_key}` });
          }
          const attachmentReply = {
            sources: chatSources(
              [...selectedTasks.values()],
              [...selectedMemos.values()],
              lists,
              (id) => memos.taskAttachments(id),
              (
                retrieved.readOnlySchedule as
                  { instances?: ContextScheduleItem[] } | undefined
              )?.instances || [],
            ),
            captureId: currentCapture?.id,
            attachments: currentCapture?.attachments.map(
              ({ id, name, kind }) => ({
                id,
                name,
                kind,
                previewUrl:
                  kind === "image"
                    ? `telldo-memo://attachment/${id}`
                    : undefined,
              }),
            ),
          };
          if (!response.actions.length) {
            if (
              currentCapture &&
              !response.memo &&
              !continuation &&
              !appliedProposalIds.length
            ) {
              memos.publish(currentCapture.id, { kind: "memo" });
              send("memo-changed", currentCapture.id);
            }
            return {
              kind: response.memo ? "memo" : "answer",
              message: response.summary,
              memoId,
              ...attachmentReply,
              appliedProposalIds,
              memoIds: [...selectedMemos.values()]
                .filter(
                  (m) =>
                    selectedMemoIds.has(m.id) ||
                    response.summary.includes(m.title),
                )
                .slice(0, 3)
                .map((m) => m.id),
              activities: [...activities.values()],
            };
          }
          const body = {
            version: response.version,
            summary: response.summary,
            idempotency_key: response.idempotency_key,
            risk: response.risk,
            actions: response.actions,
          };
          const proposal = service.db.transaction(() => {
            const proposal = service.saveProposal(
              body,
              text,
              result.raw,
              chosen.map((t) => t.id),
            );
            service.db
              .prepare("INSERT OR REPLACE INTO proposal_references VALUES(?,?)")
              .run(
                proposal.id,
                JSON.stringify(
                  [...knownRefs.values()].filter((ref) =>
                    referencedRecords.some(
                      (r) => r.kind === ref.kind && r.id === ref.id,
                    ),
                  ),
                ),
              );
            for (const assignment of response.assetAssignments || [])
              for (const id of assignment.attachmentIds)
                service.db
                  .prepare(
                    "INSERT OR IGNORE INTO proposal_assets VALUES(?,?,?)",
                  )
                  .run(proposal.id, assignment.actionIndex, id);
            return proposal;
          })();
          if (currentCapture) {
            memos.linkProposal(currentCapture.id, proposal.id);
            memos.publish(currentCapture.id, {
              kind: response.memo ? "memo" : "task",
            });
            send("memo-changed", currentCapture.id);
          }
          if (permissionMode === "auto") {
            assertRunning();
            const activityId = `apply-${appliedProposalIds.length + 1}`;
            const decision = permissionSession.apply(proposal, () => {
              progress({
                type: "activity",
                id: activityId,
                phase: "validation",
                status: "running",
                label: chinese ? "正在应用更改" : "Applying changes",
                detail: proposal.summary,
              });
              return service.applyProposal(proposal.id, true);
            });
            if (decision.kind === "limit") {
              progress({
                type: "activity",
                id: "permission-limit",
                phase: "validation",
                status: "completed",
                label: chinese
                  ? "已达到本轮自动执行上限"
                  : "Automatic step limit reached",
                detail: chinese
                  ? "已应用8步更改，下一项提案已保留，等待你确认。"
                  : "Applied 8 change steps. The next proposal was kept for your approval.",
              });
              return {
                kind: "proposal",
                message: chinese
                  ? `已应用本轮 8 步更改。下一项提案已保留，请确认后继续：${proposal.summary}`
                  : `Applied 8 change steps. Review the next retained proposal to continue: ${proposal.summary}`,
                proposalId: proposal.id,
                ...attachmentReply,
                appliedProposalIds,
                memoId,
                activities: [...activities.values()],
              };
            }
            if (decision.kind === "duplicate") {
              return {
                kind: "answer",
                message: chinese
                  ? "此更改已应用，未重复执行。"
                  : "This change was already applied; it was not repeated.",
                ...attachmentReply,
                appliedProposalIds,
                memoId,
                activities: [...activities.values()],
              };
            }
            const applied = decision.proposal;
            bindProposalAssets(applied);
            send("changed", null);
            send("memo-changed", null);
            progress({
              type: "activity",
              id: activityId,
              phase: "validation",
              status: "completed",
              label: chinese
                ? "更改已自动应用"
                : "Changes applied automatically",
              detail: applied.summary,
            });
            continuation = applied;
            appliedHistory.push({
              role: "assistant",
              content: chinese
                ? `已应用更改：${applied.summary}`
                : `Applied changes: ${applied.summary}`,
            });
            lists = contexts.lists(30);
            const changedIds = new Set([
              ...selectedTasks.keys(),
              ...proposalTaskTargets(applied).filter(
                (id): id is string => !!id,
              ),
            ]);
            for (const id of changedIds) {
              try {
                const task = service.getTask(id);
                selectedTasks.set(id, task);
                knownRefs.set(`task:${id}`, { kind: "task", id });
              } catch {
                selectedTasks.delete(id);
                knownRefs.delete(`task:${id}`);
              }
            }
            let referenceBudget = Math.max(
              0,
              24000 -
                referencedRecords
                  .filter((record) => record.kind !== "task")
                  .reduce(
                    (total, record) => total + String(record.text || "").length,
                    0,
                  ),
            );
            for (
              let index = referencedRecords.length - 1;
              index >= 0;
              index--
            ) {
              const record = referencedRecords[index];
              if (record.kind !== "task") continue;
              const id = String(record.id);
              if (!selectedTasks.has(id)) referencedRecords.splice(index, 1);
              else {
                const resolved = resolveReference({ kind: "task", id });
                const keep = Math.min(12000, referenceBudget);
                referenceBudget -= Math.min(keep, resolved.record.text.length);
                referencedRecords[index] = {
                  ...resolved.record,
                  text: resolved.record.text.slice(0, keep),
                  truncated: resolved.record.text.length > keep,
                };
              }
            }
            retrieved = {};
            retrievalReads = 0;
            continue;
          }
          progress({
            type: "activity",
            id: "validation",
            phase: "validation",
            status: "completed",
            label: chinese ? "提案已就绪" : "Proposal ready",
            detail: chinese
              ? `${result.proposal.actions.length} 项更改等待确认，尚未应用`
              : `${result.proposal.actions.length} changes await your approval; nothing applied`,
          });
          return {
            kind: "proposal",
            message: proposal.summary,
            proposalId: proposal.id,
            memoId,
            ...attachmentReply,
            appliedProposalIds,
            activities: [...activities.values()],
          };
        }
      } catch (error) {
        if (!appliedProposalIds.length) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return {
          kind: "answer",
          appliedProposalIds,
          activities: [...activities.values()],
          message: aiCancelled
            ? chinese
              ? "已停止。此前已应用的更改已保留。"
              : "Stopped. Changes already applied were kept."
            : chinese
              ? `此前已应用的更改已保留，后续执行已停止：${reason.slice(0, 500)}`
              : `Applied changes were kept. Further execution stopped: ${reason.slice(0, 500)}`,
        };
      } finally {
        aiRunning = false;
      }
    }
    case "export": {
      const path = await dialog.showSaveDialog(win!, {
        defaultPath: `Telldo-${localDay(zone())}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path.canceled || !path.filePath) return null;
      await writeFile(
        path.filePath,
        JSON.stringify(
          { ...service.exportData(), memoArchive: await memos.exportData() },
          null,
          2,
        ),
        "utf8",
      );
      return path.filePath;
    }
    case "import": {
      const path = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path.canceled) return null;
      const raw = await readFile(path.filePaths[0], "utf8");
      if (raw.length > 220_000_000) throw Error("Import exceeds 220 MB");
      const archive = JSON.parse(raw);
      if (archive.memoArchive) memos.validateArchive(archive.memoArchive);
      const imported = archive.memoArchive
        ? await memos.importData(archive.memoArchive)
        : [];
      try {
        const result = service.importData(archive);
        send("memo-changed", null);
        return result;
      } catch (error) {
        for (const memo of imported) memos.remove(memo.id, memo.version);
        send("memo-changed", null);
        throw error;
      }
    }
    case "backup": {
      const path = await dialog.showSaveDialog(win!, {
        defaultPath: `Telldo-backup-${localDay(zone())}.sqlite`,
        filters: [{ name: "SQLite", extensions: ["sqlite"] }],
      });
      if (path.canceled || !path.filePath) return null;
      await service.backup(path.filePath);
      await memos.backup(
        path.filePath.replace(/\.sqlite$/i, "") + "-memos.sqlite",
      );
      return path.filePath;
    }
    case "openData":
      return shell.openPath(app.getPath("userData"));
    default:
      throw Error("Unsupported operation");
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => show());
  app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath("userData"), { recursive: true });
      service = new TaskService(join(app.getPath("userData"), "telldo.sqlite"));
      chatHistory = new ChatHistory(service.db);
      memos = new MemoService(app.getPath("userData"));
      contexts = new ContextRepository(service, memos, zone);
      service.db.exec(
        "CREATE TABLE IF NOT EXISTS proposal_references(proposal_id TEXT PRIMARY KEY,references_json TEXT NOT NULL)",
      );
      service.db.exec(
        "CREATE TABLE IF NOT EXISTS proposal_assets(proposal_id TEXT NOT NULL,action_index INTEGER NOT NULL,attachment_id TEXT NOT NULL,PRIMARY KEY(proposal_id,action_index,attachment_id)); CREATE TABLE IF NOT EXISTS proposal_asset_effects(proposal_id TEXT NOT NULL,task_id TEXT NOT NULL,attachment_id TEXT NOT NULL,PRIMARY KEY(proposal_id,task_id,attachment_id))",
      );
      for (const proposal of service
        .listProposals()
        .filter((p) => p.status === "applied"))
        bindProposalAssets(proposal);
      protocol.handle("telldo-memo", async (request) => {
        try {
          const url = new URL(request.url);
          if (
            url.hostname !== "attachment" ||
            !/^\/[a-zA-Z0-9-]+$/.test(url.pathname)
          )
            return new Response("Not found", { status: 404 });
          const attachment = memos.getAttachment(url.pathname.slice(1));
          if (attachment.kind !== "image")
            return new Response("Preview unavailable", { status: 415 });
          return new Response(new Uint8Array(await readFile(attachment.path)), {
            headers: {
              "Content-Type": attachment.mime,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
              "Content-Security-Policy": "default-src 'none'; sandbox",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      schedules = service.schedules;
      notifications = new NotificationService(schedules, {
        supported: () => Notification.isSupported(),
        create: options => {
          const notice = new Notification(options);
          return {
            show: () => notice.show(),
            onClick: callback => { notice.on("click", callback); },
            onClose: callback => { notice.on("close", callback); },
            onFailed: callback => { notice.on("failed", (_event, error) => callback(error)); },
          };
        },
        settings,
        isChinese: () => (settings().language === "system" ? app.getLocale() : settings().language).startsWith("zh"),
        isForeground: () => !!win && win.isVisible() && win.isFocused() && !win.isMinimized(),
        open: openNotification,
        changed: () => send("notification-status", notifications.status()),
      });
      // Rebind Notification Center entries after a restart; do not replay them.
      if (process.platform === "darwin" && Notification.isSupported()) {
        void Notification.getHistory().then(items => {
          restoredNotifications = items;
          for (const notice of items) {
            const target = notificationTarget(notice.id);
            if (target) notice.on("click", () => openNotification(target));
          }
        }).catch(() => {});
      }
      calendar = new CalendarService(service);
      adapter = new CodexAdapter({
        resourceDir: join(app.getAppPath(), "resources"),
      });
      ipcMain.handle("telldo:invoke", async (event, method, ...args) => {
        if (
          event.sender !== win?.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          throw Error("Untrusted sender");
        try {
          const result = await dispatch(method, args);
          if (method === "ask" && !aiCancelled)
            notifications.conversation(args[5]?.chatId, !!result && typeof result === "object" && "kind" in result && result.kind === "proposal");
          return result;
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      createWindow();
      const icon = nativeImage.createFromPath(
        join(app.getAppPath(), "resources/tray.png"),
      );
      tray = new Tray(icon);
      tray.setToolTip("Telldo");
      tray.setTitle("✓");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Telldo", click: () => show() },
          {
            label: "退出 / Quit",
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ]),
      );
      tray.on("click", () => show());
      notify(true);
      timer = setInterval(() => notify(), 5_000);
      powerMonitor.on("resume", () => notify(true));
      await probeAI();
      send("changed", null);
    })
    .catch((error) => {
      dialog.showErrorBox("Telldo", String(error));
      app.quit();
    });
  app.on("activate", () => show());
  app.on("window-all-closed", () => {
    if (!tray || !settings().closeToTray) app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(timer);
    adapter?.cancel();
    notifications?.dispose();
  });
  app.on("will-quit", () => {
    service?.close();
    memos?.close();
  });
}
