import { useLayoutEffect, useRef, useState } from "react";

/** Keeps the complete editable value; only the displayed height is collapsed. */
export default function TaskNotes({ value, onChange, label, placeholder, more, less }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  more: string;
  less: string;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    let width = node.getBoundingClientRect().width;
    function measure() {
      if (!node) return;
      node.style.height = "auto";
      const fullHeight = node.scrollHeight;
      const limit = parseFloat(getComputedStyle(node).lineHeight) * 10;
      setOverflowing(fullHeight > limit + 2);
      node.style.height = `${expanded ? fullHeight : Math.min(fullHeight, limit)}px`;
      if (!expanded) node.scrollTop = 0;
    }
    measure();
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      if (Math.abs(next - width) < .5) return;
      width = next;
      measure();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, expanded]);
  return <section className="task-notes">
    <label htmlFor="task-notes-editor">{label}</label>
    <textarea id="task-notes-editor" ref={editor} className="task-notes-text"
      value={value} placeholder={placeholder} rows={1}
      onChange={event => onChange(event.target.value)}
      onFocus={() => setExpanded(true)} />
    {overflowing && <button className="task-notes-toggle" type="button" aria-controls="task-notes-editor" aria-expanded={expanded}
      onClick={() => setExpanded(current => !current)}>{expanded ? less : more}</button>}
  </section>;
}
