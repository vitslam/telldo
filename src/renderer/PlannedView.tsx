import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type DragEvent,
} from "react";
import { DateTime } from "luxon";
import DetailCardModal from "./DetailCardModal";
import "./calendar-detail.css";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  List,
  Plus,
  Repeat2,
  Undo2,
  X,
} from "lucide-react";
import type { Snapshot, Task } from "../shared/types";
import { isOverdue, localDay } from "../shared/dates";
import {
  calendarMonthRange,
  projectCalendar,
  getCalendarTarget,
  type CalendarRow,
  type CalendarChangeRequest,
  type CalendarChangePreview,
  type CalendarApplyResult,
} from "../shared/calendar";
const api = <T,>(method: string, ...args: unknown[]) =>
  window.telldo.invoke<T>(method, ...args);
function saved(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
interface Props {
  data: Snapshot;
  zone: string;
  isZh: boolean;
  month: string;
  setMonth: (month: string) => void;
  showDone: boolean;
  setShowDone: (value: boolean) => void;
  reload: () => Promise<void>;
  renderDetails: (task: Task, dates: ReactNode, close: () => void) => ReactNode;
  openTemplate: (task: Task) => void;
}
export default function PlannedView({
  data,
  zone,
  isZh,
  month,
  setMonth,
  showDone,
  setShowDone,
  reload,
  renderDetails,
  openTemplate,
}: Props) {
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const [mode, setMode] = useState(() =>
    saved("telldo.planned.mode", "list") === "month" ? "month" : "list",
  );
  const [listId, setListId] = useState(() => saved("telldo.planned.list", ""));
  const [selected, setSelected] = useState<string | null>(null),
    [day, setDay] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false),
    [title, setTitle] = useState(""),
    [createList, setCreateList] = useState("");
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [working, setWorking] = useState(false);
  const [undoId, setUndoId] = useState(() => saved("telldo.calendar.undo", ""));
  const [preview, setPreview] = useState<CalendarChangePreview | null>(null),
    [previewBusy, setPreviewBusy] = useState(false);
  const previewGeneration = useRef(0);
  const draggedRow = useRef<CalendarRow | null>(null);
  const filter = data.lists.some((l) => l.id === listId) ? listId : "";
  const projection = useMemo(
    () =>
      projectCalendar(data, {
        month,
        displayZone: zone,
        listId: filter || undefined,
        includeCompleted: showDone,
      }),
    [data, month, zone, filter, showDone],
  );
  const row = [...projection.rows, ...projection.unscheduled].find(
    (r) => r.key === selected,
  );
  const selectedDay =
    day || (localDay(zone).startsWith(month) ? localDay(zone) : month + "-01");
  const today = localDay(zone);
  const [lastRow, setLastRow] = useState<CalendarRow | null>(null);
  // Retain selection after moving out of the visible month, using fresh versions from the snapshot.
  const selectionProjection = useMemo(
    () =>
      lastRow
        ? projectCalendar(data, {
            month: (
              lastRow.primaryDate ||
              lastRow.dueDate ||
              selectedDay
            ).slice(0, 7),
            displayZone: zone,
            includeCompleted: true,
          })
        : null,
    [data, lastRow, zone, selectedDay],
  );
  const active =
    row ||
    selectionProjection?.rows.find((r) => r.key === selected) ||
    selectionProjection?.unscheduled.find((r) => r.key === selected);
  useEffect(() => {
    remember("telldo.planned.mode", mode);
  }, [mode]);
  useEffect(() => {
    remember("telldo.planned.list", filter);
  }, [filter]);
  const select = (r: CalendarRow) => {
    setSelected(r.key);
    setLastRow(r);
  };
  const chooseMonth = (value: string) => {
    try {
      calendarMonthRange(value);
      setMonth(value);
      setDay(null);
    } catch (e) {
      setError(String(e));
    }
  };
  async function run(fn: () => Promise<void>) {
    setError("");
    setWorking(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      await reload().catch(() => {});
    } finally {
      setWorking(false);
    }
  }
  const requestFor = (
    r: CalendarRow,
    field: "planned" | "due",
    date: string | null,
  ): CalendarChangeRequest => ({
    target: getCalendarTarget(r),
    field,
    date,
    displayZone: zone,
  });
  async function apply(request: CalendarChangeRequest) {
    await run(async () => {
      const result = await api<CalendarApplyResult>("calendarApply", request);
      setUndoId(result.undoId);
      remember("telldo.calendar.undo", result.undoId);
      setPreview(null);
      setMessage(
        text("日期已更新", "Date updated") +
          " · " +
          (request.field === "planned"
            ? text("安排", "Planned")
            : text("截止", "Due")) +
          " → " +
          (request.date || text("无日期", "No date")),
      );
      const changed = [
        ...projection.rows,
        ...projection.unscheduled,
        ...(selectionProjection?.rows || []),
      ].find(
        (r) =>
          r.task.id === request.target.taskId &&
          (r.occurrence?.occurrence_key || undefined) ===
            request.target.occurrenceKey &&
          (r.occurrence?.series_id || undefined) === request.target.seriesId,
      );
      if (changed)
        setLastRow({
          ...changed,
          task: result.task,
          occurrence: result.occurrence || changed.occurrence,
          primaryDate:
            request.field === "planned"
              ? request.date || changed.dueDate
              : changed.task.planned_date || request.date,
          dueDate: request.field === "due" ? request.date : changed.dueDate,
        });
    });
  }
  async function inspect(request: CalendarChangeRequest, forceDialog = false) {
    const generation = ++previewGeneration.current;
    setError("");
    setPreviewBusy(true);
    try {
      const value = await api<CalendarChangePreview>(
        "calendarPreview",
        request,
      );
      if (generation !== previewGeneration.current) return;
      if (
        forceDialog ||
        value.requiresConfirmation ||
        value.requiresReminderChoice ||
        value.requiresTimeChoice ||
        !value.after
      )
        setPreview(value);
      else await apply(request);
    } catch (e) {
      if (generation === previewGeneration.current) setError(String(e));
      await reload().catch(() => {});
    } finally {
      if (generation === previewGeneration.current) setPreviewBusy(false);
    }
  }
  function move(r: CalendarRow, date: string) {
    if (working || previewBusy) return;
    select(r);
    const field = r.occurrence
      ? "due"
      : r.task.planned_date || r.task.due_kind === "none"
        ? "planned"
        : "due";
    if ((field === "planned" ? r.task.planned_date : r.dueDate) === date)
      return;
    void inspect(requestFor(r, field, date));
  }
  async function toggle(r: CalendarRow, skip = false) {
    await run(async () => {
      if (r.occurrence)
        await api(
          "updateOccurrence",
          r.occurrence.series_id,
          r.occurrence.occurrence_key,
          {
            status: skip
              ? "skipped"
              : r.task.status === "done"
                ? "todo"
                : "done",
          },
          r.occurrence.version ?? 1,
        );
      else
        await api("updateTask", r.task.id, r.task.version, {
          status: r.task.status === "done" ? "todo" : "done",
        });
      setMessage(
        skip
          ? text("已跳过本次", "Occurrence skipped")
          : text("任务状态已更新", "Task status updated"),
      );
    });
  }
  const dragStart = (e: DragEvent, r: CalendarRow) => {
    // Keep the versions from pointer-down, even if an AI edit refreshes the snapshot mid-drag.
    draggedRow.current = structuredClone(r);
    e.dataTransfer.setData("application/x-telldo-task", r.key);
    e.dataTransfer.effectAllowed = "move";
  };
  const drop = (e: DragEvent, date: string) => {
    e.preventDefault();
    e.currentTarget.classList.remove("drag-over");
    const key = e.dataTransfer.getData("application/x-telldo-task");
    const r = draggedRow.current;
    draggedRow.current = null;
    if (r?.key === key) move(r, date);
  };
  const dateText = (task: Task) =>
    task.due_at
      ? DateTime.fromISO(task.due_at).setZone(zone).toFormat("MM-dd HH:mm")
      : task.due_date;
  const [dayLimit, setDayLimit] = useState(3);
  const gridObserver = useRef<ResizeObserver | null>(null);
  const monthPicker = useRef<HTMLInputElement>(null);
  const observeGrid = useMemo(
    () => (node: HTMLDivElement | null) => {
      gridObserver.current?.disconnect();
      if (!node) return;
      const resize = () =>
        setDayLimit(
          Math.max(
            0,
            Math.min(3, Math.floor((node.clientHeight / 6 - 48) / 26)),
          ),
        );
      gridObserver.current = new ResizeObserver(resize);
      gridObserver.current.observe(node);
      resize();
    },
    [],
  );
  useEffect(() => () => gridObserver.current?.disconnect(), []);
  const card = (r: CalendarRow, marker = false) => (
    <button
      key={r.key + (marker ? ":due" : "")}
      data-row-id={r.key}
      data-task-id={r.task.id}
      data-occurrence-key={r.occurrence?.occurrence_key}
      draggable={!marker && !working && !previewBusy}
      onDragStart={(e) => dragStart(e, r)}
      onDragEnd={(e) => {
        draggedRow.current = null;
        e.currentTarget
          .closest(".planned-view")
          ?.querySelectorAll(".drag-over")
          .forEach((cell) => cell.classList.remove("drag-over"));
      }}
      onClick={() => select(r)}
      title={r.task.title}
      aria-pressed={selected === r.key}
      style={{
        borderLeftColor: data.lists.find((list) => list.id === r.task.list_id)
          ?.color,
      }}
      className={`calendar-card ${marker ? "deadline" : ""} ${r.task.status === "done" ? "completed" : ""} ${r.task.status === "todo" && isOverdue(r.task, zone) ? "overdue" : ""}`}
    >
      <span>
        {marker ? "◇ " : r.occurrence ? "↻ " : ""}
        {r.task.title}
      </span>
      {r.task.due_at && (!r.task.planned_date || marker) && (
        <small className="calendar-time">
          {DateTime.fromISO(r.task.due_at).setZone(zone).toFormat("HH:mm")}
        </small>
      )}
      {!marker && data.tasks.some((t) => t.parent_id === r.task.id) && (
        <small>
          {
            data.tasks.filter(
              (t) => t.parent_id === r.task.id && t.status === "done",
            ).length
          }
          /{data.tasks.filter((t) => t.parent_id === r.task.id).length}{" "}
          {text("子任务", "subtasks")}
        </small>
      )}
    </button>
  );
  const dates = active && (
    <>
      {error && !preview && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <CalendarDates
        key={
          active.key +
          ":" +
          active.task.version +
          ":" +
          active.occurrence?.version
        }
        row={active}
        zone={zone}
        isZh={isZh}
        disabled={working || previewBusy}
        change={(field, date, wallTime) =>
          void inspect({
            ...requestFor(active, field, date),
            ...(wallTime ? { wallTime } : {}),
          })
        }
        moreSettings={
          !active.occurrence ? () => openTemplate(active.task) : undefined
        }
      />
      {!active.occurrence && (
        <button
          className="secondary full"
          disabled={working}
          onClick={() => void toggle(active)}
        >
          {active.task.status === "done"
            ? text("恢复未完成", "Reopen task")
            : text("完成任务", "Complete task")}
        </button>
      )}
    </>
  );
  return (
    <section
      className="planned-view"
      aria-label={text("计划日期视图", "Planned dates")}
    >
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <button
            aria-label={text("上个月", "Previous month")}
            onClick={() => {
              chooseMonth(
                DateTime.fromISO(month + "-01")
                  .minus({ months: 1 })
                  .toFormat("yyyy-MM"),
              );
            }}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="calendar-month-label">
            <button
              className="calendar-month-trigger"
              onClick={() => monthPicker.current?.showPicker()}
            >
              {DateTime.fromISO(month + "-01")
                .setLocale(isZh ? "zh-CN" : "en")
                .toFormat(isZh ? "yyyy年 M月" : "MMMM yyyy")}
              <ChevronDown size={14} />
            </button>
            <input
              ref={monthPicker}
              className="month-picker"
              tabIndex={-1}
              type="month"
              aria-label={text("月份", "Month")}
              value={month}
              onChange={(e) => {
                if (/^\d{4}-\d{2}$/.test(e.target.value)) {
                  chooseMonth(e.target.value);
                }
              }}
            />
          </div>
          <button
            aria-label={text("下个月", "Next month")}
            onClick={() => {
              chooseMonth(
                DateTime.fromISO(month + "-01")
                  .plus({ months: 1 })
                  .toFormat("yyyy-MM"),
              );
            }}
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => {
              setMonth(today.slice(0, 7));
              setDay(today);
            }}
          >
            {text("本月", "This month")}
          </button>
        </div>
        <div
          className="calendar-modes"
          role="group"
          aria-label={text("显示方式", "Display mode")}
        >
          <button
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List size={15} />
            {text("列表", "List")}
          </button>
          <button
            aria-pressed={mode === "month"}
            onClick={() => setMode("month")}
          >
            <CalendarDays size={15} />
            {text("月历", "Month view")}
          </button>
        </div>
      </div>
      <div className="calendar-filters">
        <select
          aria-label={text("清单筛选", "Filter list")}
          value={filter}
          onChange={(e) => setListId(e.target.value)}
        >
          <option value="">{text("全部清单", "All lists")}</option>
          {data.lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />
          {text("显示已完成", "Show completed")}
        </label>
        <span data-testid="calendar-count">
          {projection.rows.length} {text("项", "tasks")}
        </span>
        <span className="calendar-zone">{zone}</span>
        <button aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
          {text("待安排", "Unscheduled")} {projection.unscheduled.length}
        </button>
      </div>
      {error && !preview && (
        <div className="error global-error" role="alert">
          {error}
          <button onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {(message || undoId) && (
        <div className="undo-bar" aria-live="polite">
          <span>{message || text("上一次日期修改", "Last date change")}</span>
          {undoId && (
            <button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await api("calendarUndo", undoId);
                  setUndoId("");
                  remember("telldo.calendar.undo", "");
                  setMessage(text("已撤销日期修改", "Date change undone"));
                })
              }
            >
              <Undo2 size={14} />
              {text("撤销", "Undo")}
            </button>
          )}
        </div>
      )}
      {active?.primaryDate &&
        !active.primaryDate.startsWith(month) &&
        !active.dueDate?.startsWith(month) && (
          <div className="undo-bar">
            <span>
              {text("选中任务在其他月份", "Selected task is in another month")}
            </span>
            <button onClick={() => setMonth(active.primaryDate!.slice(0, 7))}>
              {text("跳到任务日期", "Go to task date")}
            </button>
          </div>
        )}
      {drawer && (
        <div
          className="calendar-unscheduled"
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.classList.add("drag-over");
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove("drag-over")}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("drag-over");
            if (working || previewBusy) return;
            const r = draggedRow.current;
            draggedRow.current = null;
            if (
              r?.key === e.dataTransfer.getData("application/x-telldo-task") &&
              !r.occurrence &&
              r.task.planned_date
            ) {
              select(r);
              void inspect(requestFor(r, "planned", null));
            }
          }}
        >
          {projection.unscheduled.length ? (
            projection.unscheduled.map((r) => card(r))
          ) : (
            <span>
              {text(
                "当前清单没有待安排任务",
                "No unscheduled tasks in these lists",
              )}
            </span>
          )}
        </div>
      )}
      <div className={`planned-layout ${day && !active ? "has-detail" : ""}`}>
        <div className="calendar-body">
          {mode === "month" ? (
            <>
              <div className="calendar-weekdays">
                {(isZh
                  ? ["一", "二", "三", "四", "五", "六", "日"]
                  : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                ).map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div className="calendar-grid" ref={observeGrid}>
                {projection.days.map((d) => (
                  <div
                    key={d.date}
                    data-date={d.date}
                    className={`calendar-day ${d.inMonth ? "" : "outside"} ${d.date === today ? "today" : ""} ${day === d.date ? "chosen" : ""}`}
                    onDragOver={(e) => {
                      if (d.inMonth) {
                        e.preventDefault();
                        e.currentTarget.classList.add("drag-over");
                      }
                    }}
                    onDragLeave={(e) =>
                      e.currentTarget.classList.remove("drag-over")
                    }
                    onDrop={(e) => {
                      if (d.inMonth) drop(e, d.date);
                    }}
                  >
                    <div className="calendar-day-header">
                      <button
                        aria-label={text("查看 ", "View ") + d.date}
                        onClick={() => {
                          if (!d.inMonth) setMonth(d.date.slice(0, 7));
                          setDay(d.date);
                          setSelected(null);
                        }}
                      >
                        {Number(d.date.slice(8))}
                      </button>
                      {d.inMonth && (
                        <button
                          aria-label={
                            text("安排任务到 ", "Schedule task on ") + d.date
                          }
                          onClick={() => {
                            setDay(d.date);
                            setSelected(null);
                          }}
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                    {d.entries
                      .slice(0, dayLimit)
                      .map((entry) =>
                        card(entry.row, entry.kind === "deadline"),
                      )}
                    {d.entries.length > dayLimit && (
                      <button
                        className="calendar-more"
                        onClick={() => {
                          setDay(d.date);
                          setSelected(null);
                        }}
                      >
                        +{d.entries.length - dayLimit} {text("项", "more")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="task-list calendar-list">
              {projection.rows.length ? (
                projection.rows.map((r) => (
                  <div
                    key={r.key}
                    data-row-id={r.key}
                    data-task-id={r.task.id}
                    data-occurrence-key={r.occurrence?.occurrence_key}
                    className={`task-row ${r.task.status === "done" ? "completed" : ""} ${selected === r.key ? "selected" : ""}`}
                  >
                    <button
                      className={`check-button ${r.task.priority} ${r.task.status === "done" ? "checked" : ""}`}
                      disabled={working}
                      aria-label={
                        (r.task.status === "done"
                          ? text("重新打开", "Reopen")
                          : text("完成", "Complete")) +
                        " " +
                        r.task.title
                      }
                      onClick={() => void toggle(r)}
                    >
                      {r.task.status === "done" && <Check size={13} />}
                    </button>
                    <button className="task-body" onClick={() => select(r)}>
                      <span className="task-title">
                        {r.occurrence && <Repeat2 size={13} />}
                        {r.task.title}
                      </span>
                      <span className="task-meta">
                        {data.lists.find((l) => l.id === r.task.list_id)?.name}
                        {r.task.planned_date && (
                          <span>
                            {text("安排", "Planned")} {r.task.planned_date}
                          </span>
                        )}
                        {r.dueDate && (
                          <span>
                            {text("截止", "Due")} {dateText(r.task)}
                          </span>
                        )}
                        {data.tasks.some((t) => t.parent_id === r.task.id) && (
                          <span>
                            {
                              data.tasks.filter(
                                (t) =>
                                  t.parent_id === r.task.id &&
                                  t.status === "done",
                              ).length
                            }
                            /
                            {
                              data.tasks.filter(
                                (t) => t.parent_id === r.task.id,
                              ).length
                            }{" "}
                            {text("子任务", "subtasks")}
                          </span>
                        )}
                      </span>
                    </button>
                    <span className="task-date">{r.groupDate}</span>
                  </div>
                ))
              ) : (
                <div className="calendar-empty">
                  {text(
                    "本月没有符合筛选条件的任务",
                    "No matching tasks this month",
                  )}
                </div>
              )}
            </div>
          )}
          <div className="calendar-legend">
            <span>▰ {text("安排日期优先", "Planned date first")}</span>
            <span>◇ {text("截止标记 · 同一任务", "Deadline · same task")}</span>
            <button
              onClick={() => {
                setDay(selectedDay);
                setSelected(null);
              }}
            >
              <Plus size={14} />
              {text("安排一件事", "Schedule a task")}
            </button>
          </div>
        </div>
        {active ? (
          active.occurrence ? (
            <DetailCardModal
              className="detail calendar-instance"
              labelledBy="calendar-instance-title"
              close={() => setSelected(null)}
            >
              <div className="calendar-instance-heading">
                <span className="calendar-instance-eyebrow">
                  <Repeat2 size={15} />
                  {text("重复任务 · 本次", "Recurring task · This occurrence")}
                </span>
                <button
                  className="calendar-card-close"
                  aria-label={text("关闭详情", "Close details")}
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <div className="detail-scroll calendar-instance-content">
                <h2 id="calendar-instance-title">{active.task.title}</h2>
                <div className="calendar-instance-meta">
                  <span
                    className="calendar-instance-list-dot"
                    style={{
                      background: data.lists.find(
                        (list) => list.id === active.task.list_id,
                      )?.color,
                    }}
                  />
                  {
                    data.lists.find((list) => list.id === active.task.list_id)
                      ?.name
                  }
                  <span className="calendar-instance-separator">·</span>
                  <span>
                    {text("仅修改本次安排", "Changes apply to this occurrence")}
                  </span>
                </div>
                {active.task.notes && (
                  <p className="calendar-instance-notes">{active.task.notes}</p>
                )}
                {active.task.tags.length > 0 && (
                  <div className="calendar-instance-tags">
                    {active.task.tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                )}
                {dates}
              </div>
              <div className="calendar-instance-footer">
                <button
                  className="text-button"
                  onClick={() => openTemplate(active.task)}
                >
                  <Repeat2 size={14} />
                  {text("管理重复任务", "Manage recurring task")}
                </button>
                <div>
                  <button
                    className="secondary"
                    disabled={working}
                    onClick={() => void toggle(active, true)}
                  >
                    {text("跳过本次", "Skip occurrence")}
                  </button>
                  <button
                    className="primary"
                    disabled={working}
                    onClick={() => void toggle(active)}
                  >
                    <Check size={15} />
                    {active.task.status === "done"
                      ? text("恢复本次", "Reopen occurrence")
                      : text("完成本次", "Complete occurrence")}
                  </button>
                </div>
              </div>
            </DetailCardModal>
          ) : (
            renderDetails(active.task, dates, () => setSelected(null))
          )
        ) : (
          day && (
            <aside className="detail calendar-agenda">
              <div className="detail-top">
                <span>{selectedDay}</span>
                <button aria-label="Close day" onClick={() => setDay(null)}>
                  <X size={18} />
                </button>
              </div>
              <div className="detail-scroll">
                <h3>{text("当天任务", "Tasks on this day")}</h3>
                {projection.entries
                  .filter((e) => e.date === selectedDay)
                  .map((e) => (
                    <button
                      className="calendar-agenda-item"
                      key={e.key}
                      onClick={() => select(e.row)}
                    >
                      {e.kind === "deadline" ? "◇ " : ""}
                      {e.row.task.title}
                    </button>
                  ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!title.trim()) return;
                    void run(async () => {
                      await api("createTask", {
                        title: title.trim(),
                        list_id: createList || filter || data.lists[0]?.id,
                        planned_date: selectedDay,
                        due_kind: "none",
                      });
                      setTitle("");
                      setMessage(
                        text("已安排到 ", "Scheduled on ") + selectedDay,
                      );
                    });
                  }}
                >
                  <label>
                    {text("安排日期", "Planned date")}
                    <input
                      type="date"
                      required
                      value={selectedDay}
                      onChange={(e) => {
                        if (e.target.value) {
                          setDay(e.target.value);
                          setMonth(e.target.value.slice(0, 7));
                        }
                      }}
                    />
                  </label>
                  <label>
                    {text("清单", "List")}
                    <select
                      value={createList || filter || data.lists[0]?.id || ""}
                      onChange={(e) => setCreateList(e.target.value)}
                    >
                      {data.lists.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {text("任务标题", "Task title")}
                    <input
                      autoFocus
                      required
                      maxLength={500}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <button
                    className="primary full"
                    disabled={working || !title.trim() || !data.lists.length}
                  >
                    {text("安排到这一天", "Schedule on this day")}
                  </button>
                </form>
              </div>
            </aside>
          )
        )}
      </div>
      {preview && (
        <DetailCardModal
          className="calendar-preview-card"
          labelledBy="calendar-preview-title"
          close={() => {
            if (working) return;
            ++previewGeneration.current;
            setPreview(null);
            setPreviewBusy(false);
          }}
        >
          <div className="calendar-preview">
            <h2 id="calendar-preview-title">
              {text("确认日期修改", "Review date change")}
            </h2>
            <p>{preview.before.title}</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <dl>
              <dt>{text("原日期", "Before")}</dt>
              <dd>
                {preview.request.field === "planned"
                  ? preview.before.planned_date || "—"
                  : dateText(preview.before) || "—"}
              </dd>
              <dt>{text("新日期", "After")}</dt>
              <dd>
                {preview.after
                  ? preview.request.field === "planned"
                    ? preview.after.planned_date || "—"
                    : dateText(preview.after) || "—"
                  : preview.request.date}
              </dd>
            </dl>
            {preview.request.field === "due" && preview.before.reminder_at && (
              <>
                <p>
                  {text("原提醒", "Previous reminder")}:{" "}
                  {DateTime.fromISO(preview.before.reminder_at)
                    .setZone(zone)
                    .toFormat("yyyy-MM-dd HH:mm ZZZZ")}
                </p>
                <label>
                  {text("提醒如何处理", "Reminder behavior")}
                  <select
                    aria-label={text("提醒如何处理", "Reminder behavior")}
                    value={preview.request.reminderPolicy || ""}
                    disabled={previewBusy}
                    onChange={(e) =>
                      void inspect(
                        {
                          ...preview.request,
                          reminderPolicy: e.target.value as "keep" | "follow",
                        },
                        true,
                      )
                    }
                  >
                    <option value="" disabled>
                      {text("请选择", "Choose an option")}
                    </option>
                    <option value="follow">
                      {text("提醒跟随", "Move reminder with due date")}
                    </option>
                    <option value="keep">
                      {text("保持提醒", "Keep reminder time")}
                    </option>
                  </select>
                </label>
                {preview.after && (
                  <p>
                    {text("新提醒", "New reminder")}:{" "}
                    {preview.after.reminder_at
                      ? DateTime.fromISO(preview.after.reminder_at)
                          .setZone(zone)
                          .toFormat("yyyy-MM-dd HH:mm ZZZZ")
                      : "—"}
                  </p>
                )}
              </>
            )}
            {preview.requiresTimeChoice && (
              <label>
                {text("选择有效时间", "Choose a valid time")}
                <input
                  type="time"
                  aria-label={text("选择有效时间", "Choose a valid time")}
                  defaultValue={
                    preview.request.wallTime ||
                    (preview.before.due_at
                      ? DateTime.fromISO(preview.before.due_at)
                          .setZone(zone)
                          .toFormat("HH:mm")
                      : "09:00")
                  }
                  onChange={(e) => {
                    if (e.target.value)
                      void inspect(
                        {
                          ...preview.request,
                          wallTime: e.target.value,
                          chosenDueAt: undefined,
                        },
                        true,
                      );
                  }}
                />
              </label>
            )}
            {preview.candidates.length > 1 && (
              <label>
                {text("夏令时对应时刻", "Daylight-saving offset")}
                <select
                  aria-label={text("夏令时对应时刻", "Daylight-saving offset")}
                  value={preview.request.chosenDueAt || ""}
                  disabled={previewBusy}
                  onChange={(e) =>
                    void inspect(
                      { ...preview.request, chosenDueAt: e.target.value },
                      true,
                    )
                  }
                >
                  <option value="" disabled>
                    {text("请选择", "Choose an option")}
                  </option>
                  {preview.candidates.map((c) => (
                    <option value={c.dueAt} key={c.dueAt}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {preview.warnings.map((warning, i) => (
              <p className="notice" key={i}>
                {warning}
              </p>
            ))}
            <p className="notice">{zone}</p>
            <div className="dialog-actions">
              <button
                disabled={working}
                onClick={() => {
                  ++previewGeneration.current;
                  setPreview(null);
                  setPreviewBusy(false);
                }}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="primary"
                disabled={
                  working ||
                  previewBusy ||
                  !!error ||
                  !preview.after ||
                  preview.requiresTimeChoice ||
                  preview.requiresReminderChoice
                }
                onClick={() => void apply(preview.request)}
              >
                {text("保存日期", "Save dates")}
              </button>
            </div>
          </div>
        </DetailCardModal>
      )}
    </section>
  );
}
function CalendarDates({
  row,
  zone,
  isZh,
  disabled,
  change,
  moreSettings,
}: {
  row: CalendarRow;
  zone: string;
  isZh: boolean;
  disabled: boolean;
  change: (
    field: "planned" | "due",
    date: string | null,
    wallTime?: string,
  ) => void;
  moreSettings?: () => void;
}) {
  const [planned, setPlanned] = useState(row.task.planned_date || ""),
    [due, setDue] = useState(row.dueDate || "");
  const originalTime = row.task.due_at
    ? DateTime.fromISO(row.task.due_at).setZone(zone).toFormat("HH:mm")
    : "";
  const [wallTime, setWallTime] = useState(originalTime);
  const text = (zh: string, en: string) => (isZh ? zh : en);
  return (
    <section className="calendar-date-editor">
      {!row.occurrence && (
        <div className="calendar-date-field">
          <label>
            {text("安排日期", "Planned date")}
            <input
              type="date"
              aria-label={text("安排日期", "Planned date")}
              disabled={disabled}
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
            />
          </label>
          <button
            className="text-button"
            disabled={disabled || planned === (row.task.planned_date || "")}
            onClick={() => change("planned", planned || null)}
          >
            {text("保存安排日期", "Save planned date")}
          </button>
        </div>
      )}
      <div className="calendar-date-field">
        <div className="calendar-due-fields">
          <label>
            {row.occurrence
              ? text("本次截止日期", "Occurrence due date")
              : text("截止日期", "Due date")}
            <input
              type="date"
              aria-label={text("截止日期", "Due date")}
              disabled={disabled}
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          {row.task.due_at && (
            <label>
              {text("截止时刻", "Due time")}
              <input
                type="time"
                aria-label={text("截止时刻", "Due time")}
                value={wallTime}
                disabled={disabled}
                onChange={(e) => setWallTime(e.target.value)}
              />
            </label>
          )}
        </div>
        <button
          className="text-button"
          disabled={
            disabled ||
            (due === (row.dueDate || "") && wallTime === originalTime) ||
            (!!row.occurrence && !due) ||
            (!!originalTime && !wallTime)
          }
          onClick={() =>
            change(
              "due",
              due || null,
              wallTime !== originalTime ? wallTime || undefined : undefined,
            )
          }
        >
          {text("保存截止日期", "Save due date")}
        </button>
      </div>
      {row.task.due_at && (
        <p className="notice">
          {DateTime.fromISO(row.task.due_at)
            .setZone(zone)
            .toFormat("HH:mm ZZZZ")}
          {row.task.time_zone !== zone && (
            <>
              {" "}
              · {text("原时区", "Original zone")}:{" "}
              {DateTime.fromISO(row.task.due_at)
                .setZone(row.task.time_zone || zone)
                .toFormat("yyyy-MM-dd HH:mm ZZZZ")}
            </>
          )}
        </p>
      )}
      {row.task.reminder_at && (
        <p className="notice">
          {text("提醒", "Reminder")}:{" "}
          {DateTime.fromISO(row.task.reminder_at)
            .setZone(zone)
            .toFormat("yyyy-MM-dd HH:mm ZZZZ")}
        </p>
      )}
      {moreSettings && (
        <button className="text-button" onClick={moreSettings}>
          {text("更多日期和提醒设置", "More date and reminder settings")}
        </button>
      )}
    </section>
  );
}
