// Types only from the Host, and its fixed strings from a module without imports: this file runs in the Cloudflare
// edition's Worker as well, where the Host's own code does not.
import type { HistoryEntry } from "../../host/src/artifact";
import { RUN_UNDO, STATE_DIR } from "../../host/src/constants";
import type { AppStatus, AppSummary, Overview } from "../../host/src/host";
import { absoluteTime, agentWords, appTitle, fill, reasonWords, relativeTime, riskWords, wordsFor, type Lang, type Words } from "./page-words";
import type {
  AppCard,
  AppModel,
  AppState,
  BackModel,
  ChangeModel,
  CheckRow,
  Fact,
  HistoryRow,
  HomeModel,
  MissingModel,
  Notice,
  OwnerAccess,
  PageModel,
  Problem,
  Rich,
  RowBadge,
  SearchEntry,
  Shot,
  Side,
  SignInModel,
  Stamp,
  Tone,
  Ui,
  UnreadableModel,
  WaitingCard,
} from "./page-model";
import { UI_KEYS } from "./page-model";

// The Host defines what `overview()` returns; the page reads it.
export type { Overview };

// ---------------------------------------------------------------------------
// The owner page: what a person, not a developer, sees of the apps their agents
// built. Four views: my apps, one app with its history, a change waiting for
// them, and going back. No chat and no app creation: the agent lives elsewhere.
//
// The server decides and words everything (this file and page-words.ts) and
// sends one view's data as JSON; the client in web/ lays it out with Beautiful
// UI's components. Strings from the record or an app (intents, agent names,
// reasons, file names, addresses) travel as data and are rendered as text; the
// JSON is escaped so nothing in it can end its <script> element. Technical terms
// stay under "Details". The page's own writes go through src/owner.ts and need
// the owner's link.
//
// The Cloudflare edition's Worker builds the same views from the same Host
// answers (cloudflare/worker/page.ts). What differs between the two is how the
// owner is let in (`OwnerAccess` in page-model.ts, `PageContext.access` here):
// an owner link here, a sign-in there. The rest that differs is what the
// context says about the deployment: whether pictures are taken, and whether
// the apps open behind a sign-in of their own.
// ---------------------------------------------------------------------------

export type { AppState } from "./page-model";

/** What `AppHost.overview()` returns: the summaries `GET /apps` returns, and per app what `status` and `history` return. */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for HTML content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]!);
}

/** JSON for inside a <script type="application/json">: nothing in it can close the element or start markup. */
export function json(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** A waiting change's preview as the Host reports it in `status`. */
export interface PreviewView {
  /** Where it is, while it stands. */
  readonly address: string | null;
  /** true: it stands. false: it ended itself or was discarded. null: the Host has no preview to report, or could not tell. */
  readonly standing: boolean | null;
  /** The Host asked the runtime and got no answer. */
  readonly unknown: boolean;
}

/**
 * A waiting change's preview, from the `preview` field `status` gives each waiting change: `{ state: "standing",
 * address }`, `{ state: "gone" }` or `{ state: "unknown" }`. A Host that publishes previews as ephemeral apps
 * derives the preview from the change id and asks the runtime whether it still stands; one that removes the
 * preview when the submit ends reports none. `status` passes on what the pending file holds, which the agent can
 * write, so callers check the address is an app on the runtime before using it.
 */
export function previewOf(pending: unknown): PreviewView {
  const none = { address: null, standing: null, unknown: false };
  if (typeof pending !== "object" || pending === null) return none;
  const preview = (pending as { preview?: unknown }).preview;
  if (typeof preview !== "object" || preview === null) return none;
  const { state, address } = preview as { state?: unknown; address?: unknown };
  if (state === "standing") return typeof address === "string" ? { address, standing: true, unknown: false } : none;
  if (state === "gone") return { address: null, standing: false, unknown: false };
  if (state === "unknown") return { address: null, standing: null, unknown: true };
  return none;
}

export interface Picture {
  /** The file name under the pictures directory; also its URL path segment. */
  readonly file: string;
  readonly at: string;
  /** The version pictured, or `pv-<change id>` for a preview. */
  readonly key: string;
  readonly kind: "version" | "preview";
  /**
   * The change that recorded the pictured version (or the waiting change, for a preview). A version name alone is
   * not enough: an app removed and created again under the same name starts at v1 again.
   */
  readonly change?: string;
}

export interface PictureMiss {
  readonly at: string;
  readonly reason: string;
  readonly detail?: string;
}

/** Pictures the page can show: the screenshot keeper, or nothing. */
export interface PictureLookup {
  readonly enabled: boolean;
  /** This Host never takes pictures (the Cloudflare edition): the placeholder says so, as a fact rather than a miss. */
  readonly never?: boolean;
  latest(name: string): Picture | null;
  preview(name: string, changeId: string): Picture | null;
  miss(name: string, key: string): PictureMiss | null;
}

export const NO_PICTURES: PictureLookup = { enabled: false, latest: () => null, preview: () => null, miss: () => null };
/** A Host that has no way to take pictures. */
export const NO_PICTURES_HERE: PictureLookup = { ...NO_PICTURES, never: true };

/** The local edition's: the owner link. */
export const OWNER_LINK: OwnerAccess = { kind: "owner-link" };

/** What every view needs besides its own data. */
export interface PageContext {
  readonly lang: Lang;
  readonly now: number;
  readonly pictures: PictureLookup;
  /** The path being shown, for the language links. */
  readonly path: string;
  /** Every app, for search and for each app's plain state. */
  readonly apps: readonly AppSummary[];
  /** Set after one of the page's own decisions went through: the view says so once. `_marked`: it also made this Host the app's manager on PneumaSpace. */
  readonly done?: "live" | "live_marked" | "no" | "back" | "back_marked";
  readonly governance?: string;
  readonly governanceNote?: string;
  readonly dataSnapshot?: string | null;
  readonly hostUrl?: string;
  readonly consoleUrl?: string;
  /** The risks the standing policy approves in this mode: a waiting change lists only the others as why it needs the owner. */
  readonly autoApproved?: readonly string[];
  /** The Host was started without an owner link. */
  readonly ownerOff?: boolean;
  /** The name this Host goes by on PneumaSpace as the manager of the apps it releases. */
  readonly manager?: string;
  /** How the owner is let in to decide; the owner link when not set. */
  readonly access?: OwnerAccess;
  /** The apps and their previews open on a runtime that asks the owner to sign in there too. */
  readonly appsSignIn?: boolean;
}

// The record and the waiting changes come from files an agent can write: any field may be missing or of another type.
const items = <T = unknown>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));
const list = (value: unknown, none = "—") => (items(value).length ? items(value).map(str).join(", ") : none);

function link(path: string, lang: Lang): string {
  return `${path}${path.includes("?") ? "&" : "?"}lang=${lang}`;
}

/** An address a person may open: http(s) only. */
function safeHref(url: unknown): string | null {
  try {
    const { protocol } = new URL(str(url));
    return protocol === "http:" || protocol === "https:" ? str(url) : null;
  } catch {
    return null;
  }
}

function stamp(ctx: PageContext, iso: unknown, mode: "rel" | "abs"): Stamp | null {
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return null;
  return { at: iso, mode, label: mode === "rel" ? relativeTime(ctx.lang, iso, ctx.now) : absoluteTime(ctx.lang, iso) };
}

/**
 * Words with values and moments in them, as parts: `template` is the page's own words, with `{name}` slots; a slot
 * in `vars` becomes that value as plain text (never read for slots again), a slot in `moments` becomes a moment the
 * page shows in the reader's time, and a moment that is missing leaves its slot empty.
 */
