import ShortcutsDialog from "./ShortcutsDialog";
import { matchShortcut, shortcutLabel, type ShortcutId } from "../shared/shortcuts";
import TaskTags from "./TaskTags";
import { projectTaskRows } from "../shared/task-rows";
import TaskTiming from "./TaskTiming";
import NotificationSettings from "./NotificationSettings";
import { LIST_COLORS, nextListColor } from "../shared/list-colors";
import DetailSelect from "./DetailSelect";
import ImagePreview from "./ImagePreview";
import TaskNotes from "./TaskNotes";
import ChatHistoryDialog from "./ChatHistoryDialog";
import SidebarResizeHandle from "./SidebarResizeHandle";
import { useChatHistory } from "./use-chat-history";
import { ProgressBatcher, type ProgressEnvelope } from "./progress-batcher";
import DetailCardModal, { isTopmostOverlay } from "./DetailCardModal";
import MemoPage from "./MemoPage";
import type { Memo, MemoAttachment } from "../shared/memo";
import RecurringProposalDetails from "./RecurringProposalDetails";
import ChatPage, {
  type ConversationMessage,
  type DraftAttachment,
  type ContentReference,
} from "./ChatPage";
import type { ChatReply } from "../shared/conversation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import PlannedView from "./PlannedView";
import { applyAppearance } from "./appearance";
import { calendarMonthRange } from "../shared/calendar";
import { DateTime } from "luxon";
import {
  Keyboard,
  Sun,
  CalendarDays,
  Layers,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  ArrowUpRight,
  X,
  Check,
  MoreHorizontal,
  ArrowRight,
  ListChecks,
  Repeat2,
  Bell,
  Trash2,
  LoaderCircle,
  SquarePen,
  History,
  NotebookPen,
  Paperclip,
  FolderPlus,
  ChevronDown,
} from "lucide-react";
import type {
  Snapshot,
  Task,
  TaskPatch,
  Proposal,
  Occurrence,
  Settings,
} from "../shared/types";
import {
  localDay,
  taskInView,
  taskFromOccurrence,
  isOverdue,
} from "../shared/dates";

const zh: Record<string, string> = {
  Notifications: "通知",
  "At the time": "到时提醒",
  "10 min before": "提前 10 分钟",
  "1 hour before": "提前 1 小时",
  "No reminder": "不提醒",
  "Save changes first": "请先保存更改",
  "Show more": "展开全文",
  "Show less": "收起",
  "AI connection": "AI 连接方式",
  "This Mac / Local": "本机 Codex",
  "Remote computer over SSH": "通过 SSH 连接远端电脑",
  "SSH host": "远端主机",
  "SSH user": "SSH 用户",
  "SSH port": "SSH 端口",
  "Remote Codex path": "远端 Codex 路径",
  "Connection helper path": "远端连接助手路径",
  "Remote proxy (optional)": "远端代理（可选）",
  "SSH uses your existing keys and known hosts. No password or token is stored in Telldo.":
    "SSH 使用已有密钥和已信任的主机记录，Telldo 不保存密码或 token。",
  "SSH connection details": "SSH 连接参数",

  "Tasks are stored locally. AI context is sent to your model provider. Review AI changes before applying them.":
    "任务保存在本地。AI 对话上下文会发送给模型提供方，更改内容由你确认后应用。",
  General: "通用",
  "Data management": "数据管理",
  Close: "关闭",
  "Create list": "创建清单",
  "Create task": "创建待办",
  "Create recurring task": "创建周期任务",
  "Edit recurring task": "修改周期任务",
  "Changes apply to this recurring task. Completed and individually edited dates are kept.":
    "修改此重复任务，已完成和单独调整过的日期会保留。",
  "Update task": "更新待办",
  "Mark complete": "完成待办",
  "Reopen task": "恢复待办",
  Reschedule: "调整日期",
  "Set tags": "设置标签",
  "Changes to review": "待确认的更改",
  "Change details": "更改详情",
  "These changes will be applied after your confirmation.":
    "确认后，将应用以下更改。",
  "Unknown list": "未知清单",
  Task: "待办",
  "Dismiss proposal": "取消提案",
  "Confirm creation": "确认创建",
  Pending: "待确认",
  Rejected: "已取消",
  Failed: "未能应用",
  Undone: "已撤销",
  Appearance: "外观",
  "Color theme": "主题配色",
  "Black & white": "经典黑白",
  Forest: "森林",
  Ocean: "海洋",
  Plum: "暮紫",
  Light: "白天",
  Dark: "黑夜",
  "Follow system": "跟随系统",
  "Display mode": "显示模式",
  "Preview instantly. Save to keep your choice.": "选择即可预览，保存后生效。",
  Conversation: "AI 对话",
  Memos: "时间线",
  Timeline: "时间线",
  Attachments: "附件",
  "Ask about this todo": "引用这条待办提问",
  "Add attachments in conversation": "在对话中补充附件",
  Today: "今天",
  Planned: "计划",
  Anytime: "随时",
  "MY LISTS": "我的清单",
  "New list": "新建清单",
  Settings: "设置",
  "Search tasks, notes, tags…": "搜索任务、备注和标签…",
  "Ask about your tasks, or tell Telldo what to do…":
    "跟 Telldo 说，你想做什么…",
  "Add a task… e.g. 明天下午交周报": "添加任务，例如：明天下午交周报",
  "Add task": "添加任务",
  "All done for now": "暂时没有待办",
  "A little space for your next idea.": "为下一件事，留一点空间。",
  "TASK DETAILS": "任务详情",
  Notes: "备注",
  "Add a little context…": "写下更多细节…",
  List: "清单",
  Priority: "优先级",
  None: "无",
  Low: "低",
  Medium: "中",
  High: "高",
  "Due date": "截止日期",
  "No date": "无日期",
  "Date only": "日期",
  "Date & time": "日期和时间",
  "Natural date": "自然语言日期",
  Parse: "解析",
  "Planned date": "安排日期",
  Reminder: "提醒",
  Tags: "标签",
  "Comma separated": "用逗号分隔",
  "Save changes": "保存更改",
  "Delete task": "删除任务",
  Subtasks: "子任务",
  "Add subtask": "添加子任务",
  Repeat: "重复",
  "Does not repeat": "不重复",
  Daily: "每天",
  Weekdays: "工作日",
  Weekly: "每周",
  Monthly: "每月日期",
  "Monthly weekday": "每月第几个星期几",
  "Month day": "每月几号",
  "Week position": "第几个",
  Weekday: "星期",
  Until: "截止到",
  Count: "次数",
  "Set repeat": "设置重复",
  "Remove repeat": "取消重复",
  "Upcoming occurrences": "重复实例",
  Skip: "跳过",
  Done: "已完成",
  "To do": "未完成",
  Back: "返回",
  Cancel: "取消",
  "Review proposal": "确认提案",
  "Apply changes": "确认应用",
  Reject: "拒绝",
  Applied: "已应用",
  Undo: "撤销",
  "Working…": "正在处理…",
  "Pending proposals": "待确认提案",
  "Show completed": "显示已完成",
  "Hide completed": "隐藏已完成",
  Language: "语言",
  System: "跟随系统",
  "Time zone": "时区",
  "System time zone": "系统时区",
  "Codex executable": "Codex 可执行文件",
  "Detect Codex": "检测 Codex",
  "Always confirm AI changes": "AI 更改一律确认",
  "Close window to tray": "关闭窗口后保留托盘运行",
  "Backup database": "备份数据库",
  "Export JSON": "导出 JSON",
  "Import JSON": "导入 JSON",
  "Open data folder": "打开数据目录",
  "Save settings": "保存设置",
  "Local first. Room to think.": "本地优先，安心安排。",
  "Rename list": "重命名清单",
  "Delete list": "删除清单",
  Create: "创建",
  Name: "名称",
  "Today’s focus": "今天，专注当下",
  "A little planning goes a long way.": "提前安排，从容一些。",
  "Ideas without a deadline.": "没有期限，也值得记住。",
  "Your space to get things done.": "让想做的事，一件件完成。",
  tasks: "项待办",
  "Every small step counts.": "每一小步，都算数。",
  Saved: "已保存",
  Completed: "已完成",
  Reopen: "重新打开",
  "Delete this task and its subtasks?": "删除此任务及其子任务？",
  "Delete this list and its tasks?": "删除此清单及其中的任务？",
  Delete: "删除",
  "Not now": "暂不",
  "AI sends selected task context to your Codex provider. Your subscription or API fees apply.":
    "AI 会把选定的任务上下文发送给 Codex 提供方，使用你自己的订阅、额度或 API 费用。",
  "Reminders work while Telldo is running, including in the tray. They are not guaranteed after Quit.":
    "Telldo 运行中（含托盘后台）提供提醒；完全退出后不保证送达。",
  "Never synchronize the live SQLite database with a cloud drive. JSON import creates new IDs.":
    "不要用网盘同步正在使用的 SQLite 数据库。JSON 导入会生成新 ID。",
  "Install Codex and run codex login in a terminal, then detect again. Manual features remain available.":
    "安装 Codex 并在终端运行 codex login，再重新检测。手动功能始终可用。",
  "Read-only sandbox is not full tool isolation.":
    "只读沙箱不等于完全禁用工具。",
  "Timezone (IANA)": "时区（IANA）",
  "Reschedule instance": "改期此实例",
  "No pending proposals": "没有待确认提案",
  "AI created a task": "AI 已创建任务",
  "Use commas, e.g. MO,WE,FR": "用逗号分隔，例如 MO,WE,FR",
  Title: "标题",
  "Dates & reminders": "日期与提醒",
  "Ask AI": "问问 AI",
  "Task details": "任务详情",
  "Permission mode": "权限模式",
  "Ask first": "逐项确认",
  "Auto apply": "自动执行",
  "Auto apply lets Telldo apply task and list changes without individual approval.":
    "自动执行模式下，Telldo 会直接应用任务和清单更改，无需逐项批准。",
  "AI changes follow your selected permission mode.":
    "AI 更改按你选择的权限模式执行。",
  Proposal: "提案",
  "Recurring template": "重复任务模板",
  "Show more occurrences": "显示更多实例",
  "Remove repeat before changing its date or time zone.":
    "更改重复规则的日期或时区前，请先取消重复。",
};
type Row = { task: Task; occurrence?: Occurrence; template?: boolean };
const api = <T,>(method: string, ...args: unknown[]) =>
  window.telldo.invoke<T>(method, ...args);
