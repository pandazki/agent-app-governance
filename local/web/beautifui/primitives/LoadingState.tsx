"use client";
// Beautiful UI LoadingState (MIT, © 2026 Shane Levine; see ../LICENSE), from https://www.beautifului.dev/r/loading-state.json.
// The page uses a single arc and a stable label. Only longer waits need a clock.
import { useEffect, useState } from "react";

export default function LoadingState({ label }: { label: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" className="shrink-0 motion-safe:animate-spin">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span role="status">{label}</span>
      {elapsed > 0 && <span role="timer" className="text-[12px] font-normal tabular-nums text-ink-3">{elapsed}s</span>}
    </span>
  );
}
