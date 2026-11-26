import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WORDS } from "../src/page-words";

// The runbook for an agent asked to install this (AGENTS.md at the repository's root) and the README's "Start here"
// are followed by agents that have nothing else. What can be checked without running an install is checked here:
// every file and link they name exists, every command names a script, a flag, a setting or a route that exists, and
// the words they promise the person match the page's.

const REPO = resolve(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const RUNBOOK = read("AGENTS.md");
const DOCS = ["AGENTS.md", "README.md", "README.zh-CN.md", "local/README.md", "local/README.zh-CN.md", "cloudflare/README.md", "cloudflare/README.zh-CN.md"];
const REPO_URL = "https://github.com/pandazki/agent-app-governance";

/** The anchors GitHub gives a Markdown file's headings. */
function anchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(([, title]) =>
      title!
        .trim()
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .replace(/ /g, "-"),
    ),
  );
}

/** Every command line in the fenced shell blocks, comments taken off. */
function commands(markdown: string): string[] {
  return [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(([, block]) =>
    block!
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter(Boolean),
  );
}

describe("the runbook and Start here, checked without an install", () => {
  test("CLAUDE.md at the root points Claude Code at the runbook", () => {
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
  });

  test("every relative link in the runbook and the guides names a file that exists, and a heading there when it names one", () => {
    for (const doc of DOCS) {
      const text = read(doc);
      for (const [, target] of text.matchAll(/\]\((?!https?:|mailto:)([^)\s]+)\)/g)) {
        const [path, hash] = target!.split("#");
        const file = path ? resolve(dirname(join(REPO, doc)), path) : join(REPO, doc);
        expect({ doc, target, exists: existsSync(file) }).toEqual({ doc, target, exists: true });
        if (hash && file.endsWith(".md")) expect({ doc, target, anchored: anchors(readFileSync(file, "utf8")).has(decodeURIComponent(hash)) }).toEqual({ doc, target, anchored: true });
      }
    }
  });

  test("every file in this repository that a runbook command runs or names exists", () => {
    const named = [
      "local/compose.yaml",
      "local/.env.example",
      "local/bin/appgov.mjs",
      "local/apps",
      "local/docs/reference.md",
      "cloudflare/scripts/install.mjs",
      "cloudflare/package.json",
      "cloudflare/package-lock.json",
      "cloudflare/README.md",
    ];
    for (const rel of named) expect({ rel, exists: existsSync(join(REPO, rel)) }).toEqual({ rel, exists: true });
    const lines = commands(RUNBOOK);
    // Run from local/ (after `cd local`) or from the root: each script a command runs is one of these.
    for (const line of lines.filter((l) => /^node \S+\.mjs/.test(l))) {
      const script = line.split(/\s+/)[1]!;
      const from = script.startsWith("bin/") ? "local" : script.startsWith("cf/") ? null : ".";
      if (from) expect({ line, exists: existsSync(join(REPO, from, script)) }).toEqual({ line, exists: true });
    }
    expect(lines).toContain("cd local");
    expect(lines).toContain("docker compose up -d --build");
    expect(lines).toContain("node bin/appgov.mjs list");
    // The clone goes into a named subfolder, never into the folder the agent was opened in.
    expect(lines).toContain(`git clone ${REPO_URL}.git agent-app-governance`);
    expect(lines).toContain("cd agent-app-governance");
  });

  test("the first Docker check tells Docker not running apart from Docker running under another context, with commands that change nothing", () => {
    const rows = RUNBOOK.split("\n").filter((line) => line.startsWith("| Docker answers |"));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).toContain('"When `docker info` fails"');
      expect(row).not.toContain("not running");
    }
    const start = RUNBOOK.indexOf("**When `docker info` fails**");
    expect(start).toBeGreaterThan(-1);
    const part = RUNBOOK.slice(start, RUNBOOK.indexOf("\n#", start));
    const says = [...part.matchAll(/Say: "([^"]+)"/g)].map(([, s]) => s!);
    expect(says.length).toBe(2);
    const [stopped, elsewhere] = [says.find((s) => s.includes("not running")), says.find((s) => s.includes("docker context use <name>"))];
    for (const words of ["Docker Desktop", "`colima start`"]) expect(stopped).toContain(words);
    expect(stopped).not.toContain("docker context use");
    for (const words of ["`<name>`", "`<current>`", "`DOCKER_CONTEXT=<name>`"]) expect(elsewhere).toContain(words);
    expect(elsewhere).not.toContain("not running");
    // What the agent runs here only reads: the commands outside the two messages.
    const run = [...part.replace(/Say: "[^"]+"/g, "").matchAll(/`(docker [^`]+)`/g)].map(([, c]) => c!);
    expect(run).toEqual(expect.arrayContaining(["docker context ls -q", "docker context show"]));
    for (const command of run) expect({ command, reads: /^docker (info\b|context (ls|show)\b|--context \S+ info\b)/.test(command) }).toEqual({ command, reads: true });
  });

  test("an agent's credential has one name: a token, 令牌", () => {
    for (const doc of DOCS) expect({ doc, found: /access key|访问密钥|agent token|agent 令牌/i.exec(read(doc))?.[0] ?? null }).toEqual({ doc, found: null });
  });

  test("the local install's checks match compose.yaml: the ports, the six services, the names, the settings for another stack", () => {
    const compose = read("local/compose.yaml");
    for (const [setting, port] of [["PNEUMA_SPACE_HTTP_PORT", 8080], ["PNEUMA_SPACE_ADMIN_PORT", 8081], ["PNEUMA_SPACE_OBJECT_PORT", 9000], ["APPGOV_HOST_PORT", 8090]] as const) {
      expect(compose).toContain(`\${${setting}:-${port}}`);
      expect(RUNBOOK).toContain(`-iTCP:${port}`);
      expect(RUNBOOK).toContain(`${setting}=`);
    }
    expect(compose).toContain("name: agent-app-governance");
    expect(compose).toContain("${PNEUMA_SPACE_NETWORK:-agent-app-governance}");
    expect(RUNBOOK).toContain("COMPOSE_PROJECT_NAME=");
    expect(RUNBOOK).toContain("PNEUMA_SPACE_NETWORK=");
    // Six services start by default (those under a profile do not).
    const block = compose.slice(compose.indexOf("\nservices:\n"), compose.search(/\n(?:volumes|networks):\n/));
    const defined = [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\s*#.*\n|\n)*)/gm)];
    const services = defined.filter(([, , body]) => !/^ {4}profiles:/m.test(body!)).map(([, name]) => name);
    expect(services.length).toBe(6);
    expect(RUNBOOK).toContain("six services");
    // The checks it runs against the stack answer where it says, and ask Compose for the port, so a port changed in
    // .env needs nothing by hand: no command names a port the stack listens on, and the hand-off takes Compose's answer.
    expect(compose).toContain("http://127.0.0.1:8081/healthz");
    const bodies = new Map(defined.map(([, name, body]) => [name!, body!]));
    for (const [service, port] of [["host", 8090], ["gateway", 8081]] as const) {
      expect(bodies.get(service)).toContain(`:${port}"`);
      expect(RUNBOOK).toContain(`$(docker compose port ${service} ${port})`);
    }
    for (const line of commands(RUNBOOK)) expect({ line, port: /127\.0\.0\.1:(8080|8081|8090|9000)\b/.test(line) }).toEqual({ line, port: false });
    expect(RUNBOOK).toContain("Your apps page is `http://<address>/`");
    expect(RUNBOOK).toContain("`<address>` is what `docker compose port host 8090` printed");
    // `grep "owner link"` in the hand-off finds the link's own line: no other line the Host prints at start says those words.
    const serve = read("local/src/serve.ts");
    expect(serve.split("\n").filter((line) => line.includes("console.log(") && line.includes("owner link")).length).toBe(1);
    expect(RUNBOOK).toContain('docker compose logs host | grep "owner link" | tail -1');
    expect(RUNBOOK).toContain('grep -v "owner link"');
    expect(read("local/bin/appgov.mjs")).toContain("no apps yet");
    expect(read("local/compose.yaml")).toContain("additional_contexts");
  });

  test("the Cloudflare install's commands use flags the installers take, and its files are where the installers write them", () => {
    const usage = /const USAGE = "([^"]+)"/.exec(read("cloudflare/scripts/install.mjs"))![1]!;
    for (const flag of ["--space-owner", "--prefix", "--domain", "--account"]) {
      expect(usage).toContain(flag);
      expect(RUNBOOK).toContain(flag);
    }
    expect(read("cloudflare/scripts/install.mjs")).toContain('join(homedir(), ".appgov"), "hosts", prefix)');
    expect(RUNBOOK).toContain("~/.appgov/hosts/<prefix>/owner.json");
    expect(RUNBOOK).toContain("~/.pneuma-space/hosts/<space domain>/owner.json");
    // What it checks against the Host answers as it says (cloudflare/test/connect.test.ts checks the answers).
    for (const route of ["<host>/ ", "<host>/apps ", "<host>/connect "]) expect(RUNBOOK).toContain(route);
  });

  test("the words promised to the person are the page's: the action to press, the first sentence, Codex's setting", () => {
    expect(RUNBOOK).toContain(`"${WORDS.en.connect_title}"`);
    expect(read("cloudflare/scripts/install.mjs")).toContain(`"${WORDS.en.connect_title}"`);
    expect(read("cloudflare/README.md")).toContain(`**${WORDS.en.connect_title}.**`);
    expect(read("cloudflare/README.zh-CN.md")).toContain(`**${WORDS.zh.connect_title}。**`);
    expect(RUNBOOK).toContain(WORDS.en.hint_new);
    expect(read("README.md")).toContain(WORDS.en.hint_new);
    expect(read("README.zh-CN.md")).toContain(WORDS.zh.hint_new);
    expect(WORDS.en.start_open_more).toContain("codex -c sandbox_workspace_write.network_access=true");
    expect(RUNBOOK).toContain("codex -c sandbox_workspace_write.network_access=true");
  });

  test("the guides quote the connect sentence as the page gives it", () => {
    const command = "`curl -fsSo .appgov-connect.cjs https://appgov-host.<subdomain>.workers.dev/connect && node .appgov-connect.cjs K7QM-4XPD-2R9T`";
    expect(read("cloudflare/README.md")).toContain(WORDS.en.connect_sentence.replace("{command}", command));
    expect(read("cloudflare/README.zh-CN.md")).toContain(WORDS.zh.connect_sentence.replace("{command}", command));
  });

  test("Start here gives each edition one sentence for the agent, with this repository's address and the runbook", () => {
    for (const doc of ["README.md", "README.zh-CN.md"]) {
      const text = read(doc);
      const start = text.indexOf("## ", text.indexOf("\n"));
      const sentences = [...text.slice(start, text.indexOf("\n## ", start + 3)).matchAll(/`(Install the [^`]+)`/g)].map(([, s]) => s!);
      expect(sentences).toEqual([
        `Install the local edition of ${REPO_URL} on this computer, following AGENTS.md in that repository.`,
        `Install the Cloudflare edition of ${REPO_URL} on my Cloudflare account, following AGENTS.md in that repository.`,
      ]);
    }
    expect(read("cloudflare/package.json")).toContain("wrangler");
  });

  test("no em dashes in what an agent or a person reads first", () => {
    for (const doc of ["AGENTS.md", "README.md", "README.zh-CN.md"]) expect({ doc, dash: read(doc).includes("—") }).toEqual({ doc, dash: false });
  });
});
