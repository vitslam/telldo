import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { CalendarDays, Bell, BellOff, ChevronDown, ChevronLeft, ChevronRight, X, Check, Clock3 } from "lucide-react";
import { moveTiming, readTiming, timingPatch, type TimingFields, type TimingSelection } from "../shared/task-timing";
import { isTopmostOverlay } from "./DetailCardModal";
import "./task-timing.css";

function reminderLabel(mode: TimingSelection["reminder"], isZh: boolean) {
  const labels = {
    none: ["不提醒", "No reminder"], at: ["到时提醒", "At the time"],
    "10": ["提前 10 分钟", "10 min before"], "60": ["提前 1 小时", "1 hour before"],
    custom: ["自定义提醒", "Custom reminder"],
  };
  return labels[mode][isZh ? 0 : 1];
}

export default function TaskTiming({ value, zone, isZh, onChange, disabled = false, lockedKind = false, requireDate = false }: {
  value: TimingFields; zone: string; isZh: boolean; onChange: (patch: TimingFields) => void | Promise<void>;
  disabled?: boolean; lockedKind?: boolean; requireDate?: boolean;
}) {
  const t = (zh: string, en: string) => isZh ? zh : en;
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const current = readTiming(value, zone);
  const today = DateTime.now().setZone(zone).startOf("day");
  const day = current.date ? DateTime.fromISO(current.date, { zone }) : null;
  const dateText = day?.isValid ? (
    current.date === today.toISODate() ? t("今天", "Today") :
    current.date === today.plus({ days: 1 }).toISODate() ? t("明天", "Tomorrow") :
    day.setLocale(isZh ? "zh-CN" : "en").toFormat(day.year === today.year ? (isZh ? "M月d日" : "MMM d") : (isZh ? "yyyy年M月d日" : "MMM d, yyyy"))
  ) + (current.time ? ` ${current.time}` : "") : t("添加时间", "Add a date");
  async function clearDate() {
    setClearing(true); setError("");
    try { await onChange(timingPatch({ date: "", time: "", reminder: "none", custom: "" }, zone)); }
    catch (e) { setError(String(e).replace(/^Error: /, "")); }
    finally { setClearing(false); }
  }
  return <div className="task-timing-row">
    <div className="task-timing-date-group">
      <button ref={trigger} type="button" disabled={disabled || clearing} className="task-timing-date" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog"><CalendarDays size={15} /><span>{dateText}</span></button>
      {current.date && !requireDate && !lockedKind && <button type="button" className="task-timing-clear" disabled={disabled || clearing} onClick={() => void clearDate()} aria-label={t("清除时间", "Clear date")} title={t("清除时间", "Clear date")}><X size={12} /></button>}
    </div>
    <span className="task-timing-separator">·</span>
    <button type="button" disabled={disabled || clearing} className={`task-timing-reminder ${current.reminder === "none" ? "is-muted" : ""}`} onClick={() => setOpen(true)}>{current.reminder === "none" ? <BellOff size={14} /> : <Bell size={14} />}<span>{reminderLabel(current.reminder, isZh)}</span></button>
    {error && <span className="timing-error" role="alert">{error}</span>}
    {open && <TimingPicker initial={current} zone={zone} isZh={isZh} anchor={trigger.current} lockedKind={lockedKind} close={() => setOpen(false)} apply={async selection => { await onChange(timingPatch(selection, zone)); setOpen(false); }} />}
  </div>;
}

