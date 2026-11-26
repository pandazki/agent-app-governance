// The owner page's own parts, composed from Beautiful UI's primitives (web/beautifui). Everything that came from
// the record or an app is rendered as text by React; no markup from data is ever inserted.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "../beautifui/atoms/Button";
import { Monogram } from "../beautifui/atoms/EntityChip";
import { Collapsible } from "../beautifui/primitives/ToolChips";
import { TaskPill } from "../beautifui/primitives/TaskRows";
import { SentPill } from "../beautifui/primitives/Recommendation";
import { SegmentLinks, ThemeToggle } from "../beautifui/site";
import { absoluteTime, act, hue, isMac, relativeTime, sayNext, useNow, useOwner, usePage, useUi } from "./lib";
import type { Fact, Hint, Rich, Shot, Tone } from "./model";

// --- words and moments ----------------------------------------------------------

export function RichText({ rich }: { rich: Rich }) {
  const { lang } = usePage();
  const now = useNow();
  return (
    <>
      {rich.parts.map((stamp, i) => {
        if (typeof stamp === "string") return <span key={i}>{stamp}</span>;
        return (
          <time key={i} dateTime={stamp.at} title={absoluteTime(lang, stamp.at)}>
            {stamp.mode === "rel" ? relativeTime(lang, stamp.at, now) : absoluteTime(lang, stamp.at)}
          </time>
        );
      })}
    </>
  );
}

// --- icons ------------------------------------------------------------------------

export const ArrowOut = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17L17 7M7 7h10v10" />
  </svg>
);

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

// --- links that look like the library's buttons and chips -------------------------

