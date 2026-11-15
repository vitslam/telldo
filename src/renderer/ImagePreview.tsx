import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isTopmostOverlay } from "./DetailCardModal";
import "./image-preview.css";

/** A shared image-only viewer, above the record or conversation it came from. */
export default function ImagePreview({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (!panel.current || !isTopmostOverlay(panel.current.parentElement) || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        panel.current.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className="overlay image-preview-overlay" onPointerDown={event => {
    if (event.target === event.currentTarget) closeRef.current();
  }}>
    <div className="image-preview-dialog" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Image preview · Escape to close" onClick={() => closeRef.current()}>
      <img src={src} alt={alt} draggable={false} />
    </div>
  </div>, document.body);
}
