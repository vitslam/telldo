import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { isTopmostOverlay } from "./DetailCardModal";
import "./detail-select.css";

interface Choice { value: string; label: string; color?: string }
export default function DetailSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Choice[]; onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220 });
  const selected = options.find(option => option.value === value);
  const search = useRef({ text: "", at: 0 });
  function dismiss() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    if (!options.length) return;
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setOpen(true);
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(240, window.innerWidth - 24);
      const height = Math.min(options.length * 32 + 10, 250, window.innerHeight - 24);
      const top = rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top, width });
    }
    place();
    menu.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopmostOverlay(menu.current?.parentElement ?? null)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);
  function move(index: number) {
    const next = (index + options.length) % options.length;
    setActive(next);
    const option = menu.current?.querySelectorAll<HTMLElement>('[role="option"]')[next];
    option?.focus();
    option?.scrollIntoView({ block: "nearest" });
  }
  return <div className="detail-choice">
    <span className="detail-choice-label" id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="detail-choice-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} aria-labelledby={`${id}-label ${id}-value`}
      onClick={() => open ? dismiss() : show()}
      onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(); } }}>
      <span className={`detail-choice-dot ${selected?.color ? "" : "is-empty"}`} style={selected?.color ? { background: selected.color } : undefined} aria-hidden="true" />
      <span className="detail-choice-value" id={`${id}-value`}>{selected?.label || value}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<div className="overlay detail-choice-overlay" onPointerDown={event => { if (event.target === event.currentTarget) dismiss(); }}>
      <div ref={menu} className="detail-choice-menu" id={`${id}-menu`} role="listbox" aria-labelledby={`${id}-label`} style={position}
        onKeyDown={event => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            move(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : active + (event.key === "ArrowDown" ? 1 : -1));
          } else if (event.key === "Tab") { event.preventDefault(); dismiss(); }
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== " ") {
            const now = Date.now();
            search.current.text = (now - search.current.at < 600 ? search.current.text : "") + event.key.toLocaleLowerCase();
            search.current.at = now;
            const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text));
            if (index >= 0) { event.preventDefault(); move(index); }
          }
        }}>
        {options.map((option, index) => <button key={option.value} type="button" role="option" aria-selected={value === option.value} tabIndex={index === active ? 0 : -1}
          className={`detail-choice-option ${value === option.value ? "selected" : ""}`} onFocus={() => setActive(index)}
          onClick={() => { onChange(option.value); dismiss(); }}>
          <span className={`detail-choice-dot ${option.color ? "" : "is-empty"}`} style={option.color ? { background: option.color } : undefined} aria-hidden="true" />
          <span>{option.label}</span>{value === option.value && <Check size={13} />}
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
