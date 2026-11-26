import { useRef, useState } from "react";
import { Button } from "../beautifui/atoms/Button";
import LoadingState from "../beautifui/primitives/LoadingState";
import { CheckOption, Drawer, FieldRow, Meter } from "../beautifui/primitives/Recommendation";
import TaskRows, { badgeFor, type TaskRow } from "../beautifui/primitives/TaskRows";
import { Collapsible, FileChips } from "../beautifui/primitives/ToolChips";
import { Section, Surface } from "../beautifui/site";
import { act, fill, useOwner, usePage, useUi } from "./lib";
import type { ChangeModel, Notice, Side } from "./model";
import { TONE_VAR } from "./home";
import { ContextNote } from "../beautifui/primitives/ContextNote";
import { ArrowOut, ButtonLink, DetailsBlock, EmptyState, Header, Picture, RichText, StatePill } from "./parts";

/** What a failed write says: the plain line, and the Host's own words under Details. */
export function Failure({ text, detail }: { text: string; detail: string }) {
  const ui = useUi();
  return (
    <div role="alert" className="mt-2 rounded-control bg-red-tint px-2.5 py-2 text-[12.5px] text-red">
      <p className="font-medium">{text}</p>
      {detail && (
        <Collapsible label={ui.details} className="mt-1 [&_button]:text-red/80">
          <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{detail}</pre>
        </Collapsible>
      )}
    </div>
  );
}

/** A refused write in one plain sentence when the Host's refusal code has one; the Host's own words go under Details. */
export function refusalText(refusals: Readonly<Record<string, string>>, data: Record<string, unknown>, fallback: string): string {
  return refusals[String(data.reason ?? "")] ?? fallback;
}

export function noticeRow(notice: Notice, i: number): TaskRow {
  return { key: `n${i}`, wrap: true, label: <span className="leading-relaxed">{notice.text}</span>, status: notice.tone === "red" ? "failed" : notice.tone === "orange" ? "caution" : "plain" };
}

type Again = "idle" | "working" | { error: string; detail: string };

/** Asking the Host to publish a side's preview again, when it no longer stands. */
function useShowAgain(side: Side): [Again, () => Promise<void>] {
  const ui = useUi();
  const { refusals, access } = usePage();
  const owner = useOwner();
  const [again, setAgain] = useState<Again>("idle");
  const showAgain = async () => {
    if (!side.again || again === "working") return;
    setAgain("working");
    const result = await act(side.again.url, {}, access);
    if (result.lost) {
      owner.lose();
      setAgain("idle");
      return;
    }
    if (result.ok) {
      location.reload();
      return;
    }
    setAgain({ error: refusalText(refusals, result.data, ui.failed), detail: String(result.data.detail ?? result.data.error ?? "") });
  };
  return [again, showAgain];
}