function Modal({
  children,
  className,
  labelledBy,
  close,
}: {
  children: ReactNode;
  className: string;
  labelledBy: string;
  close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement)) {
        (
          panel.current?.querySelector(
            "input, button, select, textarea",
          ) as HTMLElement | null
        )?.focus();
      }
    });
    const keydown = (event: KeyboardEvent) => {
      const node = panel.current;
      if (!node || event.isComposing || event.defaultPrevented) return;
      if (!isTopmostOverlay(node.parentElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = Array.from(
          node.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length > 0);
        const first = items[0],
          last = items[items.length - 1];
        if (!first) {
          event.preventDefault();
          node.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            !node.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !node.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="overlay modal-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`dialog ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
export default function App() {
  const [data, setData] = useState<Snapshot | null>(null),
    [view, setView] = useState("assistant"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [newTask, setNewTask] = useState(""),
    [speech, setSpeech] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [settingsOpen, setSettingsOpen] = useState(false),
    [showDone, setShowDone] = useState(false),
    [listDialog, setListDialog] = useState<{
      id?: string;
      name: string;
      color: string;
    } | null>(null),
    [proposalId, setProposalId] = useState<string | null>(null),
    [confirm, setConfirm] = useState<{
      message: string;
      label?: string;
      destructive?: boolean;
      run: () => Promise<unknown>;
    } | null>(null);
  const [references, setReferences] = useState<ContentReference[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>(
    [],
  );
  const ownedUrls = useRef(new Set<string>());
  const retryCapture = useRef<{ id: string; fingerprint: string } | null>(null);
  const lastListId = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);
  const [memoCount, setMemoCount] = useState(0);
  const [memoTitles, setMemoTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    const refresh = () =>
      void api<Memo[]>("memoList")
        .then((items) => {
          setMemoCount(items.length);
          setMemoTitles(Object.fromEntries(items.map((m) => [m.id, m.title])));
        })
        .catch(() => {});
    refresh();
    return window.telldo.onEvent((event) => {
      if (event.type === "memo-changed") refresh();
    });
  }, []);
  const { messages, setMessages, activeId: chatId, ready: historyReady, switching: switchingChat, change: changeChat, flush: saveChat } = useChatHistory(setError);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutHandler = useRef<(id: ShortcutId) => boolean>(() => false);
  const quickTaskInput = useRef<HTMLInputElement>(null);
  const mac = window.telldo.platform === "darwin";
  const keyHint = (id: ShortcutId) => shortcutLabel(id, mac);
  function resetChatDraft() {
    setSpeech("");
    setDraftAttachments([]);
    setReferences([]);
    retryCapture.current = null;
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current.clear();
  }
  async function selectChat(id?: string) {
    if (busy || asking.current) return;
    if (!(await changeChat(id))) return;
    resetChatDraft();
    setHistoryOpen(false);
    requestAnimationFrame(() => speechInput.current?.focus());
  }
  useEffect(() => window.telldo.onEvent(event => {
    if (event.type !== "notification-open") return;
    const target = event.data as { kind: string; id: string; listId?: string };
    setSettingsOpen(false);
    setHistoryOpen(false);
    setSelectedMemoId(null);
    if (target.kind === "task") {
      setSearch("");
      setView(target.listId || "today");
      setSelected(target.id);
      void reload().catch(e => setError(String(e)));
    } else {
      openConversation();
      if (target.id !== chatId) void selectChat(target.id).catch(e => setError(String(e)));
    }
  }), [chatId, busy]);
  useEffect(() => {
    if (historyReady && data) void api("notificationReady").catch(() => {});
  }, [historyReady, !!data]);
  const progressBuffer = useRef<ProgressBatcher | null>(null);
  if (!progressBuffer.current)
    progressBuffer.current = new ProgressBatcher((batch) => {
      setMessages((items) =>
        items.map((message) => {
          if (message.id !== batch.requestId || message.state !== "working")
            return message;
          const activities = [...(message.activities || [])];
          for (const activity of batch.activities) {
            const index = activities.findIndex(
              (item) => item.id === activity.id,
            );
            if (index >= 0)
              activities[index] = { ...activities[index], ...activity };
            else activities.push(activity);
          }
          return {
            ...message,
            ...(batch.response ? { content: batch.response.text } : {}),
            ...(batch.activities.length ? { activities } : {}),
          };
        }),
      );
    });
  useEffect(() => () => progressBuffer.current?.dispose(), []);
  const [cancelling, setCancelling] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const cancelledRequest = useRef<string | null>(null);
  const asking = useRef(false);
  const [planMonth, setPlanMonth] = useState(() =>
    DateTime.local().toFormat("yyyy-MM"),
  );
  const rangeRef = useRef<
    { start: string; end: string; zone: string } | undefined
  >(undefined);
  const speechInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const id = matchShortcut(event, window.telldo.platform === "darwin");
      if (id && shortcutHandler.current(id)) event.preventDefault();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const loadGeneration = useRef(0);
  const initializedPlanMonth = useRef(false);
  const reload = async () => {
    const generation = ++loadGeneration.current;
    const next = await api<Snapshot>("snapshot", rangeRef.current);
    if (generation === loadGeneration.current) {
      if (!initializedPlanMonth.current) {
        initializedPlanMonth.current = true;
        setPlanMonth(
          localDay(next.settings.timeZone || next.systemTimeZone).slice(0, 7),
        );
      }
      setData(next);
    }
  };
  useEffect(() => {
    if (data) applyAppearance(data.settings, true);
  }, [data?.settings.theme, data?.settings.appearance]);
  const lang =
    data?.settings.language === "system"
      ? data.systemLanguage
      : data?.settings.language;
  const isZh = lang?.startsWith("zh") ?? true;
  const t = (text: string) => (isZh ? zh[text] || text : text);
  const zone =
    data?.settings.timeZone ||
    data?.systemTimeZone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  rangeRef.current = { ...calendarMonthRange(planMonth), zone };
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [planMonth, zone]);
  const act = async (fn: () => Promise<unknown>, message = "") => {
    setError("");
    try {
      await fn();
      await reload();
      if (message) setToast(t(message));
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
    return window.telldo.onEvent((event) => {
      if (event.type === "changed") void reload();
      if (event.type === "select") setSelected(String(event.data));
      if (event.type === "progress") {
        const progress = event.data as ProgressEnvelope;
        if (
          !progress ||
          typeof progress !== "object" ||
          progress.requestId !== activeRequest.current
        )
          return;
        progressBuffer.current?.push(progress);
      }
    });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const tasks = data?.tasks || [],
    lists = data?.lists || [];
  const allRows = useMemo(
    () => data ? projectTaskRows(data, zone) : [],
    [data, zone],
  );
  const rows = useMemo(
    () =>
      (search
        ? [
            ...allRows,
            ...tasks
              .filter((t) => t.parent_id)
              .map((task) => ({ task }) as Row),
          ]
        : allRows
      )
        .filter(
          ({ task, template }) =>
            (!template || !!search || view === task.list_id) &&
            (showDone || task.status !== "done") &&
            (search
              ? `${task.title} ${task.notes} ${task.tags.join(" ")}`
                  .toLowerCase()
                  .includes(search.toLowerCase())
              : ["today", "planned", "anytime"].includes(view)
                ? taskInView(task, view, zone, undefined, showDone)
                : task.list_id === view),
        )
        .sort(
          (a, b) =>
            Number(a.task.status === "done") -
              Number(b.task.status === "done") ||
            (a.task.due_date || "9999").localeCompare(
              b.task.due_date || "9999",
            ) ||
            { high: 0, medium: 1, low: 2, none: 3 }[a.task.priority] -
              { high: 0, medium: 1, low: 2, none: 3 }[b.task.priority],
        ),
    [allRows, tasks, view, search, showDone, zone],
  );
  const task = tasks.find((t) => t.id === selected),
    currentList = lists.find((l) => l.id === view),
    pending = data?.proposals.filter((p) => p.status === "pending") || [],
    proposal = data?.proposals.find((p) => p.id === proposalId);
  async function addTask() {
    if (!newTask.trim() || !lists.length) return;
    await act(async () => {
      const parsed = await api<TaskPatch>("parseDate", newTask);
      await api("createTask", {
        ...parsed,
        title: parsed.title || newTask,
        list_id: currentList?.id || lists[0].id,
        ...(view === "today" && parsed.due_kind === "none"
          ? { planned_date: localDay(zone) }
          : {}),
      });
      setNewTask("");
    });
  }
  async function showHistory() {
    if (busy || switchingChat) return;
    await saveChat();
    openConversation();
    setHistoryOpen(true);
  }
  function startNewChat() {
    if (busy || switchingChat) return;
    openConversation();
    if (!messages.length) return;
    if (speech.trim() || draftAttachments.length || references.length) {
      setConfirm({
        message: isZh ? "当前有未发送的内容。开始新对话并清除草稿？" : "You have an unsent draft. Start a new chat and clear it?",
        label: isZh ? "开始新对话" : "Start new chat",
        destructive: false,
        run: () => selectChat(),
      });
    } else void selectChat().catch(error => setError(String(error)));
  }
  function openConversation() {
    setView("assistant");
    setSearch("");
    setSelected(null);
    requestAnimationFrame(() => speechInput.current?.focus());
  }
  async function cancelConversation() {
    if (!activeRequest.current || cancelling) return;
    cancelledRequest.current = activeRequest.current;
    setCancelling(true);
    try {
      await api("cancelAI");
    } catch (e) {
      setError(String(e));
      setCancelling(false);
      cancelledRequest.current = null;
    }
  }
  function addDraftFiles(files: File[]) {
    const next = files.map((file) => {
      const image = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
      ].includes(file.type);
      const previewUrl = image ? URL.createObjectURL(file) : undefined;
      if (previewUrl) ownedUrls.current.add(previewUrl);
      return {
        id: crypto.randomUUID(),
        name: file.name,
        bytes: file.size,
        kind: image ? ("image" as const) : ("file" as const),
        previewUrl,
        file,
      };
    });
    setDraftAttachments((old) => {
      const combined = [...old, ...next];
      if (
        combined.length > 12 ||
        combined.filter((f) => f.kind === "image").length > 8 ||
        combined.some(
          (f) =>
            f.bytes > 50 * 1024 * 1024 ||
            (f.kind === "image" && f.bytes > 20 * 1024 * 1024),
        ) ||
        combined.reduce((n, f) => n + f.bytes, 0) > 50 * 1024 * 1024
      ) {
        setError(
          isZh
            ? "最多 12 个附件、8 张图片；单张图片 20 MB，总计 50 MB。"
            : "Up to 12 files, 8 images; 20 MB per image and 50 MB total.",
        );
        for (const file of next)
          if (file.previewUrl) {
            URL.revokeObjectURL(file.previewUrl);
            ownedUrls.current.delete(file.previewUrl);
          }
        return old;
      }
      return combined;
    });
  }
  function askTaskReference(task: Task) {
    setReferences(
      (old) =>
        [
          ...old.filter((ref) => ref.kind !== "task" || ref.id !== task.id),
          {
            kind: "task",
            id: task.id,
            title: task.title,
            attachmentCount: task.attachments?.length || 0,
          },
        ].slice(-4) as ContentReference[],
    );
    setSpeech((draft) =>
      draft.trim()
        ? draft
        : isZh
          ? "请帮我看看引用的这条待办。"
          : "Review this referenced todo.",
    );
    openConversation();
  }
  function prepareTaskFiles(task: Task, files: File[]) {
    setReferences(
      (old) =>
        [
          ...old.filter((ref) => ref.kind !== "task" || ref.id !== task.id),
          {
            kind: "task",
            id: task.id,
            title: task.title,
            attachmentCount: task.attachments?.length || 0,
          },
        ].slice(-4) as ContentReference[],
    );
    addDraftFiles(files);
    setSpeech(
      isZh
        ? `请把这些附件补充到待办「${task.title}」中。`
        : `Add these attachments to the todo “${task.title}”.`,
    );
    lastListId.current = task.list_id;
    openConversation();
  }
  async function ask(continuation?: Proposal) {
    const files = continuation ? [] : draftAttachments;
    const sendingReferences = continuation ? [] : references;
    const request = continuation
      ? continuation.source_text
      : speech.trim() ||
        (files.length
          ? isZh
            ? "请读取这些内容，有明确要做的事就记为待办，否则保存内容。"
            : "Read this content. Capture a todo if it contains a clear action; otherwise keep the content."
          : sendingReferences.length
            ? isZh
              ? "请帮我回顾引用的内容。"
              : "Review the referenced content."
            : "");
    if (!request || asking.current) return;
    asking.current = true;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    progressBuffer.current?.begin(requestId);
    cancelledRequest.current = null;
    setBusy(true);
    setCancelling(false);
    if (!continuation) {
      setSpeech("");
      setDraftAttachments([]);
      setReferences([]);
    }
    const excluded = new Set(
      messages
        .filter((m) => m.error || m.state === "cancelled")
        .map((m) => m.turnId || m.id),
    );
    const history = messages
      .filter((m) => !excluded.has(m.turnId || m.id) && m.content)
      .slice(-12)
      .map((m) => ({
        role: m.role,
        content:
          m.content +
          (m.proposalId
            ? `\n[Proposal status: ${m.proposalId === continuation?.id ? "applied" : data?.proposals.find((p) => p.id === m.proposalId)?.status || "unknown"}]`
            : ""),
      }));
    const historyCaptureIds = [
      ...new Set(
        messages
          .filter((m) => m.role === "user" && m.captureId)
          .map((m) => m.captureId!),
      ),
    ].slice(-2);
    const recentReferences = [
      ...messages
        .filter((m) => m.role === "user")
        .flatMap((m) => [
          ...(m.references || []).map((ref) => ({
            kind: ref.kind,
            id: ref.id,
          })),
          ...(m.captureId ? [{ kind: "memo" as const, id: m.captureId }] : []),
        ]),
    ]
      .filter(
        (ref, index, array) =>
          !array
            .slice(index + 1)
            .some((r) => r.kind === ref.kind && r.id === ref.id),
      )
      .slice(-4);
    setMessages((items) => [
      ...items,
      ...(!continuation
        ? [
            {
              id: crypto.randomUUID(),
              turnId: requestId,
              role: "user" as const,
              content: speech.trim(),
              references: sendingReferences,
              attachments: files.map(({ id, name, kind, previewUrl }) => ({
                id,
                name,
                kind,
                previewUrl,
              })),
            },
          ]
        : []),
      {
        id: requestId,
        turnId: requestId,
        role: "assistant" as const,
        content: "",
        state: "working" as const,
        startedAt: Date.now(),
        activities: [],
      },
    ]);
    try {
      let captureId: string | undefined;
      if (files.length) {
        const fingerprint = request + "|" + files.map((f) => f.id).join("|");
        if (retryCapture.current?.fingerprint === fingerprint)
          captureId = retryCapture.current.id;
        else {
          if (retryCapture.current)
            void api("inputDiscard", retryCapture.current.id).catch(() => {});
          const attachments = await Promise.all(
            files.map(async (f) => ({
              name: f.name,
              bytes: new Uint8Array(await f.file!.arrayBuffer()),
            })),
          );
          const capture = await api<Memo>("inputStage", {
            text: speech.trim(),
            attachments,
            idempotencyKey: `input:${requestId}`,
          });
          captureId = capture.id;
          retryCapture.current = { id: capture.id, fingerprint };
          setMessages((items) =>
            items.map((m) =>
              m.turnId === requestId && m.role === "user"
                ? {
                    ...m,
                    captureId,
                    attachments: capture.attachments.map((a) => ({
                      id: a.id,
                      name: a.name,
                      kind: a.kind,
                      previewUrl:
                        a.kind === "image"
                          ? `telldo-memo://attachment/${a.id}`
                          : undefined,
                    })),
                  }
                : m,
            ),
          );
        }
      }
      const reply = await api<ChatReply>(
        "ask",
        request,
        lastListId.current,
        history,
        requestId,
        continuation?.id,
        {
          captureId,
          chatId,
          references: continuation
            ? undefined
            : sendingReferences.map(({ kind, id, asTask }) => ({ kind, id, ...(asTask ? { asTask: true } : {}) })),
          recentReferences,
        },
      );
      retryCapture.current = null;
      progressBuffer.current?.finish(requestId);
      setMessages((items) =>
        items.map((m) =>
          m.id === requestId
            ? {
                ...m,
                content: reply.message,
                proposalId: reply.proposalId,
                memoId: reply.memoId,
                memoIds: reply.memoIds,
                sources: reply.sources,
                appliedProposalIds: reply.appliedProposalIds,
                state: "completed",
                activities: reply.activities || m.activities,
                finishedAt: Date.now(),
              }
            : m.turnId === requestId && m.role === "user"
              ? {
                  ...m,
                  captureId: reply.captureId || captureId,
                  ...(reply.attachments
                    ? { attachments: reply.attachments }
                    : {}),
                }
              : m,
        ),
      );
      void reload().catch((e) => setError(String(e)));
    } catch (e) {
      progressBuffer.current?.finish(requestId);
      const cancelled = cancelledRequest.current === requestId;
      const notice = cancelled
        ? isZh
          ? "已停止，输入内容仍然保留。"
          : "Stopped. Your input is kept."
        : String(e)
            .replace(/^Error: /, "")
            .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      setMessages((items) =>
        items.map((m) =>
          m.id === requestId
            ? {
                ...m,
                notice,
                error: !cancelled,
                state: cancelled ? "cancelled" : "error",
                finishedAt: Date.now(),
              }
            : m,
        ),
      );
      if (!continuation) {
        setSpeech((draft) => draft || request);
        setDraftAttachments((draft) => (draft.length ? draft : files));
        setReferences((draft) => (draft.length ? draft : sendingReferences));
      }
    } finally {
      progressBuffer.current?.finish(requestId);
      activeRequest.current = null;
      asking.current = false;
      setBusy(false);
      setCancelling(false);
    }
  }
  function openMemo(id: string) {
    setSelected(null);
    setSelectedMemoId(id);
  }
  const dateLabel = (item: Task) => {
    const date =
      item.due_at && item.due_kind === "datetime"
        ? DateTime.fromISO(item.due_at).setZone(item.time_zone || zone)
        : DateTime.fromISO(item.due_date || item.planned_date || "", { zone });
    if (!date.isValid) return "";
    const day = date.toISODate();
    const today = DateTime.now().setZone(zone);
    const label =
      day === today.toISODate()
        ? t("Today")
        : day === today.plus({ days: 1 }).toISODate()
          ? isZh
            ? "明天"
            : "Tomorrow"
          : date
              .setLocale(isZh ? "zh-CN" : "en")
              .toFormat(
                date.year === today.year
                  ? isZh
                    ? "M月d日"
                    : "MMM d"
                  : isZh
                    ? "yyyy年M月d日"
                    : "MMM d, yyyy",
              );
    const time =
      item.due_kind === "datetime" ? ` ${date.toFormat("HH:mm")}` : "";
    return item.due_kind !== "none"
      ? isZh
        ? `${label}${time} 截止`
        : `Due ${label}${time}`
      : label;
  };
  shortcutHandler.current = id => {
    if (!data || !historyReady) return false;
    if (id === "help") { setShortcutsOpen(open => !open); return true; }
    const overlays = Array.from(document.querySelectorAll<HTMLElement>(".overlay")).filter(node => node.getClientRects().length);
    if (overlays.length) {
      if (id !== "submit") return false;
      const top = overlays.reduce((a, b) => Number(getComputedStyle(a).zIndex) > Number(getComputedStyle(b).zIndex) ? a : b);
      top.querySelector<HTMLButtonElement>('[data-shortcut-save]:not(:disabled)')?.click();
      return true;
    }
    if (["assistant", "memos", "today", "planned", "anytime"].includes(id)) {
      setView(id); setSearch(""); setSelected(null); setSelectedMemoId(null);
      if (id === "assistant") requestAnimationFrame(() => speechInput.current?.focus());
      return true;
    }
    switch (id) {
      case "focus-ai": openConversation(); return true;
      case "new-chat": startNewChat(); return true;
      case "history": void showHistory().catch(error => setError(String(error))); return true;
      case "new-list": setListDialog({ name: "", color: nextListColor(lists) }); return true;
      case "settings": setSettingsOpen(true); return true;
      case "timeline-search":
        setView("memos"); setSearch(""); setSelected(null);
        requestAnimationFrame(() => { const input = document.querySelector<HTMLInputElement>(".memo-search-input"); input?.focus(); input?.select(); });
        return true;
      case "new-task":
        setView(lists.some(list => list.id === view) || view === "today" || view === "anytime" ? view : lastListId.current || lists[0]?.id || "today");
        setSearch(""); setSelected(null); setSelectedMemoId(null);
        requestAnimationFrame(() => quickTaskInput.current?.focus());
        return true;
      case "attach":
        openConversation();
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".composer-attach")?.click());
        return true;
      case "stop": if (busy) void cancelConversation(); return true;
      case "submit":
        if (view === "assistant") document.querySelector<HTMLButtonElement>('.conversation-send:not(.stop):not(:disabled)')?.click();
        return true;
      default: return false;
    }
  };
  if (!data || !historyReady)
    return (
      <div className="loading">
        <div className="brand-mark">t.</div>
        <p>{error || "Telldo"}</p>
        <LoaderCircle className="spin" />
      </div>
    );
  const isMemoView = view === "memos" && !search;
  const isConversation = view === "assistant" && !search;
  return (
    <div
      className={`app-shell ${isConversation ? "conversation-shell" : ""} ${view === "planned" && !search ? "planned-shell" : ""}`}
    >
      <aside className="sidebar">
        <button
          className="brand"
          onClick={openConversation}
          aria-label={isZh ? "Telldo · AI 对话首页" : "Telldo · AI home"}
          title={isZh ? "回到 AI 对话 · ⌘ J" : "Open AI conversation · ⌘ J"}
        >
          <div className="brand-mark">t.</div>
          <span>Telldo</span>
        </button>
        <nav>
          {[
            ["assistant", "Conversation", Sparkles],
            ["memos", "Timeline", NotebookPen],
            ["today", "Today", Sun],
            ["planned", "Planned", CalendarDays],
            ["anytime", "Anytime", Layers],
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof Sun;
            return (
              <button
                key={String(id)}
                title={`${t(String(label))} · ${keyHint(String(id) as ShortcutId)}`}
                className={`nav-item ${view === id ? "active" : ""}`}
                onClick={() => {
                  setView(String(id));
                  setSearch("");
                  setSelected(null);
                }}
              >
                <I size={18} />
                <span>{t(String(label))}</span>
                {id === "assistant" && busy && (
                  <LoaderCircle size={13} className="spin nav-working" />
                )}

                {id !== "assistant" && id !== "memos" && (
                  <small>
                    {id === "planned"
                      ? allRows.filter(({ task }) =>
                          task.status === "todo" &&
                          (task.due_kind !== "none" || !!task.planned_date ||
                            data.recurrences.some(series => series.task_id === task.id)),
                        ).length
                      : allRows.filter(({ task: a, template }) =>
                          !template && taskInView(a, String(id), zone),
                        ).length}
                  </small>
                )}
              </button>
            );
          })}
        </nav>
        <div className="section-label">
          {t("MY LISTS")}
          <button
            aria-label={t("New list")}
            onClick={() => setListDialog({ name: "", color: nextListColor(lists) })}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="list-nav">
          {lists.map((list) => (
            <button
              className={`nav-item ${view === list.id ? "active" : ""}`}
              key={list.id}
              onClick={() => {
                setView(list.id);
                lastListId.current = list.id;
                setSearch("");
              }}
            >
              <span className="list-dot" style={{ background: list.color }} />
              <span>{list.name}</span>
              <small>
                {
                  allRows.filter(({ task }) => taskInView(task, list.id, zone)).length
                }
              </small>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-utilities">
            <button className="nav-item" title={`${t("Settings")} · ${keyHint("settings")}`} onClick={() => setSettingsOpen(true)}>
              <SettingsIcon size={18} />{t("Settings")}
            </button>
            <button className="shortcuts-trigger" aria-label={isZh ? "快捷键" : "Keyboard shortcuts"} title={`${isZh ? "快捷键" : "Keyboard shortcuts"} · ${keyHint("help")}`} onClick={() => setShortcutsOpen(true)}><Keyboard size={16} /></button>
          </div>
        </div>
      </aside>
      <SidebarResizeHandle isZh={isZh} />
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            {isConversation ? "Telldo" : isZh ? "我的空间" : "My workspace"}
            <span>/</span>
            <strong>
              {isMemoView
                ? t("Timeline")
                : isConversation
                  ? t("Conversation")
                  : search
                    ? t("Search tasks, notes, tags…")
                    : currentList?.name ||
                      t(
                        view === "today"
                          ? "Today"
                          : view === "planned"
                            ? "Planned"
                            : "Anytime",
                      )}
            </strong>
          </div>
          {isConversation && (
            <div className="conversation-actions">
              <button className="new-conversation history-trigger" disabled={busy || switchingChat}
                onClick={() => void showHistory().catch(error => setError(String(error)))} title={`${isZh ? "查看并继续之前的对话" : "Open a previous conversation"} · ${keyHint("history")}`}>
                <History size={15} /><span>{isZh ? "历史记录" : "History"}</span>
              </button>
              <button className="new-conversation" disabled={busy || switchingChat || !messages.length}
                onClick={startNewChat}
                title={`${isZh ? "开始新对话，保留任务和提案" : "Start fresh; tasks and proposals are kept"} · ${keyHint("new-chat")}`}>
                <SquarePen size={15} /><span>{isZh ? "新对话" : "New chat"}</span>
              </button>
            </div>
          )}

        </header>
        <div className="conversation-page-slot" hidden={!isConversation}>
          {error && (
            <div role="alert" className="error conversation-global-error">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label={t("Close")}>
                <X size={16} />
              </button>
            </div>
          )}
          <ChatPage
            openTask={(id) => {
              setSelectedMemoId(null);
              setSelected(id);
            }}
            permissionMode={data.settings.permissionMode || "confirm"}
            setPermissionMode={(permissionMode) =>
              void act(() => api("settings", { permissionMode }))
            }
            openMemo={openMemo}
            memoTitles={memoTitles}
            references={references}
            removeReference={(kind, id) =>
              setReferences((items) =>
                items.filter((ref) => ref.kind !== kind || ref.id !== id),
              )
            }
            attachments={draftAttachments}
            addFiles={addDraftFiles}
            removeAttachment={(id) =>
              setDraftAttachments((files) => files.filter((f) => f.id !== id))
            }
            visible={isConversation}
            messages={messages}
            busy={busy || switchingChat}
            cancelling={cancelling}
            isZh={isZh}
            proposals={data.proposals}
            speech={speech}
            setSpeech={setSpeech}
            inputRef={speechInput}
            available={!!data.capabilities?.available}
            connectionReason={data.capabilities?.reason}
            review={setProposalId}
            send={() => void ask()}
            cancel={() => void cancelConversation()}
            settings={() => setSettingsOpen(true)}
          />
        </div>
        <div className="memo-page-slot" hidden={!isMemoView}>
          <MemoPage
            completedTasks={[
              ...tasks.filter((task) => task.status === "done"),
              ...data.recurrences.flatMap((rule) => {
                const master = tasks.find((t) => t.id === rule.task_id);
                const done = data.occurrences
                  .filter((o) => o.series_id === rule.id && o.status === "done")
                  .sort((a, b) =>
                    (b.completed_at || "").localeCompare(a.completed_at || ""),
                  )[0];
                return master && done
                  ? [taskFromOccurrence(master, done, rule.tzid)]
                  : [];
              }),
            ]}
            allTasks={tasks}
            lists={lists}
            taskAttachments={Object.fromEntries(
              tasks.map((t) => [t.id, t.attachments || []]),
            )}
            onOpenTask={(id) => {
              if (tasks.some((task) => task.id === id)) setSelected(id);
            }}
            onCompose={openConversation}
            visible={isMemoView}
            isZh={isZh}
            zone={zone}
            selectedMemoId={selectedMemoId}
            onSelectMemo={setSelectedMemoId}
            onReviewProposal={setProposalId}
            onAskMemo={(memo, asTask = false) => {
              setReferences(
                (old) =>
                  [
                    ...old.filter(
                      (ref) => ref.kind !== "memo" || ref.id !== memo.id,
                    ),
                    {
                      kind: "memo",
                      id: memo.id,
                      title: memo.title,
                      attachmentCount: memo.attachments.length,
                      ...(asTask ? { asTask: true } : {}),
                    },
                  ].slice(-4) as ContentReference[],
              );
              setSpeech((draft) =>
                asTask
                  ? (isZh ? "将这份内容设为待办，保留原文和附件。" : "Make a todo from this content, keeping its text and attachments.")
                  : draft.trim()
                    ? draft
                    : isZh
                      ? "请帮我回顾引用的内容。"
                      : "Review the referenced content.",
              );
              openConversation();
            }}
          />
        </div>
        {!isConversation && !isMemoView && (
          <div className="content">
            <div className="view-heading">
              <div className="eyebrow">
                {new Intl.DateTimeFormat(isZh ? "zh-CN" : "en", {
                  timeZone: zone,
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                }).format(new Date())}
              </div>
              <div className="heading-line">
                <h1>
                  {search
                    ? `${isZh ? "搜索" : "Search"} · ${search}`
                    : currentList?.name ||
                      t(
                        view === "today"
                          ? "Today"
                          : view === "planned"
                            ? "Planned"
                            : "Anytime",
                      )}
                </h1>
                {currentList && (
                  <div className="heading-actions">
                    <button
                      title={isZh ? "编辑清单" : "Edit list"}
                      onClick={() =>
                        setListDialog({
                          id: currentList.id,
                          name: currentList.name,
                          color: currentList.color,
                        })
                      }
                    >
                      <MoreHorizontal size={20} />
                    </button>
                    <button
                      title={t("Delete list")}
                      onClick={() =>
                        setConfirm({
                          message: t("Delete this list and its tasks?"),
                          run: async () => {
                            await api("deleteList", currentList.id);
                            setView("today");
                          },
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
              <p className="view-description">
                {search
                  ? isZh
                    ? "找到你想做的那件事。"
                    : "Find what matters."
                  : view === "today"
                    ? isZh
                      ? "留一点空间，专注重要的事。"
                      : "A little space for what matters."
                    : view === "planned"
                      ? isZh
                        ? "把想做的事，放进日子里。"
                        : "Give your plans a place in time."
                      : isZh
                        ? "收好每一个想法，按自己的节奏来。"
                        : "Good ideas, at your own pace."}
              </p>
            </div>
            {error && (
              <div role="alert" className="error global-error">
                <span>{error}</span>
                <button onClick={() => setError("")}>
                  <X size={16} />
                </button>
              </div>
            )}
            {pending.length > 0 && (
              <button
                className="proposal-banner"
                onClick={() => setProposalId(pending[0].id)}
              >
                <Sparkles size={17} />
                {t("Pending proposals")} · {pending.length}
                <ArrowRight size={16} />
              </button>
            )}
            {view === "planned" && (
              <div className="planned-container" hidden={!!search}>
                <PlannedView
                  data={data}
                  zone={zone}
                  isZh={isZh}
                  month={planMonth}
                  setMonth={setPlanMonth}
                  showDone={showDone}
                  setShowDone={setShowDone}
                  reload={reload}
                  openTemplate={(item) => {
                    setView(item.list_id);
                    setSelected(item.id);
                  }}
                  renderDetails={(item, dates, close) => (
                    <TaskDetail
                      onAttach={prepareTaskFiles}
                      onAsk={askTaskReference}
                      key={item.id + ":" + item.version}
                      task={item}
                      data={data}
                      zone={zone}
                      t={t}
                      close={close}
                      act={act}
                      selectTask={(id) => {
                        setView(item.list_id);
                        setSelected(id);
                      }}
                      requestDelete={() =>
                        setConfirm({
                          message: t("Delete this task and its subtasks?") + (isZh ? " 关联的原始资料和附件会保留，需在时间线单独删除。" : " Linked source material and attachments are kept; delete them separately in Timeline."),
                          run: async () => {
                            await api("deleteTask", item.id, item.version);
                            close();
                          },
                        })
                      }
                    />
                  )}
                />
              </div>
            )}
            {!(view === "planned" && !search) && (
              <>
                <div className="task-toolbar">
                  <span>
                    {t("To do")}
                    <span className="count-pill">{rows.length}</span>
                  </span>
                  <button onClick={() => setShowDone(!showDone)}>
                    {t(showDone ? "Hide completed" : "Show completed")}
                  </button>
                </div>
                <div className="quick-add">
                  <Plus size={20} />
                  <input
                    ref={quickTaskInput}
                    aria-label="New task"
                    title={keyHint("new-task")}
                    placeholder={
                      isZh ? "手动添加任务…" : "Add a task manually…"
                    }
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !e.repeat) { e.preventDefault(); void addTask(); }
                    }}
                  />
                  <button
                    disabled={!newTask.trim() || !lists.length}
                    onClick={() => void addTask()}
                  >
                    {t("Add task")}
                    <span>↵</span>
                  </button>
                </div>
                <div className="task-list">
                  {rows.length ? (
                    rows.map(({ task: item, occurrence, template }) => (
                      <div
                        key={item.id + (occurrence?.occurrence_key || "")}
                        className={`task-row ${selected === item.id ? "selected" : ""} ${item.status === "done" ? "completed" : ""}`}
                      >
                        <button
                          className={`check-button ${item.priority} ${item.status === "done" ? "checked" : ""}`}
                          disabled={template}
                          aria-label={`${item.status === "done" ? t("Reopen") : t("Completed")} ${item.title}`}
                          onClick={() =>
                            void act(() =>
                              occurrence
                                ? api(
                                    "updateOccurrence",
                                    occurrence.series_id,
                                    occurrence.occurrence_key,
                                    {
                                      status:
                                        item.status === "done"
                                          ? "todo"
                                          : "done",
                                    },
                                    occurrence.version ?? 1,
                                  )
                                : api("updateTask", item.id, item.version, {
                                    status:
                                      item.status === "done" ? "todo" : "done",
                                  }),
                            )
                          }
                        >
                          {item.status === "done" && <Check size={13} />}
                        </button>
                        <button
                          className="task-body"
                          onClick={() => setSelected(item.id)}
                        >
                          <span className="task-title">
                            {item.title}
                            {template && (
                              <span className="pill">
                                {t("Recurring template")}
                              </span>
                            )}
                            {occurrence && <Repeat2 size={13} />}
                          </span>
                          <span className="task-meta">
                            {!currentList && (
                              <span>
                                {lists.find((l) => l.id === item.list_id)?.name}
                              </span>
                            )}
                            {!!item.attachments?.length && (
                              <span>
                                <Paperclip size={11} />
                                {item.attachments.length}
                              </span>
                            )}
                            {item.tags.map((tag) => (
                              <span className="tag" key={tag}>
                                #{tag}
                              </span>
                            ))}
                            {tasks.some((t) => t.parent_id === item.id) && (
                              <span>
                                <ListChecks size={12} />
                                {
                                  tasks.filter(
                                    (t) =>
                                      t.parent_id === item.id &&
                                      t.status === "done",
                                  ).length
                                }
                                /
                                {
                                  tasks.filter((t) => t.parent_id === item.id)
                                    .length
                                }
                              </span>
                            )}
                          </span>
                        </button>
                        <span
                          className={`task-date ${isOverdue(item, zone) && item.status === "todo" ? "overdue" : ""}`}
                        >
                          {item.reminder_at && <Bell size={12} />}{" "}
                          {dateLabel(item)}
                        </span>
                        <span className={`priority-dot ${item.priority}`} />
                      </div>
                    ))
                  ) : (
                    <div className="empty">
                      <div className="empty-art">
                        <div className="paper">
                          <span />
                          <span />
                          <span />
                          <Check size={23} />
                        </div>
                        <span className="orbit one" />
                        <span className="orbit two" />
                      </div>
                      <h3>{t("All done for now")}</h3>
                      <p>{t("A little space for your next idea.")}</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>
      {task && !(view === "planned" && !search) && (
        <TaskDetail
          onAttach={prepareTaskFiles}
          onAsk={askTaskReference}
          key={task.id + ":" + task.version}
          task={task}
          data={data}
          zone={zone}
          t={t}
          close={() => setSelected(null)}
          act={act}
          selectTask={setSelected}
          requestDelete={() =>
            setConfirm({
              message: t("Delete this task and its subtasks?") + (isZh ? " 关联的原始资料和附件会保留，需在时间线单独删除。" : " Linked source material and attachments are kept; delete them separately in Timeline."),
              run: async () => {
                await api("deleteTask", task.id, task.version);
                setSelected(null);
              },
            })
          }
        />
      )}
      {toast && (
        <div className="toast">
          <Check size={16} />
          {toast}
        </div>
      )}
      {shortcutsOpen && <ShortcutsDialog isZh={isZh} close={() => setShortcutsOpen(false)} />}
      {historyOpen && <ChatHistoryDialog isZh={isZh} activeId={chatId} select={id => selectChat(id)} close={() => setHistoryOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog
          openShortcuts={() => setShortcutsOpen(true)}
          data={data}
          t={t}
          close={() => setSettingsOpen(false)}
          act={act}
        />
      )}
      {listDialog && (
        <Modal
          className="list-dialog"
          labelledBy="list-dialog-title"
          close={() => setListDialog(null)}
        >
          <form
            className="list-dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (listDialog.id)
                  await api("updateList", listDialog.id, {
                    name: listDialog.name.trim(),
                    color: listDialog.color,
                  });
                else await api("createList", listDialog.name.trim(), listDialog.color);
                setListDialog(null);
              });
            }}
          >
            <div className="modal-heading">
              <h2 id="list-dialog-title">
                {listDialog.id ? (isZh ? "编辑清单" : "Edit list") : t("New list")}
              </h2>
              <button
                type="button"
                className="modal-close"
                aria-label={t("Close")}
                onClick={() => setListDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <label>
                {t("Name")}
                <input
                  placeholder={
                    isZh
                      ? "例如：工作、旅行、阅读"
                      : "e.g. Work, Travel, Reading"
                  }
                  autoFocus
                  required
                  maxLength={100}
                  value={listDialog.name}
                  onChange={(e) =>
                    setListDialog({ ...listDialog, name: e.target.value })
                  }
                />
              </label>
              <fieldset className="list-color-field">
                <legend>{isZh ? "颜色" : "Color"}</legend>
                <div className="list-color-options">
                  {LIST_COLORS.map(({ color, name, zh }) => (
                    <button
                      key={color}
                      type="button"
                      className="list-color-swatch"
                      style={{ "--swatch-color": color } as import("react").CSSProperties}
                      aria-label={isZh ? zh : name}
                      aria-pressed={listDialog.color.toLowerCase() === color}
                      title={isZh ? zh : name}
                      onClick={() => setListDialog({ ...listDialog, color })}
                    >
                      {listDialog.color.toLowerCase() === color && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="dialog-actions modal-footer">
              <button type="button" onClick={() => setListDialog(null)}>
                {t("Cancel")}
              </button>
              <button
                className="primary"
                type="submit"
                data-shortcut-save
                disabled={!listDialog.name.trim()}
              >
                {t(listDialog.id ? "Save changes" : "Create list")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {proposal && (
        <ProposalDialog
          proposal={proposal}
          aiBusy={busy}
          isZh={isZh}
          onApplied={(applied) => {
            openConversation();
            void ask(applied);
          }}
          tasks={tasks}
          lists={lists}
          t={t}
          close={() => setProposalId(null)}
          act={act}
        />
      )}
      {confirm && (
        <Modal
          className="small confirm-dialog"
          labelledBy="confirm-dialog-heading"
          close={() => setConfirm(null)}
        >
          <h2 id="confirm-dialog-heading">{confirm.message}</h2>
          <div className="dialog-actions">
            <button onClick={() => setConfirm(null)}>{t("Cancel")}</button>
            <button
              className={confirm.destructive === false ? "primary" : "danger primary"}
              onClick={() =>
                void act(async () => {
                  await confirm.run();
                  setConfirm(null);
                })
              }
            >
              {confirm.label || t("Delete")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function TaskDetail({
  task,
  data,
  zone,
  t,
  close,
  act,
  requestDelete,
  selectTask,
  onAttach,
  onAsk,
}: {
  task: Task;
  data: Snapshot;
  zone: string;
  t: (s: string) => string;
  close: () => void;
  act: (f: () => Promise<unknown>, m?: string) => Promise<void>;
  requestDelete: () => void;
  selectTask: (id: string) => void;
  onAttach?: (task: Task, files: File[]) => void;
  onAsk?: (task: Task) => void;
}) {
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [imagePreview, setImagePreview] = useState<MemoAttachment | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<TaskPatch>({ ...task }),
    [sub, setSub] = useState(""),
    [repeat, setRepeat] = useState(""),
    [byday, setByday] = useState("MO"),
    [monthday, setMonthday] = useState("31"),
    [position, setPosition] = useState("1"),
    [until, setUntil] = useState(""),
    [count, setCount] = useState(""),
    [occurrenceLimit, setOccurrenceLimit] = useState(12);
  const series = data.recurrences.find((r) => r.task_id === task.id),
    set = (key: keyof TaskPatch, value: unknown) =>
      setDraft((d) => ({ ...d, [key]: value }));
  useEffect(() => {
    if (!series) return;
    const rule = Object.fromEntries(
      series.rrule.split(";").map((x) => x.split("=")),
    );
    setRepeat(
      rule.FREQ === "DAILY"
        ? "daily"
        : rule.FREQ === "WEEKLY"
          ? rule.BYDAY === "MO,TU,WE,TH,FR"
            ? "weekdays"
            : "weekly"
          : rule.BYDAY
            ? "monthlyWeekday"
            : "monthly",
    );
    setByday((rule.BYDAY || "MO").replace(/^-?\d/, ""));
    setPosition(rule.BYSETPOS || rule.BYDAY?.match(/^(-?\d)/)?.[1] || "1");
    setMonthday(
      rule.BYMONTHDAY || String(DateTime.fromISO(series.dtstart).day),
    );
    setUntil(series.until || "");
    setCount(series.count ? String(series.count) : "");
  }, [series?.rrule, series?.until, series?.count]);
  const visibleOccurrences = data.occurrences.filter(
    (o) => o.series_id === series?.id,
  );
  const hasChanges =
    (
      [
        "title",
        "notes",
        "list_id",
        "priority",
        "due_kind",
        "due_date",
        "due_at",
        "time_zone",
        "planned_date",
        "reminder_at",
      ] as const
    ).some((key) => (draft[key] || "") !== (task[key] || "")) ||
    JSON.stringify(draft.tags || []) !== JSON.stringify(task.tags);
  const save = () =>
    act(async () => {
      setSaveError("");
      setSaving(true);
      try {
        await api(
          series ? "updateRecurring" : "updateTask",
          task.id,
          task.version,
          {
            title: draft.title,
            notes: draft.notes,
            list_id: draft.list_id,
            priority: draft.priority,
            ...{
                  due_kind: draft.due_kind,
                  due_date: draft.due_kind === "none" ? null : draft.due_date,
                  due_at: draft.due_kind === "datetime" ? draft.due_at : null,
                  time_zone:
                    draft.due_kind === "datetime"
                      ? draft.time_zone || zone
                      : null,
                  planned_date: draft.planned_date || null,
                  reminder_at: draft.reminder_at || null,
                },
            tags: draft.tags || [],
          },
          ...(series
            ? [
                {
                  rrule: series.rrule,
                  dtstart:
                    draft.due_kind === "datetime"
                      ? DateTime.fromISO(draft.due_at!)
                          .setZone(draft.time_zone || zone)
                          .toFormat("yyyy-MM-dd'T'HH:mm:ss")
                      : draft.due_date,
                  tzid: draft.time_zone || series.tzid,
                  until: series.until,
                  count: series.count,
                  exdates: series.exdates,
                },
              ]
            : []),
        );
        close();
      } catch (error) {
        setSaveError(String(error).replace(/^Error: /, ""));
        throw error;
      } finally {
        setSaving(false);
      }
    }, "Saved");
  async function setRecurring() {
    let rule =
      repeat === "daily"
        ? "FREQ=DAILY"
        : repeat === "weekdays"
          ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
          : repeat === "weekly"
            ? `FREQ=WEEKLY;BYDAY=${byday}`
            : repeat === "monthly"
              ? `FREQ=MONTHLY;BYMONTHDAY=${monthday}`
              : `FREQ=MONTHLY;BYDAY=${position}${byday}`;
    await act(
      () =>
        api("setRecurrence", task.id, {
          rrule: rule,
          dtstart:
            draft.due_kind === "datetime"
              ? DateTime.fromISO(draft.due_at!)
                  .setZone(draft.time_zone || zone)
                  .toFormat("yyyy-MM-dd'T'HH:mm:ss")
              : draft.due_date || localDay(zone),
          tzid: draft.time_zone || zone,
          until: until || null,
          count: count ? Number(count) : null,
          exdates: [],
        }),
      "Saved",
    );
  }
  return (
    <DetailCardModal
      className="detail task-detail-card"
      labelledBy="task-card-heading"
      close={close}
    >
      <div className="task-card-header">
        <div className="task-card-context">
          <ListChecks size={17} />
          <span id="task-card-heading">{t("Task details")}</span>
          <span className="task-card-context-divider">/</span>
          <span className="task-card-list">
            {data.lists.find((list) => list.id === task.list_id)?.name}
          </span>
        </div>
        <button
          className="task-card-close"
          onClick={close}
          aria-label="Close details"
        >
          <X size={18} />
        </button>
      </div>
      <div className="detail-scroll">
        {saveError && (
          <div className="error" role="alert">
            {saveError}
          </div>
        )}
        <textarea
          className="detail-title"
          aria-label={t("Title")}
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          rows={2}
          id="task-card-title"
        />
        {series && (
          <div className="pill">
            <Repeat2 size={12} />
            {t("Recurring template")}
          </div>
        )}
        <TaskNotes value={draft.notes || ""} onChange={value => set("notes", value)}
          label={t("Notes")} placeholder={t("Add a little context…")} more={t("Show more")} less={t("Show less")} />
        {!!task.attachments?.length && (
          <section className="detail-section task-attachment-section">
            <div className="task-attachments">
              {task.attachments?.map((file) => (
                <button
                  key={file.id}
                  className={file.kind === "image" ? "task-attachment-image" : "task-attachment-file"}
                  aria-label={file.kind === "image" ? `${t("Preview image")}: ${file.name}` : file.name}
                  onClick={() => file.kind === "image" ? setImagePreview(file) :
                    void api("memoOpen", file.id).catch((e) =>
                      act(async () => {
                        throw e;
                      }),
                    )
                  }
                  title={file.kind === "image" ? undefined : file.name}
                >
                  {file.kind === "image" ? (
                    <img
                      src={`telldo-memo://attachment/${file.id}`}
                      alt={file.name}
                    />
                  ) : (
                    <Paperclip size={17} />
                  )}
                  {file.kind !== "image" && <span>{file.name}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
        <div className="task-properties">
          <DetailSelect label={t("List")} value={draft.list_id || task.list_id}
            options={data.lists.map(list => ({ value: list.id, label: list.name, color: list.color }))}
            onChange={value => set("list_id", value)} />
          <DetailSelect label={t("Priority")} value={draft.priority || "none"}
            options={(["none", "low", "medium", "high"] as const).map(value => ({
              value, label: t(value[0].toUpperCase() + value.slice(1)),
              color: { none: undefined, low: "#7099c7", medium: "#c89954", high: "#c46e73" }[value],
            }))} onChange={value => set("priority", value)} />
        </div>
        {series && (
          <p className="notice">
            {t(
              "Changes apply to this recurring task. Completed and individually edited dates are kept.",
            )}
          </p>
        )}
        <TaskTiming value={draft} zone={series?.tzid || zone} isZh={t("General") === "通用"} requireDate={!!series}
          onChange={patch => setDraft(previous => ({ ...previous, ...patch }))} />
        <TaskTags value={draft.tags || []} suggestions={data.tasks.flatMap(item => item.tags)}
          isZh={t("General") === "通用"} onChange={tags => set("tags", tags)} />
        {!task.parent_id && (
          <details
            className="task-card-disclosure"
            open={
              data.tasks.some((item) => item.parent_id === task.id)
                ? true
                : undefined
            }
          >
            <summary>
              <ListChecks size={16} />
              <span>{t("Subtasks")}</span>
              <span className="task-card-summary">
                {data.tasks.filter((item) => item.parent_id === task.id)
                  .length || ""}
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="task-card-disclosure-body">
              {!task.parent_id && (
                <>
                  {data.tasks
                    .filter((s) => s.parent_id === task.id)
                    .map((s) => (
                      <div className="subtask" key={s.id}>
                        <button
                          className={`check-button ${s.status === "done" ? "checked" : ""}`}
                          onClick={() =>
                            void act(() =>
                              api("updateTask", s.id, s.version, {
                                status: s.status === "todo" ? "done" : "todo",
                              }),
                            )
                          }
                        >
                          {s.status === "done" && <Check size={12} />}
                        </button>
                        <button
                          aria-label="Open subtask details"
                          onClick={() => selectTask(s.id)}
                        >
                          <ArrowUpRight size={13} />
                        </button>
                        <input
                          aria-label="Subtask title"
                          defaultValue={s.title}
                          onBlur={(e) => {
                            if (e.target.value !== s.title)
                              void act(() =>
                                api("updateTask", s.id, s.version, {
                                  title: e.target.value,
                                }),
                              );
                          }}
                        />
                        <button
                          aria-label="Delete subtask"
                          onClick={() =>
                            void act(() => api("deleteTask", s.id, s.version))
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  <div className="inline-input">
                    <input
                      value={sub}
                      onChange={(e) => setSub(e.target.value)}
                      placeholder={t("Add subtask")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && sub.trim())
                          void act(async () => {
                            await api("createTask", {
                              list_id: task.list_id,
                              parent_id: task.id,
                              title: sub,
                            });
                            setSub("");
                          });
                      }}
                    />
                    <button
                      disabled={!sub.trim()}
                      onClick={() =>
                        void act(async () => {
                          await api("createTask", {
                            list_id: task.list_id,
                            parent_id: task.id,
                            title: sub,
                          });
                          setSub("");
                        })
                      }
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </details>
        )}
        {!task.parent_id && (
          <details className="task-card-disclosure">
            <summary>
              <Repeat2 size={16} />
              <span>{t("Repeat")}</span>
              <span className="task-card-summary">
                {series ? t("Recurring template") : t("Does not repeat")}
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="task-card-disclosure-body">
              {series && (
                <>
                  <button
                    className="text-button"
                    onClick={() =>
                      void act(() => api("removeRecurrence", task.id))
                    }
                  >
                    {t("Remove repeat")}
                  </button>
                </>
              )}
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              >
                {[
                  ["", "Does not repeat"],
                  ["daily", "Daily"],
                  ["weekdays", "Weekdays"],
                  ["weekly", "Weekly"],
                  ["monthly", "Monthly"],
                  ["monthlyWeekday", "Monthly weekday"],
                ].map(([v, l]) => (
                  <option value={v} key={v}>
                    {t(l)}
                  </option>
                ))}
              </select>
              {repeat && (
                <>
                  {(repeat === "weekly" || repeat === "monthlyWeekday") && (
                    <label>
                      {t("Weekday")}
                      <input
                        value={byday}
                        onChange={(e) => setByday(e.target.value.toUpperCase())}
                        placeholder={t("Use commas, e.g. MO,WE,FR")}
                      />
                    </label>
                  )}
                  {repeat === "monthly" && (
                    <label>
                      {t("Month day")}
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={monthday}
                        onChange={(e) => setMonthday(e.target.value)}
                      />
                    </label>
                  )}
                  {repeat === "monthlyWeekday" && (
                    <label>
                      {t("Week position")}
                      <select
                        value={position}
                        onChange={(e) => setPosition(e.target.value)}
                      >
                        {["1", "2", "3", "4", "-1"].map((v) => (
                          <option value={v} key={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="form-grid">
                    <label>
                      {t("Until")}
                      <input
                        type="date"
                        value={until}
                        onChange={(e) => {
                          setUntil(e.target.value);
                          setCount("");
                        }}
                      />
                    </label>
                    <label>
                      {t("Count")}
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        value={count}
                        onChange={(e) => {
                          setCount(e.target.value);
                          setUntil("");
                        }}
                      />
                    </label>
                  </div>
                  <button
                    className="secondary full"
                    onClick={() => void setRecurring()}
                  >
                    {t("Set repeat")}
                  </button>
                </>
              )}
              {series && (
                <>
                  <h4>{t("Upcoming occurrences")}</h4>
                  {visibleOccurrences.slice(0, occurrenceLimit).map((o) => (
                    <div className="occurrence" key={o.occurrence_key}>
                      <input
                        aria-label={t("Reschedule instance")}
                        type="date"
                        value={
                          taskFromOccurrence(task, o, series.tzid).due_date ||
                          o.due_date
                        }
                        onChange={(e) =>
                          void act(() =>
                            api(
                              "updateOccurrence",
                              o.series_id,
                              o.occurrence_key,
                              { override_date: e.target.value },
                              o.version ?? 1,
                            ),
                          )
                        }
                      />
                      <select
                        aria-label="Occurrence status"
                        value={o.status}
                        onChange={(e) =>
                          void act(() =>
                            api(
                              "updateOccurrence",
                              o.series_id,
                              o.occurrence_key,
                              { status: e.target.value },
                              o.version ?? 1,
                            ),
                          )
                        }
                      >
                        <option value="todo">{t("To do")}</option>
                        <option value="done">{t("Done")}</option>
                        <option value="skipped">{t("Skip")}</option>
                      </select>
                    </div>
                  ))}
                  {visibleOccurrences.length > occurrenceLimit && (
                    <button
                      className="secondary full"
                      onClick={() => setOccurrenceLimit((n) => n + 24)}
                    >
                      {t("Show more occurrences")} (
                      {visibleOccurrences.length - occurrenceLimit})
                    </button>
                  )}
                </>
              )}
            </div>
          </details>
        )}
      </div>
      <div className="task-card-footer">
        <button
          className="task-card-icon task-card-delete"
          aria-label={t("Delete task")}
          title={t("Delete task")}
          onClick={requestDelete}
        >
          <Trash2 size={17} />
        </button>
        {onAttach && (
          <button
            className="task-card-icon"
            aria-label={t("Add attachments in conversation")}
            title={t("Add attachments in conversation")}
            onClick={() => attachmentInput.current?.click()}
          >
            <Paperclip size={17} />
          </button>
        )}
        <span className="task-card-footer-space" />
        {hasChanges && <button data-shortcut-save className="primary task-card-save" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {t("Save changes")}
        </button>}
        {onAsk && <button className="task-card-ask" disabled={saving || hasChanges}
          title={hasChanges ? t("Save changes first") : undefined} onClick={() => onAsk(task)}>
          <Sparkles size={16} />{t("Ask AI")}
        </button>}
      </div>
      <input
        hidden
        ref={attachmentInput}
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) onAttach?.(task, files);
          event.target.value = "";
        }}
      />
      {imagePreview && <ImagePreview src={`telldo-memo://attachment/${imagePreview.id}`} alt={imagePreview.name} close={() => setImagePreview(null)} />}
    </DetailCardModal>
  );
}
function SettingsDialog({
  openShortcuts,
  data,
  t,
  close,
  act,
}: {
  openShortcuts: () => void;
  data: Snapshot;
  t: (s: string) => string;
  close: () => void;
  act: (f: () => Promise<unknown>, m?: string) => Promise<void>;
}) {
  const [section, setSection] = useState("appearance");
  const [draft, setDraft] = useState<Settings>(data.settings);
  useEffect(() => {
    applyAppearance(draft);
    return () => applyAppearance(data.settings);
  }, [
    draft.theme,
    draft.appearance,
    data.settings.theme,
    data.settings.appearance,
  ]);
  return (
    <Modal className="settings-modal" labelledBy="settings-title" close={close}>
      <div className="modal-heading">
        <h2 id="settings-title">{t("Settings")}</h2>
        <button className="modal-close" aria-label={t("Close")} onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("Settings")}>
          {(
            [
              ["appearance", "Appearance", Sun],
              ["general", "General", SettingsIcon],
              ["notifications", "Notifications", Bell],
              ["ai", "AI connection", Sparkles],
              ["data", "Data management", Layers],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={section === id}
              onClick={() => setSection(id)}
            >
              <Icon size={17} />
              <span>{t(label)}</span>
            </button>
          ))}
          <button className="settings-shortcuts-link" onClick={openShortcuts}><Keyboard size={17} /><span>{t("General") === "通用" ? "快捷键" : "Keyboard shortcuts"}</span></button>
        </nav>
        <div className="settings-pages">
          <div className="settings-page" hidden={section !== "appearance"}>
            <section className="appearance-settings">
              <h3>{t("Appearance")}</h3>
              <div
                className="theme-options"
                role="group"
                aria-label={t("Color theme")}
              >
                {(
                  [
                    ["mono", "Black & white"],
                    ["forest", "Forest"],
                    ["ocean", "Ocean"],
                    ["plum", "Plum"],
                  ] as const
                ).map(([theme, label]) => (
                  <button
                    key={theme}
                    className="theme-option"
                    aria-pressed={draft.theme === theme}
                    onClick={() => setDraft({ ...draft, theme })}
                  >
                    <span className={`theme-swatch swatch-${theme}`} />
                    <span>{t(label)}</span>
                    {draft.theme === theme && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div
                className="appearance-modes"
                role="group"
                aria-label={t("Display mode")}
              >
                {(
                  [
                    ["light", "Light"],
                    ["dark", "Dark"],
                    ["system", "Follow system"],
                  ] as const
                ).map(([appearance, label]) => (
                  <button
                    key={appearance}
                    aria-pressed={draft.appearance === appearance}
                    onClick={() => setDraft({ ...draft, appearance })}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <p>{t("Preview instantly. Save to keep your choice.")}</p>
            </section>
          </div>
          <div className="settings-page" hidden={section !== "general"}>
            <h3>{t("General")}</h3>
            <div className="form-grid">
              <label>
                {t("Language")}
                <select
                  value={draft.language}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      language: e.target.value as Settings["language"],
                    })
                  }
                >
                  <option value="system">{t("System")}</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                {t("Time zone")}
                <input
                  placeholder={data.systemTimeZone}
                  value={draft.timeZone}
                  onChange={(e) =>
                    setDraft({ ...draft, timeZone: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              {t("Permission mode")}
              <select
                value={draft.permissionMode || "confirm"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    permissionMode: event.target
                      .value as Settings["permissionMode"],
                  })
                }
              >
                <option value="confirm">{t("Ask first")}</option>
                <option value="auto">{t("Auto apply")}</option>
              </select>
            </label>
            <p className="settings-help">
              {t(
                "Auto apply lets Telldo apply task and list changes without individual approval.",
              )}
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.closeToTray}
                onChange={(e) =>
                  setDraft({ ...draft, closeToTray: e.target.checked })
                }
              />
              {t("Close window to tray")}
            </label>
            <p className="settings-help">
              {t(
                "Reminders work while Telldo is running, including in the tray. They are not guaranteed after Quit.",
              )}
            </p>
          </div>
          <div className="settings-page" hidden={section !== "notifications"}>
            <NotificationSettings draft={draft} change={setDraft} isZh={t("General") === "通用"} />
          </div>
          <div className="settings-page" hidden={section !== "ai"}>
            <h3>{t("AI connection")}</h3>
            <label>
              {t("AI connection")}
              <select
                value={draft.aiTransport}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    aiTransport: e.target.value as Settings["aiTransport"],
                  })
                }
              >
                <option value="local">{t("This Mac / Local")}</option>
                <option value="ssh">{t("Remote computer over SSH")}</option>
              </select>
            </label>
            <p className="settings-ai-note">
              {t("AI changes follow your selected permission mode.")}
            </p>
            {draft.aiTransport === "local" ? (
              <label>
                {t("Codex executable")}
                <input
                  value={draft.codexPath}
                  placeholder="PATH / /absolute/path/to/codex"
                  onChange={(e) =>
                    setDraft({ ...draft, codexPath: e.target.value })
                  }
                />
              </label>
            ) : (
              <div className="ssh-settings">
                <div className="form-grid">
                  <label>
                    {t("SSH host")}
                    <input
                      value={draft.sshHost}
                      placeholder="198.51.100.10"
                      onChange={(e) =>
                        setDraft({ ...draft, sshHost: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("SSH port")}
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={draft.sshPort}
                      onChange={(e) =>
                        setDraft({ ...draft, sshPort: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <label>
                  {t("SSH user")}
                  <input
                    value={draft.sshUser}
                    placeholder="username"
                    onChange={(e) =>
                      setDraft({ ...draft, sshUser: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("Remote Codex path")}
                  <input
                    value={draft.sshCodexPath}
                    placeholder="/home/username/.local/bin/codex"
                    onChange={(e) =>
                      setDraft({ ...draft, sshCodexPath: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("Connection helper path")}
                  <input
                    value={draft.sshRunnerPath}
                    placeholder="/absolute/project/resources/ssh-codex-runner.py"
                    onChange={(e) =>
                      setDraft({ ...draft, sshRunnerPath: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("Remote proxy (optional)")}
                  <input
                    value={draft.sshProxyUrl}
                    placeholder="http://proxy:3128"
                    onChange={(e) =>
                      setDraft({ ...draft, sshProxyUrl: e.target.value })
                    }
                  />
                </label>
                <p className="notice">
                  {t(
                    "SSH uses your existing keys and known hosts. No password or token is stored in Telldo.",
                  )}
                </p>
              </div>
            )}
            <button
              className="secondary"
              onClick={() =>
                void act(async () => {
                  await api("settings", draft);
                  await api("probe");
                })
              }
            >
              {t("Detect Codex")}
            </button>
            <div className="capabilities">
              <strong>Codex {data.capabilities?.version}</strong>
              <p>{data.capabilities?.reason || data.capabilities?.isolation}</p>
              <p>{t("Read-only sandbox is not full tool isolation.")}</p>
              <p>
                {t(
                  "Install Codex and run codex login in a terminal, then detect again. Manual features remain available.",
                )}
              </p>
            </div>
          </div>
          <div className="settings-page" hidden={section !== "data"}>
            <h3>{t("Data management")}</h3>
            <div className="data-actions">
              {[
                ["backup", "Backup database"],
                ["export", "Export JSON"],
                ["import", "Import JSON"],
                ["openData", "Open data folder"],
              ].map(([method, label]) => (
                <button
                  className="secondary"
                  key={method}
                  onClick={() => void act(() => api(method), "Saved")}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="settings-help">
              {t(
                "Never synchronize the live SQLite database with a cloud drive. JSON import creates new IDs.",
              )}
            </p>
          </div>
        </div>
      </div>
      <div className="dialog-actions modal-footer">
        <button onClick={close}>{t("Cancel")}</button>
        <button
          data-shortcut-save
          className="primary"
          onClick={() =>
            void act(async () => {
              await api("settings", draft);
              close();
            }, "Saved")
          }
        >
          {t("Save settings")}
        </button>
      </div>
    </Modal>
  );
}
function ProposalDialog({
  proposal,
  tasks,
  lists,
  t,
  close,
  act,
  onApplied,
  aiBusy,
  isZh,
}: {
  proposal: Proposal;
  tasks: Task[];
  lists: Snapshot["lists"];
  t: (s: string) => string;
  close: () => void;
  act: (f: () => Promise<unknown>, m?: string) => Promise<void>;
  onApplied: (proposal: Proposal) => void;
  aiBusy: boolean;
  isZh: boolean;
}) {
  const [proposalFiles, setProposalFiles] = useState<
    Record<number, MemoAttachment[]>
  >({});
  useEffect(() => {
    void api<Record<number, MemoAttachment[]>>(
      "proposalAttachments",
      proposal.id,
    )
      .then(setProposalFiles)
      .catch(() => {});
  }, [proposal.id]);
  const [working, setWorking] = useState(false);
  const [operationError, setOperationError] = useState("");
  const fields: Record<string, string> = {
    title: t("Title"),
    notes: t("Notes"),
    list_id: t("List"),
    parent_id: t("Subtasks"),
    priority: t("Priority"),
    due_kind: t("Due date"),
    due_date: t("Due date"),
    due_at: t("Date & time"),
    time_zone: t("Time zone"),
    planned_date: t("Planned date"),
    reminder_at: t("Reminder"),
    tags: t("Tags"),
    status: t("To do"),
  };
  const labels: Record<string, string> = {
    create_list: t("Create list"),
    create_recurring: t("Create recurring task"),
    update_recurring: t("Edit recurring task"),
    create: t("Create task"),
    update: t("Update task"),
    complete: t("Mark complete"),
    uncomplete: t("Reopen task"),
    reschedule: t("Reschedule"),
    delete: t("Delete task"),
    add_subtask: t("Add subtask"),
    set_tags: t("Set tags"),
  };
  const statusLabels: Record<string, string> = {
    pending: t("Pending"),
    applied: t("Applied"),
    rejected: t("Rejected"),
    failed: t("Failed"),
    undone: t("Undone"),
  };
  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  const taskNames = new Map(tasks.map((task) => [task.id, task.title]));
  for (const action of proposal.actions) {
    if (action.type === "create_list")
      listNames.set(action.temp_id, action.patch.name);
    else if (action.temp_id && action.patch.title)
      taskNames.set(action.temp_id, action.patch.title);
  }
  async function execute(
    method: "applyProposal" | "rejectProposal" | "undoProposal",
  ) {
    if (working) return;
    setWorking(true);
    setOperationError("");
    let applied: Proposal | undefined;
    try {
      await act(
        async () => {
          try {
            const result = await api<Proposal>(method, proposal.id);
            if (method === "applyProposal") applied = result;
            close();
          } catch (error) {
            setOperationError(
              String(error)
                .replace(/^Error: /, "")
                .replace(
                  /^Error invoking remote method '[^']+': (?:Error: )?/,
                  "",
                ),
            );
            throw error;
          }
        },
        method === "applyProposal" ? "Applied" : "",
      );
      if (applied) onApplied(applied);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal
      className="proposal-review-dialog"
      labelledBy="proposal-review-title"
      close={close}
    >
      <div className="modal-heading">
        <h2 id="proposal-review-title">
          {t(
            proposal.status === "pending"
              ? "Changes to review"
              : "Change details",
          )}
        </h2>
        <button className="modal-close" aria-label={t("Close")} onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="proposal-review-body">
        <div className="proposal-review-summary">
          <span className={`proposal-status ${proposal.status}`}>
            {statusLabels[proposal.status]}
          </span>
          <p>{proposal.summary}</p>
        </div>
        <div className="proposal-change-list">
          {proposal.actions.map((action, index) => {
            if (action.type === "create_list")
              return (
                <section
                  className="proposal-change new-list-change"
                  key={index}
                >
                  <div
                    className="proposal-change-symbol"
                    style={
                      action.patch.color
                        ? { color: action.patch.color }
                        : undefined
                    }
                  >
                    <FolderPlus size={20} />
                  </div>
                  <div className="proposal-change-content">
                    <span className="proposal-action-label">
                      {labels[action.type]}
                    </span>
                    <h3>{action.patch.name}</h3>
                  </div>
                </section>
              );
            if (
              action.type === "create_recurring" ||
              action.type === "update_recurring"
            )
              return (
                <section
                  className="proposal-change recurring-change"
                  key={index}
                >
                  <div className="proposal-change-symbol">
                    <Repeat2 size={19} />
                  </div>
                  <div className="proposal-change-content">
                    <span className="proposal-action-label">
                      {labels[action.type]}
                    </span>
                    <h3>{action.patch.title}</h3>
                    <RecurringProposalDetails
                      action={action}
                      listName={
                        listNames.get(action.patch.list_id) || t("Unknown list")
                      }
                      isZh={isZh}
                    />
                  </div>
                </section>
              );
            const task = tasks.find((item) => item.id === action.target_id);
            const title = task?.title || action.patch.title || t("Task");
            const details = Object.entries(action.patch)
              .filter(([key, value]) => {
                if (key === "sort_order") return false;
                if (
                  (key === "due_kind" || key === "time_zone") &&
                  action.type === "create"
                )
                  return false;
                if (key === "title" && action.type === "create") return false;
                if (key === "due_date" && action.patch.due_at) return false;
                return (
                  action.type !== "create" ||
                  (value !== null &&
                    value !== "" &&
                    !(Array.isArray(value) && !value.length))
                );
              })
              .map(([key, value]) => {
                let display =
                  value === null
                    ? "—"
                    : Array.isArray(value)
                      ? value.join(", ") || "—"
                      : String(value);
                if (key === "list_id")
                  display = listNames.get(String(value)) || t("Unknown list");
                if (key === "parent_id" && value !== null)
                  display = taskNames.get(String(value)) || t("Task");
                if (
                  ["due_at", "reminder_at"].includes(key) &&
                  typeof value === "string"
                ) {
                  const date = DateTime.fromISO(value).setZone(
                    action.patch.time_zone ||
                      task?.time_zone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                  );
                  if (date.isValid) display = date.toFormat("yyyy-MM-dd HH:mm");
                }
                return (
                  <div key={key}>
                    <dt>{fields[key] || key}</dt>
                    <dd>{display}</dd>
                  </div>
                );
              });
            return (
              <section className="proposal-change" key={index}>
                <div className="proposal-change-symbol">
                  {action.type === "create" || action.type === "add_subtask" ? (
                    <Plus size={18} />
                  ) : action.type === "delete" ? (
                    <Trash2 size={17} />
                  ) : (
                    <ListChecks size={18} />
                  )}
                </div>
                <div className="proposal-change-content">
                  <span className="proposal-action-label">
                    {labels[action.type]}
                  </span>
                  <h3>{title}</h3>
                  {!!details.length && <dl>{details}</dl>}
                  {!!proposalFiles[index]?.length && (
                    <div className="proposal-attachments">
                      {proposalFiles[index].map((file) => (
                        <span key={file.id}>
                          {file.kind === "image" ? (
                            <img
                              src={`telldo-memo://attachment/${file.id}`}
                              alt=""
                            />
                          ) : (
                            <Paperclip size={14} />
                          )}
                          <span>{file.name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {action.type === "delete" &&
                    tasks.some(
                      (item) => item.parent_id === action.target_id,
                    ) && (
                      <p>
                        {t("Subtasks")}:{" "}
                        {tasks
                          .filter((item) => item.parent_id === action.target_id)
                          .map((item) => item.title)
                          .join(", ")}
                      </p>
                    )}
                </div>
              </section>
            );
          })}
        </div>
        {proposal.status === "pending" && (
          <p className="proposal-review-note">
            {t("These changes will be applied after your confirmation.")}
          </p>
        )}
        {operationError && (
          <div className="proposal-operation-error" role="alert">
            {operationError}
          </div>
        )}
      </div>
      <div className="dialog-actions modal-footer">
        <button disabled={working} onClick={close}>
          {t(proposal.status === "pending" ? "Not now" : "Back")}
        </button>
        {proposal.status === "pending" && (
          <>
            <button
              disabled={working}
              onClick={() => void execute("rejectProposal")}
            >
              {t("Dismiss proposal")}
            </button>
            <button
              className="primary"
              disabled={working || aiBusy}
              onClick={() => void execute("applyProposal")}
            >
              {working && <LoaderCircle size={14} className="spin" />}
              {t(
                proposal.actions.length === 1 &&
                  proposal.actions[0].type === "create_list"
                  ? "Confirm creation"
                  : "Apply changes",
              )}
            </button>
          </>
        )}
        {proposal.status === "applied" && (
          <button
            className="primary"
            disabled={working}
            onClick={() => void execute("undoProposal")}
          >
            {working && <LoaderCircle size={14} className="spin" />}
            {t("Undo")}
          </button>
        )}
      </div>
    </Modal>
  );
}