function rich(ctx: PageContext, template: string, vars: Readonly<Record<string, string | number>>, moments: Readonly<Record<string, { iso: unknown; mode: "rel" | "abs" }>> = {}): Rich {
  const parts: (string | Stamp)[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const key = m[1]!;
    if (!(key in vars) && !(key in moments)) continue;
    if (m.index > last) parts.push(template.slice(last, m.index));
    if (key in vars) parts.push(String(vars[key]));
    else {
      const s = stamp(ctx, moments[key]!.iso, moments[key]!.mode);
      if (s) parts.push(s);
    }
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return { parts };
}

const plain = (text: string): Rich => ({ parts: text ? [text] : [] });

function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 1)).toUpperCase();
}

/** Typographic quotes around the person's own words. */
const quoted = (text: unknown) => `“${str(text).trim()}”`;

const cli = (args: string) => `node ${STATE_DIR}/appgov.mjs ${args}`;

/** One part of a view, or a fallback: one malformed record does not take the page down. */
function guarded<T>(build: () => T, fallback: T): T {
  try {
    return build();
  } catch {
    return fallback;
  }
}

// --- the state of an app ---------------------------------------------------

/** One plain state per app, the most pressing first. */
export function appState(summary: AppSummary): AppState {
  if ("error" in summary) return "unreadable";
  if (items(summary.pending).length) return "waiting";
  if (summary.serving_uncertain) return "uncertain";
  if (summary.serves_other_version) return "not_live";
  if (!summary.active_version) return "unpublished";
  const last = summary.last_change;
  if (last && (last.outcome === "rejected" || last.outcome === "release_failed")) return "not_live";
  return "normal";
}

const STATE_TONE: Record<AppState, Tone> = { normal: "green", waiting: "orange", not_live: "red", uncertain: "neutral", unpublished: "neutral", unreadable: "neutral" };

function stateWords(w: Words, state: AppState): string {
  return w[`state_${state}`];
}

/**
 * Which of its two meanings `serving_uncertain` has (the Host's `servingUncertainLine`): `undo`, an undo that did
 * not finish, which refuses submit and approve until another undo answers; `answer`, an address nobody saw answer
 * after a release, which refuses nothing and the next release that answers settles.
 */
export function uncertainKind(line: unknown): "undo" | "answer" | null {
  const text = str(line);
  return text ? (text.endsWith(RUN_UNDO) ? "undo" : "answer") : null;
}

const PENDING_DIR = `${STATE_DIR}/pending/`;

/** The file a `malformed_pending` line names: the Host writes `<state dir>/pending/<file> is not a waiting change ...`. */
function malformedFile(line: unknown): string {
  const text = str(line);
  return text.startsWith(PENDING_DIR) ? (/^(\S+) is not /.exec(text.slice(PENDING_DIR.length))?.[1] ?? "") : "";
}

/** Who runs the app on PneumaSpace, as status asked: another manager blocks every write; nobody means the next write marks it. */
function managerOf(status: AppStatus): { readonly other: string | null; readonly unmanaged: boolean; readonly note: string } {
  const m = (status as { space_manager?: { state?: unknown; name?: unknown; note?: unknown } }).space_manager;
  return { other: m?.state === "other" ? str(m.name) || "?" : null, unmanaged: m?.state === "unmanaged", note: str(m?.note) };
}

/** What holds an app as a whole, in plain words, most pressing first. */
function situation(w: Words, status: AppStatus): Notice[] {
  const notices: Notice[] = [];
  const manager = managerOf(status);
  if (manager.other) notices.push({ tone: "red", text: fill(w.elsewhere_body, { manager: manager.other }) });
  const kind = uncertainKind(status.serving_uncertain);
  if (kind === "undo") notices.push({ tone: "red", text: w.uncertain_undo_body });
  else if (kind === "answer") notices.push({ tone: "orange", text: w.uncertain_answer_body });
  else if (status.serving_version && status.active_version && status.serving_version !== status.active_version) notices.push({ tone: "red", text: w.serves_other_body });
  return notices;
}

// --- pictures --------------------------------------------------------------

function liveKey(summary: { serving_version?: string | null; active_version?: string | null }): string | null {
  return summary.serving_version ?? summary.active_version ?? null;
}

/** The app's latest picture, or the placeholder with why there is none when the keeper tried. */
function shotOf(ctx: PageContext, name: string, picture: Picture | null, key: string | null, withTaken = false): Shot {
  const w = wordsFor(ctx.lang, ctx.access);
  const monogram = initials(appTitle(name));
  const miss = key ? ctx.pictures.miss(name, key) : null;
  // A version that asks visitors to sign in is not shown by an older picture: that would be the guest view of something else.
  if (picture && !(miss?.reason === "needs_sign_in" && picture.key !== key)) {
    return {
      src: `/pictures/${picture.file}`,
      monogram,
      caption: null,
      ...(withTaken ? { taken: rich(ctx, picture.key === key ? w.picture_taken : w.picture_older, {}, { when: { iso: picture.at, mode: "rel" } }) } : {}),
    };
  }
  if (!ctx.pictures.enabled) return { src: null, monogram, caption: noPicture(ctx) };
  return { src: null, monogram, caption: miss?.reason === "needs_sign_in" ? w.no_picture_sign_in : w.no_picture };
}

/** What the placeholder says when there is no picture to look for: nothing where pictures are turned off, that there are none where none are ever taken. */
function noPicture(ctx: PageContext): string | null {
  const w = wordsFor(ctx.lang, ctx.access);
  return ctx.pictures.enabled ? w.no_picture : ctx.pictures.never ? w.no_picture_here : null;
}

/**
 * The label of the agent token a credential names, or null. The Cloudflare edition's container writes an agent
 * token's credential as `agent token "<label>" (<id>)` (cloudflare/src/server.ts, `credentialOf`).
 */
export function tokenLabel(credential: unknown): string | null {
  const m = /^agent token ("(?:[^"\\]|\\.)*") \(t[0-9a-f]+\)$/.exec(str(credential));
  if (!m) return null;
  try {
    const label = JSON.parse(m[1]!) as unknown;
    return typeof label === "string" && label.trim() ? label : null;
  } catch {
    return null;
  }
}

/** "Codex · 5 minutes ago", or "Codex, with the token “laptop” · …" when an agent token is named. */
function whoWords(ctx: PageContext, template: { plain: string; token: string }, agent: unknown, credential: unknown, owner: string | undefined, when: { iso: unknown; mode: "rel" | "abs" }): Rich {
  const w = wordsFor(ctx.lang, ctx.access);
  const token = tokenLabel(credential);
  const who = agentWords(w, agent, owner);
  return token ? rich(ctx, template.token, { who, token }, { when }) : rich(ctx, template.plain, { who }, { when });
}

// --- what every view shares --------------------------------------------------

function searchEntries(ctx: PageContext): SearchEntry[] {
  const w = wordsFor(ctx.lang, ctx.access);
  return ctx.apps.map((summary) => {
    const name = summary.app_id;
    const words =
      "error" in summary
        ? ""
        : [...items<{ intent?: unknown }>(summary.pending).map((p) => str(p?.intent)), str(summary.last_change?.intent)]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 200);
    const state = appState(summary);
    return { name, title: appTitle(name), href: link(`/app/${name}`, ctx.lang), state, stateLabel: stateWords(w, state), words, monogram: initials(appTitle(name)) };
  });
}

function uiWords(w: Words): Ui {
  return Object.fromEntries(UI_KEYS.map((key) => [key, w[key]])) as Ui;
}

