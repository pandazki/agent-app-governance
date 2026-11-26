// Small pieces of context beside the control they explain. The page's CSP allows its
// own stylesheet. Put the note in the top layer so card overflow cannot clip it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const InfoIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-11v2" />
  </svg>
);

export function ContextNote({ label, children, icon = InfoIcon, href }: { label: string; children: ReactNode; icon?: ReactNode; href?: string }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const close = () => {
    clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
  };

  useLayoutEffect(() => {
    const panel = note.current;
    const trigger = anchor.current;
    if (!open || !panel || !trigger) return;
    panel.showPopover?.();
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const top = rect.bottom + 4;
      panel.style.left = Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + "px";
      panel.style.top = (top + panel.offsetHeight < innerHeight ? top : Math.max(8, rect.top - panel.offsetHeight - 4)) + "px";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      panel.hidePopover?.();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const props = { className: "context-trigger", "aria-label": label, "aria-describedby": id };
  return (
    <span ref={anchor} className="inline-flex shrink-0 items-center"
      onPointerEnter={(e) => { if (e.pointerType !== "touch") show(); }}
      onPointerLeave={() => { if (!pinned.current && !anchor.current?.querySelector(":focus-visible")) timer.current = setTimeout(close, 160); }}
      onFocus={(e) => { if (e.target.matches(":focus-visible")) show(); }} onBlur={close}>
      {href ? <a {...props} href={href}>{icon}</a> : (
        <button {...props} type="button" aria-expanded={open} aria-controls={id} onClick={() => {
          if (pinned.current) close();
          else { pinned.current = true; show(); }
        }}>{icon}</button>
      )}
      <span id={id} ref={note} popover="manual" role="tooltip" className="context-note" hidden={!open}>{children}</span>
    </span>
  );
}
