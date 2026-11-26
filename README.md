# agent-app-governance

[中文版](./README.zh-CN.md)

## Start here

You get a page with the small apps your coding agent (Claude Code or Codex) builds for you, a record of every change, your say on the risky ones, and a way back to an earlier version. It covers the apps you create here: apps you already have cannot be imported, and it is not a backup of their data.

Choose one edition:

- **Local**: runs on your computer, in Docker. You need Docker, Node.js 24 and git. Nothing to pay. An agent's install took about two minutes with the images already built; building them the first time takes longer.
- **Cloudflare**: runs on your own Cloudflare account, so nothing runs on your computer once it is installed. You need a Cloudflare account on the Workers Paid plan (it costs money every month) with a domain in it (a domain costs a yearly fee), and Docker, Node.js 24 and Bun for the install. It installs PneumaSpace there too, and asks you for a few things only you can do in Cloudflare.

The easiest way to start: open Claude Code or Codex in the folder where it should go, and paste one sentence.

- Local: `Install the local edition of https://github.com/pandazki/agent-app-governance on this computer, following AGENTS.md in that repository.`
- Cloudflare: `Install the Cloudflare edition of https://github.com/pandazki/agent-app-governance on my Cloudflare account, following AGENTS.md in that repository.`

Your agent checks what is needed first and stops to ask you for what only you can do. To do it by hand: [the local guide](./local/README.md), [the Cloudflare guide](./cloudflare/README.md).

When it is done, you have your apps page to open in your browser (for the local edition, http://127.0.0.1:8090/ or the address your agent gives you; for the Cloudflare one, your Host's own address), and it shows the next step. Then you tell your agent what you want, for example: "Make me a new app called reading-list: a list of books I want to read, where I can add a book and tick it off when I've read it."

## What it is

A coding agent such as Claude Code or Codex can build a small app with stored data in a few minutes. Living with that app afterwards is the hard part:

- Nobody keeps track of what changed, who asked for it, or whether anything was checked before it went live.
- The next change can break the app or delete its data, and the agent does not always stop to ask.
- Going back is guesswork. The agent's session is gone, and stored data does not go back with the code.

This repository gives such apps one way to go live. You create an app here from a template. Whichever agent changes it afterwards submits the change to a service called the Host, which checks it, has it approved by a rule or by you, publishes it, and records it in the app's own folder.

## What you get

- **One setting for how strict it is.** The Host runs in one of three modes:
  - `record`: every change is recorded and the Host publishes it. Nothing checks or approves it. A change that fails to start stays recorded but not live.
  - `personal` (the default): a change has to pass the app's tests and, unless previews are switched off, start in a preview and answer there the requests the app declares in `preview.json`. A standing rule lets ordinary changes go live; risky ones wait for you. With the default preset, a change is risky when visitors no longer have to sign in, or when new SQL drops or renames a table or column, drops an index, empties a table, or deletes every row. An `UPDATE` that changes stored rows is not caught.
  - `review-all`: the same checks, and you decide every change after the app is created. Creating an app never waits for you.

  Which change counts as risky is set in a preset file, not in code.
- **Every change recorded.** Each version is kept in the app's folder with what was asked, which agent made it, and which guarantees held: checked, previewed, approved, unchanged since the check. A version that was only recorded says so. Copy the folder to another machine and its source and history go with it; the app's stored data does not.
- **Undo, with its limits stated.** Undo puts back the code of an earlier version. Stored data stays as it is, unless you set up the optional data snapshots for apps on PostgreSQL; they are off by default, and `status` says so. A one-way change is one that putting the old code back cannot undo, such as dropping a column. Going back past one needs your confirmation. In `personal` and `review-all` the preset marks such changes, and in every mode the agent can mark one itself by submitting with `--one-way "<what is lost>"`. The preset sets the least a change needs and the agent can only raise it: a change the agent marks waits for you, with its words shown as its own, even when the rules found nothing.
- **Any agent, or a product that starts one.** An agent edits the app in place and submits with a small CLI kept in the app's folder. A program can also have the Host start Claude Code or Codex itself. Both write to the same history. A page lists your apps and what waits for you, and lets you decide and go back.

## Editions

| Edition | State | Where the apps run |
| --- | --- | --- |
| [local](./local/README.md) | Runs | Your machine: one `docker compose up` starts PneumaSpace and the Host, on loopback ports |
| [cloudflare](./cloudflare/README.md) | Runs, `personal` mode only, the apps page behind a sign-in | Cloudflare: the Host in a Container behind a Worker, each app's record in R2, the apps on a PneumaSpace deployment on Cloudflare. The owner signs in; agents use tokens the owner creates |

The local edition assumes one trusted machine, four free ports on 127.0.0.1, Docker (its gateway container mounts the Docker socket) and Node.js 24. [local/README.md](./local/README.md) lists what it needs before you start. With that in place:

```sh
cd local
docker compose up -d --build
```

Then open your apps page, http://127.0.0.1:8090/: it shows the two steps to a first app. The local guide goes on from there: deciding on a change, and going back.

## Limits

- It covers new apps created here from PneumaSpace's template. Nothing imports an existing app or its data.
- The local edition: one trusted machine and one person. The owner is not authenticated: approving needs a terminal, or a link the Host prints in its log. That stops an honest agent from approving its own change, not another program on the same machine.
- Undo restores code. Stored data comes back only through the optional snapshot practice, and only for apps whose database is on PostgreSQL. Apps on SQLite, and files, key-value data and objects, are not covered.
- The preset's rules for SQL are text patterns: they stop a `DROP` written in a string that never runs, and miss a deletion built from variables.
- The rules read only SQL text and the app's manifest. A change that deletes or rewrites files, key-value data or objects looks like an ordinary code change to them; for that, the Host relies on the agent declaring it with `--one-way`. The agent instructions in every app tell it to.
- The Host is code in this repository, not a package to import. The parts that publish a version, check that the app answers and put the address back are in `host/`, not in pneuma-framework.
- What has been run: on an earlier build of this code, on macOS with colima and with Docker Desktop, real Claude Code and Codex sessions that changed apps and submitted them, changes that waited for the owner and were approved or denied, an undo past a one-way change, and the PostgreSQL snapshots. On this code: the offline tests, and one create, scripted change and undo on macOS with colima. On 2026-11-26, from the sentence under "Start here", a Codex session installed the local edition on a machine whose default ports were taken (it chose other ports and touched nothing else), and a second session made a working app (reading-list) from its hand-off. Not run: a whole Linux machine, several users, a hosted setup.

## Built on

- [pneuma-framework](https://github.com/pandazki/pneuma-framework) provides the change history and its guarantees, the sequence of checks before a change is applied, the approval rules, the record of which version an address serves, and the adapters that start Claude Code and Codex. Its packages are not published; the local edition takes them from source at one pinned commit.
- [PneumaSpace](https://github.com/pandazki/pneuma-space) runs the apps: an app is a folder and a manifest, a preview is a temporary app that ends itself, and a released app refuses writes that do not name the Host that manages it. The local edition builds it from source at one pinned commit.

## License

[MIT](./LICENSE). pneuma-framework and PneumaSpace, which the images are built from, are MIT too.
