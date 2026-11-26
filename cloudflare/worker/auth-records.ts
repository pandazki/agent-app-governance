import type { AuthStore, CodeState, StoredCode, StoredToken } from "./gateway";

// ---------------------------------------------------------------------------
// The owner's sessions, the agent tokens, the one-time codes that connect an
// agent, and the count of failed attempts, over a synchronous key-value store:
// the auth Durable Object's own storage (worker/index.ts), or a map in the
// tests (test/stack.ts), so the tests run this very code.
//
// Secrets are never stored, only their SHA-256: `session:<hash>`,
// `token:<hash>` (with `token-id:<id>` naming the hash), `code:<hash>` (with
// `code-id:<id>` saying what became of it). A Durable Object runs one call at
// a time, so taking a code is one step: no second caller can take it too.
// ---------------------------------------------------------------------------

/** The Durable Object storage's synchronous key-value API, as much as this file uses. */
export interface SyncKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}

/** A map with the same API, for the tests. */
export class MapKv implements SyncKv {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put<T>(key: string, value: T): void {
    this.map.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
  *list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    for (const key of [...this.map.keys()].sort()) if (key.startsWith(prefix)) yield [key, this.map.get(key) as T];
  }
}

/** What became of a code, kept a day after it ended so the page can say so. */
interface CodeFate {
  readonly hash: string;
  readonly label: string;
  readonly expires_at: number;
  readonly state: "waiting" | "used" | "cancelled";
  readonly token_id?: string;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class AuthRecords implements AuthStore {
  constructor(private readonly kv: SyncKv) {}

  async addSession(hash: string, expiresAt: number): Promise<void> {
    this.kv.put(`session:${hash}`, { expires_at: expiresAt });
  }

  async hasSession(hash: string, now: number): Promise<boolean> {
    const found = this.kv.get<{ expires_at: number }>(`session:${hash}`);
    if (!found) return false;
    if (found.expires_at <= now) {
      this.kv.delete(`session:${hash}`);
      return false;
    }
    return true;
  }

  async dropSession(hash: string): Promise<void> {
    this.kv.delete(`session:${hash}`);
  }

  async addToken(hash: string, token: StoredToken): Promise<void> {
    this.kv.put(`token:${hash}`, token);
    this.kv.put(`token-id:${token.id}`, hash);
  }

  /** The token, when it is valid; its last use is noted, to the hour, for the owner's list of connections. */
  async findToken(hash: string, now: number): Promise<StoredToken | null> {
    const token = this.kv.get<StoredToken>(`token:${hash}`);
    if (!token || token.revoked_at !== null || token.expires_at <= now) return null;
    if (!token.last_used_at || now - token.last_used_at >= HOUR) this.kv.put(`token:${hash}`, { ...token, last_used_at: now });
    return token;
  }

  async listTokens(): Promise<StoredToken[]> {
    return [...this.kv.list<StoredToken>({ prefix: "token:" })].map(([, token]) => token).sort((a, b) => a.created_at - b.created_at);
  }

  async revokeToken(id: string, now: number): Promise<boolean> {
    const hash = this.kv.get<string>(`token-id:${id}`);
    const token = hash ? this.kv.get<StoredToken>(`token:${hash}`) : undefined;
    if (!hash || !token) return false;
    if (token.revoked_at === null) this.kv.put(`token:${hash}`, { ...token, revoked_at: now });
    return true;
  }

  async loginFailures(key: string, now: number, failed: boolean): Promise<number> {
    const slot = Math.floor(now / 600_000);
    const name = `login:${key}`;
    const kept = this.kv.get<{ slot: number; count: number }>(name);
    const count = kept && kept.slot === slot ? kept.count : 0;
    if (!failed) return count;
    this.kv.put(name, { slot, count: count + 1 });
    return count + 1;
  }

  /** Keep a new code, unless `limit` codes are waiting already. Codes that ended over a day ago are forgotten here. */
  async addCode(hash: string, code: StoredCode, now: number, limit: number): Promise<boolean> {
    let waiting = 0;
    for (const [key, fate] of [...this.kv.list<CodeFate>({ prefix: "code-id:" })]) {
      if (fate.state === "waiting" && fate.expires_at > now) waiting++;
      else if (fate.expires_at + DAY <= now) {
        this.kv.delete(key);
        this.kv.delete(`code:${fate.hash}`);
      } else if (fate.state === "waiting") this.kv.delete(`code:${fate.hash}`);
    }
    if (waiting >= limit) return false;
    this.kv.put(`code:${hash}`, code);
    this.kv.put<CodeFate>(`code-id:${code.id}`, { hash, label: code.label, expires_at: code.expires_at, state: "waiting" });
    return true;
  }

  /** Take the code: once. It is gone after this call whatever it finds, and a code past its time gives nothing. */
  async takeCode(hash: string, now: number): Promise<StoredCode | null> {
    const code = this.kv.get<StoredCode>(`code:${hash}`);
    if (!code) return null;
    this.kv.delete(`code:${hash}`);
    if (code.expires_at <= now) return null;
    const fate = this.kv.get<CodeFate>(`code-id:${code.id}`);
    if (fate) this.kv.put<CodeFate>(`code-id:${code.id}`, { ...fate, state: "used" });
    return code;
  }

  /** The token a used code became: noted so the page that made the code can say which connection it is. */
  async noteCodeToken(id: string, tokenId: string): Promise<void> {
    const fate = this.kv.get<CodeFate>(`code-id:${id}`);
    if (fate) this.kv.put<CodeFate>(`code-id:${id}`, { ...fate, token_id: tokenId });
  }

  async codeState(id: string, now: number): Promise<CodeState> {
    const fate = this.kv.get<CodeFate>(`code-id:${id}`);
    if (!fate || fate.state === "cancelled") return { state: "gone" };
    if (fate.state === "used") return { state: "used", label: fate.label, ...(fate.token_id ? { token_id: fate.token_id } : {}) };
    if (fate.expires_at <= now) return { state: "expired" };
    return { state: "waiting", expires_at: fate.expires_at };
  }

  /** The owner closed the code before it was used: it can no longer be taken. */
  async dropCode(id: string): Promise<boolean> {
    const fate = this.kv.get<CodeFate>(`code-id:${id}`);
    if (!fate) return false;
    this.kv.delete(`code:${fate.hash}`);
    if (fate.state === "waiting") this.kv.put<CodeFate>(`code-id:${id}`, { ...fate, state: "cancelled" });
    return true;
  }
}
