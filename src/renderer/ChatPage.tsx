import "./chat-result-cards.css";
import { DateTime } from "luxon";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  Pause,
  ChevronDown,
  ShieldCheck,
  Zap,
  Circle,
  FileText,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Plus,
  FolderPlus,
  Repeat2,
  Trash2,
  Paperclip,
  NotebookPen,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ChatMessage, ChatSource } from "../shared/conversation";
import type { AIActivity } from "../shared/ai-progress";
import { activityPresentation } from "./activity-presentation";
import type { Proposal } from "../shared/types";

export interface DraftAttachment {
  id: string;
  name: string;
  bytes: number;
  kind: "image" | "file";
  previewUrl?: string;
  file?: globalThis.File;
}
export type { ConversationAttachment, ContentReference, ConversationMessage } from "../shared/chat-history";
import type { ConversationAttachment, ContentReference, ConversationMessage } from "../shared/chat-history";

function ReferenceChips({
  references,
  isZh,
  openMemo,
  removeReference,
  draft = false,
}: {
  references: ContentReference[];
  isZh: boolean;
  openMemo: (id: string) => void;
  removeReference?: (kind: ContentReference["kind"], id: string) => void;
  draft?: boolean;
}) {
  const text = (zh: string, en: string) => (isZh ? zh : en);
  return (
    <div className={draft ? "draft-references" : "conversation-references"}>
      {draft && (
        <span className="draft-references-label">
          {text("引用记录", "Referencing")}
        </span>
      )}
      <div
        className="content-reference-list"
        role="list"
        aria-label={text("引用的内容", "Referenced content")}
      >
        {references.map((reference) => {
          const title = reference.title || text("这条记录", "This record");
          const label =
            reference.kind === "task"
              ? text("待办", "Task")
              : text("记录", "Record");
          const contents = (
            <>
              {reference.kind === "task" ? (
                <ListChecks size={14} />
              ) : (
                <NotebookPen size={14} />
              )}
              <span className="content-reference-title" title={title}>
                {title}
              </span>
              {!!reference.attachmentCount && (
                <span
                  className="content-reference-count"
                  title={text(
                    `${reference.attachmentCount} 个附件`,
                    `${reference.attachmentCount} attachments`,
                  )}
                >
                  <Paperclip size={10} />
                  {reference.attachmentCount}
                </span>
              )}
            </>
          );
          return (
            <div
              key={`${reference.kind}:${reference.id}`}
              className="content-reference"
              role="listitem"
              data-reference-id={reference.id}
            >
              {reference.kind === "memo" ? (
                <button
                  type="button"
                  className="content-reference-main"
                  onClick={() => openMemo(reference.id)}
                  aria-label={text(
                    `查看引用${label}：${title}`,
                    `Open referenced ${label.toLowerCase()}: ${title}`,
                  )}
                >
                  {contents}
                </button>
              ) : (
                <span
                  className="content-reference-main"
                  aria-label={`${label}: ${title}`}
                >
                  {contents}
                </span>
              )}
              {removeReference && (
                <button
                  type="button"
                  className="content-reference-remove"
                  onClick={() => removeReference(reference.kind, reference.id)}
                  aria-label={text(
                    `移除引用 ${title}`,
                    `Remove reference ${title}`,
                  )}
                  title={text("移除引用", "Remove reference")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A deliberately small, text-only renderer. Model output never becomes HTML.
function inline(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
function ReplyText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="reply-prose">
      {lines.map((line, i) => {
        const heading = line.match(/^#{1,4}\s+(.+)/);
        const bullet = line.match(/^\s*(?:[-*•]|\d+[.)、])\s+(.+)/);
        if (!line.trim()) return <div className="reply-break" key={i} />;
        if (heading) return <h3 key={i}>{inline(heading[1])}</h3>;
        if (bullet)
          return (
            <div className="reply-list-item" key={i}>
              <span aria-hidden="true">·</span>
              <div>{inline(bullet[1])}</div>
            </div>
          );
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}

function changePresentation(type: string, isZh: boolean) {
  const labels: Record<string, [string, string]> = {
    create: ["创建待办", "Create task"], add_subtask: ["创建子任务", "Add subtask"],
    create_list: ["创建清单", "Create list"], create_recurring: ["创建重复待办", "Create recurring task"],
    update_recurring: ["调整重复待办", "Edit recurring task"], update: ["更新待办", "Update task"],
    complete: ["完成待办", "Mark complete"], uncomplete: ["恢复待办", "Reopen task"],
    reschedule: ["调整日期", "Reschedule"], delete: ["删除待办", "Delete task"], set_tags: ["更新标签", "Set tags"],
  };
  const Icon = type === "create" || type === "add_subtask" ? Plus
    : type === "create_list" ? FolderPlus
    : type.includes("recurring") ? Repeat2
    : type === "reschedule" ? CalendarDays
    : type === "complete" ? Check
    : type === "delete" ? Trash2 : ListChecks;
  return { Icon, label: (labels[type] || ["待办", "Task"])[isZh ? 0 : 1] };
}

function SourceCards({ sources, changes = [], isZh, openMemo, openTask }: {
  sources: ChatSource[];
  changes?: Proposal[];
  isZh: boolean;
  openMemo: (id: string) => void;
  openTask: (id: string) => void;
}) {
  const text = (zh: string, en: string) => isZh ? zh : en;
  const dateLabel = (source: ChatSource) => {
    const value = source.dueAt || source.dueDate || (source.kind === "memo" ? source.createdAt : undefined);
    if (!value) return "";
    const date = DateTime.fromISO(value, { zone: source.timeZone || "local" }).setLocale(isZh ? "zh-CN" : "en");
    return date.isValid ? date.toFormat(source.dueAt ? (isZh ? "M月d日 HH:mm" : "MMM d, HH:mm") : (isZh ? "yyyy年M月d日" : "MMM d, yyyy")) : "";
  };
  return <div className="chat-result-cards" aria-label={text("相关记录", "Related records")}>
    {sources.slice(0, 6).map(source => {
      const open = () => source.kind === "task" ? openTask(source.id) : openMemo(source.id);
      const action = source.kind === "task" ? changes.flatMap(proposal => proposal.actions).find(action =>
        action.target_id === source.id || ("title" in action.patch && action.patch.title === source.title)) : undefined;
      const presentation = action ? changePresentation(action.type, isZh) : {
        Icon: source.kind === "memo" ? NotebookPen : source.status === "done" ? Check : ListChecks,
        label: source.kind === "memo" ? text("资料", "Saved content") : source.status === "done" ? text("已完成", "Completed") : text("待办", "Task"),
      };
      const { Icon, label } = presentation;
      const date = dateLabel(source);
      const images = source.attachments?.filter(file => file.kind === "image").slice(0, 3) || [];
      const files = source.attachments?.filter(file => file.kind === "file").slice(0, 3) || [];
      return <div className="chat-result" key={`${source.kind}:${source.id}`} data-source-id={source.id}>
        <button className={`chat-result-card is-${source.kind}`} onClick={open}
          aria-label={text(`查看${source.kind === "task" ? "任务" : "资料"}：${source.title}`, `Open ${source.kind === "task" ? "task" : "record"}: ${source.title}`)}>
          <span className="chat-result-symbol" aria-hidden="true"><Icon size={19} strokeWidth={1.7} /></span>
          <span className="chat-result-content">
            {source.kind !== "task" && <span className="chat-result-caption">{label}</span>}
            <span className="chat-result-title">{source.title}</span>
            {(source.listName || date || source.text) && <span className="chat-result-fields">
              {source.listName && <span className="chat-result-field"><span>{text("清单", "List")}</span><span>{source.listName}</span></span>}
              {date && <span className="chat-result-field"><span>{source.kind === "task" ? text("截止", "Due") : text("保存时间", "Saved")}</span><span>{date}</span></span>}
              {source.text && <span className="chat-result-field"><span>{source.kind === "task" ? text("备注", "Notes") : text("内容", "Content")}</span><span className="chat-result-excerpt">{source.text}</span></span>}
            </span>}
            {!!images.length && <span className={`chat-result-images ${images.length === 1 ? "single" : ""}`}>
              {images.map(file => <img key={file.id} src={file.previewUrl || `telldo-memo://attachment/${file.id}`} alt={file.name} loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />)}
            </span>}
            {!!files.length && <span className="chat-result-files">{files.map(file => <span key={file.id}><Paperclip size={12} />{file.name}</span>)}</span>}
          </span>
        </button>

      </div>;
    })}
  </div>;
}

/** Changes with no returned record (for example list creation or deletion) keep a useful detail entry. */
function ChangeCards({ changes, isZh, review }: { changes: Proposal[]; isZh: boolean; review: (id: string) => void }) {
  return <div className="chat-result-cards">
    {changes.flatMap(proposal => proposal.actions.map((action, index) => {
      const { Icon, label } = changePresentation(action.type, isZh);
      const title = "name" in action.patch ? action.patch.name : "title" in action.patch && action.patch.title ? action.patch.title : proposal.summary;
      const notes = "notes" in action.patch ? action.patch.notes : undefined;
      return <div className="chat-result" key={`${proposal.id}:${index}`}>
        <button className="chat-result-card" onClick={() => review(proposal.id)}>
          <span className="chat-result-symbol" aria-hidden="true"><Icon size={19} /></span>
          <span className="chat-result-content"><span className="chat-result-caption">{label}</span><span className="chat-result-title">{title}</span>
            {notes && <span className="chat-result-fields"><span className="chat-result-field"><span>{isZh ? "备注" : "Notes"}</span><span className="chat-result-excerpt">{notes}</span></span></span>}
          </span>
        </button>
      </div>;
    }))}
  </div>;
}

function Execution({
  message,
  isZh,
}: {
  message: ConversationMessage;
  isZh: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const running = message.state === "working";
  const stopped = message.state === "cancelled";
  const failed = !!message.error || message.state === "error";
  // Keep public operations and replies; transport, model and validation are internal.
  const activities = (message.activities || []).filter(item => {
    const { kind } = activityPresentation(item);
    return item.phase !== "connection" && kind !== "model" && kind !== "validation";
  });
  const lastResponse = [...activities].reverse().find(item => item.phase === "response" && item.text);
  const current = [...activities].reverse().find(item => item.status === "running");
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const elapsed = message.finishedAt && message.startedAt
    ? Math.max(1, Math.round((message.finishedAt - message.startedAt) / 1000))
    : null;
  const duration = elapsed === null ? null : elapsed < 60
    ? text(`${elapsed} 秒`, `${elapsed}s`)
    : text(`${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`, `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  const heading = running
    ? (current?.phase === "response" ? text("正在处理", "Working") : current?.label) || text("正在处理", "Working")
    : stopped ? text("已停止", "Stopped")
    : failed ? text("未能完成", "Couldn't complete")
    : text("处理完成", "Completed");
  const isOpen = expanded ?? running;
  const summary = activities.reduce<ReturnType<typeof activityPresentation>[]>((items, item) => {
    const presentation = activityPresentation(item);
    if (!["model", "response", "validation", "context"].includes(presentation.kind)
      && !items.some(value => value.kind === presentation.kind)) items.push(presentation);
    return items;
  }, []).slice(0, 3);
  if (!activities.length && !running) return null;
  return (
    <div className={`execution ${running ? "is-running" : ""} ${failed ? "is-error" : ""}`}>
      <button
        type="button"
        className="execution-toggle"
        aria-expanded={isOpen}
        aria-controls={`execution-${message.id}`}
        onClick={() => setExpanded(!isOpen)}
      >
        <span className="execution-overview-icon" aria-hidden="true">
          {running ? <LoaderCircle size={15} className="spin" />
            : stopped ? <Pause size={14} />
            : failed ? <CircleAlert size={15} />
            : <CircleCheck size={15} />}
        </span>
        <span className="execution-heading">{heading}</span>
        {duration && <span className="execution-time">{duration}</span>}
        {!isOpen && summary.length > 0 && (
          <span className="execution-summary-icons" aria-hidden="true">
            {summary.map(({ kind, Icon }) => <Icon key={kind} size={13} strokeWidth={1.7} />)}
          </span>
        )}
        <ChevronRight size={12} className={isOpen ? "is-open" : ""} />
      </button>
      {isOpen && (
        <ol id={`execution-${message.id}`} className="execution-steps" aria-label={text("执行过程", "Activity") }>
          {activities.map(item => {
            const { kind, Icon } = activityPresentation(item);
            const active = running && item.status === "running" && item === current;
            const interrupted = !running && (stopped || failed) && item.status === "running";
            const reply = item.text && !(item === lastResponse && item.text.trim() === message.content.trim())
              ? item.text : null;
            if (item.phase === "response") {
              return reply ? (
                <li key={item.id} className="execution-public-reply">
                  <ReplyText text={reply} />
                </li>
              ) : null;
            }
            const search = /^search-\d+$/.test(item.id);
            const count = item.detail?.match(/(?:^| · )找到 (\d+) 条，返回/)?.[1]
              ?? item.detail?.match(/(?:^| · )(\d+) matches, \d+ returned/)?.[1];
            const searchLabel = active ? text("正在搜索", "Searching") : item.status === "completed"
              ? text("已搜索", "Searched") : text("搜索", "Search");
            return (
              <li key={item.id} className={`execution-step kind-${kind} ${active ? "is-active" : ""} ${reply ? "has-reply" : ""} ${interrupted ? "is-interrupted" : ""}`}>
                <span className="execution-step-icon" aria-hidden="true">
                  <Icon size={16} strokeWidth={1.65} />
                  {active && <span className="execution-active-dot" />}
                </span>
                <div className="execution-step-content">
                  {search ? (
                    <details className="execution-search-details">
                      <summary>
                        <span>{searchLabel}</span>
                        {item.status === "completed" && count !== undefined && (
                          <span className="execution-search-count"> · {text(`找到 ${count} 条`, `${count} found`)}</span>
                        )}
                        {interrupted && <span className="execution-step-state"> · {stopped ? text("已停止", "Stopped") : text("未完成", "Incomplete")}</span>}
                        <ChevronRight size={11} aria-hidden="true" />
                      </summary>
                      {item.detail && <p className="execution-step-detail">{item.detail}</p>}
                    </details>
                  ) : (
                    <>
                      <div className="execution-step-heading">
                        <span className="execution-step-label">{item.label}</span>
                        {active && <span className="execution-step-state">{text("进行中", "In progress")}</span>}
                        {interrupted && <span className="execution-step-state">{stopped ? text("已停止", "Stopped") : text("未完成", "Incomplete")}</span>}
                        {item.status === "completed" && <span className="execution-sr-only">{text("，已完成", ", completed")}</span>}
                      </div>
                      {item.detail && <p className="execution-step-detail">{item.detail}</p>}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export default function ChatPage({
  visible,
  messages,
  busy,
  cancelling,
  isZh,
  proposals,
  speech,
  setSpeech,
  inputRef,
  available,
  connectionReason,
  review,
  send,
  cancel,
  settings,
  openMemo,
  openTask,
  permissionMode,
  setPermissionMode,
  memoTitles,
  attachments,
  addFiles,
  removeAttachment,
  references,
  removeReference,
}: {
  visible: boolean;
  messages: ConversationMessage[];
  busy: boolean;
  cancelling: boolean;
  isZh: boolean;
  proposals: Proposal[];
  speech: string;
  setSpeech: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  available: boolean;
  connectionReason?: string;
  review: (id: string) => void;
  send: () => void;
  cancel: () => void;
  settings: () => void;
  openMemo: (id: string) => void;
  openTask: (id: string) => void;
  permissionMode: "confirm" | "auto";
  setPermissionMode: (mode: "confirm" | "auto") => void;
  memoTitles: Record<string, string>;
  attachments: DraftAttachment[];
  addFiles: (files: globalThis.File[]) => void;
  removeAttachment: (id: string) => void;
  references: ContentReference[];
  removeReference: (kind: ContentReference["kind"], id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ConversationAttachment | null>(null);
  const stickToBottom = useRef(true);
  const previousUser = useRef("");
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const empty = messages.length === 0;
  const hasDraft =
    !!speech.trim() || attachments.length > 0 || references.length > 0;
  useEffect(() => {
    if (!visible) {
      setDragging(false);
      dragDepth.current = 0;
      setPreview(null);
    }
  }, [visible]);
  useEffect(() => {
    if (!preview) return;
    const previous = document.activeElement as HTMLElement | null;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPreview(null);
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      previous?.isConnected && previous.focus();
    };
  }, [preview]);
  function selectFiles(files: globalThis.File[]) {
    if (!files.length) return;
    addFiles(files);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function displaySize(bytes?: number) {
    if (bytes === undefined) return "";
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  const unseenProposals = proposals.filter(
    (p) =>
      p.status === "pending" &&
      !messages.some(
        (m) => m.proposalId === p.id || m.appliedProposalIds?.includes(p.id),
      ),
  );
  useLayoutEffect(() => {
    if (!visible) return;
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [speech, inputRef, visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const lastUser = messages.filter((m) => m.role === "user").at(-1)?.id || "";
    if (lastUser !== previousUser.current) {
      stickToBottom.current = true;
      previousUser.current = lastUser;
    }
    if (stickToBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, visible]);
  useEffect(() => {
    if (!visible) return;
    const element = scroll.current;
    const body = element?.firstElementChild;
    if (!element || !body) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight;
      setAwayFromBottom(
        element.scrollHeight - element.scrollTop - element.clientHeight > 90,
      );
    });
    observer.observe(body);
    observer.observe(element);
    return () => observer.disconnect();
  }, [empty, visible]);
  function latest() {
    stickToBottom.current = true;
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "smooth",
    });
    setAwayFromBottom(false);
  }
  const lastReply = messages.filter((m) => m.role === "assistant").at(-1);
  const announcement = busy
    ? text("正在回复", "Responding")
    : lastReply?.error
      ? text("回复失败，可以重试", "Response failed. You can retry.")
      : lastReply?.state === "cancelled"
        ? text("已停止回复", "Response stopped")
        : lastReply
          ? text("回复已完成", "Response complete")
          : "";
  const examples = [
    {
      Icon: ListChecks,
      label: text("梳理待办", "Catch up"),
      prompt: text("还有哪些待办没完成？", "What tasks are still unfinished?"),
    },
    {
      Icon: CalendarDays,
      label: text("看看明天", "Look ahead"),
      prompt: text("明天有哪些安排？", "What's on my schedule tomorrow?"),
    },
    {
      Icon: Plus,
      label: text("记下一件事", "Make a plan"),
      prompt: text(
        "明天下午3点交周报",
        "Send the weekly update tomorrow at 3pm",
      ),
    },
  ];
  return (
    <section
      className={`chat-page ${empty ? "is-empty" : "has-messages"}`}
      aria-label={text("AI 对话", "AI conversation")}
    >
      <div
        className="chat-screen-reader-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
      <div
        className="chat-scroll"
        ref={scroll}
        onClickCapture={(event) => {
          if ((event.target as Element).closest(".execution-toggle"))
            stickToBottom.current = false;
        }}
        onScroll={() => {
          if (!visible) return;
          const element = scroll.current!;
          const distance =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          // A small upward scroll pauses following; the jump-to-latest control
          // appears only once the reader is meaningfully away from the end.
          stickToBottom.current = distance <= 6;
          setAwayFromBottom(distance > 90);
        }}
      >
        <div className="chat-thread">
          {unseenProposals.length > 0 && (
            <button
              className="chat-pending"
              onClick={() => review(unseenProposals[0].id)}
            >
              <ListChecks size={14} />
              {text(
                `${unseenProposals.length} 个提案等待确认`,
                `${unseenProposals.length} proposals to review`,
              )}
              <ArrowUpRight size={13} />
            </button>
          )}
          {empty ? (
            <div className="chat-welcome">
              <div className="welcome-symbol">
                <Sparkles size={26} strokeWidth={1.4} />
              </div>
              <h1>{text("今天，从哪里开始？", "Where shall we start?")}</h1>
              <p>
                {text(
                  "写下想法，或安排接下来的事。",
                  "Share a thought, or make a plan.",
                )}
              </p>
            </div>
          ) : (
            <div
              className="conversation-messages"
              role="log"
              aria-label={text("对话记录", "Conversation")}
              aria-live="off"
            >
              {messages.map((message) => {
                const proposalIds = Array.from(
                  new Set([
                    ...(message.appliedProposalIds || []),
                    ...(message.proposalId ? [message.proposalId] : []),
                  ]),
                );
                const appliedChanges = proposalIds.map(id => proposals.find(proposal => proposal.id === id))
                  .filter((proposal): proposal is Proposal => !!proposal && proposal.status === "applied");
                const legacyMemoIds = message.memoIds?.filter(
                  (id) =>
                    !message.sources?.some(
                      (source) => source.kind === "memo" && source.id === id,
                    ),
                );
                const attachments = !!message.attachments?.length && (
                      <div
                        className="conversation-attachments"
                        aria-label={text(
                          "这条消息的附件",
                          "Message attachments",
                        )}
                      >
                        {message.attachments.map((file) =>
                          file.kind === "image" && file.previewUrl ? (
                            <button
                              className="conversation-attachment-image"
                              key={file.id}
                              title={file.name}
                              onClick={() => setPreview(file)}
                              aria-label={text(
                                `预览 ${file.name}`,
                                `Preview ${file.name}`,
                              )}
                            >
                              <img src={file.previewUrl} alt={file.name} />
                              <span>{file.name}</span>
                            </button>
                          ) : (
                            <div
                              className="conversation-attachment-file"
                              key={file.id}
                            >
                              <FileText size={18} />
                              <span>
                                <strong>{file.name}</strong>
                                <small>{displaySize(file.bytes)}</small>
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    );
                return (
                  <article
                    key={message.id}
                    className={`conversation-message ${message.role} ${message.error ? "has-error" : ""}`}
                    aria-label={
                      message.role === "user" ? text("你", "You") : "Telldo"
                    }
                  >
                    {message.role === "assistant" && (
                      <Execution message={message} isZh={isZh} />
                    )}
                    {message.role === "user" && attachments}
                    {message.content &&
                      (message.role === "assistant" ? (
                        <ReplyText text={message.content} />
                      ) : (
                        <div className="user-message-text">
                          {message.content}
                        </div>
                      ))}
                    {!!message.references?.length && (
                      <ReferenceChips
                        references={message.references}
                        isZh={isZh}
                        openMemo={openMemo}
                      />
                    )}
                    {message.role !== "user" && attachments}
                    {message.state === "working" && !message.content && (
                      <div className="reply-waiting" role="status">
                        {text("正在为你整理…", "Putting it together…")}
                        <span aria-hidden="true"> ···</span>
                      </div>
                    )}
                    {!!message.sources?.length && (
                      <SourceCards
                        sources={message.sources}
                        changes={appliedChanges}
                        isZh={isZh}
                        openMemo={openMemo}
                        openTask={openTask}
                      />
                    )}
                    {!message.sources?.length && !!appliedChanges.length && <ChangeCards changes={appliedChanges} isZh={isZh} review={review} />}
                    {message.memoId &&
                      !message.sources?.some(
                        (source) =>
                          source.kind === "memo" &&
                          source.id === message.memoId,
                      ) && (
                        <button
                          className="conversation-memo-link"
                          onClick={() => openMemo(message.memoId!)}
                        >
                          <span className="memo-link-icon">
                            <NotebookPen size={18} />
                          </span>
                          <span>
                            <strong>
                              {text("已留下这份内容", "Saved for later")}
                            </strong>
                            <small>
                              {text(
                                "查看原文与附件",
                                "Open text and attachments",
                              )}
                            </small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      )}
                    {!!legacyMemoIds?.length && (
                      <div className="conversation-memo-sources">
                        {legacyMemoIds.map((id, i) => (
                          <button key={id} onClick={() => openMemo(id)}>
                            <NotebookPen size={12} />
                            {memoTitles[id] ||
                              text(`资料 ${i + 1}`, `Record ${i + 1}`)}
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                    {proposalIds.map((id) => {
                      const proposal = proposals.find((item) => item.id === id);
                      const status =
                        proposal?.status ||
                        (message.appliedProposalIds?.includes(id)
                          ? "applied"
                          : "pending");
                      if (status === "applied") return null;
                      return (
                        <button
                          key={id}
                          className={`conversation-proposal ${status}`}
                          onClick={() => review(id)}
                        >
                          <span className="proposal-icon">
                            <ListChecks size={18} />
                          </span>
                          <span>
                            <strong>
                              {status === "rejected"
                                  ? text("已取消提案", "Proposal dismissed")
                                  : status === "undone"
                                    ? text("已撤销更改", "Changes undone")
                                    : text("确认更改", "Review changes")}
                            </strong>
                            <small>
                              {status === "pending"
                                ? text(
                                    "查看具体更改，由你决定是否应用",
                                    "Review the changes before applying",
                                  )
                                : text("查看详情", "View details")}
                            </small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      );
                    })}
                    {message.notice && (
                      <p
                        className={`conversation-notice ${message.error ? "error-notice" : ""}`}
                      >
                        {message.notice}
                      </p>
                    )}
                    {message.error && (
                      <div className="chat-error-help">
                        {text(
                          "可以在输入框中修改后重试。",
                          "Edit your message below and try again.",
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="chat-compose-region">
        {awayFromBottom && !empty && (
          <button className="jump-to-latest" onClick={latest}>
            <ArrowDown size={13} />
            {text("回到最新", "Jump to latest")}
          </button>
        )}
        <div
          className={`conversation-composer ${dragging ? "is-dragging" : ""} ${attachments.length ? "has-attachments" : ""}`}
          id="ai-composer"
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={(event) => {
            if (
              event.dataTransfer.types.includes("Files") &&
              --dragDepth.current <= 0
            ) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              dragDepth.current = 0;
              setDragging(false);
              selectFiles(Array.from(event.dataTransfer.files));
            }
          }}
        >
          <input
            ref={fileInput}
            className="conversation-file-input"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              selectFiles(Array.from(event.target.files || []));
              event.target.value = "";
            }}
          />
          {!!references.length && (
            <ReferenceChips
              references={references}
              isZh={isZh}
              openMemo={openMemo}
              removeReference={removeReference}
              draft
            />
          )}
          {!!attachments.length && (
            <div
              className="draft-attachments"
              aria-label={text("待发送附件", "Attachments ready to send")}
            >
              {attachments.map((file) => (
                <div
                  key={file.id}
                  className={`draft-attachment ${file.kind === "image" && file.previewUrl ? "is-image" : "is-file"}`}
                >
                  {file.kind === "image" && file.previewUrl ? (
                    <button
                      className="draft-attachment-preview"
                      onClick={() => setPreview(file)}
                      title={text("预览图片", "Preview image")}
                    >
                      <img src={file.previewUrl} alt={file.name} />
                    </button>
                  ) : (
                    <div className="draft-attachment-symbol">
                      <FileText size={22} strokeWidth={1.5} />
                    </div>
                  )}
                  <div className="draft-attachment-label">
                    <strong title={file.name}>{file.name}</strong>
                    <small>{displaySize(file.bytes)}</small>
                  </div>
                  <button
                    className="draft-attachment-remove"
                    onClick={() => removeAttachment(file.id)}
                    aria-label={text(
                      `移除 ${file.name}`,
                      `Remove ${file.name}`,
                    )}
                    title={text("移除附件", "Remove attachment")}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={speech}
            rows={2}
            maxLength={4000}
            aria-label={text("告诉 Telldo", "Tell Telldo")}
            placeholder={text(
              references.length
                ? "围绕引用的内容，继续问问…"
                : attachments.length
                  ? "补充一点说明，和附件一起发送…"
                  : "问问待办，或说说你的想法…",
              references.length
                ? "Ask about the referenced content…"
                : attachments.length
                  ? "Add a little context for these attachments…"
                  : "Ask about your tasks, or share an idea…",
            )}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                selectFiles(files);
                const pastedText = event.clipboardData.getData("text/plain");
                if (pastedText)
                  setSpeech(speech ? `${speech}\n${pastedText}` : pastedText);
              }
            }}
            onChange={(e) => setSpeech(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (available && !busy && hasDraft) send();
              }
            }}
          />
          <div className="conversation-composer-controls">
            <div className="composer-left-tools">
              <button
                className="composer-attach"
                onClick={() => fileInput.current?.click()}
                aria-label={text("添加图片或文件", "Add images or files")}
                title={text(
                  "添加附件，和文字一起发送",
                  "Add attachments to your message",
                )}
              >
                <Paperclip size={16} />
              </button>
              {available ? (
                <span className="composer-provider">
                  <Sparkles size={13} />
                  Codex
                </span>
              ) : (
                <button
                  className="composer-connect"
                  onClick={settings}
                  title={connectionReason}
                >
                  {text("连接 Codex", "Connect Codex")}
                  <ArrowUpRight size={13} />
                </button>
              )}
              <label
                className={`composer-permission ${permissionMode === "auto" ? "is-auto" : ""}`}
                title={text("权限模式", "Permission mode")}
              >
                {permissionMode === "auto" ? (
                  <Zap size={12} />
                ) : (
                  <ShieldCheck size={13} />
                )}
                <select
                  aria-label={text("权限模式", "Permission mode")}
                  value={permissionMode}
                  disabled={busy}
                  onChange={(event) =>
                    setPermissionMode(event.target.value as "confirm" | "auto")
                  }
                >
                  <option value="confirm">
                    {text("逐项确认", "Ask first")}
                  </option>
                  <option value="auto">{text("自动执行", "Auto apply")}</option>
                </select>
                <ChevronDown size={11} />
              </label>
            </div>
            <div className="composer-send-controls">
              <span className="composer-key-hint">
                {busy
                  ? text("可以继续起草", "Keep drafting")
                  : text("⇧ ↵ 换行", "⇧ ↵ New line")}
              </span>
              {busy ? (
                <button
                  className="conversation-send stop"
                  disabled={cancelling}
                  onClick={cancel}
                  aria-label={text("停止回复", "Stop response")}
                  title={text("停止回复", "Stop response")}
                >
                  {cancelling ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Square size={13} fill="currentColor" />
                  )}
                </button>
              ) : (
                <button
                  className="conversation-send"
                  disabled={!available || !hasDraft}
                  onClick={send}
                  aria-label={text("发送消息", "Send message")}
                  title={text("发送 · Enter", "Send · Enter")}
                >
                  <ArrowUp size={19} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {dragging && (
            <div className="composer-drop-hint" aria-hidden="true">
              <ImageIcon size={22} strokeWidth={1.4} />
              <span>
                {text("松开，加入这条消息", "Drop into this message")}
              </span>
            </div>
          )}
        </div>
        {!!attachments.length && (
          <div className="draft-attachments-note">
            {text(
              "附件会和文字一起交给 AI，发送前可以继续补充。",
              "Text and attachments go to AI together. Keep adding context before you send.",
            )}
          </div>
        )}
        {empty && !references.length && (
          <div className="chat-suggestions">
            {examples.map(({ Icon, label, prompt }) => (
              <button
                key={label}
                onClick={() => {
                  setSpeech(prompt);
                  inputRef.current?.focus();
                }}
              >
                <Icon size={15} />
                <span>{label}</span>
                <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        )}

      </div>
      {visible && preview?.previewUrl && (
        <div
          className="overlay conversation-image-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <div
            className="conversation-image-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={text("图片预览", "Image preview")}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                event.currentTarget
                  .querySelector<HTMLButtonElement>("button")
                  ?.focus();
              }
            }}
          >
            <div>
              <span>{preview.name}</span>
              <button
                autoFocus
                onClick={() => setPreview(null)}
                aria-label={text("关闭预览", "Close preview")}
              >
                <X size={18} />
              </button>
            </div>
            <img src={preview.previewUrl} alt={preview.name} />
          </div>
        </div>
      )}
    </section>
  );
}
