import type { NotificationConstructorOptions } from "electron";
import type { Settings } from "../shared/types";
import type { Reminder, ScheduleService } from "./schedule-service";

export type NotificationTarget = { kind: "task" | "chat"; id: string };
export interface NativeNotice {
  show(): void;
  onClick(callback: () => void): void;
  onClose(callback: () => void): void;
  onFailed(callback: (error: string) => void): void;
}
interface NotificationHost {
  supported(): boolean;
  create(options: NotificationConstructorOptions): NativeNotice;
  settings(): Settings;
  isChinese(): boolean;
  isForeground(): boolean;
  open(target?: NotificationTarget): void;
  changed(): void;
}
export function notificationTarget(id: string): NotificationTarget | undefined {
  const match = /^telldo\.(task|chat)\.([0-9a-f-]{36})(?:\.|$)/i.exec(id);
  return match ? { kind: match[1] as "task" | "chat", id: match[2] } : undefined;
}

/** Keep the native objects alive, and leave scheduling/deduplication in SQLite. */
export class NotificationService {
  private active = new Set<NativeNotice>();
  private lastError = "";
  private retryAfter = 0;
  constructor(private schedules: ScheduleService, private host: NotificationHost) {}
  status() { return { supported: this.host.supported(), lastError: this.lastError }; }
  private publish(options: NotificationConstructorOptions, target?: NotificationTarget, retry?: () => void): boolean {
    if (!this.host.supported()) return false;
    let notice: NativeNotice | undefined;
    let failureHandled = false;
    const failed = (error: unknown) => {
      if (failureHandled) return;
      failureHandled = true;
      if (notice) this.active.delete(notice);
      this.lastError = String(error || "Notification could not be shown").slice(0, 500);
      this.retryAfter = Date.now() + 60_000;
      retry?.();
      this.host.changed();
    };
    try {
      notice = this.host.create({ ...options, silent: options.silent ?? !this.host.settings().notificationSound });
      this.active.add(notice);
      notice.onClick(() => this.host.open(target));
      notice.onClose(() => { this.active.delete(notice!); });
      notice.onFailed(failed);
      notice.show();
      return true;
    } catch (error) { failed(error); return false; }
  }
  reminders(startup = false, now = new Date()) {
    const enabled = this.host.settings().notificationsEnabled && this.host.supported();
    // Disabled reminders are consumed quietly; enabling doesn't replay an old backlog.
    if (enabled && Date.now() < this.retryAfter) return;
    const notices = this.schedules.dueNotifications(now, startup || !enabled);
    if (!enabled || !notices.length) return;
    const chinese = this.host.isChinese();
    const deliver = (items: Reminder[], options: NotificationConstructorOptions) =>
      this.publish(options, { kind: "task", id: items[0].taskId }, () => this.schedules.retryNotifications(items));
    if (startup || notices.length > 3) {
      deliver(notices, {
        id: `telldo.task.${notices[0].taskId}.summary.${now.getTime()}`,
        groupId: "telldo.reminders", title: chinese ? "待办提醒" : "Task reminders",
        subtitle: chinese ? `${notices.length} 项待办等你查看` : `${notices.length} tasks to review`,
        body: notices.slice(0, 3).map(item => item.title).join(" · "),
      });
    } else for (const item of notices) {
      deliver([item], {
        id: `telldo.task.${item.taskId}.${item.occurrenceKey || "once"}.${item.fireAt}`,
        groupId: "telldo.reminders", title: item.title,
        subtitle: chinese ? "待办提醒" : "Task reminder",
        body: item.body || (chinese ? "到提醒时间了，点击查看待办。" : "It's time. Click to view your task."),
      });
    }
  }
  conversation(chatId: unknown, needsApproval: boolean) {
    const s = this.host.settings();
    if (!s.notificationsEnabled || !s.notifyAIComplete || this.host.isForeground()) return;
    const id = typeof chatId === "string" && /^[0-9a-f-]{36}$/i.test(chatId) ? chatId : undefined;
    const chinese = this.host.isChinese();
    this.publish({
      ...(id ? { id: `telldo.chat.${id}` } : {}), groupId: "telldo.conversations",
      title: needsApproval ? (chinese ? "有更改等待你确认" : "Changes ready for review") : (chinese ? "回复已就绪" : "Your reply is ready"),
      body: chinese ? "点击回到对话，继续安排。" : "Click to return to your conversation.",
    }, id ? { kind: "chat", id } : undefined);
  }
  test(sound: boolean) {
    this.lastError = "";
    if (!this.host.supported()) throw Error("System notifications are unavailable / 当前系统不支持通知");
    const chinese = this.host.isChinese();
    if (!this.publish({ groupId: "telldo.test", title: "Telldo", silent: !sound,
      body: chinese ? "通知已准备好，让重要的事如期发生。" : "You're all set. A little nudge, right on time." }))
      throw Error(this.lastError);
    return this.status();
  }
  dispose() { this.active.clear(); }
}