function TimingPicker({ initial, zone, isZh, anchor, lockedKind, close, apply }: {
  initial: TimingSelection; zone: string; isZh: boolean; anchor: HTMLElement | null;
  lockedKind: boolean; close: () => void; apply: (selection: TimingSelection) => Promise<void>;
}) {
  const t = (zh: string, en: string) => isZh ? zh : en;
  const today = DateTime.now().setZone(zone).startOf("day");
  const [selection, setSelection] = useState(initial);
  const [month, setMonth] = useState(() => DateTime.fromISO(initial.date || today.toISODate()!, { zone }).startOf("month"));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const panel = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null);
  const reminderTrigger = useRef<HTMLButtonElement>(null);
  const reminderTouched = useRef(false), saving = useRef(false);
  const dismissRef = useRef<() => void>(() => {});
  function move(date: string, time = selection.time) {
    setError(""); setSelection(old => moveTiming(old, date, time, zone, reminderTouched.current));
  }
  async function dismiss() {
    if (saving.current) return;
    if (JSON.stringify(selection) === JSON.stringify(initial)) { close(); return; }
    saving.current = true; setBusy(true); setError("");
    try {
      if (lockedKind && !!selection.time !== !!initial.time)
        throw Error(t("单次安排保持重复任务的时间类型，可在管理重复任务中调整。", "Change the time type in the recurring task settings."));
      // Commit one edit when leaving the picker, including Escape. This avoids
      // version races while adjusting a recurring occurrence's date and time.
      await apply(selection);
    } catch (e) { setError(String(e).replace(/^Error: /, "")); }
    finally { saving.current = false; setBusy(false); }
  }
  dismissRef.current = () => { void dismiss(); };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const place = () => {
      const bounds = anchor?.getBoundingClientRect(), height = panel.current?.getBoundingClientRect().height || 370;
      const width = Math.min(326, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(bounds?.left || 12, window.innerWidth - width - 12)), top: Math.max(12, Math.min((bounds?.bottom || 12) + 8, window.innerHeight - height - 12)), width });
    };
    place(); const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('.timing-calendar [aria-pressed="true"],.timing-quick-dates button')?.focus({ preventScroll: true }));
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !isTopmostOverlay(overlay.current)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismissRef.current(); }
      if (event.key === "Tab" && panel.current) {
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(el => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const days = Array.from({ length: 42 }, (_, i) => month.startOf("week").plus({ days: i }));
  return createPortal(<div ref={overlay} className="overlay timing-overlay" onPointerDown={e => { if (e.target === e.currentTarget) dismissRef.current(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={t("时间与提醒", "Date & reminder")} aria-busy={busy} className="timing-picker" style={position}>
      <div className="timing-picker-heading"><span>{t("时间", "Date & time")}</span><button type="button" disabled={busy} onClick={() => dismissRef.current()} aria-label={t("关闭时间选择", "Close date picker")}><X size={15} /></button></div>
      <fieldset className="timing-controls" disabled={busy}>
        <div className="timing-quick-dates">{[[today, t("今天", "Today")], [today.plus({ days: 1 }), t("明天", "Tomorrow")], [today.plus({ weeks: 1 }).startOf("week"), t("下周", "Next week")]].map(([day, label]) => <button type="button" key={String(label)} onClick={() => { const next = day as DateTime; move(next.toISODate()!); setMonth(next.startOf("month")); }}>{String(label)}</button>)}</div>
        <div className="timing-month-heading"><span>{month.setLocale(isZh ? "zh-CN" : "en").toFormat(isZh ? "yyyy年 M月" : "MMMM yyyy")}</span><div><button type="button" aria-label={t("上个月", "Previous month")} onClick={() => setMonth(month.minus({ months: 1 }))}><ChevronLeft size={15} /></button><button type="button" aria-label={t("下个月", "Next month")} onClick={() => setMonth(month.plus({ months: 1 }))}><ChevronRight size={15} /></button></div></div>
        <div className="timing-weekdays">{(isZh ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"]).map((label, i) => <span key={i}>{label}</span>)}</div>
        <div className="timing-calendar" role="group" aria-label={t("选择日期", "Choose date")}>{days.map(day => <button type="button" key={day.toISODate()} aria-label={day.toISODate()!} aria-pressed={selection.date === day.toISODate()} className={`${day.month !== month.month ? "outside-month" : ""} ${day.toISODate() === today.toISODate() ? "is-today" : ""}`} onClick={() => move(day.toISODate()!)}>{day.day}</button>)}</div>
        <div className="timing-clock">
          <div className="timing-time-control"><Clock3 size={14} />{selection.time !== "" || (!lockedKind && selection.date) ? <><input type="time" aria-label={t("具体时间", "Time")} value={selection.time} onChange={e => move(selection.date, e.target.value)} disabled={!selection.date} />{selection.time && !lockedKind && <button type="button" onClick={() => move(selection.date, "")} aria-label={t("移除具体时间", "Remove time")}><X size={12} /></button>}</> : <span>{t("仅日期", "Date only")}</span>}</div>
          <button ref={reminderTrigger} type="button" className="timing-reminder-trigger" role="combobox" aria-label={t("提醒", "Reminder")} aria-haspopup="listbox" aria-expanded={reminderOpen} disabled={!selection.date} onClick={() => setReminderOpen(true)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setReminderOpen(true); } }}>{selection.reminder === "none" ? <BellOff size={13} /> : <Bell size={13} />}<span>{reminderLabel(selection.reminder, isZh)}</span><ChevronDown size={11} /></button>
        </div>
        {selection.reminder === "custom" && <input className="timing-custom-reminder" type="datetime-local" aria-label={t("自定义提醒时间", "Custom reminder time")} value={selection.custom} onChange={e => { setError(""); setSelection(old => ({ ...old, custom: e.target.value })); }} />}
      </fieldset>
      {error && <p className="timing-error" role="alert">{error}</p>}
      {reminderOpen && <ReminderMenu anchor={reminderTrigger.current} value={selection.reminder} hasTime={!!selection.time} isZh={isZh} close={() => setReminderOpen(false)} choose={mode => { reminderTouched.current = true; setError(""); setSelection(old => ({ ...old, reminder: mode })); }} />}
    </div>
  </div>, document.body);
}

function ReminderMenu({ anchor, value, hasTime, isZh, close, choose }: {
  anchor: HTMLElement | null; value: TimingSelection["reminder"]; hasTime: boolean; isZh: boolean;
  close: () => void; choose: (mode: TimingSelection["reminder"]) => void;
}) {
  const options: TimingSelection["reminder"][] = hasTime ? ["none", "at", "10", "60", "custom"] : ["none", "custom"];
  const [active, setActive] = useState(Math.max(0, options.indexOf(value)));
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const overlay = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  function dismiss() { closeRef.current(); anchor?.focus({ preventScroll: true }); }
  useLayoutEffect(() => {
    function place() {
      const rect = anchor?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(180, window.innerWidth - 24), height = options.length * 30 + 8;
      setPosition({ width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 5 : Math.max(12, rect.top - height - 5) });
    }
    place(); menu.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    const keydown = (e: KeyboardEvent) => { if (e.key === "Escape" && isTopmostOverlay(overlay.current)) { e.preventDefault(); e.stopImmediatePropagation(); dismiss(); } };
    document.addEventListener("keydown", keydown, true); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("keydown", keydown, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, []);
  function focus(index: number) {
    const next = (index + options.length) % options.length; setActive(next);
    menu.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }
  return createPortal(<div ref={overlay} className="overlay timing-reminder-overlay" onPointerDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={menu} role="listbox" aria-label={isZh ? "提醒" : "Reminder"} className="timing-reminder-menu" style={position} onKeyDown={e => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); focus(e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : active + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Tab") { e.preventDefault(); dismiss(); }
    }}>{options.map((mode, index) => <button type="button" role="option" key={mode} aria-selected={mode === value} tabIndex={active === index ? 0 : -1} onFocus={() => setActive(index)} onClick={() => { choose(mode); dismiss(); }}><span>{reminderLabel(mode, isZh)}</span>{mode === value && <Check size={12} />}</button>)}</div>
  </div>, document.body);
}
