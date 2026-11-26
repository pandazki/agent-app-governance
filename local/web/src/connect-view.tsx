import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../beautifui/atoms/Button";
import LoadingState from "../beautifui/primitives/LoadingState";
import { ContextNote } from "../beautifui/primitives/ContextNote";
import { Drawer } from "../beautifui/primitives/Recommendation";
import { Collapsible } from "../beautifui/primitives/ToolChips";
import { act, fill, useOwner, usePage, useUi } from "./lib";
import type { ConnectModel, Connection } from "./model";
import { Failure } from "./change-view";
import { RichText, TextField } from "./parts";
import { CopyLine } from "./start-view";

type Code = { id: string; code: string; expires_at: string; command: string };
type Phase = { kind: "name" } | { kind: "code"; code: Code } | { kind: "expired"; label: string };

const POLL_MS = 2000;

/**
 * Connecting an assistant (the Cloudflare edition): name the connection, get a one-time code, and give the assistant
 * the sentence with its command. The panel asks the Host what became of the code until it is used, and then shows the
 * home view again, where the connection is listed; closing the panel closes the code too.
 */
export function ConnectPanel({ connect, onClose }: { connect: ConnectModel; onClose?: () => void }) {
  const ui = useUi();
  const { access } = usePage();
  const owner = useOwner();
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "name" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  const sending = useRef(false);
  const code = phase.kind === "code" ? phase.code : null;

  // While the code waits: ask what became of it, and move on when it was used, or say so when it expired. When the
  // tab is closed, reloaded or leaves the page first, the code is closed too: no code outlives the panel that shows it.
  useEffect(() => {
    if (!code) return;
    let live = true;
    let used = false;
    const tick = async () => {
      const result = await act(connect.stateUrl.replace("{id}", encodeURIComponent(code.id)), {}, access);
      if (!live) return;
      if (result.lost) return owner.lose();
      const state = String(result.data.state ?? "");
      if (state === "used") {
        used = true;
        location.href = connect.done;
      } else if (state === "expired" || state === "gone") setPhase({ kind: "expired", label });
    };
    const leave = () => {
      if (used || access.kind !== "session") return;
      void fetch(connect.cancelUrl.replace("{id}", encodeURIComponent(code.id)), { method: "POST", keepalive: true, headers: { "content-type": "application/json", "x-appgov-csrf": access.csrf }, body: "{}" }).catch(() => {});
    };
    const timer = setInterval(tick, POLL_MS);
    addEventListener("pagehide", leave);
    return () => {
      live = false;
      clearInterval(timer);
      removeEventListener("pagehide", leave);
    };
  }, [code?.id]);

  const make = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!label.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const result = await act(connect.url, { label: label.trim() }, access);
    sending.current = false;
    setBusy(false);
    if (result.lost) return owner.lose();
    if (!result.ok || typeof result.data.code !== "string") {
      setFailure({ text: result.data.reason === "too_many_codes" ? ui.connect_limit : ui.failed, detail: String(result.data.error ?? "") });
      return;
    }
    setPhase({ kind: "code", code: result.data as unknown as Code });
  };

  const close = () => {
    if (code) void act(connect.cancelUrl.replace("{id}", encodeURIComponent(code.id)), {}, access);
    setPhase({ kind: "name" });
    setFailure(null);
    onClose?.();
  };

  if (owner.state !== "yes") return <p className="text-[12.5px] leading-relaxed text-ink-2">{ui.read_only_decide}</p>;

  if (phase.kind === "code") {
    const [before = "", after = ""] = connect.sentence.split("{command}");
    const until = new Date(phase.code.expires_at).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" });
    return (
      <div>
        <CopyLine label={ui.connect_paste} text={fill(connect.sentence, { command: phase.code.command })} mono={false}>
          {before.trim()}
          {/* The command on a line of its own, so it is read whole at any width. */}
          <code className="my-1 block w-fit max-w-full rounded-[4px] bg-surface px-1.5 py-0.5 font-mono text-[11.5px] leading-[1.6] text-ink shadow-hairline [overflow-wrap:anywhere]">{phase.code.command}</code>
          {after.trim()}
        </CopyLine>
        <div className="mt-2 flex items-center gap-2">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span role="status" className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
            {fill(ui.connect_waiting, { time: until })}
          </span>
          <ContextNote label={ui.more_info}>{ui.connect_more}</ContextNote>
          <Button variant="ghost" size="xs" onClick={close}>
            {ui.connect_close}
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "expired") {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">{ui.connect_expired}</p>
          <Button variant="accent" size="sm" className="text-[12.5px]" disabled={busy} onClick={() => make()}>
            {busy ? ui.working : ui.connect_again}
          </Button>
        </div>
        {failure && <Failure text={failure.text} detail={failure.detail} />}
      </div>
    );
  }

  return (
    <form onSubmit={make}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <TextField value={label} onChange={setLabel} label={ui.connect_label} placeholder={ui.connect_placeholder} disabled={busy} maxLength={40} />
        </div>
        <Button type="submit" variant="accent" size="sm" className="mb-1 text-[12.5px]" disabled={busy || !label.trim()}>
          {busy ? ui.working : ui.connect_go}
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" size="sm" className="mb-1 px-2.5 text-[12.5px]" disabled={busy} onClick={close}>
            {ui.cancel}
          </Button>
        )}
      </div>
      {failure && <Failure text={failure.text} detail={failure.detail} />}
    </form>
  );
}

