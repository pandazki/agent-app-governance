# agent-app-governance

[中文版](./README.zh-CN.md)

A coding agent such as Claude Code or Codex can build a small app with stored data in a few minutes. Living with that app afterwards is the hard part:

- Nobody keeps track of what changed, who asked for it, or whether anything was checked before it went live.
- The next change can break the app or delete its data, and the agent does not always stop to ask.
- Going back is guesswork. The agent's session is gone, and stored data does not go back with the code.

This repository puts such apps under one governed loop. Whichever agent makes a change, the change takes the same path before it goes live, and the app's own directory keeps the record. It is built on [pneuma-framework](https://github.com/pandazki/pneuma-framework) and [PneumaSpace](https://github.com/pandazki/pneuma-space).

## What you get

- **One loop, one knob.** You start the Host in one of three modes:
  - `record`: every change is recorded and published. Nothing is checked.
  - `personal` (the default): every change runs the app's tests and a preview. A standing policy lets ordinary changes go live; risky ones, such as dropping sign-in or deleting stored data, wait for you.
  - `review-all`: the same checks, and you decide every change.

  Which change counts as risky is set in a preset file, not in code.
- **Every change recorded.** Each version is kept in the app's directory with what was asked, which agent made it, and which guarantees held: checked, previewed, approved, unchanged since the check. A version that was only recorded says so. Copy the directory to another machine and the history goes with it.
- **Undo, with its limits stated.** Undo puts back the code of an earlier version. Stored data comes back only if the Host declares a data snapshot capability; as shipped it declares none, and says so. A change that deletes data is marked one-way, and going back past it needs your confirmation.
- **Any agent, or a product that starts one.** An agent edits the app in place and submits with a small CLI kept in the app's directory. A product can also start Claude Code or Codex itself. Both write to the same history. A page shows your apps and what waits for you, and lets you decide and go back.

## Editions

| Edition | State | Where the apps run |
| --- | --- | --- |
| [local](./local/README.md) | Runs | Your machine: one `docker compose up` starts PneumaSpace and the Host, on loopback ports |
| [cloudflare](./cloudflare/README.md) | Being built | Cloudflare |

To try the local edition, with Docker running:

```sh
cd local
docker compose up -d --build
node bin/pneuma.mjs create todo
```

Then open http://127.0.0.1:8090/. [local/README.md](./local/README.md) covers the rest: handing the app to your agent, the owner link, other ports, and the tests.

## Limits

These come from the runs recorded in [local/README.md](./local/README.md) and from pneuma-framework's [milestone 54 snapshot](https://github.com/pandazki/pneuma-framework/blob/c1ffce726866a3b315e9714c49a5547c2426fbcf/docs/archive/milestone-54-snapshot.md), which says what this setup proved and what it did not.

- The Host in `local/` is an example to copy, not a package to import. The code that publishes a version, checks that the app answers and puts the address back lives in the example, not in pneuma-framework.
- On one machine the owner is not authenticated. Approving needs a terminal, or a link the Host prints in its log. That stops an honest agent from approving its own change, not another program on the same machine.
- Stored data comes back on undo only with a declared snapshot capability. `local/` ships one as a practice, off by default, for apps whose database is on PostgreSQL. Apps on SQLite, and files, key-value data and objects, are not covered.
- The preset's rules for SQL are text patterns: they stop a `DROP` written in a string that never runs, and miss a deletion built from variables.
- It has run end to end on macOS, with colima and with Docker Desktop. A whole Linux machine, several users and hosted operation have not been run.

## Built on

- [pneuma-framework](https://github.com/pandazki/pneuma-framework) provides the loop: the change record, the governed change, the approval rules, the rollout state, and the Claude Code and Codex lanes. Its packages are not published; the local edition takes them from source at one pinned commit.
- [PneumaSpace](https://github.com/pandazki/pneuma-space) runs the apps: an app is a directory and a manifest, a preview is an app that ends itself, and a released app refuses writes that do not name its manager. The local edition builds it from source at one pinned commit.
