import { useEffect, useRef } from "react";
import { DateTime } from "luxon";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { defaultTimelineFilters, timelineRange, type TimelineFilters as Filters } from "../shared/timeline-filters";
import "./timeline-filters.css";
function MultiFilter({label, options, value, onChange}: {label: string; options: {id: string; name: string}[]; value: string[]; onChange: (v:string[])=>void}) {
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const pointer=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))ref.current?.removeAttribute("open");};const key=(e:KeyboardEvent)=>{if(e.key === "Escape" && ref.current?.open){e.preventDefault();e.stopPropagation();ref.current.open=false;ref.current.querySelector("summary")?.focus();}};document.addEventListener("pointerdown",pointer);ref.current?.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",pointer);ref.current?.removeEventListener("keydown",key);};},[]);
  return <details ref={ref} className="timeline-multi"><summary aria-label={label}><span>{value.length === 1 ? options.find(o=>o.id===value[0])?.name || label : label}{value.length>1 && ` · ${value.length}`}</span><ChevronDown size={12}/></summary><div className="timeline-filter-menu"><button type="button" onClick={()=>onChange([])}>{label}<span>{!value.length?"✓":""}</span></button>{options.map(o=><label key={o.id}><input type="checkbox" checked={value.includes(o.id)} onChange={()=>onChange(value.includes(o.id)?value.filter(v=>v!==o.id):[...value,o.id])}/>{o.name}</label>)}</div></details>;
}
export default function TimelineFilters({value, change, lists, isZh, zone, count}: {value: Filters; change:(v:Filters)=>void; lists:{id:string;name:string}[];isZh:boolean;zone:string;count:number}) {
 const t=(zh:string,en:string)=>isZh?zh:en, patch=(p:Partial<Filters>)=>change({...value,...p});
 const listOptions=[...lists,{id:"__unassigned",name:t("未归属","Unassigned")}];
 const kinds=[{id:"task",name:t("任务","Tasks")},{id:"memo",name:t("收集内容","Collected content")}];
 const attachments=[{id:"image",name:t("含图片","With images")},{id:"file",name:t("含文件","With files")}];
 const extras=[{id:"none",name:t("无附件","No attachments")},{id:"pdf",name:"PDF"},{id:"document",name:t("文档","Documents")},{id:"audio",name:t("音频","Audio")},{id:"video",name:t("视频","Video")},{id:"other",name:t("其他文件","Other files")}];
 const now=DateTime.now().setZone(zone), anchor=DateTime.fromISO(value.anchor,{zone});
 const dayLabel=value.period==="day" && value.anchor!==now.toISODate()?t("按天","Day"):t("今天","Today");
 const weekLabel=value.period==="week" && anchor.startOf("week").toISODate()!==now.startOf("week").toISODate()?t("按周","Week"):t("本周","This week");
 const monthLabel=value.period==="month" && anchor.toFormat("yyyy-MM")!==now.toFormat("yyyy-MM")?t("按月","Month"):t("本月","This month");
 const range=timelineRange(value,zone), invalid=!!range && range.start>range.end;
 const clear=()=>change({...defaultTimelineFilters(zone),scope:value.scope});
 const active=value.lists.length+value.kinds.length+value.attachments.length+Number(value.period!=="all")+Number(!!value.search);
 const chip=(key:string,text:string,remove:()=>void)=><button className="timeline-filter-chip" key={key} onClick={remove} aria-label={`${t("移除筛选","Remove filter")}: ${text}`}>{text}<X size={11}/></button>;
 function move(direction:number){const date=DateTime.fromISO(value.anchor,{zone});patch({anchor:date.plus(value.period==="day"?{days:direction}:value.period==="week"?{weeks:direction}:{months:direction}).toISODate()!});}
 return <div className="timeline-filter-area">
  <div className="timeline-filter-controls">
   <MultiFilter label={t("全部清单","All lists")} options={listOptions} value={value.lists} onChange={v=>patch({lists:v})}/>
   <select aria-label={t("时间范围","Time range")} value={value.period} onChange={e=>patch({period:e.target.value as Filters["period"],anchor:DateTime.now().setZone(zone).toISODate()!})}>{[["all",t("全部时间","All time")],["day",dayLabel],["week",weekLabel],["month",monthLabel],["custom",t("自定义日期","Custom dates")]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
   <MultiFilter label={t("全部记录类型","All record types")} options={kinds} value={value.kinds} onChange={v=>patch({kinds:v as Filters["kinds"]})}/>
   <MultiFilter label={t("不限附件","Any attachment")} options={attachments} value={value.attachments.filter(v=>v==="image" || v==="file")} onChange={v=>patch({attachments:[...value.attachments.filter(v=>v!=="image" && v!=="file"),...v] as Filters["attachments"]})}/>
   <MultiFilter label={t("更多筛选","More filters")} options={extras} value={value.attachments.filter(v=>v!=="image" && v!=="file")} onChange={v=>patch({attachments:[...value.attachments.filter(v=>v==="image" || v==="file"),...v] as Filters["attachments"]})}/>
  </div>
  {range && <div className="timeline-range-nav">
   {value.period!=="custom" ? <><button aria-label={t("上一个时间范围","Previous period")} onClick={()=>move(-1)}><ChevronLeft size={14}/></button><span>{range.start}{range.end!==range.start && ` — ${range.end}`}</span><button aria-label={t("下一个时间范围","Next period")} onClick={()=>move(1)}><ChevronRight size={14}/></button><button className="timeline-range-now" onClick={()=>patch({anchor:DateTime.now().setZone(zone).toISODate()!})}>{t("回到当前","Current period")}</button></> : <><label>{t("从","From")}<input aria-label={t("开始日期","Start date")} type="date" value={value.start} onChange={e=>{if(e.target.value)patch({start:e.target.value});}}/></label><label>{t("至","To")}<input aria-label={t("结束日期","End date")} type="date" value={value.end} onChange={e=>{if(e.target.value)patch({end:e.target.value});}}/></label>{invalid && <span role="alert">{t("结束日期不能早于开始日期","End date must follow start date")}</span>}</>}
  </div>}
  <div className="timeline-filter-summary" aria-live="polite">
   {value.lists.map(id=>chip(`list-${id}`,listOptions.find(l=>l.id===id)?.name || t("已删除清单","Deleted list"),()=>patch({lists:value.lists.filter(v=>v!==id)})))}
   {value.kinds.map(id=>chip(`kind-${id}`,kinds.find(k=>k.id===id)!.name,()=>patch({kinds:value.kinds.filter(v=>v!==id)})))}
   {range && chip("period",`${range.start}${range.start!==range.end?` — ${range.end}`:""}`,()=>patch({period:"all"}))}
   {value.attachments.map(id=>chip(`file-${id}`,[...attachments,...extras].find(a=>a.id===id)!.name,()=>patch({attachments:value.attachments.filter(v=>v!==id)})))}
   {value.search && chip("search",value.search,()=>patch({search:""}))}
   <span className="timeline-result-count">{t(`${count} 条记录`,`${count} record${count===1?"":"s"}`)}</span>{!!active && <button className="timeline-reset" onClick={clear}>{t("清除筛选","Clear filters")}</button>}
  </div>
  <p className="timeline-time-basis">{t("按完成 / 收集时间排列；未完成任务按创建时间。","Completed / collected time; unfinished tasks use creation time.")}</p>
 </div>;
}
