// The owner page's client: reads the view's data the Host put in the page (an inert JSON element), and lays it
// out with Beautiful UI's components. It renders data as text only; links it follows are the ones the Host built.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import LoadingState from "../beautifui/primitives/LoadingState";
import SearchPalette from "../beautifui/primitives/SearchPalette";
import { PageColumn } from "../beautifui/site";
import { hue, OwnerContext, PageContext, useOwnerState } from "./lib";
import type { PageModel } from "./model";
import { View } from "./view";

/**
 * While the browser fetches the next view: a view is built when it is asked for, and on the Cloudflare edition that
 * can mean starting the app's container first, a second or more. Shown only when it takes longer than a moment.
 */
function useNavigating(): boolean {
  const [navigating, setNavigating] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.hasAttribute("download") || anchor.origin !== location.origin) return;
      clearTimeout(timer);
      timer = setTimeout(() => setNavigating(true), 250);
    };
    // Coming back to this page from the browser's cache: whatever was on its way has gone.
    const shown = () => {
      clearTimeout(timer);
      setNavigating(false);
    };
    document.addEventListener("click", click);
    window.addEventListener("pageshow", shown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", click);
      window.removeEventListener("pageshow", shown);
    };
  }, []);
  return navigating;
}

function Page({ model }: { model: PageModel }) {
  const owner = useOwnerState(model.ownerOff, model.access);
  const [searching, setSearching] = useState(false);
  const onSearch = () => setSearching(true);
  const navigating = useNavigating();
  const signIn = model.view === "signin";

  useEffect(() => {
    if (signIn) return;
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [signIn]);

  // "It's live now" is said once: a reload does not say it again.
  useEffect(() => {
    if (!model.done) return;
    const url = new URL(location.href);
    url.searchParams.delete("done");
    history.replaceState(null, "", url.pathname + url.search);
  }, [model.done]);

  return (
    <PageContext.Provider value={model}>
      <OwnerContext.Provider value={owner}>
        <PageColumn>
          <View model={model} onSearch={onSearch} />
        </PageColumn>
        {navigating && (
          <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
            <span className="rounded-full bg-surface px-3 py-1.5 shadow-overlay" style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <LoadingState label={model.ui.loading} />
            </span>
          </div>
        )}
        {!signIn && (
        <SearchPalette
          open={searching}
          onClose={() => setSearching(false)}
          labels={{ placeholder: model.ui.search_placeholder, ariaLabel: model.ui.search_label, clearLabel: model.ui.clear, emptyTitle: model.ui.search_empty, emptyHint: model.ui.search_keys }}
          items={model.search.map((entry) => ({ key: entry.name, title: entry.title, sub: entry.words ? `${entry.stateLabel} · ${entry.words}` : entry.stateLabel, href: entry.href, mark: entry.monogram, color: hue(entry.name) }))}
          match={(item, terms) => {
            const entry = model.search.find((e) => e.name === item.key);
            const hay = `${item.title} ${item.key} ${entry?.words ?? ""} ${entry?.stateLabel ?? ""}`.toLowerCase();
            return terms.every((term) => hay.includes(term));
          }}
        />
        )}
      </OwnerContext.Provider>
    </PageContext.Provider>
  );
}

function start() {
  const source = document.getElementById("model");
  const root = document.getElementById("root");
  if (!source || !root) return;
  const model = JSON.parse(source.textContent || "{}") as PageModel;

  // The language the person chose last time, unless the address names one.
  const params = new URLSearchParams(location.search);
  try {
    const saved = localStorage.getItem("appgov-lang");
    if (!params.has("lang") && (saved === "en" || saved === "zh") && saved !== model.lang) {
      params.set("lang", saved);
      location.replace(`${location.pathname}?${params.toString()}`);
      return;
    }
  } catch {}

  createRoot(root).render(
    <StrictMode>
      <Page model={model} />
    </StrictMode>,
  );
}

start();
