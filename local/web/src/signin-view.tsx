import { useRef, useState, type FormEvent } from "react";
import { Button } from "../beautifui/atoms/Button";
import LoadingState from "../beautifui/primitives/LoadingState";
import { ContextNote } from "./context-note";
import type { SignInModel } from "./model";
import { Header, TextField } from "./parts";

/**
 * Before the owner signs in (the Cloudflare edition): one field for the owner key and one button, in the cards'
 * grammar of the rest of the page. It says nothing about the apps; the Host serves nothing else until the key is right.
 * The key goes to the Host once, in the body of a same-origin request; the session comes back as a cookie no script
 * can read, and the page reloads into the view that was asked for.
 */
export function SignInView({ model }: { model: SignInModel }) {
  const ui = model.ui;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sending = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = key.trim();
    if (sending.current || !typed) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    let status = 0;
    try {
      const res = await fetch(model.signInUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: typed }) });
      status = res.status;
      await res.body?.cancel();
    } catch {}
    if (status === 200) {
      location.reload();
      return;
    }
    sending.current = false;
    setBusy(false);
    setFailure(status === 401 ? ui.signin_wrong : status === 429 ? ui.signin_limited : ui.failed);
  };

  return (
    <>
      <Header crumbs={[]} title={ui.signin_title} meta={ui.signin_lead} bare />
      <div className="px-5 py-6 sm:px-8">
          <form onSubmit={submit} className="mx-auto w-full max-w-[440px] overflow-hidden rounded-card bg-surface shadow-card">
            <div className="primitive-card-pad">
              <TextField type="password" name="key" value={key} onChange={setKey} autoComplete="current-password" autoFocus label={ui.signin_key} error={failure} help={<ContextNote label={ui.details}>{ui.signin_where}</ContextNote>} disabled={busy} />
            </div>
            <div className="primitive-card-footer flex items-center justify-between gap-3 border-t border-line">
              {busy ? (
                <span className="pl-0.5">
                  <LoadingState label={ui.working} />
                </span>
              ) : (
                <span />
              )}
              <Button type="submit" variant="accent" size="sm" className="text-[12.5px]" disabled={busy || !key.trim()}>
                {ui.signin_go}
              </Button>
            </div>
          </form>
      </div>
    </>
  );
}
