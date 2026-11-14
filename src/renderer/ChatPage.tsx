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
  ListChecks,
  LoaderCircle,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ChatMessage } from "../shared/conversation";
import type { AIActivity } from "../shared/ai-progress";
import type { Proposal } from "../shared/types";

export interface ConversationMessage extends ChatMessage {
  turnId?: string;
  notice?: string;
  activities?: AIActivity[];
  state?: "working" | "completed" | "cancelled" | "error";
  startedAt?: number;
  finishedAt?: number;
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
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousUser = useRef("");
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const empty = messages.length === 0;
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
                  "问问待办，或一起安排接下来的事。",
                  "Catch up on your tasks. Make room for what's next.",
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
                    {message.state === "working" && !message.content && (
                      <div className="reply-waiting" role="status">
                        {text("正在为你整理…", "Putting it together…")}
                        <span aria-hidden="true"> ···</span>
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
                              ? text("已应用到任务", "Changes applied")
                              : status === "rejected"
                                ? text("已取消提案", "Proposal dismissed")
                                : status === "undone"
                                  ? text("已撤销更改", "Changes undone")
                                  : text("确认任务更改", "Review task changes")}
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
        <div className="conversation-composer" id="ai-composer">
          <textarea
            ref={inputRef}
            value={speech}
            rows={2}
            maxLength={4000}
            aria-label={text("告诉 Telldo", "Tell Telldo")}
            placeholder={text(
              "问问待办，或说说你的想法…",
              "Ask about your tasks, or share an idea…",
            )}
            onChange={(e) => setSpeech(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (available && !busy && speech.trim()) send();
              }
            }}
          />
          <div className="conversation-composer-controls">
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
                  disabled={!available || !speech.trim()}
                  onClick={send}
                  aria-label={text("发送消息", "Send message")}
                  title={text("发送 · Enter", "Send · Enter")}
                >
                  <ArrowUp size={19} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </div>
        {empty && (
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
    </section>
  );
}
