import { useEffect, useState } from "react";
import { Bell, ExternalLink, Volume2, Sparkles, Send } from "lucide-react";
import type { Settings } from "../shared/types";
import "./notifications.css";
interface Status { supported: boolean; lastError: string; }
export default function NotificationSettings({ draft, change, isZh }: {
  draft: Settings; change: (settings: Settings) => void; isZh: boolean;
}) {
  const t = (zh: string, en: string) => isZh ? zh : en;
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void window.telldo.invoke("notificationStatus").then(value => { if (active) setStatus(value as Status); }).catch(e => { if (active) setError(String(e)); });
    const off = window.telldo.onEvent(event => {
      if (event.type === "notification-status") { setStatus(event.data as Status); setRequested(false); }
    });
    return () => { active = false; off(); };
  }, []);
  async function test() {
    setTesting(true); setError(""); setRequested(false);
    try { setStatus(await window.telldo.invoke("notificationTest", draft.notificationSound) as Status); setRequested(true); }
    catch (e) { setError(String(e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
    finally { setTesting(false); }
  }
  const rows = [
    { field: "notificationsEnabled", Icon: Bell, label: t("系统通知", "System notifications"), help: t("在你为待办设置的提醒时间通知你。", "A nudge at the reminder time you set for a task.") },
    { field: "notifyAIComplete", Icon: Sparkles, label: t("AI 回复完成", "AI reply ready"), help: t("仅在应用处于后台时通知，前台对话不打扰。", "Only when Telldo is in the background.") },
    { field: "notificationSound", Icon: Volume2, label: t("提示音", "Notification sound"), help: t("随系统通知播放声音。", "Play a sound with system notifications.") },
  ] as const;
  return <section className="notification-settings">
    <h3>{t("通知", "Notifications")}</h3>
    <div className="notification-options">
      {rows.map(({ field, Icon, label, help }) => <label className="notification-option" key={field}>
        <Icon size={16} aria-hidden="true" />
        <span className="notification-option-copy"><span>{label}</span><small>{help}</small></span>
        <input type="checkbox" role="switch" aria-label={label} checked={draft[field]} disabled={field !== "notificationsEnabled" && !draft.notificationsEnabled}
          onChange={event => change({ ...draft, [field]: event.target.checked })} />
      </label>)}
    </div>
    <div className="notification-tools">
      <button type="button" onClick={() => void test()} disabled={testing || status?.supported === false}><Send size={14} />{t(testing ? "发送中…" : "测试通知", testing ? "Sending…" : "Test notification")}</button>
      {window.telldo.platform === "darwin" && <button type="button" onClick={() => {
        setError(""); void window.telldo.invoke("notificationSettings").catch(e => setError(String(e)));
      }}>{t("系统通知设置", "System settings")}<ExternalLink size={13} /></button>}
    </div>
    {(error || status?.lastError) && <p className="notification-feedback notification-error" role="alert">{error || status?.lastError}</p>}
    {requested && !status?.lastError && <p className="notification-feedback" role="status">{t("测试通知已发起。如未出现，请在系统通知设置中允许 Telldo，并检查专注模式。", "Test notification requested. If it doesn't appear, allow Telldo in system settings and check Focus mode.")}</p>}
    {status?.supported === false && <p className="notification-feedback">{t("当前环境不支持系统通知。", "System notifications aren't available in this environment.")}</p>}
    <p className="notification-help">{t("点击待办详情里的时间或提醒，也可以直接告诉 AI。关闭窗口后可继续在后台提醒；完全退出应用后停止提醒。", "Click the date or reminder in task details, or ask AI. Reminders continue with the window closed when Telldo stays in the menu bar. Quitting the app stops reminders.")}</p>
  </section>;
}
