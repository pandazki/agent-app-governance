import { useState } from "react";
import { buttonVariants } from "../beautifui/atoms/Button";
import TaskRows, { TaskDetail, TaskPill, type TaskRow, type TaskStatus } from "../beautifui/primitives/TaskRows";
import { Collapsible, FileChips } from "../beautifui/primitives/ToolChips";
import { Section, Surface } from "../beautifui/site";
import { fill, useUi } from "./lib";
import type { AppModel, HistoryRow, RowBadge, Tone } from "./model";
import { noticeRow } from "./change-view";
import { Address, ArrowOut, ButtonLink, Details, Header, HintCard, Picture, RichText, StatePill } from "./parts";
import { ContextNote } from "../beautifui/primitives/ContextNote";
import { RuntimeCheck, CheckResult, LifeBlock } from "./life-view";

const BADGE_STATUS: Record<RowBadge, TaskStatus> = { done: "done", failed: "failed", waiting: "waiting", plain: "plain", undo: "undo" };
const TONE_TEXT: Record<Tone, string> = { green: "text-green", red: "text-red", orange: "text-orange", neutral: "text-ink-2", accent: "text-accent-ink" };

function historyRow(row: HistoryRow, ui: AppModel["ui"]): TaskRow {
  return {
    key: row.id,
    label: row.title,
    amount: row.when.parts.length ? <RichText rich={row.when} /> : undefined,
    status: BADGE_STATUS[row.badge],
    pill: row.pill ? <TaskPill tone={row.pill.tone === "accent" ? "accent" : row.pill.tone}>{row.pill.label}</TaskPill> : undefined,
    defaultOpen: row.badge === "waiting" || Boolean(row.oneWay),
    details: (
      <>
        {row.standing && (
          <p className={`text-[12.5px] leading-relaxed ${TONE_TEXT[row.standingTone]}`}>
            <RichText rich={row.standing} />
          </p>
        )}
        <TaskDetail label={<RichText rich={row.who} />} />
        {row.note && <TaskDetail label={row.note} />}
        {row.snapshot && <TaskDetail label={row.snapshot} />}
        {row.oneWay && (
          <div className="rounded-control bg-red-tint px-2.5 py-2 text-[12px] leading-relaxed text-red">
            <p className="font-medium">{ui.one_way}</p>
            <p className="mt-0.5">{row.oneWay.body}</p>
            {row.oneWay.why && <p className="mt-0.5 opacity-80 [overflow-wrap:anywhere]">{row.oneWay.why}</p>}
            {row.oneWay.said && <p className="mt-0.5 opacity-80 [overflow-wrap:anywhere]">{row.oneWay.said}</p>}
          </div>
        )}
        {row.files.length > 0 && (
          <div className="pt-1">
            <FileChips files={row.files.slice(0, 6)} more={row.files.length > 6 ? `+${row.files.length - 6}` : undefined} />
          </div>
        )}
        {(row.review || row.back) && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {row.review && (
              <ButtonLink href={row.review} variant="accent" size="sm" className="text-[12.5px]">
                {ui.review}
              </ButtonLink>
            )}
            {row.back && (
              <ButtonLink href={row.back} variant="secondary" size="sm" className="text-[12.5px]">
                {ui.go_back}
              </ButtonLink>
            )}
          </div>
        )}
        <div className="pt-0.5">
          <Details facts={row.facts} />
        </div>
      </>
    ),
  };
}