export function ButtonLink({ href, variant, size = "sm", external, children, className = "" }: { href: string; variant: "primary" | "secondary" | "ghost" | "accent" | "quiet"; size?: "xs" | "sm" | "md"; external?: boolean; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={`${buttonVariants({ variant, size })} ${className}`} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

/** ContextCards' source chip, as a link out. */
export function SourceChip({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full bg-inset px-2 text-[12px] font-medium text-ink-2 shadow-btn transition-[background-color,color] duration-150 hover:bg-hover hover:text-ink"
    >
      <span className="truncate">{children}</span>
      <ArrowOut />
    </a>
  );
}

const TONE_PILL: Record<Tone, "green" | "red" | "orange" | "neutral" | "accent"> = { neutral: "neutral", green: "green", orange: "orange", red: "red", accent: "accent" };

export function StatePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <TaskPill tone={TONE_PILL[tone]}>{children}</TaskPill>;
}

export function AppMark({ name, mark }: { name: string; mark: string }) {
  return <Monogram color={hue(name)}>{mark}</Monogram>;
}

// --- pictures -----------------------------------------------------------------

/** A stored picture of an app, or its placeholder. A picture that does not load leaves the placeholder. */
export function Picture({ shot, name, className = "" }: { shot: Shot; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const show = shot.src && !failed;
  return (
    <div className={`relative aspect-[16/10] w-full overflow-hidden bg-inset ${className}`}>
      {show ? (
        <img src={shot.src!} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover object-top" />
      ) : (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center"
          style={{ backgroundImage: "repeating-linear-gradient(-45deg, transparent 0, transparent 7px, var(--stripe) 7px, var(--stripe) 8px)" }}
        >
          <span className="flex size-8 items-center justify-center rounded-control text-[12px] font-semibold text-white shadow-hairline" style={{ background: hue(name) }}>
            {shot.monogram}
          </span>
          {shot.caption && <span className="max-w-64 text-[12px] text-ink-3 text-pretty">{shot.caption}</span>}
        </div>
      )}
    </div>
  );
}

// --- the header -----------------------------------------------------------------

export function Crumbs({ items }: { items: { text: string; href?: string }[] }) {
  // On a phone there is room for one step back, not the whole trail.
  const up = [...items].reverse().find((item) => item.href);
  return (
    <>
    {up && (
      <a href={up.href} className="-ml-1 flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink sm:hidden">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
        <span className="truncate">{up.text}</span>
      </a>
    )}
    <nav aria-label="Breadcrumb" className={`min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3 ${up ? "hidden sm:flex" : "flex"}`}>
      {items.map((item, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden className="text-line-strong">/</span>}
          {item.href ? (
            <a href={item.href} className="truncate transition-colors duration-150 hover:text-ink">
              {item.text}
            </a>
          ) : (
            <span aria-current="page" className="truncate text-ink-2">
              {item.text}
            </span>
          )}
        </span>
      ))}
    </nav>
    </>
  );
}

/** The owner's standing in this tab, as a quiet pill; it opens a small card that says how deciding works. */
export function OwnerPill() {
  const page = usePage();
  const ui = page.ui;
  const session = page.access.kind === "session";
  const { state } = useOwner();
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    await act("/owner/signout", {}, page.access);
    location.href = page.links.home;
  };
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const yes = state === "yes";
  const label = state === "checking" ? ui.owner_checking : yes ? ui.owner_yes : session ? ui.owner_signed_out : ui.owner_no;
  const tone = state === "lost" ? "text-orange" : "text-ink-2";
  const panelId = useId();
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)} className={`context-trigger rounded-full bg-field ${tone}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
          <circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c0-4.3 3.2-7 7.5-7s7.5 2.7 7.5 7" />
        </svg>
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label={ui.owner_help_title} className="absolute right-0 top-10 z-40 w-[min(20rem,calc(100vw-2.5rem))] overflow-hidden rounded-card bg-surface shadow-overlay" style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}>
          <div className="primitive-card-pad">
            <p className="text-[13px] font-semibold text-ink">{label}</p>
            <p className="mt-2 text-[12.5px] font-medium text-ink">{ui.owner_help_title}</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{state === "off" ? ui.owner_off : state === "lost" ? ui.owner_lost : ui.owner_help}</p>
            {session && yes && (
              <div className="mt-3 flex justify-end">
                <Button variant="secondary" size="sm" className="text-[12.5px]" disabled={leaving} onClick={signOut}>
                  {ui.sign_out}
                </Button>
              </div>
            )}
            {!yes && state !== "off" && !session && (
              <>
                <p className="mt-2 text-[12px] text-ink-3">{ui.owner_how}</p>
                <code className="mt-1 block rounded-chip bg-field px-1.5 py-1 font-mono text-[11px] text-ink-2 shadow-hairline">[host] owner link …/#owner=…</code>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SearchButton({ onOpen }: { onOpen: () => void }) {
  const ui = useUi();
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(isMac()), []);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ui.search_open}
      className="inline-flex h-9 items-center gap-2 rounded-full bg-field px-3 text-[12px] font-medium text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.96] max-sm:w-9 max-sm:justify-center max-sm:px-0"
    >
      <SearchIcon />
      <span className="max-sm:hidden">{ui.search}</span>
      <kbd className="rounded-[4px] bg-surface px-1 font-mono text-[10.5px] text-ink-3 shadow-hairline max-sm:hidden">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

export function Header({
  crumbs,
  title,
  meta,
  pills,
  action,
  onSearch,
  bare,
}: {
  crumbs: { text: string; href?: string }[];
  title: ReactNode;
  meta?: ReactNode;
  pills?: ReactNode;
  action?: ReactNode;
  onSearch?: () => void;
  /** Before signing in: no search and no owner pill, only the language and the theme. */
  bare?: boolean;
}) {
  const page = usePage();
  const owner = useOwner();
  const ui = page.ui;
  // What the write that led here left to say, once, under its "Done" (going back: what stays in stored data).
  const [said] = useState(() => (page.done ? sayNext.peek() : null));
  useEffect(() => sayNext.drop(), []);
  const remember = (lang: string) => () => {
    try {
      localStorage.setItem("appgov-lang", lang);
    } catch {}
  };
  return (
    // Above the sections, whose entry animation makes each its own layer: the owner card opens over them.
    <header className="relative z-20 border-b border-dashed border-line px-5 pt-5 pb-5 sm:px-8 sm:pt-6 sm:pb-6">
      <div className="flex items-center justify-between gap-2">
        {crumbs.some(c => c.href) ? <Crumbs items={crumbs} /> : <span />}
        <div className="flex shrink-0 items-center gap-2">
          {!bare && onSearch && <SearchButton onOpen={onSearch} />}
          <SegmentLinks
            label={ui.language}
            active={page.lang}
            items={[
              { key: "en", text: "EN", href: page.links.en, onPick: remember("en") },
              { key: "zh", text: "中", href: page.links.zh, onPick: remember("zh") },
            ]}
          />
          <ThemeToggle labels={{ light: ui.theme_light, dark: ui.theme_dark }} />
          {!bare && <OwnerPill />}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-3 sm:mt-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[23px] leading-snug font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{title}</h1>
            {pills}
          </div>
          {meta && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{meta}</p>}
          {!bare && owner.state !== "yes" && <p className="mt-1 text-[12px] text-ink-2">{owner.state === "checking" ? ui.owner_checking : owner.state === "lost" ? ui.owner_lost : ui.owner_no}</p>}
        </div>
        {action}
      </div>
      {page.done && (
        <div className="mt-4">
          <SentPill>{page.done}</SentPill>
          {said && <p className="mt-2 max-w-[640px] text-[12.5px] leading-relaxed text-ink-2">{said}</p>}
        </div>
      )}
    </header>
  );
}

// --- "Details" ------------------------------------------------------------------

export function Details({ facts, label }: { facts: readonly Fact[]; label?: string }) {
  const ui = useUi();
  if (!facts.length) return null;
  return (
    <Collapsible label={label ?? ui.details}>
      <dl className="flex flex-col gap-1.5 py-0.5">
        {facts.map((fact, i) => (
          <div key={i} className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
            <dt className="text-[11.5px] text-ink-3">{fact.label}</dt>
            <dd className={`min-w-0 text-ink-2 [overflow-wrap:anywhere] ${fact.mono ? "font-mono text-[11.5px] leading-[1.6]" : "text-[12px] leading-relaxed"}`}>
              {fact.href ? (
                <a href={fact.href} target="_blank" rel="noopener noreferrer" className="underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink hover:decoration-current">
                  {fact.value}
                </a>
              ) : (
                fact.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Collapsible>
  );
}

/** The last block of a view: no number, no title, the Details disclosure alone. */
export function DetailsBlock({ facts }: { facts: readonly Fact[] }) {
  if (!facts.length) return null;
  return (
    <div className="px-5 py-4 sm:px-8">
      <Details facts={facts} />
    </div>
  );
}

// --- the hint: what to tell the agent ---------------------------------------------

export function Copy({ text }: { text: string }) {
  const ui = useUi();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {}
      area.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" onClick={copy} className={`${buttonVariants({ variant: "secondary", size: "xs" })} min-w-16`} aria-live="polite">
      {done ? (
        <span className="inline-flex items-center gap-1 text-green">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
          {ui.copied}
        </span>
      ) : (
        ui.copy
      )}
    </button>
  );
}

/**
 * The page's one-line text field, as the sign-in screen asks for the owner key: also where a confirmation asks for a
 * typed name. Monospace for what is typed exactly; the placeholder in the page's own font.
 */
export function TextField({
  value,
  onChange,
  label,
  placeholder,
  type = "text",
  name,
  autoComplete = "off",
  autoFocus = false,
  disabled = false,
  maxLength,
  help,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  help?: ReactNode;
  error?: string | null;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">{label}</label>
        {help}
      </div>
      <input id={id} type={type} name={name} value={value} onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false} placeholder={placeholder}
        disabled={disabled} maxLength={maxLength} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="owner-input" />
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-[13px] font-medium leading-relaxed text-red">{error}</p>}
    </div>
  );
}

export function HintCard({ hint, title }: { hint: Hint; title?: string }) {
  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-pad">
        {title && <p className="text-[14px] font-medium text-ink">{title}</p>}
        <p className={`${title ? "mt-1.5" : ""} text-[13px] leading-relaxed text-ink-2`}>{hint.body}</p>
      </div>
      <div className="primitive-card-footer flex items-start gap-3 border-t border-line bg-inset">
        <p className="min-w-0 flex-1 px-1 py-1 text-[12.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">{hint.example}</p>
        <Copy text={hint.example} />
      </div>
    </div>
  );
}

/** Empty panels keep their explanation at reading height. An affirmative result can supply its own icon. */
export function EmptyState({ title, body, icon }: { title: string; body?: string; icon?: ReactNode }) {
  return (
    <div className="px-4 py-4 text-center">
      <p className="text-[14px] font-medium leading-relaxed text-ink">
        {icon && <span aria-hidden className="mr-1.5 inline-flex align-middle">{icon}</span>}
        {title}
      </p>
      {body && <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</p>}
    </div>
  );
}
