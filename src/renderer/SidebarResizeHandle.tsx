import { useLayoutEffect, useRef, useState } from "react";
import "./sidebar-resize.css";

const preferenceKey = "telldo.sidebar-width";
const minimum = 180;
const maximum = () => Math.max(minimum, Math.min(360, window.innerWidth - 640));
const clamp = (width: number) => Math.round(Math.max(minimum, Math.min(maximum(), width)));
const defaultWidth = () => window.innerWidth <= 1100 ? 190 : 216;
function storedWidth() {
  try {
    const value = Number(localStorage.getItem(preferenceKey));
    return value >= minimum && value <= 360 ? value : null;
  } catch { return null; }
}
export default function SidebarResizeHandle({ isZh }: { isZh: boolean }) {
  const preferred = useRef<number | null>(storedWidth());
  const [width, setWidth] = useState(() => clamp(preferred.current ?? defaultWidth()));
  const widthRef = useRef(width);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function update(value: number) {
    const next = clamp(value);
    widthRef.current = next;
    // Set on the root so the native macOS title surface follows the same boundary.
    document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
    setWidth(next);
  }
  function remember() {
    preferred.current = widthRef.current;
    try { localStorage.setItem(preferenceKey, String(widthRef.current)); } catch { /* Session resizing still works. */ }
  }
  useLayoutEffect(() => {
    update(preferred.current ?? defaultWidth());
    const resize = () => update(preferred.current ?? defaultWidth());
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      document.documentElement.classList.remove("sidebar-resizing");
      document.documentElement.style.removeProperty("--sidebar-width");
    };
  }, []);
  function finish() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.documentElement.classList.remove("sidebar-resizing");
    remember();
  }
  return <div className={`sidebar-resize-handle ${dragging ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label={isZh ? "调整侧栏宽度" : "Resize sidebar"} aria-valuemin={minimum} aria-valuemax={maximum()} aria-valuenow={width} tabIndex={0}
    title={isZh ? "拖动调整宽度 · 双击恢复默认" : "Drag to resize · Double-click to reset"}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { pointer: event.pointerId, x: event.clientX, width: widthRef.current };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      document.documentElement.classList.add("sidebar-resizing");
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointer === event.pointerId) update(start.width + event.clientX - start.x);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => {
      preferred.current = null;
      try { localStorage.removeItem(preferenceKey); } catch { /* Keep the default for this session. */ }
      update(defaultWidth());
    }}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      update(event.key === "Home" ? minimum : event.key === "End" ? maximum() : widthRef.current + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 24 : 8));
      remember();
    }}
  />;
}
