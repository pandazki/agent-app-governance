import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Where an operation's time goes.
//
// A caller that wants to know wraps the operation in `collectSteps`; the code
// the operation runs marks its steps with `timed` (or `timedSync`). Steps nest:
// a step started inside another is one level deeper. Outside `collectSteps`,
// `timed` only runs the work, so code that marks its steps costs nothing when
// nobody asks.
// ---------------------------------------------------------------------------

export interface Step {
  readonly step: string;
  /** Milliseconds the step took, its inner steps included. */
  readonly ms: number;
  /** 0 for a step the operation itself marked, 1 for a step inside one of those, and so on. */
  readonly depth: number;
  /** When the step started, in ms from the start of the operation. Steps that overlap ran at the same time. */
  readonly at_ms: number;
}

interface Frame {
  readonly steps: { step: string; ms: number; depth: number; at_ms: number }[];
  readonly depth: number;
  readonly start: number;
}

const current = new AsyncLocalStorage<Frame>();

/**
 * Run `work`, collecting the steps it marks, in the order they started; a step measured elsewhere (`measured`) comes
 * where its measure arrived. Steps that overlap ran at the same time, so their times add up to more than `ms`.
 */
export async function collectSteps<T>(work: () => Promise<T>): Promise<{ value: T; steps: Step[]; ms: number }> {
  const frame: Frame = { steps: [], depth: 0, start: performance.now() };
  const value = await current.run(frame, work);
  return { value, steps: frame.steps, ms: Math.round(performance.now() - frame.start) };
}

function begin(step: string): { entry: Frame["steps"][number]; inner: Frame; began: number } | null {
  const frame = current.getStore();
  if (!frame) return null;
  const began = performance.now();
  const entry = { step, ms: 0, depth: frame.depth, at_ms: Math.round(began - frame.start) };
  frame.steps.push(entry);
  return { entry, inner: { steps: frame.steps, depth: frame.depth + 1, start: frame.start }, began };
}

/** Mark `work` as a step of the operation being collected, if any. */
export async function timed<T>(step: string, work: () => Promise<T> | T): Promise<T> {
  const open = begin(step);
  if (!open) return work();
  try {
    return await current.run(open.inner, work);
  } finally {
    open.entry.ms = Math.round(performance.now() - open.began);
  }
}

/** As `timed`, for synchronous work, without an await: for code that relies on nothing else running in between. */
export function timedSync<T>(step: string, work: () => T): T {
  const open = begin(step);
  if (!open) return work();
  try {
    return current.run(open.inner, work);
  } finally {
    open.entry.ms = Math.round(performance.now() - open.began);
  }
}

/** A step measured elsewhere (in another process), added as it was measured, ending now. */
export function measured(step: string, ms: number): void {
  const frame = current.getStore();
  if (!frame) return;
  frame.steps.push({ step, ms: Math.round(ms), depth: frame.depth, at_ms: Math.max(0, Math.round(performance.now() - frame.start - ms)) });
}
