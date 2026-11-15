import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function isTopmostOverlay(overlay: HTMLElement | null): boolean {
  const overlays = Array.from(
    document.querySelectorAll<HTMLElement>(".overlay"),
  ).filter((node) => node.getClientRects().length > 0);
  const top = overlays.reduce<HTMLElement | null>(
    (highest, node) =>
      !highest ||
      Number(getComputedStyle(node).zIndex) >=
        Number(getComputedStyle(highest).zIndex)
        ? node
        : highest,
    null,
  );
  return top === overlay;
}

/** Keeps record details above their source page without changing its layout. */
export default function DetailCardModal({
  children,
  className = "",
  labelledBy,
  close,
}: {
  children: ReactNode;
  className?: string;
  labelledBy: string;
  close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => panel.current?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (
        !panel.current ||
        event.isComposing ||
        event.defaultPrevented ||
        !isTopmostOverlay(panel.current.parentElement)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length > 0);
      const first = items[0],
        last = items.at(-1);
      if (!first) {
        event.preventDefault();
        panel.current.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === panel.current ||
          document.activeElement === first ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === panel.current ||
          document.activeElement === last ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className="overlay detail-card-overlay"
      onPointerDown={(event) => {
        if (
          event.target === event.currentTarget &&
          isTopmostOverlay(event.currentTarget)
        )
          closeRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`dialog detail-card ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
