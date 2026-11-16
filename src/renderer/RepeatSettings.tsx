import { useState } from "react";
import { Repeat2 } from "lucide-react";
import { RRule } from "rrule";
import { DateTime } from "luxon";
export type RepeatValue = { rrule: string; until: string | null; count: number | null };
const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const zhDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const parse = (value: RepeatValue): Record<string, string> => Object.fromEntries(value.rrule.split(";").map(s => s.split("=")));
export function alignRepeatDate(value: RepeatValue | null | undefined, date: string) {
  if (!value || !date) return date;
  const start = new Date(`${date}T00:00:00Z`);
  const rule = new RRule({ ...RRule.parseString(value.rrule), dtstart: start });
  return rule.after(start, true)?.toISOString().slice(0, 10) || date;
}
export function repeatLabel(value: RepeatValue | null, zh: boolean) {
  if (!value) return zh ? "不重复" : "Does not repeat";
  const r = parse(value), interval = Number(r.INTERVAL || 1);
  if (r.FREQ === "WEEKLY" && r.BYDAY === "MO,TU,WE,TH,FR" && interval === 1) return zh ? "每个工作日" : "Every weekday";
  const base = interval === 1 ? (({ DAILY: zh ? "每天" : "Daily", WEEKLY: zh ? "每周" : "Weekly", MONTHLY: zh ? "每月" : "Monthly", YEARLY: zh ? "每年" : "Yearly" } as Record<string, string>)[r.FREQ] || (zh ? "自定义重复" : "Custom repeat")) : (zh ? `每 ${interval} ${r.FREQ === "DAILY" ? "天" : r.FREQ === "WEEKLY" ? "周" : r.FREQ === "MONTHLY" ? "个月" : "年"}` : `Every ${interval} ${r.FREQ === "DAILY" ? "days" : r.FREQ === "WEEKLY" ? "weeks" : r.FREQ === "MONTHLY" ? "months" : "years"}`);
  if (r.FREQ === "WEEKLY" && r.BYDAY) return `${base} · ${r.BYDAY.split(",").map(d => (zh ? zhDays : names)[days.indexOf(d)] || d).join(zh ? "、" : ", ")}`;
  return base;
}
export default function RepeatSettings({value, date, isZh, onChange}: {value: RepeatValue | null; date: string; isZh: boolean; onChange: (value: RepeatValue | null) => void}) {
  const t = (zh: string, en: string) => isZh ? zh : en;
  const r = value ? parse(value) : {}, interval = Number(r.INTERVAL || 1);
  const [custom, setCustom] = useState(false);
  const mode = !value ? "none" : custom ? "custom" : r.FREQ === "DAILY" ? "daily" : r.FREQ === "WEEKLY" ? r.BYDAY === "MO,TU,WE,TH,FR" ? "weekdays" : "weekly" : r.BYDAY ? "monthlyWeekday" : "monthly";
  function replace(rule: string) { onChange({rrule: rule, until: value?.until || null, count: value?.count || null}); }
  function update(key: string, next: string) { const fields = {...r, [key]: next}; replace(Object.entries(fields).filter(([,v]) => v).map(([k,v])=>`${k}=${v}`).join(";")); }
  const weekday = days[(DateTime.fromISO(date).weekday || 1) - 1];
  return <div className="timing-repeat">
    <label className="timing-repeat-line"><span><Repeat2 size={14}/>{t("重复", "Repeat")}</span><select aria-label={t("重复频率", "Repeat frequency")} value={mode} onChange={e => {
      const key=e.target.value; setCustom(key === "custom");
      if(key === "none") {onChange(null);return;}
      replace(key === "daily" ? "FREQ=DAILY" : key === "weekdays" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : key === "weekly" ? `FREQ=WEEKLY;BYDAY=${weekday}` : key === "monthly" ? `FREQ=MONTHLY;BYMONTHDAY=${DateTime.fromISO(date).day || 1}` : key === "monthlyWeekday" ? `FREQ=MONTHLY;BYDAY=1${weekday}` : "FREQ=WEEKLY;BYDAY="+weekday);
    }}>{[["none",t("不重复","Does not repeat")],["daily",t("每天","Daily")],["weekdays",t("工作日","Weekdays")],["weekly",t("每周","Weekly")],["monthly",t("每月","Monthly")],["monthlyWeekday",t("每月的某个星期","Monthly weekday")],["custom",t("自定义…","Custom…")]].map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>
    {value && <>
      {mode === "custom" && <label className="timing-repeat-line"><span>{t("周期","Frequency")}</span><select aria-label={t("重复单位","Repeat unit")} value={r.FREQ} onChange={e=>replace(`FREQ=${e.target.value}`)}>{[["DAILY",t("每天","Daily")],["WEEKLY",t("每周","Weekly")],["MONTHLY",t("每月","Monthly")]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
      {r.FREQ === "WEEKLY" && mode !== "weekdays" && <div className="timing-repeat-days" role="group" aria-label={t("每周重复日","Repeat weekdays")}>{days.map((day,i)=><button type="button" key={day} aria-label={(isZh ? zhDays : names)[i]} aria-pressed={(r.BYDAY || weekday).split(",").includes(day)} onClick={()=>{const selected=(r.BYDAY || weekday).split(",");const next=selected.includes(day)?selected.filter(d=>d!==day):[...selected,day];if(next.length)update("BYDAY",days.filter(d=>next.includes(d)).join(","));}}>{(isZh ? ["一","二","三","四","五","六","日"] : ["M","T","W","T","F","S","S"])[i]}</button>)}</div>}
      {r.FREQ === "MONTHLY" && !r.BYDAY && <label className="timing-repeat-line"><span>{t("每月几日","Day of month")}</span><input type="number" min="1" max="31" aria-label={t("每月几日","Day of month")} value={r.BYMONTHDAY || DateTime.fromISO(date).day || 1} onChange={e=>update("BYMONTHDAY",e.target.value)}/></label>}
      {r.FREQ === "MONTHLY" && r.BYDAY && <div className="timing-repeat-interval"><select aria-label={t("第几个星期","Week position")} value={r.BYDAY.match(/^(-?\d)/)?.[1] || r.BYSETPOS || "1"} onChange={e=>replace(`FREQ=MONTHLY;BYDAY=${e.target.value}${r.BYDAY.replace(/^-?\d/,"")}`)}>{["1","2","3","4","-1"].map((v,i)=><option key={v} value={v}>{(isZh?["第一个","第二个","第三个","第四个","最后一个"]:["First","Second","Third","Fourth","Last"])[i]}</option>)}</select><select aria-label={t("星期","Weekday")} value={r.BYDAY.replace(/^-?\d/,"")} onChange={e=>replace(`FREQ=MONTHLY;BYDAY=${r.BYDAY.match(/^(-?\d)/)?.[1] || r.BYSETPOS || "1"}${e.target.value}`)}>{days.map((d,i)=><option key={d} value={d}>{(isZh?zhDays:names)[i]}</option>)}</select></div>}
      <details className="timing-repeat-end" open={value.until || value.count ? true : undefined}><summary>{t("结束条件","Ends")}{!value.until && !value.count && <span>{t("永不结束","Never")}</span>}</summary><label>{t("结束日期","End date")}<input aria-label={t("结束日期","End date")} type="date" min={date} value={value.until?.slice(0,10) || ""} onChange={e=>onChange({...value,until:e.target.value || null,count:null})}/></label><label>{t("重复次数","Number of occurrences")}<input aria-label={t("重复次数","Number of occurrences")} type="number" min="1" max="10000" value={value.count || ""} onChange={e=>onChange({...value,count:e.target.value?Number(e.target.value):null,until:null})}/></label></details>
    </>}
  </div>;
}
