import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  Tray,
  Menu,
  nativeImage,
  shell,
} from "electron";
import { join } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { TaskService } from "./task-service";
import { CalendarService } from "./calendar-service";
import type { ScheduleService } from "./schedule-service";
import { CodexAdapter } from "./codex-adapter";
import { SshCodexAdapter } from "./ssh-codex-adapter";
import { parseNaturalDate, localDay } from "../shared/dates";
import type { Settings, Capabilities } from "../shared/types";

app.setName("Telldo");
// Separate disposable storage for the acceptance harness; never touch a user's live data.
if (process.env.TELLDO_TEST_DATA)
  app.setPath("userData", process.env.TELLDO_TEST_DATA);
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let service: TaskService;
let schedules: ScheduleService;
let calendar: CalendarService;
let adapter: CodexAdapter | SshCodexAdapter;
let aiRunning = false;
let aiProbing = false;
let capabilities: Capabilities | null = null;
let timer: NodeJS.Timeout;
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
  win?.show();
  win?.focus();
  if (taskId) {
    if (win!.webContents.isLoading())
      win!.webContents.once("did-finish-load", () => send("select", taskId));
    else send("select", taskId);
  }
}
function notify(startup = false) {
  const notices = schedules.dueNotifications(new Date(), startup);
  send("changed", null);
  if (!notices.length) return;
  const zh =
    settings().language === "zh" ||
    (settings().language === "system" && app.getLocale().startsWith("zh"));
  if (startup) {
    const n = new Notification({
      title: "Telldo",
      body: zh
        ? `你有 ${notices.length} 条待处理的过期提醒`
        : `${notices.length} overdue reminder(s) to review`,
    });
    n.on("click", () => show(notices[0].taskId));
    n.show();
  } else
    for (const item of notices) {
      const n = new Notification({ title: "Telldo", body: item.title });
      n.on("click", () => show(item.taskId));
      n.show();
    }
  send("changed", null);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f7f8fc",
    title: "Telldo",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
async function snapshot(range?: { start: string; end: string; zone: string }) {
  if (range) schedules.materializeRange(range.start, range.end, range.zone);
  else schedules.materialize();
  return {
    lists: service.listLists(),
    tasks: service.listTasks(),
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
    case "snapshot":
      return snapshot(args[0]);
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
    case "setRecurrence":
      return schedules.setRecurrence(args[0], args[1]);
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
    case "applyProposal":
      return service.applyProposal(args[0], true);
    case "rejectProposal":
      return service.rejectProposal(args[0]);
    case "undoProposal":
      return service.undoProposal(args[0]);
    case "cancelAI":
      adapter.cancel();
      return true;
    case "probe":
      return probeAI();
    case "settings": {
      if (aiRunning || aiProbing)
        throw Error("Codex is busy. / Codex 正忙，请完成或取消当前请求。");
      const before = aiConfig(settings()),
        value = service.setSettings(args[0]);
      if (aiConfig(value) !== before) await probeAI();
      return value;
    }
    case "ask": {
      if (aiRunning || aiProbing) throw Error("Codex is busy. / Codex 正忙。");
      aiRunning = true;
      try {
        const text = String(args[0]).trim();
        if (!text || text.length > 4000)
          throw Error("Please enter 1–4000 characters");
        const all = service.listTasks();
        const recurring = new Set(
          schedules.listRecurrences().map((r) => r.task_id),
        );
        const tasks = all.filter(
          (t) =>
            !recurring.has(t.id) &&
            (t.status === "todo" || text.includes(t.title)),
        );
        const relevant = tasks.filter(
          (t) =>
            text.includes(t.title) ||
            (t.due_date && t.due_date < localDay(zone())),
        );
        const chosen = [
          ...new Map([...relevant, ...tasks].map((t) => [t.id, t])).values(),
        ].slice(0, 30);
        const result = await adapter.run(
          text,
          {
            today: localDay(zone()),
            timeZone: zone(),
            currentListId: args[1],
            lists: service.listLists().map(({ id, name }) => ({ id, name })),
            tasks: chosen.map(
              ({
                id,
                title,
                version,
                due_kind,
                due_date,
                due_at,
                list_id,
                status,
                parent_id,
                time_zone,
              }) => ({
                id,
                title,
                version,
                due_kind,
                due_date,
                due_at,
                list_id,
                status,
                parent_id,
                time_zone,
              }),
            ),
          },
          (progress) => send("progress", progress),
        );
        const proposal = service.saveProposal(
          result.proposal,
          text,
          result.raw,
          chosen.map((t) => t.id),
        );
        if (
          !settings().alwaysConfirm &&
          proposal.risk === "low" &&
          proposal.actions.length === 1 &&
          proposal.actions[0].type === "create"
        )
          service.applyProposal(proposal.id);
        return proposal.id;
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
      await service.exportToFile(path.filePath);
      return path.filePath;
    }
    case "import": {
      const path = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path.canceled) return null;
      const raw = await readFile(path.filePaths[0], "utf8");
      if (raw.length > 20_000_000) throw Error("Import exceeds 20 MB");
      return service.importData(JSON.parse(raw));
    }
    case "backup": {
      const path = await dialog.showSaveDialog(win!, {
        defaultPath: `Telldo-backup-${localDay(zone())}.sqlite`,
        filters: [{ name: "SQLite", extensions: ["sqlite"] }],
      });
      if (path.canceled || !path.filePath) return null;
      await service.backup(path.filePath);
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
      schedules = service.schedules;
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
          return await dispatch(method, args);
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
      timer = setInterval(() => notify(), 15_000);
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
  });
  app.on("will-quit", () => service?.close());
}