/** One connection, with revoking it behind the page's confirmation drawer. */
function ConnectionRow({ connection }: { connection: Connection }) {
  const ui = useUi();
  const { access, refusals } = usePage();
  const owner = useOwner();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await act(connection.revokeUrl, {}, access);
    if (result.ok) {
      location.reload();
      return;
    }
    setBusy(false);
    if (result.lost) return owner.lose();
    setFailure({ text: refusals[String(result.data.reason ?? "")] ?? ui.failed, detail: String(result.data.error ?? "") });
  };
  return (
    <li>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{connection.label}</p>
          <p className="text-[12px] text-ink-3">
            <RichText rich={connection.meta} />
          </p>
        </div>
        {owner.state === "yes" && !asking && (
          <Button variant="quiet" size="xs" onClick={() => setAsking(true)}>
            {ui.revoke}
          </Button>
        )}
      </div>
      <Drawer open={asking}>
        <p className="text-[13px] leading-relaxed text-ink-2">{fill(ui.revoke_body, { label: connection.label })}</p>
        {failure && <Failure text={failure.text} detail={failure.detail} />}
        <div className="mt-2 flex items-center justify-end gap-2">
          {busy ? (
            <LoadingState label={ui.working} />
          ) : (
            <>
              <Button variant="ghost" size="sm" className="px-2.5 text-[12.5px]" onClick={() => setAsking(false)}>
                {ui.cancel}
              </Button>
              <Button variant="accent" size="sm" className="text-[12.5px]" onClick={revoke}>
                {ui.revoke_go}
              </Button>
            </>
          )}
        </div>
      </Drawer>
    </li>
  );
}

/** The assistants connected to this Host, and connecting another. */
export function Connections({ connections, connect }: { connections: readonly Connection[]; connect: ConnectModel }) {
  const ui = useUi();
  const owner = useOwner();
  const [adding, setAdding] = useState(false);
  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-card bg-surface shadow-card">
      {connections.length > 0 && (
        <ul className="divide-y divide-line">
          {connections.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
      <div className={`px-3 py-2.5 ${connections.length ? "border-t border-line" : ""}`}>
        {adding ? (
          <ConnectPanel connect={connect} onClose={() => setAdding(false)} />
        ) : (
          owner.state === "yes" && (
            <Button variant="secondary" size="xs" onClick={() => setAdding(true)}>
              {connections.length ? ui.connect_another : ui.connect_title}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** The assistants connected to this Host, at the end of the home view (the Cloudflare edition). */
export function ConnectionsBlock({ connections, connect }: { connections: readonly Connection[]; connect: ConnectModel }) {
  const ui = useUi();
  return (
    <Collapsible label={connections.length ? `${ui.connections_title} · ${connections.length}` : ui.connections_title}>
      <Connections connections={connections} connect={connect} />
    </Collapsible>
  );
}
