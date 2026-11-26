import type { ReactNode } from "react";
import { ContextNote } from "../beautifui/primitives/ContextNote";
import { Badge, CheckIcon } from "../beautifui/primitives/TaskRows";
import { useUi } from "./lib";
import type { ConnectModel, StartModel, StartStep } from "./model";
import { ConnectPanel } from "./connect-view";
import { Copy } from "./parts";

/** Words to copy, with what they are above them: a folder, a sentence for the assistant. */
export function CopyLine({ label, text, mono, children }: { label: string; text: string; mono: boolean; children?: ReactNode }) {
  return (
    <div className="mt-2">
      <p className="pb-1 text-[13px] leading-relaxed text-ink-2">{label}</p>
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
  return (
    <li className="flex gap-3 px-3 py-3" aria-current={step.state === "now" ? "step" : undefined}>
      <span className="pt-1">
        <Marker state={step.state} n={n} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className={`text-[14px] font-medium ${step.state === "later" ? "text-ink-3" : "text-ink"}`}>{step.title}</span>
            {step.doneNote && <span className="min-w-0 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">{step.doneNote}</span>}
          </div>
          {step.more && <span className="-my-1 -mr-1.5"><ContextNote label={ui.more_info}>{step.more}</ContextNote></span>}
        </div>
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
    <ol className="w-full max-w-[600px] divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
      {start.steps.map((step, i) => (
        <Step key={step.title} step={step} n={i + 1} connect={connect} />
      ))}
    </ol>
  );
}
