# Apps managed by an appgov Host

This directory holds apps that an appgov Host keeps and publishes on PneumaSpace. Each directory here is one app with its own recorded history. The Host is at {{HOST_URL}}; the same address is in `.appgov/host.json`. The owner's page, at {{HOST_URL}}/ in a browser, shows every app, its history and what waits for them; decisions made there are the owner's own, through the owner link the Host printed for them.

Run these from this directory; nothing needs installing:

- `node .appgov/appgov.mjs list`: every app with its current version, its address, the last change (when, by which agent, what was asked), changes waiting for the owner, and files changed but not submitted.
- `node .appgov/appgov.mjs status <name>` and `node .appgov/appgov.mjs history <name>`: one app in full.
- `node .appgov/appgov.mjs create <name>`: create and publish a new app. Its directory appears here as `<name>/`.

To change an app, work inside its directory and follow its own `AGENTS.md`. An app here goes live only through this CLI's `create` and `submit`. Do not publish, deploy or host it with any other tool, skill or service your environment offers, and do not create accounts or projects elsewhere for it. Never copy files into an app. When a change waits for the owner, only the owner decides: on the Host's page, opened from their owner link, or in their own terminal. Never approve or deny a change yourself.

If the CLI cannot reach the Host, it names the address it tried and where that address came from. Ask the user for the right address and pass `--host <url>`.
