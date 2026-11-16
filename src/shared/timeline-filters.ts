import { DateTime } from "luxon";
import type { MemoAttachment } from "./memo";
export type AttachmentFilter = "image" | "file" | "pdf" | "document" | "audio" | "video" | "other" | "none";
export interface TimelineFilters {
  lists: string[]; kinds: ("task" | "memo")[]; attachments: AttachmentFilter[];
  period: "all" | "day" | "week" | "month" | "custom";
  anchor: string; start: string; end: string; search: string; scope: "review" | "all";
}
export function defaultTimelineFilters(zone: string): TimelineFilters {
  const day = DateTime.now().setZone(zone).toISODate()!;
  return { lists: [], kinds: [], attachments: [], period: "all", anchor: day, start: day, end: day, search: "", scope: "review" };
}
export function readTimelineFilters(raw: string | null, zone: string): TimelineFilters {
  const defaults = defaultTimelineFilters(zone);
  try {
    const v = JSON.parse(raw || "null"); if (!v || typeof v !== "object") return defaults;
    const array = (items: unknown, allowed?: string[]) => Array.isArray(items) ? [...new Set(items.filter(x => typeof x === "string" && x.length <= 128 && (!allowed || allowed.includes(x))))].slice(0,100) as string[] : [];
    const date = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && DateTime.fromISO(x).isValid ? x : defaults.anchor;
    return { lists: array(v.lists), kinds: array(v.kinds,["task","memo"]) as TimelineFilters["kinds"], attachments: array(v.attachments,["image","file","pdf","document","audio","video","other","none"]) as AttachmentFilter[], period: ["all","day","week","month","custom"].includes(v.period) ? v.period : "all", anchor: date(v.anchor), start: date(v.start), end: date(v.end), search: typeof v.search === "string" ? v.search.slice(0,1000) : "", scope: v.scope === "all" ? "all" : "review" };
  } catch { return defaults; }
}
export function timelineRange(filters: TimelineFilters, zone: string): { start: string; end: string } | null {
  if (filters.period === "all") return null;
  if (filters.period === "custom") return { start: filters.start, end: filters.end };
  const day = DateTime.fromISO(filters.anchor,{zone});
  const unit = filters.period === "day" ? "day" : filters.period === "week" ? "week" : "month";
  return { start: day.startOf(unit).toISODate()!, end: day.endOf(unit).toISODate()! };
}
export function attachmentMatches(file: MemoAttachment, type: AttachmentFilter): boolean {
  if (type === "none") return false;
  if (type === "image" || type === "file") return file.kind === type;
  if (file.kind === "image") return false;
  const ext = file.name.split(".").at(-1)?.toLowerCase(), mime = file.mime || "";
  const pdf = ext === "pdf" || mime === "application/pdf";
  const document = ["doc","docx","xls","xlsx","ppt","pptx","txt","md","csv","json","rtf","odt"].includes(ext || "") || mime.startsWith("text/");
  const audio = mime.startsWith("audio/") || ["mp3","wav","m4a","flac","ogg"].includes(ext || "");
  const video = mime.startsWith("video/") || ["mp4","mov","mkv","webm","avi"].includes(ext || "");
  return type === "pdf" ? pdf : type === "document" ? document : type === "audio" ? audio : type === "video" ? video : !pdf && !document && !audio && !video;
}
export function matchesTimelineFilters(record: {kind: "task" | "memo"; at: string; listIds: string[]; attachments: MemoAttachment[]; content: string}, filters: TimelineFilters, zone: string): boolean {
  if (filters.lists.length && !filters.lists.some(id => id === "__unassigned" ? !record.listIds.length : record.listIds.includes(id))) return false;
  if (filters.kinds.length && !filters.kinds.includes(record.kind)) return false;
  if (filters.attachments.length && !(filters.attachments.includes("none") && !record.attachments.length) && !record.attachments.some(file => filters.attachments.some(type => attachmentMatches(file,type)))) return false;
  const range = timelineRange(filters,zone), day = DateTime.fromISO(record.at).setZone(zone).toISODate();
  if (range && (!day || day < range.start || day > range.end)) return false;
  const query = filters.search.trim().toLocaleLowerCase();
  return !query || `${record.content} ${record.attachments.map(f=>f.name).join(" ")}`.toLocaleLowerCase().includes(query);
}
