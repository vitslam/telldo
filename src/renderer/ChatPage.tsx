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
  Circle,
  FileText,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Plus,
  Paperclip,
  NotebookPen,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ChatMessage } from "../shared/conversation";
import type { AIActivity } from "../shared/ai-progress";
import type { Proposal } from "../shared/types";

export interface DraftAttachment {
  id: string;
  name: string;
  bytes: number;
  kind: "image" | "file";
  previewUrl?: string;
  file?: globalThis.File;
}
export interface ConversationAttachment {
  id: string;
  name: string;
  bytes?: number;
  kind: "image" | "file";
  previewUrl?: string;
}
/** The ID binds the source; the title is display text only. */
export interface ContentReference {
  kind: "memo" | "task";
  id: string;
  title: string;
  attachmentCount?: number;
}
export interface ConversationMessage extends ChatMessage {
  attachments?: ConversationAttachment[];
  references?: ContentReference[];
  turnId?: string;
  notice?: string;
  activities?: AIActivity[];
  state?: "working" | "completed" | "cancelled" | "error";
  startedAt?: number;
  finishedAt?: number;
}

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

function Execution({
  message,
  isZh,
}: {
  message: ConversationMessage;
  isZh: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const running = message.state === "working";
  const activities = message.activities || [];
  const current = [...activities]
    .reverse()
    .find((item) => item.status === "running");
  const elapsed =
    message.finishedAt && message.startedAt
      ? Math.max(1, Math.round((message.finishedAt - message.startedAt) / 1000))
      : null;
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const heading = running
    ? current?.label || text("正在准备", "Preparing")
    : message.state === "cancelled"
      ? text("已停止", "Stopped")
      : message.error
        ? text("未能完成", "Couldn't complete")
        : text("处理完成", "Completed");
  const isOpen = expanded ?? running;
  if (!activities.length && !running) return null;
  return (
    <div className={`execution ${running ? "is-running" : ""}`}>
      <button
        className="execution-toggle"
        aria-expanded={isOpen}
        aria-controls={`execution-${message.id}`}
        onClick={() => setExpanded(!isOpen)}
      >
        {running ? (
          <LoaderCircle size={13} className="spin" />
        ) : message.error ? (
          <X size={13} />
        ) : message.state === "cancelled" ? (
          <Square size={11} />
        ) : (
          <Check size={13} />
        )}
        <span>{heading}</span>
        {elapsed && (
          <span className="execution-time">
            {elapsed}
            {text(" 秒", "s")}
          </span>
        )}
        <ChevronRight size={12} className={isOpen ? "is-open" : ""} />
      </button>
      {isOpen && (
        <ol id={`execution-${message.id}`} className="execution-steps">
          {activities.map((item) => (
            <li key={item.id} className={item.status}>
              {item.status === "completed" ? (
                <Check size={12} />
              ) : running ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <Circle size={10} />
              )}
              <div>
                <span>{item.label}</span>
                {item.detail && <p>{item.detail}</p>}
              </div>
            </li>
          ))}
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
      p.status === "pending" && !messages.some((m) => m.proposalId === p.id),
  );
  useLayoutEffect(() => {
    if (!visible) return;
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [speech, inputRef, visible]);
  useEffect(() => {
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
          const away =
            element.scrollHeight - element.scrollTop - element.clientHeight >
            90;
          stickToBottom.current = !away;
          setAwayFromBottom(away);
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
                const proposal = proposals.find(
                  (p) => p.id === message.proposalId,
                );
                const status = proposal?.status;
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
                    {!!message.attachments?.length && (
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
                    )}
                    {message.state === "working" && !message.content && (
                      <div className="reply-waiting" role="status">
                        {text("正在为你整理…", "Putting it together…")}
                        <span aria-hidden="true"> ···</span>
                      </div>
                    )}
                    {message.memoId && (
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
                    {!!message.memoIds?.length && (
                      <div className="conversation-memo-sources">
                        {message.memoIds.map((id, i) => (
                          <button key={id} onClick={() => openMemo(id)}>
                            <NotebookPen size={12} />
                            {memoTitles[id] ||
                              text(`资料 ${i + 1}`, `Record ${i + 1}`)}
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                    {message.proposalId && (
                      <button
                        className={`conversation-proposal ${status || "pending"}`}
                        onClick={() => review(message.proposalId!)}
                      >
                        <span className="proposal-icon">
                          {status === "applied" ? (
                            <Check size={18} />
                          ) : (
                            <ListChecks size={18} />
                          )}
                        </span>
                        <span>
                          <strong>
                            {status === "applied"
                              ? text("更改已应用", "Changes applied")
                              : status === "rejected"
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
                    )}
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
        {!empty && (
          <div className="conversation-footnote">
            {text(
              "询问即回答，更改由你确认。",
              "Answers right away. Changes with your approval.",
            )}
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
