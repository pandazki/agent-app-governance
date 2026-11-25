import { createContext, useContext, useEffect, useState } from "react";
import type { Lang, OwnerAccess, PageModel } from "./model";

export const PageContext = createContext<PageModel>(null as unknown as PageModel);
export const usePage = () => useContext(PageContext);
export const useUi = () => useContext(PageContext).ui;

// --- time -------------------------------------------------------------------

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en");

export function relativeTime(lang: Lang, iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const diff = at - now;
  const format = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  return format.format(0, "minute");
}

/** In the reader's own time zone. */
export function absoluteTime(lang: Lang, iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** The current minute: relative times re-render once a minute. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// --- owner ------------------------------------------------------------------

const OWNER_KEY = "appgov-owner";

export const ownerToken = {
  get(): string | null {
    try {
      return sessionStorage.getItem(OWNER_KEY);
    } catch {
      return null;
    }
  },
  drop(): void {
    try {
      sessionStorage.removeItem(OWNER_KEY);
    } catch {}
  },
};

/**
 * "checking": this tab holds a token the Host has not confirmed yet. "yes": it may decide. "no": it holds none.
 * "lost": the Host no longer takes the one it held. "off": the Host has no owner link at all.
 */
export type OwnerState = "checking" | "yes" | "no" | "lost" | "off";

export const OwnerContext = createContext<{ state: OwnerState; lose: () => void }>({ state: "no", lose: () => {} });
export const useOwner = () => useContext(OwnerContext);

/**
 * With an owner link (the local edition), a tab that holds a token asks the Host whether it still takes it. Signed in
 * (the Cloudflare edition), a view with data was served to the session, so the tab may decide until a write says the
 * session has ended.
 */
export function useOwnerState(off: boolean, access: OwnerAccess = { kind: "owner-link" }): { state: OwnerState; lose: () => void } {
  const session = access.kind === "session";
  const [state, setState] = useState<OwnerState>(() => (session ? "yes" : off ? "off" : ownerToken.get() ? "checking" : "no"));
  useEffect(() => {
    if (state !== "checking" || session) return;
    const token = ownerToken.get();
    if (!token) return setState("no");
    let live = true;
    fetch("/owner/session", { method: "POST", headers: { "content-type": "application/json", "x-appgov-owner": token }, body: "{}" })
      .then((res) => {
        if (!live) return;
        if (res.ok) setState("yes");
        else {
          ownerToken.drop();
          setState("lost");
        }
      })
      .catch(() => live && setState("no"));
    return () => {
      live = false;
    };
  }, [state]);
  useEffect(() => {
    document.documentElement.dataset.owner = state;
  }, [state]);
  return {
    state,
    lose: () => {
      if (!session) ownerToken.drop();
      setState("lost");
    },
  };
}

export interface ActResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data: Record<string, unknown>;
  /** The owner token was refused, or the Host has no owner link: the tab can no longer decide. */
  readonly lost: boolean;
}

/** The header that authorises a write: the owner link's token, or this session's own token next to its cookie. */
function writeHeaders(access: OwnerAccess): Record<string, string> | null {
  if (access.kind === "session") return { "content-type": "application/json", "x-appgov-csrf": access.csrf };
  const token = ownerToken.get();
  return token ? { "content-type": "application/json", "x-appgov-owner": token } : null;
}

/** Refusals that mean this tab can no longer decide: the owner link is not taken, or the sign-in has ended. */
const LOST = new Set(["owner_link_required", "owner_page_off", "signed_out"]);

/** One of the page's own writes. It carries what `access` authorises it with and nothing else. */
export async function act(url: string, body: Record<string, unknown>, access: OwnerAccess = { kind: "owner-link" }): Promise<ActResult> {
  const headers = writeHeaders(access);
  if (!headers) return { ok: false, status: 0, data: {}, lost: true };
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data, lost: LOST.has(String(data.reason ?? "")) };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err) }, lost: false };
  }
}

/** A line the next view of this tab says once, under its "Done", after a write that navigated to it. */
export const sayNext = {
  set(text: string): void {
    try {
      sessionStorage.setItem("appgov-say-next", text);
    } catch {}
  },
  peek(): string | null {
    try {
      return sessionStorage.getItem("appgov-say-next");
    } catch {
      return null;
    }
  },
  drop(): void {
    try {
      sessionStorage.removeItem("appgov-say-next");
    } catch {}
  },
};

// --- words ------------------------------------------------------------------

export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

/** A stable colour per app for its monogram, from the library's own status hues. */
const HUES = ["#e08a3c", "#25a878", "#16a6c7", "#7c6cf0", "#e0598b", "#8a8f98"];
export function hue(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
