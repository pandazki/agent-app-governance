import { HostError, type AppHost, type OwnerAct } from "../../host/src/host";

// The owner's acts on whether an app is there, as the local edition's API (src/server.ts) and its owner page
// (src/owner.ts) both route them.

/** The owner's acts on whether an app is there, by the word their route ends in: the CLI's verbs. */
export const LIFECYCLE_VERBS = new Set(["take-down", "bring-back", "publish-again", "clear"]);

/** An owner's reason, when one was given: one line, as long as a deny's. */
export function reasonOf(input: Record<string, unknown>): { reason?: string } {
  return typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim().slice(0, 500) } : {};
}

/** Take down, bring back, publish again or clear, by the verb: the same acts for the API and the owner page. */
export function lifecycle(host: AppHost, name: string, verb: string, act: OwnerAct, confirm: unknown): Promise<unknown> {
  if (verb === "take-down") return host.takeDown(name, act);
  if (verb === "bring-back") return host.bringBack(name, act);
  if (verb === "publish-again") return host.publishAgain(name, act);
  if (verb === "clear") return host.clear(name, { ...act, confirm: typeof confirm === "string" ? confirm : "" });
  throw new HostError(404, "not found");
}