const GREEN_TICK = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/** One side of before and after: a card with its label, a way to open the real thing, and its picture. */
function SideCard({ side, name }: { side: Side; name: string }) {
  const ui = useUi();
  const owner = useOwner();
  const [again, showAgain] = useShowAgain(side);
  return (
    <div className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex min-h-12 items-center gap-2.5 border-b border-line px-3">
        <span className="shrink-0 text-[13px] font-medium text-ink">{side.label}</span>
        {side.note && (
          <span className="min-w-0 text-[12px] text-ink-3">
            <RichText rich={side.note} />
          </span>
        )}
        {side.open && (
          <ButtonLink href={side.open} variant="secondary" size="xs" external className="ml-auto">
            {ui.open}
            <ArrowOut />
          </ButtonLink>
        )}
      </div>
      {side.shot && <Picture shot={side.shot} name={name} className={side.empty ? "border-b border-line opacity-60 grayscale" : ""} />}
      {side.empty && (
        <div className="my-auto">
          <EmptyState
            title={side.empty.text}
            icon={side.empty.tone === "green" ? GREEN_TICK : undefined}
          />
          {side.again && (
            <div className="flex flex-col items-center px-4 pb-4">
              {again === "working" ? (
                <LoadingState label={ui.preview_again_working} />
              ) : owner.state === "yes" ? (
                <Button variant="secondary" size="sm" className="text-[12.5px]" onClick={showAgain}>
                  {side.again.label}
                </Button>
              ) : null}
              {typeof again === "object" && <Failure text={again.error} detail={again.detail} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One side as a row, where the Host never takes pictures: the card's bar on its own (its label, when the preview ends
 * itself, a way to open it), and what stands in for the preview when there is none.
 */
function SideRow({ side }: { side: Side }) {
  const ui = useUi();
  const owner = useOwner();
  const [again, showAgain] = useShowAgain(side);
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 py-2 pr-2 pl-3">
        <span className="shrink-0 text-[13px] font-medium text-ink">{side.label}</span>
        {side.note && (
          <span className="min-w-0 text-[12px] text-ink-3">
            <RichText rich={side.note} />
          </span>
        )}
        {side.empty && (
          <span className="flex min-w-0 items-start gap-1.5 text-[12px] leading-relaxed text-ink-3">
            {side.empty.tone === "green" && <span className="mt-[0.2em] shrink-0">{GREEN_TICK}</span>}
            <span>{side.empty.text}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {side.open && (
            <ButtonLink href={side.open} variant="secondary" size="xs" external>
              {ui.open}
              <ArrowOut />
            </ButtonLink>
          )}
          {side.again &&
            (again === "working" ? (
              <LoadingState label={ui.preview_again_working} />
            ) : owner.state === "yes" ? (
              <Button variant="secondary" size="xs" onClick={showAgain}>
                {side.again.label}
              </Button>
            ) : null)}
        </span>
      </div>
      {typeof again === "object" && (
        <div className="px-3 pb-3">
          <Failure text={again.error} detail={again.detail} />
        </div>
      )}
    </div>
  );
}

type Mode = "idle" | "approve" | "deny";

/**
 * The decision, as a RecommendationCard: the question, the change, how well it was checked, and two actions.
 * Each action opens the card's drawer to confirm; a one-way change asks for the box to be ticked first.
 */
function DecisionCard({ model }: { model: ChangeModel }) {
  const ui = useUi();
  const owner = useOwner();
  const d = model.decision;
  const [mode, setMode] = useState<Mode>("idle");
  const [ticked, setTicked] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  // One decision at a time: a second click while one is on its way, or while the page moves on after it, sends nothing.
  const sending = useRef(false);
  const can = owner.state === "yes";

  const go = async (verb: "approve" | "deny") => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const result = await act(verb === "approve" ? d.approveUrl : d.denyUrl, verb === "deny" && reason.trim() ? { reason: reason.trim() } : {}, model.access);
    if (result.ok && !(verb === "approve" && result.data.status === "rejected")) {
      // Still working until the next view is here: the buttons stay off.
      location.href = verb === "approve" ? d.doneLive : d.doneNo;
      return;
    }
    sending.current = false;
    setBusy(false);
    if (result.lost) return owner.lose();
    const why = model.reasons[String(result.data.reason ?? "")] ?? ui.why_other;
    setFailure({
      text: result.ok ? fill(ui.not_released, { why }) : refusalText(model.refusals, result.data, ui.failed),
      detail: String(result.data.detail ?? result.data.error ?? ""),
    });
  };

  const open = (next: Mode) => {
    setFailure(null);
    setTicked(false);
    setMode(next);
  };

  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-pad">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink">{ui.why_title}</h3>
          {d.oneWay && <StatePill tone="red">{ui.one_way}</StatePill>}
        </div>
        {model.oneWay && (
          <div className="space-y-1.5 border-s-2 border-red ps-3 text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]">
            <p className="font-medium text-red">{model.oneWay.body}</p>
            {model.oneWay.why && <p>{model.oneWay.why}</p>}
            {model.oneWay.said && <p className="font-medium">{model.oneWay.said}</p>}
          </div>
        )}
        {model.why.map((line) => (
          <p key={line} className="my-1 flex items-start gap-2 text-[13px] font-medium leading-relaxed text-ink">
            {badgeFor("caution")}{line}
          </p>
        ))}
        {d.blocked && can && <p className="mt-2 rounded-control bg-orange-tint px-2.5 py-2 text-[12.5px] leading-relaxed text-orange">{d.blocked}</p>}
      </div>

      <Drawer open={mode === "approve"}>
        <p className="pb-1 text-[11px] font-medium text-ink-3">{ui.confirm_title}</p>
        <ul className="flex flex-col gap-1">
          {[...d.lines, ...(d.marks ? [d.marks] : [])].map((line) => (
            <li key={line} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-2">
              <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-ink-3" />
              {line}
            </li>
          ))}
        </ul>
        {d.check && (
          <div className="mt-2">
            <CheckOption checked={ticked} onChange={setTicked} disabled={busy}>
              {d.check}
            </CheckOption>
          </div>
        )}
        {failure && mode === "approve" && <Failure text={failure.text} detail={failure.detail} />}
      </Drawer>

      <Drawer open={mode === "deny"}>
        <p className="pb-1 text-[11px] font-medium text-ink-3">{ui.deny_title}</p>
        <p className="text-[12.5px] leading-relaxed text-ink-2">{ui.deny_body}</p>
        <div className="mt-1.5">
          <FieldRow value={reason} onChange={setReason} placeholder={ui.deny_reason} label={ui.deny_reason} maxLength={500} />
        </div>
        {failure && mode === "deny" && <Failure text={failure.text} detail={failure.detail} />}
      </Drawer>

      <div className="primitive-card-footer flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-surface">
        {busy ? (
          <span className="pl-0.5">
            <LoadingState label={ui.working} />
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2 pl-0.5">
            <Meter signal={d.signal} tone={TONE_VAR[d.signalTone]} />
            <span className="truncate text-[12.5px] font-medium text-ink-2">{d.signalLabel}</span>
          </span>
        )}
        {can ? (
          <span className="-mr-0.5 ml-auto flex items-center gap-2">
            {mode === "idle" ? (
              <>
                <Button variant="secondary" size="sm" className="px-2.5 text-[12.5px]" onClick={() => open("deny")}>
                  {ui.deny}
                </Button>
                <Button variant="accent" size="sm" className="text-[12.5px]" disabled={Boolean(d.blocked)} onClick={() => open("approve")}>
                  {ui.approve}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="px-2.5 text-[12.5px]" disabled={busy} onClick={() => open("idle")}>
                  {ui.cancel}
                </Button>
                {mode === "approve" ? (
                  <Button variant="accent" size="sm" className="text-[12.5px]" disabled={busy || (Boolean(d.check) && !ticked)} onClick={() => go("approve")}>
                    {ui.confirm_go}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" className="text-[12.5px]" disabled={busy} onClick={() => go("deny")}>
                    {ui.deny_go}
                  </Button>
                )}
              </>
            )}
          </span>
        ) : (
          <span className="w-full px-0.5 text-[12px] leading-relaxed text-ink-3 sm:w-auto sm:max-w-[60%] sm:text-right">{owner.state === "checking" ? ui.owner_checking : ui.read_only_decide}</span>
        )}
      </div>
    </div>
  );
}

export function ChangeView({ model, onSearch }: { model: ChangeModel; onSearch: () => void }) {
  const ui = useUi();
  const crumbs = [{ text: ui.my_apps, href: model.links.home }, { text: model.appTitle, href: model.appHref }, { text: ui.change_title }];
  if (model.gone) {
    return (
      <>
        <Header crumbs={crumbs} title={model.intent} onSearch={onSearch}
          action={<ButtonLink href={model.appHref} variant="secondary">{model.appTitle}</ButtonLink>} />
      </>
    );
  }
  return (
    <>
      <Header
        crumbs={crumbs}
        title={model.intent}
        meta={<RichText rich={model.meta} />}
        pills={<StatePill tone="orange">{ui.waiting_title}</StatePill>}
        onSearch={onSearch}
      />
      <Section title={`${model.before.label} · ${model.after.label}`} aside={
        (model.after.open || (model.before.open && model.opensElsewhere)) && (
          <ContextNote label={ui.open_new}>
            {model.after.open && <span className="block">{ui.preview_open_hint}</span>}
            {model.opensElsewhere}
          </ContextNote>
        )
      }>
        <Surface>
          {model.picturesOn ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SideCard side={model.before} name={model.name} />
              <SideCard side={model.after} name={model.name} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <SideRow side={model.before} />
              <SideRow side={model.after} />
            </div>
          )}
          {model.notices.length > 0 && (
            <div className="mx-auto mt-3 w-full max-w-[720px]">
              <TaskRows rows={model.notices.map(noticeRow)} />
            </div>
          )}
        </Surface>
      </Section>
      <Section title={ui.checked_title}>
        <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-2 rounded-card bg-surface px-3 py-2.5 text-[13px] shadow-card">
          {model.checked.map((row) => (
            <li key={row.text} className="min-w-0 max-w-full">
              {row.files?.length ? (
                <Collapsible label={row.text}>
                  <FileChips files={row.files.slice(0, 24)} more={row.files.length > 24 ? `+${row.files.length - 24}` : undefined} />
                </Collapsible>
              ) : (
                <span className="flex items-center gap-2 py-1 font-medium">
                  {badgeFor(row.tone === "caution" ? "caution" : "done")}{row.text}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={ui.decide_title} aside={<ContextNote label={ui.decision_title}>{ui.decide_lead}</ContextNote>}>
        <DecisionCard model={model} />
      </Section>
      <DetailsBlock facts={model.facts} />
    </>
  );
}
