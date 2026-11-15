import {
  BookOpen, CalendarDays, FileText, FolderOpen, Image, ListChecks,
  MessageSquareText, Paperclip, Pause, Search, ShieldCheck, ClipboardList, Sparkles,
} from "lucide-react";
import type { AIActivity } from "../shared/ai-progress";

/** Stable host IDs first; translated labels only distinguish legacy subtypes. */
export function activityPresentation(activity: AIActivity) {
  const { id, phase, label } = activity;
  if (/^search-\d+$/.test(id)) {
    if (/日程|schedule/i.test(label)) return { kind: "calendar", Icon: CalendarDays };
    if (/清单|lists/i.test(label)) return { kind: "lists", Icon: FolderOpen };
    return { kind: "search", Icon: Search };
  }
  if (/^attachment-/.test(id)) {
    return ["已加载原图", "正在加载原图", "Original image loaded", "Loading original image"].includes(label)
      ? { kind: "image", Icon: Image }
      : { kind: "attachment", Icon: Paperclip };
  }
  if (/^record-\d+$/.test(id)) return { kind: "read", Icon: BookOpen };
  if (/^apply-\d+$/.test(id)) return { kind: "apply", Icon: ListChecks };
  if (id === "permission-limit") return { kind: "approval", Icon: Pause };
  if (id === "validation" && /提案|proposal/i.test(label))
    return { kind: "approval", Icon: ClipboardList };
  if (phase === "response") return { kind: "response", Icon: MessageSquareText };
  if (phase === "validation") return { kind: "validation", Icon: ShieldCheck };
  if (phase === "model") return { kind: "model", Icon: Sparkles };
  return { kind: "context", Icon: FileText };
}