/** The Host's refusals a write from the page can meet, each with its sentence (refuse_<code>). */
const REFUSAL_CODES = ["preview_gone", "preview_unknown", "managed_elsewhere", "serving_uncertain", "malformed_pending", "previews_off", "preview_failed", "preview_refused", "draft_changed_after_check", "crosses_one_way_change", "plan_changed"] as const;

const DONE_WORDS = { live: "done_live", live_marked: "done_live_marked", no: "done_no", back: "done_back", back_marked: "done_back_marked" } as const;

const REASON_CODES = ["verify_failed", "preview_refused", "protected_file_changed", "outside_writable_roots", "no_change", "draft_changed_after_check", "base_changed", "invalid_manifest", "publish_failed", "published_unhealthy", "data_snapshot_failed", "record_failed", "agent_failed", "data_snapshot_refused", "data_restore_failed", "unhealthy_after_data_restore"];

function common(ctx: PageContext, title: string) {
  const w = wordsFor(ctx.lang, ctx.access);
  return {
    lang: ctx.lang,
    ui: uiWords(w),
    reasons: Object.fromEntries(REASON_CODES.map((code) => [code, reasonWords(w, code)])),
    refusals: Object.fromEntries(REFUSAL_CODES.map((code) => [code, w[`refuse_${code}`]])),
    title,
    now: ctx.now,
    links: { home: link("/", ctx.lang), zh: link(ctx.path, "zh"), en: link(ctx.path, "en") },
    search: searchEntries(ctx),
    ...(ctx.done ? { done: w[DONE_WORDS[ctx.done]] } : {}),
    ownerOff: Boolean(ctx.ownerOff),
    picturesOn: ctx.pictures.enabled,
    access: ctx.access ?? OWNER_LINK,
    opensElsewhere: ctx.appsSignIn ? w.opens_elsewhere : null,
  };
}

const facts = (rows: readonly (Fact | null | false | undefined)[]): Fact[] => rows.filter((row): row is Fact => Boolean(row && row.value));

// --- my apps ---------------------------------------------------------------

/** How many of tests, preview and approval stood behind a change, for the three-bar meter. */
function signalOf(w: Words, checks: unknown): { signal: number; label: string; tone: Tone } {
  const list = items<{ id?: unknown; status?: unknown }>(checks);
  const passed = (id: string) => list.some((check) => check?.id === id && check?.status === "passed");
  const tests = passed("npm-test");
  const tried = passed("space-preview");
  const signal = (tests ? 1 : 0) + (tried ? 1 : 0) + (tests && tried ? 1 : 0);
  return { signal, label: tests && tried ? w.checked_tried : tests ? w.checked : tried ? w.tried : w.not_checked, tone: signal >= 2 ? "green" : signal === 1 ? "orange" : "neutral" };
}

export function homeModel(overview: Overview, ctx: PageContext): HomeModel {
  const w = wordsFor(ctx.lang, ctx.access);
  const summaries = overview.summaries;
  // Each app's owner subject, which reads as "you": from the summary, or from status where the Host gave one.
  const owners = new Map([
    ...summaries.flatMap((summary) => ("error" in summary || typeof summary.owner !== "string" ? [] : [[summary.app_id, summary.owner] as const])),
    ...overview.apps.flatMap((app) => ("status" in app ? [[app.app_id, app.status.owner] as const] : [])),
  ]);
  const lastAt = (summary: AppSummary) => ("error" in summary ? "" : str(summary.last_change?.at));
  const sorted = [...summaries].sort((a, b) => ("error" in a ? 1 : 0) - ("error" in b ? 1 : 0) || lastAt(b).localeCompare(lastAt(a)) || a.app_id.localeCompare(b.app_id));

  // The summaries carry each waiting change in short; status carries it whole, its checks included.
  const fullPending = new Map(overview.apps.flatMap((app) => ("status" in app ? [[app.app_id, app.status.pending] as const] : [])));
  const waiting: WaitingCard[] = summaries.flatMap((summary) =>
    "error" in summary
      ? []
      : items<Record<string, unknown>>(fullPending.get(summary.app_id) ?? summary.pending).flatMap((pending) =>
          guarded<WaitingCard[]>(() => {
            const name = summary.app_id;
            const signal = signalOf(w, pending.checks);
            return [
              {
                app: name,
                appTitle: appTitle(name),
                href: link(`/app/${name}/change/${encodeURIComponent(str(pending.change_id))}`, ctx.lang),
                intent: quoted(pending.intent),
                meta: whoWords(ctx, { plain: w.by_on, token: w.by_token }, pending.agent, pending.credential, owners.get(name), { iso: pending.created_at, mode: "rel" }),
                oneWay: Boolean(pending.one_way),
                signal: signal.signal,
                signalLabel: signal.label,
                signalTone: signal.tone,
                shot: shotOf(ctx, name, ctx.pictures.latest(name), liveKey(summary)),
              },
            ];
          }, []),
        ),
  );

  // Files among the waiting changes the Host could not read as one: named, so the owner can have them looked at.
  const problems: Problem[] = summaries.flatMap((summary) =>
    "error" in summary
      ? []
      : items(summary.malformed_pending).map((line) => ({
          app: summary.app_id,
          appTitle: appTitle(summary.app_id),
          href: link(`/app/${summary.app_id}`, ctx.lang),
          text: fill(w.malformed_home, { app: appTitle(summary.app_id) }),
          line: str(line),
        })),
  );

  const apps: AppCard[] = sorted.flatMap((summary) =>
    guarded<AppCard[]>(() => {
      const name = summary.app_id;
      const base = { name, title: appTitle(name), href: link(`/app/${name}`, ctx.lang) };
      if ("error" in summary) {
        return [{ ...base, state: "unreadable", stateLabel: stateWords(w, "unreadable"), tone: "neutral", meta: plain(w.unreadable_body), shot: shotOf(ctx, name, null, null), address: null, review: null, unreadable: w.unreadable_body }];
      }
      const state = appState(summary);
      const last = summary.last_change;
      const first = items<{ change_id?: unknown }>(summary.pending)[0];
      return [
        {
          ...base,
          state,
          stateLabel: stateWords(w, state),
          tone: STATE_TONE[state],
          meta: last ? rich(ctx, `${w.updated} · {who}`, { who: agentWords(w, last.agent, owners.get(name)) }, { when: { iso: last.at, mode: "rel" } }) : plain(w.never_changed),
          shot: shotOf(ctx, name, ctx.pictures.latest(name), liveKey(summary)),
          address: safeHref(summary.address),
          review: state === "waiting" && first ? link(`/app/${name}/change/${encodeURIComponent(str(first.change_id))}`, ctx.lang) : null,
          unreadable: null,
        },
      ];
    }, []),
  );

  const host = safeHref(ctx.hostUrl);
  const console = safeHref(ctx.consoleUrl);
  return {
    view: "home",
    ...common(ctx, w.title_home),
    waiting,
    problems,
    apps,
    hint: { body: w.hint_body, example: w.hint_new },
    facts: facts([
      { label: w.d_governance, value: ctx.governanceNote ? `${str(ctx.governance)}: ${str(ctx.governanceNote)}` : str(ctx.governance) },
      { label: w.d_snapshot, value: ctx.dataSnapshot ? ctx.dataSnapshot : w.d_none },
      { label: w.d_pictures, value: ctx.pictures.enabled ? w.d_pictures_on : ctx.pictures.never ? w.d_pictures_never : w.d_pictures_off },
      host ? { label: w.d_host, value: host, href: host, mono: true } : null,
      console ? { label: w.d_console, value: console, href: console, mono: true } : null,
      console ? { label: "", value: fill(w.d_console_warn, { manager: ctx.manager ?? "appgov" }) } : null,
      { label: w.d_terminal, value: `${cli("list")} · ${cli("status <name>")} · ${cli("history <name>")}`, mono: true },
    ]),
  };
}

