import { useId, useState, type ReactNode } from "react";
import { Badge, CheckIcon } from "../beautifui/primitives/TaskRows";
import { useUi } from "./lib";
import type { ConnectModel, StartModel, StartStep } from "./model";
import { ConnectPanel } from "./connect-view";
import { Copy } from "./parts";

/**
 * A small "i" that shows what a person may want to know, under the line it sits on, and hides it again: a button, so
 * it works by keyboard and on a touch screen; its label is also its tooltip.
 */
export function useMore(text: string | null, label: string): { button: ReactNode; panel: ReactNode } {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return { button: null, panel: null };
  return {
    button: (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((now) => !now)}
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${open ? "bg-hover text-ink" : "text-ink-3"}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
    ),
    panel: open ? (
      <p id={id} className="mt-1.5 rounded-control bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]" style={{ animation: "fade-in 150ms ease-out both" }}>
        {text}
      </p>
    ) : null,
  };
}

/** Words to copy, with what they are above them: a folder, a sentence for the assistant. */
export function CopyLine({ label, text, mono, children }: { label: string; text: string; mono: boolean; children?: ReactNode }) {
  return (
    <div className="mt-2">
      <p className="pb-1 text-[12px] leading-relaxed text-ink-3">{label}</p>
      <div className="flex items-start gap-3 rounded-control bg-inset py-1.5 pr-1.5 pl-3 shadow-hairline">
        <p className={`min-w-0 flex-1 py-1 text-ink [overflow-wrap:anywhere] ${mono ? "font-mono text-[12px] leading-[1.6]" : "text-[12.5px] leading-relaxed"}`}>{children ?? text}</p>
        <Copy text={text} />
      </div>
    </div>
  );
}

function Marker({ state, n }: { state: StartStep["state"]; n: number }) {
  if (state === "done") return <Badge tone="green">{CheckIcon}</Badge>;
  if (state === "later") return <Badge tone="neutral">{n}</Badge>;
  return <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold tabular-nums text-canvas">{n}</span>;
}

function Step({ step, n, connect }: { step: StartStep; n: number; connect: ConnectModel | null }) {
  const ui = useUi();
  const more = useMore(step.more, ui.more_info);
  return (
    <li className="flex gap-3 px-4 py-3.5" aria-current={step.state === "now" ? "step" : undefined}>
      <span className="pt-px">
        <Marker state={step.state} n={n} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5.5 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className={`text-[13.5px] font-medium ${step.state === "later" ? "text-ink-3" : "text-ink"}`}>{step.title}</span>
          {more.button}
          {step.doneNote && <span className="min-w-0 text-[12px] text-ink-3 [overflow-wrap:anywhere]">{step.doneNote}</span>}
        </div>
        {more.panel}
        {step.state !== "later" && step.copy && <CopyLine label={step.copy.label} text={step.copy.text} mono={step.copy.mono} />}
        {step.state === "now" && step.connect && connect && (
          <div className="mt-2">
            <ConnectPanel connect={connect} />
          </div>
        )}
      </div>
    </li>
  );
}

/** While there are no apps: the steps to a first one, in order, marking the one that is the person's to do now. */
export function StartSteps({ start, connect }: { start: StartModel; connect: ConnectModel | null }) {
  return (
    <ol className="mx-auto w-full max-w-[600px] divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {start.steps.map((step, i) => (
        <Step key={step.title} step={step} n={i + 1} connect={connect} />
      ))}
    </ol>
  );
}
