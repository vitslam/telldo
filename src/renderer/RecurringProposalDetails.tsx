import { DateTime } from "luxon";
import type {
  CreateRecurringAction,
  UpdateRecurringAction,
} from "../shared/types";

export default function RecurringProposalDetails({
  action,
  listName,
  isZh,
}: {
  action: CreateRecurringAction | UpdateRecurringAction;
  listName: string;
  isZh: boolean;
}) {
  const p = action.patch;
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const start = DateTime.fromISO(p.dtstart, { zone: p.tzid }).setZone(p.tzid);
  const parts: Record<string, string> = Object.fromEntries(
    p.rrule
      .toUpperCase()
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=")),
  );
  const weekdays: Record<string, string> = isZh
    ? {
        MO: "周一",
        TU: "周二",
        WE: "周三",
        TH: "周四",
        FR: "周五",
        SA: "周六",
        SU: "周日",
      }
    : {
        MO: "Monday",
        TU: "Tuesday",
        WE: "Wednesday",
        TH: "Thursday",
        FR: "Friday",
        SA: "Saturday",
        SU: "Sunday",
      };
  const defaultDay = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][
    start.weekday - 1
  ];
  const days = (parts.BYDAY || defaultDay || "MO").split(",");
  let frequency = text("每天", "Every day");
  if (parts.FREQ === "WEEKLY") {
    frequency =
      days.join(",") === "MO,TU,WE,TH,FR"
        ? text("每个工作日", "Every weekday")
        : isZh
          ? `每${days.map((day) => weekdays[day]).join("、")}`
          : `Every ${days.map((day) => weekdays[day]).join(", ")}`;
  } else if (parts.FREQ === "MONTHLY") {
    if (parts.BYDAY) {
      const match = parts.BYDAY.match(/^(-1|[1-5])?([A-Z]{2})$/);
      const position = parts.BYSETPOS || match?.[1] || "1";
      const day = weekdays[match?.[2] || defaultDay];
      const ordinal = (
        {
          "-1": "last",
          "1": "first",
          "2": "second",
          "3": "third",
          "4": "fourth",
          "5": "fifth",
        } as Record<string, string>
      )[position];
      frequency = isZh
        ? `每月${position === "-1" ? "最后一个" : `第 ${position} 个`}${day}`
        : `The ${ordinal} ${day} of every month`;
    } else {
      const day = Number(parts.BYMONTHDAY || start.day);
      frequency = text(`每月 ${day} 日`, `Day ${day} of every month`);
      if (day > 28)
        frequency += text(
          "（短月取最后一天）",
          " (last day in shorter months)",
        );
    }
  }
  const formatDate = (date: DateTime) =>
    date.toFormat(isZh ? "yyyy年M月d日" : "MMM d, yyyy");
  const timing =
    p.due_kind === "datetime"
      ? `${formatDate(start)} · ${start.toFormat("HH:mm")}`
      : formatDate(start);
  const ending = p.until
    ? formatDate(DateTime.fromISO(p.until, { zone: p.tzid })) +
      text("（含当天）", " (inclusive)")
    : p.count
      ? text(`共 ${p.count} 次`, `${p.count} occurrences`)
      : text("不设结束日期", "No end date");
  let reminder = text("不提醒", "No reminder");
  if (p.reminder_at) {
    const date = DateTime.fromISO(p.reminder_at).setZone(p.tzid);
    const dayOffset = Math.round(
      date.startOf("day").diff(start.startOf("day"), "days").days,
    );
    const day =
      dayOffset === 0
        ? text("当天", "Same day")
        : dayOffset === -1
          ? text("前一天", "Previous day")
          : dayOffset < 0
            ? text(`提前 ${-dayOffset} 天`, `${-dayOffset} days before`)
            : text(`${dayOffset} 天后`, `${dayOffset} days after`);
    reminder = `${day} ${date.toFormat("HH:mm")}`;
  }
  return (
    <div className="proposal-recurrence-summary">
      <div className="recurrence-pattern">
        {frequency}
        {p.due_kind === "datetime" && <span>{start.toFormat("HH:mm")}</span>}
      </div>
      <dl>
        <div>
          <dt>{text("清单", "List")}</dt>
          <dd>{listName}</dd>
        </div>
        {p.priority && p.priority !== "none" && (
          <div>
            <dt>{text("优先级", "Priority")}</dt>
            <dd>
              {
                (
                  {
                    high: text("高", "High"),
                    medium: text("中", "Medium"),
                    low: text("低", "Low"),
                  } as Record<string, string>
                )[p.priority]
              }
            </dd>
          </div>
        )}
        <div>
          <dt>{text("开始", "Starts")}</dt>
          <dd>{timing}</dd>
        </div>
        <div>
          <dt>{text("结束", "Ends")}</dt>
          <dd>{ending}</dd>
        </div>
        <div>
          <dt>{text("每次提醒", "Reminder")}</dt>
          <dd>{reminder}</dd>
        </div>
        <div>
          <dt>{text("时区", "Time zone")}</dt>
          <dd>{p.tzid}</dd>
        </div>
      </dl>
      {p.notes && <p className="recurrence-notes">{p.notes}</p>}
      {!!p.tags?.length && (
        <div className="recurrence-tags">
          {p.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}