// --- the history, as a person would tell it ------------------------------------

type ItemKind = "created" | "change" | "waiting" | "stale" | "denied" | "rejected" | "not_live" | "undo" | "undo_failed" | "release" | "snapshot" | "other";

export interface TimelineItem {
  readonly id: string;
  /** Every entry this item tells, in record order: a change, the owner's decision on it, the data snapshot before it. */
  readonly entries: readonly HistoryEntry[];
  /** The entry that settled it. */
  readonly main: HistoryEntry;
  readonly kind: ItemKind;
  /** The version this item made, or an undo landed on. */
  readonly version: string | null;
  readonly oneWay: { readonly reason: string; readonly destructive: boolean } | null;
  readonly snapshot: boolean;
  /** Position of `main` in the history: items are told newest first by it. */
  readonly order: number;
}

const DEFAULT_CREATE_INTENT = "Create the app from the PneumaSpace template";
const VERSIONED: readonly ItemKind[] = ["created", "change", "release", "not_live"];

function oneWayReason(entry: HistoryEntry): string | null {
  const value = (entry as { one_way?: unknown }).one_way;
  if (!value) return null;
  if (typeof value === "object") return str((value as { reason?: unknown }).reason) || "one-way";
  return str(value);
}

/**
 * The history grouped into what a person would call one event: a change and the owner's decision on it are one
 * item, a data snapshot belongs to the change it was taken for, and a later one-way declaration marks its version.
 */
export function timeline(history: readonly HistoryEntry[], pendingIds: ReadonlySet<string>): TimelineItem[] {
  const groups = new Map<string, { entries: HistoryEntry[]; indexes: number[] }>();
  const declarations: HistoryEntry[] = [];
  history.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    if (entry.kind === "declaration") return void declarations.push(entry);
    const forChange = (entry as { for_change?: unknown }).for_change;
    const key = entry.kind === "snapshot" && typeof forChange === "string" ? forChange : typeof entry.change_id === "string" && entry.change_id ? entry.change_id : `#${index}`;
    const group = groups.get(key) ?? { entries: [], indexes: [] };
    group.entries.push(entry);
    group.indexes.push(index);
    groups.set(key, group);
  });
  const out: TimelineItem[] = [];
  for (const [id, { entries, indexes }] of groups) {
    let at = entries.length - 1;
    while (at > 0 && entries[at]!.kind === "snapshot") at--;
    const main = entries[at]!;
    const kind: ItemKind =
      main.kind === "snapshot"
        ? "snapshot"
        : main.kind === "restore"
          ? main.outcome === "rolled_back"
            ? "undo"
            : "undo_failed"
          : main.kind === "release"
            ? main.outcome === "published"
              ? "release"
              : "rejected"
            : main.outcome === "published"
              ? main.kind === "create"
                ? "created"
                : "change"
              : main.outcome === "needs_approval"
                ? pendingIds.has(id)
                  ? "waiting"
                  : "stale"
                : main.outcome === "denied"
                  ? "denied"
                  : main.outcome === "rejected"
                    ? "rejected"
                    : main.outcome === "release_failed"
                      ? "not_live"
                      : "other";
    const version = typeof main.version === "string" && (VERSIONED.includes(kind) || kind === "undo") ? main.version : null;
    const reasons = entries.map(oneWayReason).filter((reason): reason is string => Boolean(reason));
    if (version && VERSIONED.includes(kind)) {
      for (const declaration of declarations) if (declaration.version === version) reasons.push(oneWayReason(declaration) ?? "");
    }
    const destructive = entries.some((entry) => items(entry.risks).includes("destructive_definition"));
    out.push({
      id,
      entries,
      main,
      kind,
      version,
      oneWay: reasons.length && kind !== "undo" && kind !== "undo_failed" ? { reason: reasons.find(Boolean) ?? "", destructive } : null,
      snapshot: entries.some((entry) => entry.kind === "snapshot"),
      order: indexes[at]!,
    });
  }
  return out.sort((a, b) => b.order - a.order);
}

/** The version `version` was built on, by the rule undo follows (host/src/host.ts `builtOn`). */
function builtOn(history: readonly HistoryEntry[], version: string): string | null {
  const base = history.find((entry) => entry?.version === version && entry.kind !== "restore")?.base_version;
  return typeof base === "string" ? base : null;
}

/** `version` and every version it was built on, newest first: the versions undo can go back to. */
export function lineage(history: readonly HistoryEntry[], version: string | null): string[] {
  const out: string[] = [];
  for (let at = version; at && !out.includes(at); at = builtOn(history, at)) out.push(at);
  return out;
}

/** A version named the way the person would: the words of the change that made it, or "how the app first was". */
function versionLabel(w: Words, history: readonly HistoryEntry[], version: string): string | null {
  const creator = history.find((entry) => entry?.version === version && entry.kind !== "restore");
  if (!creator) return null;
  const intent = str(creator.intent);
  return creator.kind === "create" && (!intent || intent === DEFAULT_CREATE_INTENT) ? w.first_version : quoted(intent);
}

/** When a version was first recorded. */
function madeAt(history: readonly HistoryEntry[], version: string): string | undefined {
  return history.find((entry) => entry?.version === version && entry.kind !== "restore")?.at;
}

function checkedPart(w: Words, entry: HistoryEntry): string {
  const guarantees = items<string>(entry.guarantees);
  const checked = guarantees.includes("verified");
  const tried = guarantees.includes("previewed");
  return checked && tried ? w.checked_tried : checked ? w.checked : tried ? w.tried : w.not_checked;
}

/** What stood behind a change that went live, from its guarantees and its approval. */
function standing(w: Words, entry: HistoryEntry, owner: string): { text: string; tone: Tone } {
  const guarantees = items<string>(entry.guarantees);
  if (!guarantees.length) return { text: w.live_no_checks, tone: "neutral" };
  const parts = [checkedPart(w, entry)];
  if (guarantees.includes("approved")) {
    const by = items<string>(entry.approval?.by);
    if (by.includes(owner)) parts.push(w.you_confirmed);
    else if (by.includes("policy:auto")) parts.push(w.auto_approved);
    else if (by.length) parts.push(fill(w.approved_by, { who: by.join(", ") }));
  }
  return { text: parts.join(" · "), tone: "green" };
}

interface Marks {
  readonly live: string | null;
  readonly savedNotLive: string | null;
  readonly goBack: ReadonlySet<string>;
  readonly undone: ReadonlySet<string>;
}

/** Which item gets "Running now", "Go back to this", "Undone": the newest item that made each version. */
function marks(all: readonly TimelineItem[], history: readonly HistoryEntry[], status: AppStatus): Marks {
  const serving = status.serving_uncertain ? null : (status.serving_version ?? status.active_version);
  const current = status.active_version;
  const line = new Set(lineage(history, current));
  const newest = new Map<string, string>();
  for (const item of all) if (item.version && VERSIONED.includes(item.kind) && !newest.has(item.version)) newest.set(item.version, item.id);
  const goBack = new Set<string>();
  const undone = new Set<string>();
  for (const [version, id] of newest) {
    if (line.has(version) && version !== current) goBack.add(id);
    if (!line.has(version) && version !== serving) undone.add(id);
  }
  return { live: serving ? (newest.get(serving) ?? null) : null, savedNotLive: current && current !== serving ? (newest.get(current) ?? null) : null, goBack, undone };
}

