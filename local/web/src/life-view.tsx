import { useRef, useState } from "react";
import { Button } from "../beautifui/atoms/Button";
import LoadingState from "../beautifui/primitives/LoadingState";
import { Drawer } from "../beautifui/primitives/Recommendation";
import { act, useNow, useOwner, usePage, useUi } from "./lib";
import type { Checked, LifeCard, LifeVerb } from "./model";
import { ContextNote } from "../beautifui/primitives/ContextNote";
import { RetryIcon } from "../beautifui/primitives/TaskRows";
import { Failure, refusalText } from "./change-view";
import { RichText, TextField } from "./parts";

function Bullets({ lines, tone = "text-ink-2" }: { lines: readonly string[]; tone?: string }) {
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => (
        <li key={line} className={`flex gap-2 text-[12.5px] leading-relaxed [overflow-wrap:anywhere] ${tone}`}>
          <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-ink-3" />
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * Take down, bring back, publish again and clear, in the decision card's grammar: what the app's state means, then each
 * act opens the card's drawer with what it does; clearing lists what it deletes and what stays, and asks for the name.
 */
export function LifeBlock({ life }: { life: LifeCard }) {
  const ui = useUi();
  const { refusals, access } = usePage();
  const owner = useOwner();
  const [mode, setMode] = useState<LifeVerb | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  // One act at a time: a second click while one is on its way, or while the page moves on after it, sends nothing.
  const sending = useRef(false);
  const can = owner.state === "yes";
  const chosen = life.actions.find((action) => action.verb === mode) ?? null;
  const ready = Boolean(chosen && (!chosen.typeName || typed.trim() === chosen.typeName));

  const go = async () => {
    if (!chosen || !ready || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const result = await act(chosen.url, chosen.typeName ? { confirm: typed.trim() } : {}, access);
    if (result.ok) {
      location.href = chosen.done;
      return;
    }
    sending.current = false;
    setBusy(false);
    if (result.lost) return owner.lose();
    setFailure({ text: refusalText(refusals, result.data, ui.failed), detail: String(result.data.detail ?? result.data.error ?? "") });
  };

  const open = (next: LifeVerb | null) => {
    setFailure(null);
    setTyped("");
    setMode(next);
  };

  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-pad">
        <p className="text-[13px] leading-relaxed text-ink-2">{life.body}</p>
      </div>
      {life.actions.map((action) => (
        <Drawer key={action.verb} open={mode === action.verb}>
          {action.lines.length > 0 && <Bullets lines={action.lines} />}
          {action.deletes && (
            <>
              <p className="pb-1 text-[11px] font-medium text-red">{ui.clear_deletes}</p>
              <Bullets lines={action.deletes} tone="text-red" />
            </>
          )}
          {action.keeps && action.keeps.length > 0 && (
            <>
              <p className="pt-2 pb-1 text-[11px] font-medium text-ink-3">{ui.clear_keeps}</p>
              <Bullets lines={action.keeps} />
            </>
          )}
          {action.typeName && (
            <div className="mt-2">
              <TextField value={typed} onChange={setTyped} label={action.typeLabel ?? action.typeName} placeholder={action.typeName} disabled={busy} maxLength={64} />
            </div>
          )}
          {failure && mode === action.verb && <Failure text={failure.text} detail={failure.detail} />}
        </Drawer>
      ))}
      {life.actions.length > 0 && (
        <div className="primitive-card-footer flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line">
          {busy ? (
            <span className="pl-0.5">
              <LoadingState label={ui.working} />
            </span>
          ) : !can ? (
            <span className="px-0.5 text-[12px] leading-relaxed text-ink-3">{owner.state === "checking" ? ui.owner_checking : ui.read_only_decide}</span>
          ) : (
            <span />
          )}
          {can && (
            <span className="-mr-0.5 ml-auto flex flex-wrap items-center justify-end gap-2">
              {chosen === null ? (
                life.actions.map((action) => (
                  <Button key={action.verb} variant={action.variant} size="sm" className="text-[12.5px]" onClick={() => open(action.verb)}>
                    {action.label}
                  </Button>
                ))
              ) : (
                <>
                  <Button variant="ghost" size="sm" className="px-2.5 text-[12.5px]" disabled={busy} onClick={() => open(null)}>
                    {ui.cancel}
                  </Button>
                  <Button variant={chosen.verb === "clear" ? "danger" : "accent"} size="sm" className="text-[12.5px]" disabled={busy || !ready} onClick={go}>
                    {chosen.verb === "clear" ? ui.clear_go : chosen.label}
                  </Button>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The link always checks, including on touch. The explicit check shows its timestamp with the result. */
export function RuntimeCheck({ checked }: { checked: Checked }) {
  const ui = useUi();
  return (
    <ContextNote label={checked.href ? ui.check_now : ui.details} href={checked.href ?? undefined} icon={RetryIcon}>
      {checked.href && <strong className="block">{ui.check_now}</strong>}
      <RichText rich={checked.text} />
    </ContextNote>
  );
}

export function CheckResult({ checked }: { checked: Checked }) {
  const now = useNow();
  const stamp = checked.text.parts.find((part) => typeof part !== "string");
  const stale = stamp && now - Date.parse(stamp.at) >= 5 * 60_000;
  if (checked.failed) return <p role="alert" className="runtime-failure">{checked.failed} <RichText rich={checked.text} /></p>;
  const requested = typeof location !== "undefined" && new URLSearchParams(location.search).get("check") === "1";
  if (!stale && !requested) return null;
  return <p role="status" className="text-[12px] text-ink-2"><RichText rich={checked.text} /></p>;
}
