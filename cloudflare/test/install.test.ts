import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The installer's decisions about the Host's address (cloudflare/scripts/install.mjs), against a fake Cloudflare API:
// which hostname the Host is served on, which zone it is in, whether another Worker has it, and the address the owner
// credentials file and the Worker are given. The deploy itself is run for real (see the README).

// A path the type checker does not follow: the installer is plain JavaScript run by Node.
const install = (await import(join(import.meta.dir, "..", "scripts", "install.mjs"))) as {
  parse(argv: string[]): { domain?: string; prefix: string };
  chooseDomain(recorded: string | undefined, given: string | undefined): string | null;
  hostAddress(domain: string | null, workersDev: string): string;
  findZone(api: Api, accountId: string, hostname: string): Promise<{ id: string; nameServers: string[] }>;
  waitForRecord(hostname: string, nameServers: string[], options: { wait?: number; every?: number; resolver?: unknown }): Promise<boolean>;
  domainHolder(api: Api, accountId: string, hostname: string, service: string): Promise<string | null>;
  attachDomain(api: Api, accountId: string, zoneId: string, hostname: string, service: string): Promise<void>;
  ownerRecord(existing: Record<string, unknown> | null, url: string, key: string): Record<string, unknown>;
  workerConfig(options: Record<string, unknown>, accountId: string, commit: string, hostUrl: string): { vars: Record<string, string>; routes?: unknown };
  waitForHttps(url: string, options: { wait?: number; every?: number; first?: number; fetcher?: (url: string, init?: unknown) => Promise<Response> }): Promise<void>;
  Stop: new (message: string) => Error;
};
type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; ok: boolean; result?: unknown; errors: string }>;

/** A Cloudflare API with one account: its zones and its Workers' custom domains; every call is kept. */
function fakeApi(zones: string[], domains: { hostname: string; service: string }[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const api: Api = async (method, path, body) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    const zone = /^\/zones\?name=([^&]+)&account\.id=acct$/.exec(path);
    if (method === "GET" && zone) return { status: 200, ok: true, result: zones.includes(zone[1]!) ? [{ id: `zone-${zone[1]}`, name: zone[1], name_servers: ["ana.ns.example.net", "bob.ns.example.net"] }] : [], errors: "" };
    if (method === "GET" && path === "/accounts/acct/workers/domains") return { status: 200, ok: true, result: domains, errors: "" };
    if (method === "PUT" && path === "/accounts/acct/workers/domains") {
      domains.push({ hostname: (body as { hostname: string }).hostname, service: (body as { service: string }).service });
      return { status: 200, ok: true, result: {}, errors: "" };
    }
    return { status: 404, ok: false, errors: "10000: not found" };
  };
  return { api, calls };
}

const args = (extra: string[] = []) => ["https://space.example.com", "--space-owner", "/tmp/owner.json", "--prefix", "appgov-host", ...extra];