function itemTitle(w: Words, item: TimelineItem, history: readonly HistoryEntry[]): string {
  const intent = str(item.main.intent || item.entries[0]?.intent);
  switch (item.kind) {
    case "created":
      return intent && intent !== DEFAULT_CREATE_INTENT ? quoted(intent) : w.item_created;
    case "undo":
    case "undo_failed": {
      const target = item.kind === "undo" ? item.version : str((item.main as { target_version?: unknown }).target_version);
      const label = target ? versionLabel(w, history, target) : null;
      if (!label) return w.item_undo_version;
      return fill(item.kind === "undo" ? w.item_undo : w.item_undo_failed, { version: label });
    }
    case "snapshot":
      return w.item_snapshot;
    default:
      return intent ? quoted(intent) : w.item_created;
  }
}

/** What stood behind an item, in plain words, and how it reads. */
function itemStanding(ctx: PageContext, item: TimelineItem, owner: string, history: readonly HistoryEntry[]): { text: string | Rich; tone: Tone; badge: RowBadge } | null {
  const w = wordsFor(ctx.lang, ctx.access);
  const main = item.main;
  switch (item.kind) {
    case "created":
    case "change":
    case "release": {
      const s = standing(w, main, owner);
      return { ...s, badge: s.tone === "green" ? "done" : "plain" };
    }
    case "waiting":
      return { text: `${checkedPart(w, main)} · ${w.waiting_for_you}`, tone: "orange", badge: "waiting" };
    case "stale":
      return { text: w.no_decision, tone: "neutral", badge: "plain" };
    case "denied":
      return { text: w.said_no, tone: "neutral", badge: "plain" };
    case "rejected":
      return { text: fill(w.did_not_go_live, { why: reasonWords(w, main.reason, main.checks) }), tone: "red", badge: "failed" };
    case "not_live":
      return { text: fill(w.saved_did_not_go_live, { why: reasonWords(w, main.reason, main.checks) }), tone: "red", badge: "failed" };
    case "undo_failed":
      return { text: fill(w.undo_failed_why, { why: reasonWords(w, main.reason, main.checks) }), tone: "red", badge: "failed" };
    case "undo": {
      const crossed = (main as { one_way_crossed?: { by?: unknown; data_ref?: { ref?: unknown } } }).one_way_crossed;
      if (crossed?.by !== "data_restored") return { text: w.data_kept, tone: "neutral", badge: "undo" };
      const ref = str(crossed.data_ref?.ref);
      const saved = ref ? history.find((entry) => str(entry?.data_ref?.ref) === ref)?.at : undefined;
      if (!saved) return { text: w.data_back_undated, tone: "neutral", badge: "undo" };
      return { text: rich(ctx, w.data_back, {}, { when: { iso: saved, mode: "abs" } }), tone: "neutral", badge: "undo" };
    }
    case "snapshot":
      return { text: w.snapshot_saved, tone: "neutral", badge: "plain" };
    default:
      return null;
  }
}

function itemFacts(w: Words, item: TimelineItem, name: string, goBack: boolean): Fact[] {
  const main = item.main;
  const tests = items<{ id?: unknown; status?: unknown; coverage?: { note?: unknown } }>(main.checks).find((check) => check?.id === "npm-test");
  const snapshot = item.entries.find((entry) => entry.kind === "snapshot")?.data_ref;
  const approval = main.approval as { reason_code?: unknown; by?: unknown; preset?: unknown } | undefined;
  const candidates = items<{ agent?: unknown; markers?: unknown }>(main.agent_candidates);
  return facts([
    item.version ? { label: w.d_version, value: `${item.version}${main.base_version ? ` ← ${str(main.base_version)}` : ""}`, mono: true } : null,
    { label: w.d_change, value: str(main.change_id), mono: true },
    { label: w.d_outcome, value: `${str(main.kind)} ${str(main.outcome)}`, mono: true },
    // On a decision, `agent` is who decided; the agent that made the change is its `author`.
    { label: w.d_agent, value: main.author !== undefined ? str(main.author) : `${str(main.agent)}${main.agent_source ? ` (${str(main.agent_source)})` : ""}${candidates.length ? `: ${candidates.map((c) => `${str(c?.agent)} ${list(c?.markers)}`).join("; ")}` : ""}`, mono: true },
    main.kind !== "snapshot" ? { label: w.d_guarantees, value: items(main.guarantees).length ? list(main.guarantees) : w.d_recorded_only, mono: true } : null,
    items(main.risks).length ? { label: w.d_risks, value: list(main.risks), mono: true } : null,
    approval ? { label: w.d_approval, value: `${str(approval.reason_code)} · ${list(approval.by)}${approval.preset ? ` (${str(approval.preset)})` : ""}`, mono: true } : null,
    tests?.coverage ? { label: w.d_tests, value: `${str(tests.status)}: ${str(tests.coverage.note)}` } : null,
    item.oneWay ? { label: w.d_one_way, value: item.oneWay.reason } : null,
    snapshot ? { label: w.d_data, value: `${str(snapshot.capability)} ${str(snapshot.ref)}`, mono: true } : null,
    main.reason ? { label: w.d_reason, value: str(main.reason), mono: true } : null,
    main.address_note ? { label: w.d_address, value: str(main.address_note) } : null,
    main.set_aside ? { label: w.d_note, value: str(main.set_aside) } : null,
    main.note ? { label: w.d_note, value: str(main.note) } : null,
    main.channel ? { label: w.d_channel, value: str(main.channel), mono: true } : null,
    goBack && item.version ? { label: w.d_terminal, value: cli(`undo --to ${item.version} "<why>" --app ${name}`), mono: true } : null,
  ]);
}

function historyRow(ctx: PageContext, item: TimelineItem, name: string, status: AppStatus, history: readonly HistoryEntry[], m: Marks): HistoryRow {
  const w = wordsFor(ctx.lang, ctx.access);
  const main = item.main;
  const canGoBack = m.goBack.has(item.id);
  const stand = itemStanding(ctx, item, status.owner, history);
  const pill =
    m.live === item.id
      ? { label: w.running_now, tone: "green" as Tone }
      : item.kind === "waiting"
        ? { label: w.waiting_for_you_pill, tone: "orange" as Tone }
        : m.savedNotLive === item.id
          ? { label: w.saved_not_live, tone: "neutral" as Tone }
          : m.undone.has(item.id)
            ? { label: w.undone_later, tone: "neutral" as Tone }
            : ["rejected", "not_live", "undo_failed"].includes(item.kind)
              ? { label: w.not_live_pill, tone: "red" as Tone }
              : null;
  const undoReason = item.kind === "undo" || item.kind === "undo_failed" ? str(main.intent) : "";
  // On a decision, `agent` is who decided and `author` the agent that made the change, which the entry submitting it names with its credential.
  const maker = main.author !== undefined ? { agent: main.author, credential: item.entries.find((entry) => entry !== main && entry.change_id === main.change_id && entry.credential !== undefined)?.credential } : { agent: main.agent, credential: main.credential };
  const standingRich: Rich | null = stand ? (typeof stand.text === "string" ? plain(stand.text) : stand.text) : null;
  return {
    id: item.id,
    title: itemTitle(w, item, history),
    when: rich(ctx, "{when}", {}, { when: { iso: main.at, mode: "rel" } }),
    badge: stand?.badge ?? "plain",
    pill,
    standing: standingRich,
    standingTone: stand?.tone ?? "neutral",
    who: whoWords(ctx, { plain: w.by_on, token: w.by_token }, maker.agent, maker.credential, status.owner, { iso: main.at, mode: "abs" }),
    note: undoReason && undoReason !== "undo" ? quoted(undoReason) : null,
    oneWay: item.oneWay ? { body: item.oneWay.destructive ? w.one_way_destructive : w.one_way_other, why: item.oneWay.reason ? fill(w.one_way_why, { why: item.oneWay.reason }) : null } : null,
    snapshot: item.snapshot && item.kind !== "snapshot" ? w.snapshot_saved : null,
    review: item.kind === "waiting" ? link(`/app/${name}/change/${encodeURIComponent(item.id)}`, ctx.lang) : null,
    back: canGoBack && item.version ? link(`/app/${name}/back/${encodeURIComponent(item.version)}`, ctx.lang) : null,
    files: items<string>(main.changed_paths).map(str).slice(0, 40),
    facts: itemFacts(w, item, name, canGoBack),
  };
}

