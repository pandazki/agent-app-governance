# Apps kept by an appgov centre

This directory is where you work with apps that an appgov centre keeps and publishes on PneumaSpace. The centre is at {{CENTRE}}. Nothing needs installing. Run these from this directory:

- `node .appgov/appgov.mjs list`: every app, with its version, its address, the last change and what waits for the owner.
- `node .appgov/appgov.mjs create <name>`: create and publish a new app. Its working copy appears here as `<name>/`.
- `node .appgov/appgov.mjs fetch <name>`: put the working copy of an app that already exists here as `<name>/`.
- `node .appgov/appgov.mjs status <name>` and `node .appgov/appgov.mjs history <name>`: one app in full.

To change an app, work inside its directory and follow its own `AGENTS.md`. A change goes live only through that app's `submit`; never publish an app another way. When a change waits for the owner, only the owner decides. Never approve or deny a change yourself, never run a command with `--owner`, `login` or `token`, and never read the owner's files under `~/.appgov/`: those are the user's, in their own terminal.

`.appgov/centre.json` holds the centre's address and an agent token, which is a credential. Never print it or show its contents, copy it into another file, or commit it; the CLI reads it for you. If the centre refuses the token, ask the user for a new one.

If the CLI says it is at another API level than the centre, run `node .appgov/appgov.mjs update` to get the centre's own CLI. Do not download a CLI from anywhere else.