describe("the installer and the Host's address", () => {
  test("--domain takes a hostname, in lowercase, and nothing else", () => {
    expect(install.parse(args()).domain).toBeUndefined();
    expect(install.parse(args(["--domain", "Host.Example.com"])).domain).toBe("host.example.com");
    expect(install.parse(args(["--domain", "https://host.example.com/"])).domain).toBe("host.example.com");
    for (const bad of ["localhost", "host.example.com/path", "host_name.example.com", "-host.example.com", "host.example.com:8443"]) expect(() => install.parse(args(["--domain", bad]))).toThrow(install.Stop);
  });

  test("a rerun without --domain keeps the domain the Host has; another one is refused with what to do instead", () => {
    expect(install.chooseDomain(undefined, undefined)).toBeNull();
    expect(install.chooseDomain(undefined, "host.example.com")).toBe("host.example.com");
    expect(install.chooseDomain("host.example.com", undefined)).toBe("host.example.com");
    expect(install.chooseDomain("host.example.com", "host.example.com")).toBe("host.example.com");
    expect(() => install.chooseDomain("host.example.com", "other.example.com")).toThrow(/served on host\.example\.com already\. To move it to other\.example\.com: remove host\.example\.com from the Worker/);
    expect(install.hostAddress("host.example.com", "https://appgov-host.<subdomain>.workers.dev")).toBe("https://host.example.com");
    expect(install.hostAddress(null, "https://appgov-host.<subdomain>.workers.dev")).toBe("https://appgov-host.<subdomain>.workers.dev");
  });

  test("the zone is the longest suffix of the hostname the account has; none is refused before anything changes", async () => {
    const { api, calls } = fakeApi(["example.com", "deep.example.com"], []);
    expect(await install.findZone(api, "acct", "host.deep.example.com")).toEqual({ id: "zone-deep.example.com", nameServers: ["ana.ns.example.net", "bob.ns.example.net"] });
    expect((await install.findZone(api, "acct", "host.example.com")).id).toBe("zone-example.com");
    await expect(install.findZone(api, "acct", "host.example.org")).rejects.toThrow(/no zone of host\.example\.org is in this Cloudflare account/);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("a hostname another Worker has is never taken over; one this Worker has is left as it is; a free one is attached", async () => {
    const taken = fakeApi(["example.com"], [{ hostname: "space.example.com", service: "pneuma-space" }]);
    await expect(install.domainHolder(taken.api, "acct", "space.example.com", "appgov-host")).rejects.toThrow(/space\.example\.com is a custom domain of another Worker \(pneuma-space\); it is not taken over/);
    expect(taken.calls.some((call) => call.method !== "GET")).toBe(false);

    const ours = fakeApi(["example.com"], [{ hostname: "host.example.com", service: "appgov-host" }]);
    expect(await install.domainHolder(ours.api, "acct", "host.example.com", "appgov-host")).toBe("appgov-host");

    const free = fakeApi(["example.com"], [{ hostname: "space.example.com", service: "pneuma-space" }]);
    expect(await install.domainHolder(free.api, "acct", "host.example.com", "appgov-host")).toBeNull();
    await install.attachDomain(free.api, "acct", "zone-example.com", "host.example.com", "appgov-host");
    expect(free.calls.at(-1)).toEqual({ method: "PUT", path: "/accounts/acct/workers/domains", body: { environment: "production", hostname: "host.example.com", service: "appgov-host", zone_id: "zone-example.com" } });
    // Run again: it is the Worker's now, and nothing more is asked.
    expect(await install.domainHolder(free.api, "acct", "host.example.com", "appgov-host")).toBe("appgov-host");
  });

  test("the record is looked for at the zone's own nameservers until they have it, and only then through this machine", async () => {
    let asked = 0;
    const resolver = {
      resolve4: async (name: string) => {
        expect(name).toBe("host.example.com");
        if (++asked < 3) throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
        return ["192.0.2.1"];
      },
      resolve6: async () => {
        throw Object.assign(new Error("queryAaaa ENODATA"), { code: "ENODATA" });
      },
    };
    expect(await install.waitForRecord("host.example.com", ["ana.ns.example.net"], { every: 5, resolver })).toBe(true);
    expect(asked).toBe(3);
    const never = { resolve4: async () => [], resolve6: async () => [] };
    expect(await install.waitForRecord("host.example.com", ["ana.ns.example.net"], { wait: 30, every: 5, resolver: never })).toBe(false);
  });

  test("the wait for HTTPS ends when the Host answers there, and says when it is this machine's lookup that fails", async () => {
    let asked = 0;
    await install.waitForHttps("https://host.example.com", {
      wait: 2000,
      every: 5,
      fetcher: async (url) => {
        asked++;
        expect(url).toBe("https://host.example.com/me");
        if (asked < 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        return new Response("{}", { status: 401 });
      },
    });
    expect(asked).toBe(3);
    const notFound = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    await expect(install.waitForHttps("https://host.example.com", { wait: 30, every: 5, fetcher: notFound })).rejects.toThrow(/is attached, but this machine cannot look its name up yet/);
    const noCertificate = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
    };
    await expect(install.waitForHttps("https://host.example.com", { wait: 30, every: 5, fetcher: noCertificate })).rejects.toThrow(/does not answer over valid HTTPS yet; its certificate may still be on its way/);
  });

  test("the Worker and the owner credentials file are given the Host's address; the key stays", () => {
    const config = install.workerConfig({ prefix: "appgov-host", space: "https://space.example.com" }, "acct", "0".repeat(40), "https://host.example.com");
    expect(config.vars.APPGOV_HOST_URL).toBe("https://host.example.com");
    // The domain is attached through the API, never as a route the deploy would replace.
    expect(config.routes).toBeUndefined();
    expect(install.ownerRecord({ url: "https://appgov-host.<subdomain>.workers.dev", key: "apk_kept" }, "https://host.example.com", "apk_other")).toEqual({ url: "https://host.example.com", key: "apk_kept" });
    expect(install.ownerRecord(null, "https://host.example.com", "apk_new")).toEqual({ url: "https://host.example.com", key: "apk_new" });
  });
});