// --- one app ---------------------------------------------------------------

export function appModel(name: string, status: AppStatus, entries: readonly HistoryEntry[], ctx: PageContext): AppModel {
  const w = wordsFor(ctx.lang, ctx.access);
  const title = appTitle(name);
  const summary = ctx.apps.find((app) => app.app_id === name);
  const state = summary ? appState(summary) : "normal";
  const last = summary && !("error" in summary) ? summary.last_change : null;
  const pending = items<Record<string, unknown>>(status.pending);
  const uncommitted = items<string>(status.uncommitted);
  const notices: Notice[] = situation(w, status);
  const malformed = items(status.malformed_pending).map(str);
  for (const line of malformed) notices.push({ tone: "orange", text: fill(w.malformed_body, { file: `${PENDING_DIR}${malformedFile(line) || "?"}` }) });
  if (uncommitted.length) notices.push({ tone: "neutral", text: uncommitted.length === 1 ? w.working_here_one : fill(w.working_here_other, { n: uncommitted.length }) });

  let history: HistoryRow[] = [];
  let historyError: string | null = null;
  try {
    const pendingIds = new Set(pending.map((p) => str(p?.change_id)));
    const all = timeline(entries, pendingIds);
    const m = marks(all, entries, status);
    history = all.map((item) =>
      guarded<HistoryRow>(() => historyRow(ctx, item, name, status, entries, m), {
        id: item.id,
        title: w.item_unreadable,
        when: plain(""),
        badge: "plain",
        pill: null,
        standing: null,
        standingTone: "neutral",
        who: plain(""),
        note: null,
        oneWay: null,
        snapshot: null,
        review: null,
        back: null,
        files: [],
        facts: [],
      }),
    );
  } catch {
    historyError = w.item_unreadable;
  }
  const address = safeHref(status.address);
  return {
    view: "app",
    ...common(ctx, title),
    name,
    appTitle: title,
    state,
    stateLabel: stateWords(w, state),
    tone: STATE_TONE[state],
    meta: last ? rich(ctx, `${w.updated} · {who}`, { who: agentWords(w, last.agent, status.owner) }, { when: { iso: last.at, mode: "rel" } }) : plain(w.never_changed),
    address,
    addressText: str(status.address),
    shot: shotOf(ctx, name, ctx.pictures.latest(name), liveKey(status), true),
    notices,
    waiting: pending.map((p) => ({ intent: quoted(p.intent), href: link(`/app/${name}/change/${encodeURIComponent(str(p.change_id))}`, ctx.lang) })),
    history,
    historyError,
    hint: { body: w.hint_app_body, example: fill(w.hint_app, { name }) },
    facts: facts([
      { label: w.d_current, value: str(status.active_version ?? w.d_none), mono: true },
      { label: w.d_serving, value: status.serving_uncertain ? str(status.serving_uncertain) : str(status.serving_version ?? w.d_none), mono: !status.serving_uncertain },
      { label: w.d_previous, value: str(status.previous_version ?? w.d_none), mono: true },
      { label: w.d_owner, value: str(status.owner), mono: true },
      address ? { label: w.d_address, value: address, href: address, mono: true } : { label: w.d_address, value: str(status.address), mono: true },
      uncommitted.length ? { label: w.d_uncommitted, value: list(uncommitted), mono: true } : null,
      { label: w.d_governance, value: `${str(status.governance)}: ${str(status.governance_note)}` },
      { label: w.d_manager, value: managerOf(status).note },
      ...malformed.map((line, i) => ({ label: i === 0 ? w.d_malformed : "", value: line })),
      { label: w.d_terminal, value: `${cli(`status ${name}`)} · ${cli(`history ${name}`)}`, mono: true },
    ]),
  };
}

/** `unreachable`: the Host could not be asked (the Cloudflare edition's container did not answer), rather than could not read the app. */
export function unreadableModel(name: string, error: string, ctx: PageContext, unreachable = false): UnreadableModel {
  const w = wordsFor(ctx.lang, ctx.access);
  return { view: "unreadable", ...common(ctx, appTitle(name)), name, appTitle: appTitle(name), stateLabel: w.state_unreadable, body: unreachable ? w.unreachable_body : w.unreadable_body, facts: facts([{ label: w.d_error, value: error, mono: true }]) };
}

export function missingModel(ctx: PageContext, message?: string): MissingModel {
  const w = wordsFor(ctx.lang, ctx.access);
  return { view: "missing", ...common(ctx, w.not_found), message: message ?? w.not_found };
}

/** The view before the owner signs in: the page's own words and nothing from any app, whatever `ctx.apps` holds. */
export function signInModel(ctx: PageContext, signInUrl: string): SignInModel {
  const w = wordsFor(ctx.lang, ctx.access);
  return { view: "signin", ...common({ ...ctx, apps: [] }, w.signin_title), signInUrl };
}

// --- a change waiting for the owner ------------------------------------------

/** A preview address the page may link to: an app on the same runtime as the app itself. The Host reports it; an agent can write the files it reads it from. */
function previewHref(appAddress: string, address: string | null): string | null {
  if (!address) return null;
  try {
    const app = new URL(appAddress);
    const preview = new URL(address);
    return preview.origin === app.origin && preview.pathname.startsWith(app.pathname.replace(/[^/]+\/$/, "")) && !preview.username ? preview.href : null;
  } catch {
    return null;
  }
}