export function AppView({ model, onSearch }: { model: AppModel; onSearch: () => void }) {
  const ui = useUi();
  const [all, setAll] = useState(model.historyAll === true);
  const rows = model.history.map((row) => historyRow(row, ui));
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <>
      <Header
        crumbs={[{ text: ui.my_apps, href: model.links.home }, { text: model.appTitle }]}
        title={model.appTitle}
        meta={<RichText rich={model.meta} />}
        pills={<StatePill tone={model.tone}>{model.stateLabel}</StatePill>}
        onSearch={onSearch}
      />
      {model.waiting.length > 0 && (
        <Section title={ui.waiting_title} aside={<ContextNote label={ui.waiting_title}>{ui.section_waiting_hint}</ContextNote>}>
          <Surface>
            <div className="flex flex-col gap-2">
              {model.waiting.map((w) => (
                <div key={w.href} className="flex items-center gap-3 overflow-hidden rounded-card bg-surface py-2 pr-2 pl-3 shadow-card">
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{w.intent}</span>
                  <a href={w.href} className={`${buttonVariants({ variant: "accent", size: "sm" })} shrink-0 text-[12.5px]`}>
                    {ui.review}
                  </a>
                </div>
              ))}
            </div>
          </Surface>
        </Section>
      )}
      <Section title={model.serving ? ui.running_now : ui.not_running} note={model.shot.taken ? <RichText rich={model.shot.taken} /> : undefined}>
        <div className={`flex flex-col gap-2 ${model.picturesOn && model.serving ? "mx-auto max-w-[720px]" : ""}`}>
          <div className="overflow-hidden rounded-card bg-surface shadow-card">
            <div className="flex min-h-12 items-center gap-1 px-3 py-1.5">
              {model.address ? (
                <a href={model.address} target="_blank" rel="noopener noreferrer" className="address-link">
                  <Address text={model.addressText} />
                  <ArrowOut size={13} /><span className="sr-only">{ui.open_new}</span>
                </a>
              ) : <span className="min-w-0 font-mono text-[12px] text-ink-2"><Address text={model.addressText} /></span>}
              <div className="ml-auto flex shrink-0 items-center">
                {model.address && model.opensElsewhere && <ContextNote label={`${ui.details} · ${ui.open_new}`}>{model.opensElsewhere}{model.checked && <span className="mt-1 block"><RichText rich={model.checked.text} /></span>}</ContextNote>}
                {model.checked && <RuntimeCheck checked={model.checked} />}
              </div>
            </div>
            {model.picturesOn && (model.serving || model.shot.src) ? (
              model.address ? <a href={model.address} target="_blank" rel="noopener noreferrer" aria-label={ui.open_new} className="block border-t border-line">
                <Picture shot={model.shot} name={model.name} />
              </a> : <Picture shot={model.shot} name={model.name} className={model.serving ? "" : "opacity-60 grayscale"} />
            ) : !model.serving && model.shot.caption && model.picturesOn ? (
              <p className="px-3 pb-2 text-[12px] text-ink-3">{model.shot.caption}</p>
            ) : null}
          </div>
          {model.notices.length > 0 && <TaskRows rows={model.notices.map(noticeRow)} />}
          {model.checked && <CheckResult checked={model.checked} />}
        </div>
      </Section>
      <Section title={ui.history_title} note={model.history.length ? String(model.history.length) : undefined}>
        <Surface>
          {model.historyError ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-ink-3">{model.historyError}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <TaskRows rows={shown} />
              {rows.length > shown.length ? (
                <button type="button" onClick={() => setAll(true)} className={`${buttonVariants({ variant: "secondary", size: "xs" })} self-center`}>
                  {fill(ui.show_earlier, { n: rows.length - shown.length })}
                </button>
              ) : model.earlier ? (
                <ButtonLink href={model.earlier.href} variant="secondary" size="xs" className="self-center">
                  {model.earlier.label}
                </ButtonLink>
              ) : null}
            </div>
          )}
        </Surface>
      </Section>
      {model.hint && (
        <div className="px-5 pt-4 sm:px-8">
          <Collapsible label={ui.hint_title}>
            <div className="max-w-[560px]"><HintCard hint={model.hint} /></div>
          </Collapsible>
        </div>
      )}
      {/* Taking the app down and clearing it are not everyday acts: they sit with the app's details, open while it is not there. */}
      <div className="flex flex-col gap-1.5 px-5 py-4 sm:px-8">
        {model.life && (
          <Collapsible label={ui.life_title} defaultOpen={model.life.open}>
            <LifeBlock life={model.life} />
          </Collapsible>
        )}
        <Details facts={model.facts} checked={model.checked} />
      </div>
    </>
  );
}
