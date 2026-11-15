import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  File,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  MoreHorizontal,
  NotebookPen,
  MessageSquare,
  List as ListIcon,
  Circle,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import type { Task } from "../shared/types";
import type { Memo, MemoAttachment } from "../shared/memo";
import DetailCardModal from "./DetailCardModal";
import "./memo.css";

const invoke = <T,>(method: string, ...args: unknown[]) =>
  window.telldo.invoke<T>(method, ...args);
const message = (error: unknown) =>
  String(error)
    .replace(/^Error: /, "")
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
const attachmentUrl = (file: MemoAttachment) =>
  file.previewUrl || `telldo-memo://attachment/${encodeURIComponent(file.id)}`;
function size(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
function taskSuggestionLabel(memo: Memo, isZh: boolean) {
  const labels: Record<string, [string, string]> = {
    pending: ["发现可安排的事", "Something to plan"],
    applied: ["已安排为待办", "Added to your tasks"],
    rejected: ["已取消安排", "Plan dismissed"],
    undone: ["安排已撤销", "Plan undone"],
    failed: ["安排未完成", "Plan couldn't be applied"],
  };
  const label = labels[memo.proposal_status || "pending"] || labels.pending;
  return label[isZh ? 0 : 1];
}
function taskSuggestionAction(memo: Memo, isZh: boolean) {
  return !memo.proposal_status || memo.proposal_status === "pending"
    ? isZh
      ? "查看提案"
      : "Review proposal"
    : isZh
      ? "查看详情"
      : "View details";
}
type Filter = "all" | "tasks" | "text" | "image" | "file";
export interface MemoListOption {
  id: string;
  name: string;
}

function AttachmentTile({
  file,
  compact = false,
  onOpen,
}: {
  file: MemoAttachment;
  compact?: boolean;
  onOpen: (file: MemoAttachment) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (file.kind === "image" && !failed)
    return (
      <button
        className={`memo-image ${compact ? "compact" : ""}`}
        onClick={() => onOpen(file)}
        title={file.name}
        aria-label={file.name}
      >
        <img
          src={attachmentUrl(file)}
          alt={file.name}
          loading="lazy"
          onError={() => setFailed(true)}
        />
        <span>
          <ImageIcon size={12} />
          {file.name}
        </span>
      </button>
    );
  const ext = file.name.includes(".")
    ? file.name.split(".").at(-1)!.slice(0, 6).toUpperCase()
    : "FILE";
  return (
    <button
      className={`memo-file-tile ${compact ? "compact" : ""}`}
      onClick={() => onOpen(file)}
      title={file.name}
    >
      <span className="memo-file-symbol">
        <FileText size={19} strokeWidth={1.5} />
        <small>{ext}</small>
      </span>
      <span className="memo-file-info">
        <strong>{file.name}</strong>
        <small>{size(file.bytes)}</small>
      </span>
      <ArrowUpRight size={14} />
    </button>
  );
}

function MemoDetail({
  memo,
  isZh,
  zone,
  close,
  saved,
  deleted,
  review,
  ask,
}: {
  memo: Memo;
  isZh: boolean;
  zone: string;
  close: () => void;
  saved: (memo: Memo) => void;
  deleted: () => void;
  review?: (id: string) => void;
  ask?: (memo: Memo) => void;
}) {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [title, setTitle] = useState(memo.title);
  const [body, setBody] = useState(memo.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const userEdited = useRef(false);
  const dirty = title !== memo.title || body !== memo.body;
  useEffect(() => {
    if (!userEdited.current) {
      setTitle(memo.title);
      setBody(memo.body);
    }
  }, [memo.title, memo.body]);
  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError("");
    try {
      saved(
        await invoke<Memo>("memoUpdate", memo.id, memo.version, {
          title: title.trim(),
          body,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function dismiss() {
    if (busy) return;
    if (confirmDelete) setConfirmDelete(false);
    else close();
  }
  async function open(file: MemoAttachment) {
    try {
      await invoke("memoOpen", file.id);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <DetailCardModal
      className="memo-detail"
      labelledBy="memo-detail-heading"
      close={dismiss}
    >
      <div
        className="memo-detail-layout"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
      >
        <header className="memo-detail-header">
          <span id="memo-detail-heading">
            <NotebookPen size={15} />
            {t("内容详情", "Content details")}
          </span>
          <button
            aria-label={t("关闭", "Close")}
            title={t("关闭 · Esc", "Close · Esc")}
            disabled={busy}
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </header>
        <div className="memo-detail-scroll">
          <input
            id="memo-detail-title"
            className="memo-detail-title"
            maxLength={200}
            aria-label={t("标题", "Title")}
            placeholder={t("无标题备忘录", "Untitled memo")}
            value={title}
            onChange={(e) => {
              userEdited.current = true;
              setTitle(e.target.value);
            }}
          />
          <div className="memo-detail-date">
            <time dateTime={memo.created_at}>
              {DateTime.fromISO(memo.created_at)
                .setZone(zone)
                .setLocale(isZh ? "zh-CN" : "en")
                .toFormat(
                  isZh ? "yyyy年M月d日 · HH:mm" : "MMMM d, yyyy · HH:mm",
                )}
            </time>
            {!!memo.attachments.length && (
              <span>
                {t(
                  `${memo.attachments.length} 个附件`,
                  `${memo.attachments.length} attachment${memo.attachments.length === 1 ? "" : "s"}`,
                )}
              </span>
            )}
          </div>
          <textarea
            className={`memo-detail-body ${!body && memo.attachments.length ? "is-empty" : ""}`}
            aria-label={t("正文", "Memo text")}
            placeholder={t("为这份内容写一点备注…", "Add a little context…")}
            value={body}
            maxLength={100000}
            onChange={(e) => {
              userEdited.current = true;
              setBody(e.target.value);
            }}
          />
          {!memo.body && memo.summary && (
            <p className="memo-attachment-summary">{memo.summary}</p>
          )}
          {!!memo.attachments.length && (
            <section
              className="memo-detail-attachments"
              aria-label={t("附件", "Attachments")}
            >
              <div className="memo-detail-section-label">
                {t("附件", "Attachments")}
              </div>
              {memo.attachments.map((file) => (
                <AttachmentTile file={file} key={file.id} onOpen={open} />
              ))}
            </section>
          )}
          {!memo.body && memo.extracted_text && (
            <details className="memo-extracted-text">
              <summary>
                {t("查看文本内容", "View text content")}
                <ChevronRight size={12} />
              </summary>
              <pre>{memo.extracted_text}</pre>
            </details>
          )}
          {memo.analysis_state === "task" && memo.proposal_id && review && (
            <button
              className="memo-detail-suggestion"
              onClick={() => review(memo.proposal_id!)}
            >
              <Sparkles size={15} />
              <span>{taskSuggestionLabel(memo, isZh)}</span>
              {taskSuggestionAction(memo, isZh)}
              <ArrowUpRight size={13} />
            </button>
          )}
          {error && (
            <div className="memo-error" role="alert">
              {error}
            </div>
          )}
          {confirmDelete && (
            <div className="memo-delete-confirm" role="alert">
              <span>
                {t(
                  "删除这条记录及其附件？",
                  "Delete this record and its attachments?",
                )}
              </span>
              <div>
                <button onClick={() => setConfirmDelete(false)}>
                  {t("保留", "Keep")}
                </button>
                <button
                  disabled={busy}
                  className="memo-delete-action"
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await invoke("memoDelete", memo.id, memo.version);
                      deleted();
                    } catch (e) {
                      setError(message(e));
                      setBusy(false);
                    }
                  }}
                >
                  {t("删除", "Delete")}
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="memo-detail-footer">
          <button
            className="memo-delete-button"
            disabled={busy}
            aria-label={t("删除记录", "Delete record")}
            title={t("删除记录", "Delete record")}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={16} />
          </button>
          <div>
            {ask && (
              <button
                className="memo-ask"
                disabled={busy || dirty}
                onClick={() => {
                  close();
                  ask(memo);
                }}
                title={
                  dirty ? t("先保存更改", "Save your changes first") : undefined
                }
              >
                <Sparkles size={14} />
                {t("问问 Telldo", "Ask Telldo")}
              </button>
            )}
            <button
              className="memo-detail-save"
              disabled={busy || (dirty && !title.trim())}
              onClick={() => (dirty ? void save() : dismiss())}
            >
              {busy ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Check size={14} />
              )}
              {dirty ? t("保存更改", "Save changes") : t("完成", "Done")}
            </button>
          </div>
        </footer>
      </div>
    </DetailCardModal>
  );
}

type TimelineEntry =
  | {
      kind: "memo";
      id: string;
      at: string;
      memo: Memo;
      attachments: MemoAttachment[];
    }
  | {
      kind: "task";
      id: string;
      at: string;
      task: Task;
      attachments: MemoAttachment[];
    };

export default function MemoPage({
  isZh,
  zone,
  visible = true,
  onReviewProposal,
  onAskMemo,
  selectedMemoId,
  onSelectMemo,
  lists = [],
  onCompose,
  completedTasks = [],
  allTasks = completedTasks,
  taskAttachments = {},
  onOpenTask,
}: {
  isZh: boolean;
  zone: string;
  visible?: boolean;
  onReviewProposal?: (id: string) => void;
  onAskMemo?: (memo: Memo) => void;
  selectedMemoId?: string | null;
  onSelectMemo?: (id: string | null) => void;
  lists?: MemoListOption[];
  onCompose?: () => void;
  completedTasks?: Task[];
  allTasks?: Task[];
  taskAttachments?: Record<string, MemoAttachment[]>;
  onOpenTask?: (id: string) => void;
}) {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"review" | "all">("review");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  const detail = memos.find((memo) => memo.id === selected);
  async function load() {
    const current = ++generation.current;
    const items = await invoke<Memo[]>("memoList");
    if (current === generation.current) {
      setMemos(items);
      setLoading(false);
    }
  }
  useEffect(() => {
    void load().catch((e) => {
      setError(message(e));
      setLoading(false);
    });
    return window.telldo.onEvent((event) => {
      if (event.type === "memo-changed")
        void load().catch((e) => setError(message(e)));
    });
  }, []);
  useEffect(() => {
    if (selectedMemoId) {
      setSelected(selectedMemoId);
      void load().catch((e) => setError(message(e)));
    }
  }, [selectedMemoId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const taskRecords = scope === "review" ? completedTasks : allTasks;
  const records: TimelineEntry[] = [
    ...memos
      .filter(
        (memo) =>
          !memo.task_ids?.some((id) =>
            allTasks.some((task) => task.id === id),
          ) &&
          !(memo.capture_kind === "task" && memo.proposal_status === "pending"),
      )
      .map((memo) => ({
        kind: "memo" as const,
        id: memo.id,
        at: memo.created_at,
        memo,
        attachments: memo.attachments,
      })),
    ...taskRecords.map((task) => ({
      kind: "task" as const,
      id: `${task.id}:${task.completed_at || task.created_at}`,
      at:
        task.status === "done"
          ? task.completed_at || task.updated_at
          : task.created_at,
      task,
      attachments: taskAttachments[task.id] || [],
    })),
  ];
  const query = search.toLocaleLowerCase().trim();
  const filtered = records
    .filter((record) => {
      if (filter === "tasks" && record.kind !== "task") return false;
      if (
        filter === "text" &&
        (record.kind !== "memo" || record.attachments.length)
      )
        return false;
      if (
        (filter === "image" || filter === "file") &&
        !record.attachments.some((file) => file.kind === filter)
      )
        return false;
      const content =
        record.kind === "memo"
          ? `${record.memo.title} ${record.memo.body} ${record.memo.summary} ${record.memo.extracted_text}`
          : `${record.task.title} ${record.task.notes} ${record.task.tags.join(" ")} ${lists.find((list) => list.id === record.task.list_id)?.name || ""}`;
      return (
        !query ||
        `${content} ${record.attachments.map((file) => file.name).join(" ")}`
          .toLocaleLowerCase()
          .includes(query)
      );
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const grouped = new Map<string, TimelineEntry[]>();
  for (const record of filtered) {
    const date = DateTime.fromISO(record.at).setZone(zone).toISODate() || "";
    grouped.set(date, [...(grouped.get(date) || []), record]);
  }
  const today = DateTime.now().setZone(zone).toISODate();
  const yesterday = DateTime.now().setZone(zone).minus({ days: 1 }).toISODate();
  function dayLabel(day: string) {
    return day === today
      ? t("今天", "Today")
      : day === yesterday
        ? t("昨天", "Yesterday")
        : DateTime.fromISO(day)
            .setLocale(isZh ? "zh-CN" : "en")
            .toFormat(
              day.startsWith(String(DateTime.now().setZone(zone).year))
                ? isZh
                  ? "M月d日 · cccc"
                  : "MMMM d · cccc"
                : isZh
                  ? "yyyy年M月d日"
                  : "MMMM d, yyyy",
            );
  }
  function openMemo(id: string) {
    setSelected(id);
    onSelectMemo?.(id);
  }
  function close() {
    setSelected(null);
    onSelectMemo?.(null);
  }
  function renderAttachments(record: TimelineEntry) {
    const images = record.attachments.filter((file) => file.kind === "image");
    const files = record.attachments.filter((file) => file.kind !== "image");
    const openRecord = () =>
      record.kind === "memo"
        ? openMemo(record.memo.id)
        : onOpenTask?.(record.task.id);
    return (
      <>
        {!!images.length && (
          <div className={`memo-images count-${Math.min(images.length, 3)}`}>
            {images.slice(0, 3).map((file) => (
              <div key={file.id}>
                <AttachmentTile file={file} compact onOpen={openRecord} />
              </div>
            ))}
            {images.length > 3 && (
              <button className="memo-more-images" onClick={openRecord}>
                +{images.length - 3}
              </button>
            )}
          </div>
        )}
        {!!files.length && (
          <div className="memo-entry-files">
            {files.slice(0, 2).map((file) => (
              <AttachmentTile
                file={file}
                compact
                key={file.id}
                onOpen={openRecord}
              />
            ))}
            {files.length > 2 && (
              <button className="memo-files-more" onClick={openRecord}>
                {t(
                  `还有 ${files.length - 2} 个文件`,
                  `${files.length - 2} more files`,
                )}
                <ChevronRight size={12} />
              </button>
            )}
          </div>
        )}
      </>
    );
  }
  return (
    <section
      className="memo-page memo-timeline-page"
      aria-label={t("时间线", "Timeline")}
    >
      <div className="memo-workspace">
        <header className="memo-page-heading">
          <div>
            <div className="memo-eyebrow">
              {t(
                "每一件完成的事，都有迹可循",
                "A LITTLE HISTORY OF GETTING THERE",
              )}
            </div>
            <h1>{t("时间线", "Timeline")}</h1>
            <p>
              {t(
                "回看已经完成的事，也找回留下的内容。",
                "Look back on what you've done, and what you've kept.",
              )}
            </p>
          </div>
          {onCompose && (
            <button className="memo-return-chat" onClick={onCompose}>
              <MessageSquare size={15} />
              {t("回到对话", "Back to conversation")}
              <ArrowUpRight size={13} />
            </button>
          )}
        </header>
        <div
          className="timeline-scope"
          role="group"
          aria-label={t("时间线范围", "Timeline scope")}
        >
          <button
            aria-pressed={scope === "review"}
            onClick={() => setScope("review")}
          >
            {t("已完成与资料", "Completed & collected")}
          </button>
          <button
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            {t("全部记录", "All records")}
          </button>
        </div>
        {error && (
          <div className="memo-page-error memo-error" role="alert">
            <span>{error}</span>
            <button
              onClick={() => setError("")}
              aria-label={t("关闭", "Dismiss")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="memo-collection-bar">
          <div
            className="memo-filters"
            aria-label={t("内容类型", "Content type")}
          >
            {(
              [
                ["all", t("全部", "All")],
                ["tasks", t("待办", "Tasks")],
                ["text", t("文字", "Text")],
                ["image", t("图片", "Images")],
                ["file", t("文件", "Files")],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="memo-search">
            <Search size={14} />
            <input
              className="memo-search-input"
              aria-label={t("搜索记录", "Search records")}
              placeholder={t(
                "搜索做过的事与留下的内容",
                "Search tasks and collected content",
              )}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button
                aria-label={t("清除搜索", "Clear search")}
                onClick={() => setSearch("")}
              >
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        {loading ? (
          <div className="memo-loading">
            <LoaderCircle className="spin" size={19} />
          </div>
        ) : !filtered.length ? (
          <div className="memo-empty">
            <div className="memo-empty-symbol">
              {filter === "tasks" ? (
                <CheckCheck size={24} strokeWidth={1.4} />
              ) : (
                <NotebookPen size={24} strokeWidth={1.4} />
              )}
            </div>
            <h2>
              {query || filter !== "all"
                ? t("还没找到这条记录", "Nothing found just yet")
                : t("完成的事，都留在这里。", "A place for what you've done.")}
            </h2>
            <p>
              {query || filter !== "all"
                ? t(
                    "试试其他关键词，或查看全部内容。",
                    "Try another search, or look through everything.",
                  )
                : t(
                    "完成一件待办，留下的一段文字或一张图片。\n以后想起时，都能沿着时间找回来。",
                    "A task completed. A thought or an image kept.\nFind them here when you want to look back.",
                  )}
            </p>
            {query || filter !== "all" ? (
              <button
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                {t("查看全部", "View all")}
                <ChevronRight size={13} />
              </button>
            ) : (
              onCompose && (
                <button onClick={onCompose}>
                  {t("到对话中记录", "Start in conversation")}
                  <ArrowUpRight size={13} />
                </button>
              )
            )}
          </div>
        ) : (
          <div className="memo-timeline">
            {[...grouped].map(([day, items]) => (
              <section
                className="memo-day"
                key={day}
                aria-label={dayLabel(day)}
              >
                <h2>
                  <span>{dayLabel(day)}</span>
                  <small>{items.length}</small>
                </h2>
                <div className="memo-day-items">
                  {items.map((record) => (
                    <article
                      className={`memo-entry ${record.kind === "task" ? "timeline-task" : ""}`}
                      key={`${record.kind}:${record.id}`}
                    >
                      <div className="memo-time">
                        <time dateTime={record.at}>
                          {DateTime.fromISO(record.at)
                            .setZone(zone)
                            .toFormat("HH:mm")}
                        </time>
                        <span />
                      </div>
                      <div
                        className="memo-entry-card"
                        onClick={(event) => {
                          if ((event.target as Element).closest("button, a"))
                            return;
                          if (record.kind === "memo") openMemo(record.memo.id);
                          else onOpenTask?.(record.task.id);
                        }}
                      >
                        {record.kind === "task" ? (
                          <>
                            <button
                              className={`timeline-task-copy ${record.task.status === "done" ? "is-complete" : ""}`}
                              onClick={() => onOpenTask?.(record.task.id)}
                              aria-label={t(
                                `查看 ${record.task.title}`,
                                `Open ${record.task.title}`,
                              )}
                            >
                              <span className="timeline-task-check">
                                {record.task.status === "done" ? (
                                  <Check size={16} />
                                ) : (
                                  <Circle size={16} />
                                )}
                              </span>
                              <span>
                                <h3>{record.task.title}</h3>
                                {record.task.notes && (
                                  <p>{record.task.notes}</p>
                                )}
                              </span>
                              <ArrowUpRight size={14} />
                            </button>
                            {renderAttachments(record)}
                            <div className="memo-entry-footer">
                              <span
                                className={`timeline-task-status ${record.task.status === "done" ? "done" : ""}`}
                              >
                                {record.task.status === "done" ? (
                                  <CheckCheck size={12} />
                                ) : (
                                  <Circle size={11} />
                                )}{" "}
                                {record.task.status === "done"
                                  ? t("已完成", "Completed")
                                  : t("未完成", "Not completed")}
                              </span>
                              <span className="memo-entry-list">
                                <ListIcon size={11} />
                                {lists.find(
                                  (list) => list.id === record.task.list_id,
                                )?.name || t("清单", "List")}
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <button
                              className="memo-entry-copy"
                              onClick={() => openMemo(record.memo.id)}
                              aria-label={t(
                                `打开 ${record.memo.title}`,
                                `Open ${record.memo.title}`,
                              )}
                            >
                              <h3>{record.memo.title}</h3>
                              {record.memo.body &&
                                record.memo.body.trim() !==
                                  record.memo.title && (
                                  <p>
                                    {record.memo.body.trim().split("\n")[0] ===
                                    record.memo.title
                                      ? record.memo.body
                                          .trim()
                                          .split("\n")
                                          .slice(1)
                                          .join("\n")
                                          .trim()
                                      : record.memo.body}
                                  </p>
                                )}
                              {!record.memo.body &&
                                (record.memo.summary ||
                                  record.memo.extracted_text) && (
                                  <p>
                                    {record.memo.summary ||
                                      record.memo.extracted_text}
                                  </p>
                                )}
                            </button>
                            {renderAttachments(record)}
                            <div className="memo-entry-footer">
                              <span>
                                <Sparkles size={11} />
                                {t("来自对话", "From a conversation")}
                              </span>
                              {record.memo.analysis_state === "task" &&
                                record.memo.proposal_id &&
                                onReviewProposal && (
                                  <button
                                    className="memo-task-suggestion"
                                    onClick={() =>
                                      onReviewProposal(record.memo.proposal_id!)
                                    }
                                  >
                                    <CheckCheck size={12} />
                                    {taskSuggestionLabel(record.memo, isZh)}
                                    <ArrowUpRight size={12} />
                                  </button>
                                )}
                              <button
                                className="memo-open-detail"
                                onClick={() => openMemo(record.memo.id)}
                                aria-label={t("查看详情", "View details")}
                              >
                                <MoreHorizontal size={15} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      <div className="memo-live-status" role="status" aria-live="polite">
        {notice}
      </div>
      {!!notice && (
        <div className="memo-saved-notice" aria-hidden="true">
          <Check size={13} />
          {notice}
        </div>
      )}
      {detail && (visible || selectedMemoId) && (
        <MemoDetail
          key={detail.id}
          memo={detail}
          isZh={isZh}
          zone={zone}
          close={close}
          saved={(memo) => {
            setMemos((items) =>
              items.map((item) => (item.id === memo.id ? memo : item)),
            );
            setNotice(t("已保存更改", "Changes saved"));
            close();
          }}
          deleted={() => {
            setMemos((items) => items.filter((item) => item.id !== detail.id));
            setNotice(t("已删除", "Deleted"));
            close();
          }}
          review={onReviewProposal}
          ask={onAskMemo}
        />
      )}
    </section>
  );
}