export function changeModel(name: string, status: AppStatus, changeId: string, ctx: PageContext): ChangeModel {
  const w = wordsFor(ctx.lang, ctx.access);
  const title = appTitle(name);
  const appHref = link(`/app/${name}`, ctx.lang);
  const pending = items<Record<string, any>>(status.pending).find((p) => str(p?.change_id) === changeId);
  const decideUrl = (verb: string) => `/owner/apps/${name}/changes/${encodeURIComponent(changeId)}/${verb}`;
  const backTo = (done: string) => link(`/app/${name}?done=${done}`, ctx.lang);
  const address = safeHref(status.address);
  const nowSide: Side = { label: w.now, open: address, shot: shotOf(ctx, name, ctx.pictures.latest(name), liveKey(status)), empty: null, again: null, note: null };
  const base = { view: "change" as const, ...common(ctx, `${w.change_title} · ${title}`), name, appTitle: title, appHref, changeId };
  const manager = managerOf(status);
  const undoUnfinished = uncertainKind(status.serving_uncertain) === "undo";
  if (!pending) {
    // A file the Host could not read as a waiting change is not listed in `pending`: say that, rather than "no longer waits".
    const malformed = items(status.malformed_pending).map(str).find((line) => malformedFile(line) === `${changeId}.json`);
    return {
      ...base,
      gone: true,
      intent: malformed ? w.change_malformed : w.change_gone,
      meta: plain(""),
      before: nowSide,
      after: { label: w.after, open: null, shot: null, empty: null, again: null, note: null },
      checked: [],
      why: [],
      oneWay: null,
      notices: [],
      decision: { approveUrl: decideUrl("approve"), denyUrl: decideUrl("deny"), doneLive: backTo("live"), doneNo: backTo("no"), oneWay: false, lines: [], consequence: null, check: null, signal: 0, signalLabel: "", signalTone: "neutral", blocked: null, marks: null },
      facts: facts([malformed ? { label: w.d_malformed, value: malformed } : null]),
    };
  }
  const checks = items<{ id?: unknown; status?: unknown; coverage?: { tests?: unknown; app_tests?: unknown } }>(pending.checks);
  const tests = checks.find((check) => check?.id === "npm-test");
  const previewCheck = checks.find((check) => check?.id === "space-preview");
  const risks = items<string>(pending.risks);
  const paths = items<string>(pending.changed_paths).map(str);
  const oneWay = typeof pending.one_way === "string" && pending.one_way ? pending.one_way : null;
  const snapshotHost = Boolean(status.data_snapshot);

  const checked: CheckRow[] = [];
  if (tests?.status === "passed") {
    const n = tests.coverage?.tests;
    const own = tests.coverage?.app_tests;
    // No test that ran is not a pass to report: say that none ran, as the warning it is.
    if (n === 0) checked.push({ text: w.tests_none_ran, tone: "caution" });
    else {
      checked.push({ text: typeof n === "number" && typeof own === "number" ? fill(w.tests_passed, { n, own }) : w.tests_passed_plain, tone: "done" });
      if (own === 0) checked.push({ text: w.tests_none_own, tone: "caution" });
    }
  }
  if (previewCheck?.status === "passed") checked.push({ text: w.started_in_preview, tone: "done" });
  checked.push({ text: paths.length === 1 ? w.files_one : fill(w.files_other, { n: paths.length }), tone: "done", files: paths.slice(0, 40) });
  // Only what the standing policy could not approve is why the change waits; in review-all mode that is every risk.
  const auto = new Set(ctx.autoApproved ?? []);
  const why = [...new Set(risks.filter((risk) => !auto.has(risk)).map((risk) => riskWords(w, risk)))];
  if (status.governance === "review-all") why.push(w.review_all);

  // The preview, as the Host reports it from PneumaSpace: where it is, when it ends itself, or that it no longer stands.
  const preview = previewOf(pending);
  const previewLink = preview.standing === false ? null : previewHref(status.address, preview.address);
  const previewPicture = ctx.pictures.preview(name, changeId);
  const ends = preview.standing && typeof pending.preview?.expires_at === "string" ? rich(ctx, w.preview_ends, {}, { when: { iso: pending.preview.expires_at, mode: "rel" } }) : null;
  const previewMissing = preview.standing === false || preview.unknown;
  const after: Side = previewMissing
    ? {
        label: w.after,
        open: null,
        shot: previewPicture ? shotOf(ctx, name, previewPicture, null) : null,
        empty: { text: preview.unknown ? w.preview_unknown : w.preview_gone, tone: "neutral" },
        // The Host refuses a new preview while an undo is unfinished, as it refuses the approval it would lead to,
        // and does not replace one PneumaSpace did not say anything about.
        again: undoUnfinished || preview.unknown ? null : { label: w.preview_again, url: decideUrl("preview") },
        note: null,
      }
    : previewPicture || previewLink
      ? { label: w.after, open: previewLink, shot: previewPicture ? shotOf(ctx, name, previewPicture, null) : { src: null, monogram: initials(title), caption: noPicture(ctx) }, empty: null, again: null, note: ends }
      : { label: w.after, open: null, shot: null, empty: previewCheck?.status === "passed" ? { text: w.preview_passed, tone: "green" } : { text: w.no_preview, tone: "neutral" }, again: null, note: null };
  // Approving is refused, in the Host's order, while an undo is unfinished, while another manager runs the app, and while no
  // preview stands; and it ends in "didn't go live" when the change was made on a version the app has since left.
  const behind = typeof pending.base_version === "string" && typeof status.active_version === "string" && pending.base_version !== status.active_version;
  const blocked = undoUnfinished
    ? w.blocked_undo
    : manager.other
      ? fill(w.blocked_elsewhere, { manager: manager.other })
      : previewMissing
        ? preview.unknown
          ? w.blocked_preview_unknown
          : w.blocked_preview
        : behind
          ? w.blocked_behind
          : null;

  const signal = signalOf(w, checks);
  const signInDropped = risks.includes("policy_change");
  return {
    ...base,
    gone: false,
    intent: quoted(pending.intent),
    meta: whoWords(ctx, { plain: w.made_by, token: w.made_by_token }, pending.agent, pending.credential, status.owner, { iso: pending.created_at, mode: "rel" }),
    before: nowSide,
    after,
    checked,
    why: why.length ? why : [w.risk_other],
    oneWay: oneWay ? { title: w.one_way_title, body: snapshotHost ? w.one_way_with_snapshot : w.one_way_no_snapshot, why: fill(w.one_way_why, { why: oneWay }) } : null,
    notices: situation(w, status),
    decision: {
      approveUrl: decideUrl("approve"),
      denyUrl: decideUrl("deny"),
      doneLive: backTo(manager.unmanaged ? "live_marked" : "live"),
      doneNo: backTo("no"),
      oneWay: Boolean(oneWay),
      lines: [fill(w.confirm_who, { app: title }), ...(signInDropped ? [w.confirm_sign_in] : []), ...(oneWay ? [] : [w.confirm_back])],
      consequence: oneWay ? (snapshotHost ? w.one_way_with_snapshot : w.one_way_no_snapshot) : null,
      check: oneWay ? (snapshotHost ? w.confirm_check_snapshot : w.confirm_check_none) : null,
      signal: signal.signal,
      signalLabel: signal.label,
      signalTone: signal.tone,
      blocked,
      marks: manager.unmanaged ? w.marks_live : null,
    },
    facts: facts([
      { label: w.d_change, value: changeId, mono: true },
      { label: w.d_risks, value: list(risks), mono: true },
      ...items(pending.disclosure).map((line, i) => ({ label: i === 0 ? w.d_disclosure : "", value: str(line) })),
      { label: w.d_files, value: list(paths), mono: true },
      { label: w.d_tests, value: checks.map((check) => `${str(check?.id)} ${str(check?.status)}`).join(", "), mono: true },
      oneWay ? { label: w.d_one_way, value: oneWay } : null,
      preview.address ? { label: w.d_preview, value: preview.address, mono: true } : null,
      previewMissing ? { label: w.d_preview, value: `${str(pending.preview?.app)} (${preview.unknown ? w.d_preview_unknown : w.d_preview_gone}): ${str(pending.preview?.note)}` } : null,
      { label: w.d_manager, value: manager.note },
      { label: w.d_agent, value: `${str(pending.agent)}${pending.agent_provenance?.source ? ` (${str(pending.agent_provenance.source)})` : ""}`, mono: true },
      pending.credential ? { label: w.d_credential, value: str(pending.credential), mono: true } : null,
      { label: w.d_terminal, value: `${cli(`approve ${changeId} --app ${name}`)} · ${cli(`deny ${changeId} --app ${name}`)}`, mono: true },
    ]),
  };
}

// --- going back -------------------------------------------------------------

/** What `AppHost.undoPlan` returns, as far as the page reads it. */
export interface UndoPlanView {
  /** The current version the plan starts from; going back sends it, and the Host refuses once it is not current. */
  readonly from: string | null;
  readonly target: string;
  readonly undone: readonly string[];
  readonly oneWay: readonly { readonly version?: string }[];
  readonly dataRef?: { readonly capability: string; readonly ref: string };
  readonly crossing: { readonly data_restore: "snapshot" | "none"; readonly text: string } | null;
  /**
   * What the versions gone back past left in stored data that the older code may not show (the Cloudflare edition's
   * container finds it: cloudflare/src/data-left.ts): they declare storage it does not, or run SQL it does not.
   */
  readonly dataLeft?: { readonly storage: boolean; readonly sql: readonly string[] } | null;
}

