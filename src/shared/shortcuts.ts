export type ShortcutId = "assistant" | "memos" | "today" | "planned" | "anytime" | "focus-ai" | "new-chat" | "history" | "attach" | "stop" | "new-task" | "new-list" | "timeline-search" | "settings" | "help" | "submit";
export interface Shortcut {
  id: ShortcutId; group: "navigation" | "conversation" | "tasks" | "general" | "editing";
  code: string; key: string; shift?: boolean; hidden?: boolean; zh: string; en: string;
}
export const SHORTCUTS: Shortcut[] = [
  { id: "assistant", group: "navigation", code: "Digit1", key: "1", zh: "AI 对话", en: "Conversation" },
  { id: "memos", group: "navigation", code: "Digit2", key: "2", zh: "时间线", en: "Timeline" },
  { id: "today", group: "navigation", code: "Digit3", key: "3", zh: "今天", en: "Today" },
  { id: "planned", group: "navigation", code: "Digit4", key: "4", zh: "计划", en: "Planned" },
  { id: "anytime", group: "navigation", code: "Digit5", key: "5", zh: "随时", en: "Anytime" },
  { id: "focus-ai", group: "conversation", code: "KeyJ", key: "J", zh: "回到 AI 输入", en: "Focus AI input" },
  { id: "new-chat", group: "conversation", code: "KeyN", key: "N", zh: "新对话", en: "New chat" },
  { id: "history", group: "conversation", code: "KeyH", key: "H", shift: true, zh: "对话历史", en: "Chat history" },
  { id: "attach", group: "conversation", code: "KeyA", key: "A", shift: true, zh: "添加图片或文件", en: "Add images or files" },
  { id: "stop", group: "conversation", code: "Period", key: ".", zh: "停止回复", en: "Stop response" },
  { id: "new-task", group: "tasks", code: "KeyT", key: "T", zh: "添加待办", en: "Add a task" },
  { id: "new-list", group: "tasks", code: "KeyN", key: "N", shift: true, zh: "新建清单", en: "New list" },
  { id: "timeline-search", group: "general", code: "KeyF", key: "F", zh: "搜索时间线", en: "Search Timeline" },
  { id: "timeline-search", group: "general", code: "KeyK", key: "K", hidden: true, zh: "搜索时间线", en: "Search Timeline" },
  { id: "settings", group: "general", code: "Comma", key: ",", zh: "设置", en: "Settings" },
  { id: "help", group: "general", code: "Slash", key: "/", zh: "快捷键", en: "Keyboard shortcuts" },
  { id: "submit", group: "editing", code: "Enter", key: "Enter", zh: "发送 / 保存更改", en: "Send / save changes" },
];
interface KeyInput { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean }
export function matchShortcut(event: KeyInput, mac: boolean): ShortcutId | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  return SHORTCUTS.find(item => !!item.shift === event.shiftKey && (event.code ? event.code === item.code || (item.code === "Enter" && event.code === "NumpadEnter") : event.key.toLowerCase() === item.key.toLowerCase()))?.id || null;
}
export function shortcutKeys(id: ShortcutId, mac: boolean): string[] {
  const item = SHORTCUTS.find(item => item.id === id)!;
  return [mac ? "⌘" : "Ctrl", ...(item.shift ? [mac ? "⇧" : "Shift"] : []), item.key === "Enter" ? "↵" : item.key];
}
export function shortcutLabel(id: ShortcutId, mac: boolean): string { return shortcutKeys(id, mac).join(mac ? "" : "+"); }
