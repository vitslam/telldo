import { Keyboard, X } from "lucide-react";
import DetailCardModal from "./DetailCardModal";
import { SHORTCUTS, shortcutKeys } from "../shared/shortcuts";
import "./shortcuts.css";

export default function ShortcutsDialog({ isZh, close }: { isZh: boolean; close: () => void }) {
  return <DetailCardModal className="shortcuts-dialog" labelledBy="shortcuts-title" close={close}>
    <header className="shortcuts-heading"><h2 id="shortcuts-title"><Keyboard size={19} />{isZh ? "快捷键" : "Keyboard shortcuts"}</h2><button type="button" aria-label={isZh ? "关闭快捷键" : "Close shortcuts"} onClick={close}><X size={17} /></button></header>
    <ShortcutsReference isZh={isZh} />
  </DetailCardModal>;
}

export function ShortcutsReference({ isZh }: { isZh: boolean }) {
  const mac = window.telldo.platform === "darwin";
  const groups = [["navigation", "导航", "Navigation"], ["conversation", "对话", "Conversation"], ["tasks", "任务", "Tasks"], ["general", "通用", "General"], ["editing", "编辑", "Editing"]] as const;
  return (
    <div className="shortcuts-groups">
      {groups.map(([group, zh, en]) => <section key={group} className={`shortcuts-group shortcuts-${group}`}><h3>{isZh ? zh : en}</h3><dl>
        {SHORTCUTS.filter(item => item.group === group && !item.hidden).map(item => <div key={item.id}><dt>{isZh ? item.zh : item.en}</dt><dd>{shortcutKeys(item.id, mac).map((key, i) => <kbd key={i}>{key}</kbd>)}</dd></div>)}
        {group === "editing" && <>
          <div><dt>{isZh ? "对话中换行" : "New line in chat"}</dt><dd><kbd>{mac ? "⇧" : "Shift"}</kbd><kbd>↵</kbd></dd></div>
          <div><dt>{isZh ? "收起当前弹层" : "Close current overlay"}</dt><dd><kbd>Esc</kbd></dd></div>
          <div><dt>{isZh ? "移动焦点" : "Move focus"}</dt><dd><kbd>Tab</kbd></dd></div>
        </>}
      </dl></section>)}
    </div>
  );
}
