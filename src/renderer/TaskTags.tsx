import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Hash, Plus, X, Check, Search } from "lucide-react";
import { isTopmostOverlay } from "./DetailCardModal";
import "./task-tags.css";

export default function TaskTags({ value, suggestions, isZh, onChange }: {
  value: string[]; suggestions: string[]; isZh: boolean; onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const t = (zh: string, en: string) => isZh ? zh : en;
  return <section className="task-tags" aria-label={t("标签", "Tags")}>
    <span className="task-tags-label"><Hash size={15} />{t("标签", "Tags")}</span>
    <div className="task-tags-values">
      {value.map(tag => <span className="task-tag-chip" key={tag}><span>{tag}</span><button type="button" aria-label={t(`移除标签 ${tag}`, `Remove tag ${tag}`)} onClick={() => onChange(value.filter(item => item !== tag))}><X size={11} /></button></span>)}
      <button ref={trigger} type="button" className="task-tags-add" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Plus size={13} />{t("添加标签", "Add tag")}</button>
    </div>
    {open && <TagPicker anchor={trigger.current} value={value} suggestions={suggestions} isZh={isZh} onChange={onChange} close={() => setOpen(false)} />}
  </section>;
}

function TagPicker({ anchor, value, suggestions, isZh, onChange, close }: {
  anchor: HTMLElement | null; value: string[]; suggestions: string[]; isZh: boolean;
  onChange: (tags: string[]) => void; close: () => void;
}) {
  const id = useId();
  const t = (zh: string, en: string) => isZh ? zh : en;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const overlay = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const dismissRef = useRef(close); dismissRef.current = close;
  const canonical = new Map<string, string>();
  for (const tag of [...value, ...suggestions]) if (tag.trim()) canonical.set(tag.toLocaleLowerCase(), tag);
  const name = query.trim().replace(/^#+/, "");
  const known = [...canonical.values()].sort((a, b) => a.localeCompare(b, isZh ? "zh-CN" : "en"));
  const matches = known.filter(tag => tag.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  const canCreate = !!name && !canonical.has(name.toLocaleLowerCase());
  const options = [...matches.map(tag => ({ tag, create: false })), ...(canCreate ? [{ tag: name, create: true }] : [])];
  function dismiss() { dismissRef.current(); anchor?.focus({ preventScroll: true }); }
  function toggle(tag: string) {
    const existing = value.find(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase());
    onChange(existing ? value.filter(item => item !== existing) : [...value, tag]);
    setQuery(""); setActive(-1); input.current?.focus();
  }
  function addNames(text: string) {
    const next = [...value];
    for (const part of text.split(/[,，\n\r]+/)) {
      const trimmed = part.trim().replace(/^#+/, "");
      const tag = canonical.get(trimmed.toLocaleLowerCase()) || trimmed;
      if (tag && !next.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) next.push(tag);
    }
    onChange(next); setQuery(""); setActive(-1);
  }
  useLayoutEffect(() => {
    function place() {
      const rect = anchor?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(280, window.innerWidth - 24), height = panel.current?.getBoundingClientRect().height || 230;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 7 : Math.max(12, rect.top - height - 7) });
    }
    place(); const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    input.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !isTopmostOverlay(overlay.current)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
      if (event.key === "Tab") { event.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener("keydown", keydown, true); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); document.removeEventListener("keydown", keydown, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, []);
  function move(delta: number) {
    if (!options.length) return;
    const next = active < 0 ? (delta > 0 ? 0 : options.length - 1) : (active + delta + options.length) % options.length;
    setActive(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
  }
  return createPortal(<div ref={overlay} className="overlay task-tags-overlay" onPointerDown={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={t("选择标签", "Choose tags")} className="task-tags-picker" style={position}>
      <div className="task-tags-search"><Search size={14} /><input ref={input} role="combobox" aria-label={t("搜索或新建标签", "Search or create a tag")} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-options`} aria-activedescendant={active >= 0 && active < options.length ? `${id}-${active}` : undefined} placeholder={t("搜索或新建标签…", "Search or create a tag…")} value={query} onChange={event => { setQuery(event.target.value); setActive(-1); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
          else if (event.key === "Enter") { event.preventDefault(); if (active >= 0 && options[active]) toggle(options[active].tag); else if (name) addNames(name); else if (options[0]) toggle(options[0].tag); }
          else if ((event.key === "," || event.key === "，") && name) { event.preventDefault(); addNames(name); }
        }} onPaste={event => { const text = event.clipboardData.getData("text"); if (/[,，\n\r]/.test(text)) { event.preventDefault(); addNames(text); } }} /></div>
      <div className="task-tags-options" id={`${id}-options`} role="listbox" aria-label={t("标签", "Tags")} aria-multiselectable="true">
        {options.map((option, index) => {
          const selected = value.some(tag => tag.toLocaleLowerCase() === option.tag.toLocaleLowerCase());
          return <button type="button" role="option" id={`${id}-${index}`} key={option.tag} aria-selected={selected} tabIndex={-1} className={index === active ? "is-active" : ""} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => toggle(option.tag)}>{option.create ? <Plus size={13} /> : <Hash size={13} />}<span>{option.create ? t(`新建「${option.tag}」`, `Create “${option.tag}”`) : option.tag}</span>{selected && <Check size={13} />}</button>;
        })}
      </div>
      {!options.length && <p className="task-tags-empty">{t("输入名称，按回车创建标签", "Type a name, then Enter to create a tag")}</p>}
    </div>
  </div>, document.body);
}
