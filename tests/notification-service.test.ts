import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationConstructorOptions } from "electron";
import { TaskService } from "../src/main/task-service";
import { NotificationService, notificationTarget, type NativeNotice, type NotificationTarget } from "../src/main/notification-service";
const now = new Date("2026-11-15T04:00:00Z");
class Notice implements NativeNotice {
  click = () => {}; close = () => {}; failed = (_error: string) => {};
  show = vi.fn();
  constructor(public options: NotificationConstructorOptions) {}
  onClick(callback: () => void) { this.click = callback; }
  onClose(callback: () => void) { this.close = callback; }
  onFailed(callback: (error: string) => void) { this.failed = callback; }
}
describe("desktop notification delivery", () => {
  let service: TaskService, notifications: NotificationService;
  let notices: Notice[], foreground: boolean, supported: boolean;
  let open: ReturnType<typeof vi.fn<(target?: NotificationTarget) => void>>;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    service = new TaskService(":memory:"); notices = []; foreground = false; supported = true; open = vi.fn();
    notifications = new NotificationService(service.schedules, {
      settings: () => service.getSettings(), supported: () => supported, isChinese: () => false,
      isForeground: () => foreground, open, changed: () => {},
      create: options => { const notice = new Notice(options); notices.push(notice); return notice; },
    });
  });
  afterEach(() => { notifications.dispose(); service.close(); vi.useRealTimers(); });
  const create = (service: TaskService, title = "Review report") => service.createTask({ title, reminder_at: now.toISOString() });
  it("delivers due reminders only once and opens the exact task", () => {
    const task = create(service); notifications.reminders(); notifications.reminders();
    expect(notices).toHaveLength(1); expect(notices[0].options.title).toBe(task.title);
    expect(notices[0].options.silent).toBe(false); notices[0].click(); expect(open).toHaveBeenCalledWith({ kind: "task", id: task.id });
    new NotificationService(service.schedules, {settings:()=>service.getSettings(), supported:()=>true, isChinese:()=>false, isForeground:()=>false,open,changed:()=>{},create:()=>{throw Error("already delivered");}}).reminders(true);
  });
  it("consumes disabled reminders quietly without replaying on re-enable", () => {
    create(service); service.setSettings({notificationsEnabled:false}); notifications.reminders();
    service.setSettings({notificationsEnabled:true}); notifications.reminders(true); expect(notices).toHaveLength(0);
    create(service, "New reminder"); notifications.reminders(); expect(notices).toHaveLength(1);
  });
  it("doesn't notify for completed or deleted tasks", () => {
    const completed = create(service), deleted = create(service, "Deleted");
    service.updateTask(completed.id,completed.version,{status:"done"}); service.deleteTask(deleted.id,deleted.version);
    notifications.reminders(); expect(notices).toHaveLength(0);
  });
  it("summarizes missed reminders instead of producing a burst", () => {
    for(let i=0;i<5;i++) create(service,`Task ${i}`);
    notifications.reminders(true); expect(notices).toHaveLength(1); expect(notices[0].options.subtitle).toBe("5 tasks to review");
    notifications.reminders(); expect(notices).toHaveLength(1);
  });
  it("releases a failed delivery claim and retries after backoff", () => {
    create(service); notifications.reminders(); notices[0].failed("Permission denied");
    expect(notifications.status().lastError).toBe("Permission denied");
    notifications.reminders(); expect(notices).toHaveLength(1);
    vi.advanceTimersByTime(61_000); notifications.reminders(false,new Date()); expect(notices).toHaveLength(2);
    notifications.reminders(); expect(notices).toHaveLength(2);
  });
  it("only notifies for AI completion in the background and respects both switches", () => {
    const id="12345678-1234-1234-1234-123456789abc";
    foreground=true; notifications.conversation(id,false); expect(notices).toHaveLength(0);
    foreground=false; notifications.conversation(id,true); expect(notices[0].options.title).toBe("Changes ready for review");
    notices[0].click();expect(open).toHaveBeenCalledWith({kind:"chat",id});
    service.setSettings({notifyAIComplete:false}); notifications.conversation(id,false); expect(notices).toHaveLength(1);
    service.setSettings({notifyAIComplete:true,notificationsEnabled:false}); notifications.conversation(id,false); expect(notices).toHaveLength(1);
  });
  it("previews notification sound without saving unsaved preferences", () => {
    notifications.test(false); expect(notices[0].options.silent).toBe(true); expect(service.getSettings().notificationSound).toBe(true);
    supported=false;expect(()=>notifications.test(true)).toThrow(/unavailable/);
  });
  it("restores older settings and rejects malformed notification preferences", () => {
    service.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('preferences',?)").run(JSON.stringify({language:"en"}));
    expect(service.getSettings()).toMatchObject({notificationsEnabled:true,notificationSound:true,notifyAIComplete:true});
    expect(()=>service.setSettings({notificationSound:"false" as unknown as boolean})).toThrow(/Invalid settings/);
  });
  it("routes persisted Notification Center IDs and ignores other apps", () => {
    const id="12345678-1234-1234-1234-123456789abc";
    expect(notificationTarget(`telldo.task.${id}.once.date`)).toEqual({kind:"task",id});
    expect(notificationTarget(`telldo.chat.${id}`)).toEqual({kind:"chat",id});
    expect(notificationTarget(`other.task.${id}`)).toBeUndefined();
    expect(notificationTarget(`telldo.chat.${id}invalid`)).toBeUndefined();
  });
});