/** The data-left line in the person's words, or null. */
function dataLeftWords(w: Words, left: UndoPlanView["dataLeft"]): string | null {
  if (!left || (!left.storage && !items(left.sql).length)) return null;
  const sql = items<string>(left.sql).map(str);
  const shown = sql.slice(0, 2).map((statement) => (statement.length > 60 ? `${statement.slice(0, 59)}…` : statement));
  const what = [left.storage ? w.back_left_storage : "", sql.length ? fill(w.back_left_sql, { sql: `${shown.join("; ")}${sql.length > 2 ? "; …" : ""}` }) : ""].filter(Boolean).join(w.back_left_and);
  return fill(w.back_data_left, { what });
}

export function backModel(name: string, status: AppStatus, entries: readonly HistoryEntry[], version: string, plan: UndoPlanView | null, ctx: PageContext): BackModel {
  const w = wordsFor(ctx.lang, ctx.access);
  const title = appTitle(name);
  const at = madeAt(entries, version);
  const uncommitted = items<string>(status.uncommitted);
  const inLine = lineage(entries, status.active_version).includes(version);
  const label = versionLabel(w, entries, version);
  const manager = managerOf(status);
  const base = {
    view: "back" as const,
    ...common(ctx, title),
    name,
    appTitle: title,
    appHref: link(`/app/${name}`, ctx.lang),
    version,
    heading: label ? fill(w.back_title, { version: label }) : w.item_undo_version,
    made: at ? rich(ctx, w.back_made, {}, { when: { iso: at, mode: "abs" } }) : null,
    undoUrl: `/owner/apps/${name}/undo`,
    doneHref: link(`/app/${name}?done=${manager.unmanaged ? "back_marked" : "back"}`, ctx.lang),
  };
  const empty = { undone: [], data: null, check: null, blocked: null, marks: null, accept: false, from: null, afterNote: null, facts: [] };
  if (version === status.active_version) return { ...base, ...empty, kind: "current" };
  if (!plan || !inLine) return { ...base, ...empty, kind: "not_earlier" };
  const oneWayVersions = new Set(plan.oneWay.map((entry) => str(entry.version)));
  const undone = plan.undone.map((v) => {
    const made = entries.find((entry) => entry?.version === v && entry.kind !== "restore");
    return { title: made ? itemTitleOfVersion(w, made) : v, when: made ? rich(ctx, "{when}", {}, { when: { iso: made.at, mode: "abs" } }) : null, oneWay: oneWayVersions.has(v) };
  });
  let data: Rich;
  let check: string | null = null;
  const left = dataLeftWords(w, plan.dataLeft);
  if (!plan.crossing) data = plain(left ?? w.back_data_stays);
  else if (plan.crossing.data_restore === "snapshot" && plan.dataRef) {
    const saved = entries.filter((entry) => str(entry?.data_ref?.ref) === plan.dataRef!.ref).at(-1)?.at;
    const oldest = [...plan.undone].reverse().find((v) => oneWayVersions.has(v));
    const change = oldest ? str(entries.find((entry) => entry?.version === oldest && entry.kind !== "restore")?.intent) : "";
    data = rich(ctx, w.back_data_snapshot, { change }, { when: { iso: saved, mode: "abs" } });
    check = w.back_check_snapshot;
  } else {
    data = plain(w.back_data_none);
    check = w.back_check_none;
  }
  return {
    ...base,
    kind: "plan",
    undone,
    data,
    check,
    // The Host asks who runs the app before it looks at the working tree.
    blocked: manager.other
      ? fill(w.back_blocked_elsewhere, { manager: manager.other })
      : uncommitted.length
        ? uncommitted.length === 1
          ? w.back_blocked_one
          : fill(w.back_blocked_other, { n: uncommitted.length })
        : null,
    marks: manager.unmanaged ? w.marks_back : null,
    accept: Boolean(plan.crossing),
    from: plan.from,
    afterNote: left,
    facts: facts([
      { label: w.d_version, value: `${str(status.active_version)} → ${version}`, mono: true },
      plan.crossing ? { label: w.d_plan, value: plan.crossing.text } : null,
      { label: w.d_manager, value: manager.note },
      { label: w.d_terminal, value: cli(`undo --to ${version} "<why>" --app ${name}${plan.crossing ? " --accept-one-way" : ""}`), mono: true },
    ]),
  };
}

function itemTitleOfVersion(w: Words, made: HistoryEntry): string {
  const intent = str(made.intent);
  return made.kind === "create" && (!intent || intent === DEFAULT_CREATE_INTENT) ? w.item_created : quoted(intent);
}

// --- the page around the data --------------------------------------------------

/** The headers every view is served with: only this response's own script runs, nothing frames it, nothing leaks the address. */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cache-control": "no-store",
  };
}

/**
 * Before anything renders: take the owner token out of the address (the fragment no browser sends anywhere) into
 * this tab's session storage, and set the theme, so the page does not flash the other one.
 */
const HEAD_SCRIPT = `(() => {
  const m = /(?:^#|&)owner=([A-Za-z0-9_-]{16,})/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem("appgov-owner", m[1]); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  let held = null;
  try { held = sessionStorage.getItem("appgov-owner"); } catch {}
  document.documentElement.dataset.owner = held ? "checking" : "no";
  let theme = null;
  try { theme = localStorage.getItem("appgov-theme"); } catch {}
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
})();`;

/** Where the built client is (web/build.ts), and a version for each file so a new build is not served from a cache. */
export interface PageAssets {
  readonly dir: string;
  /** The files the page may serve, by name, with a short hash of their content. */
  readonly files: ReadonlyMap<string, string>;
}

const ASSET_TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

/** The content type a built file is served with, or null for anything the page does not serve. */
/** The tab's icon: four app tiles. Fixed text written here, not built, so a browser never asks for /favicon.ico. */
export const PAGE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#18181b"/>' +
  '<rect x="8" y="8" width="7" height="7" rx="2" fill="#fafafa"/><rect x="17" y="8" width="7" height="7" rx="2" fill="#fafafa" opacity=".55"/>' +
  '<rect x="8" y="17" width="7" height="7" rx="2" fill="#fafafa" opacity=".55"/><rect x="17" y="17" width="7" height="7" rx="2" fill="#f97316"/></svg>\n';

export function assetType(name: string): string | null {
  if (!/^(app\.js|app\.css|fonts\/[a-z0-9-]+(-wght-normal\.woff2|\.LICENSE\.txt))$/.test(name)) return null;
  return ASSET_TYPES[name.slice(name.lastIndexOf("."))] ?? null;
}

/** The HTML around one view: the head script, the stylesheet, the view's data, and the client that renders it. */
export function renderShell(model: PageModel, nonce: string, assets: PageAssets): string {
  const w = wordsFor(model.lang, model.access);
  const css = assets.files.get("app.css");
  const js = assets.files.get("app.js");
  const missing = !css || !js;
  return `<!doctype html>
<html lang="${w.html_lang}" data-owner="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${esc(model.title)}</title>
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<script nonce="${esc(nonce)}">${HEAD_SCRIPT}</script>
${css ? `<link rel="stylesheet" href="/assets/app.css?v=${css}">` : ""}
</head>
<body>
<div id="root">${missing ? `<p>${esc(w.assets_missing)}</p>` : ""}</div>
<noscript><p>${esc(w.needs_script)}</p></noscript>
<script type="application/json" id="model">${json(model)}</script>
${js ? `<script nonce="${esc(nonce)}" src="/assets/app.js?v=${js}" defer></script>` : ""}
</body>
</html>
`;
}
