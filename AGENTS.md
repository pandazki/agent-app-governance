# Installing agent-app-governance: a runbook for coding agents

This file is for a coding agent that a person asked to install or set up this project. If you were asked to work on the code itself, it does not apply; each edition's guide is in its folder. For what the project is, read [README.md](./README.md); this file does not repeat it.

## Rules for the whole install

- **Secrets stay where they are.** Never print, `cat`, copy, paste into the chat or read back to the person a key, a token, an owner link, a session, or the contents of any file under `~/.appgov/` or `~/.pneuma-space/`, or of a `.appgov/centre.json`. When the person needs one, tell them which file it is in, and let them open it.
- **Touch only what you start.** Never stop, remove, restart or reconfigure a container, volume, network, compose project, Worker, bucket, database or DNS record that you did not create in this session. When a default name or port is taken, choose another as described below.
- **When a step fails, stop.** Report the exact command and its whole output to the person. Do not work around it by editing files in this repository, and do not try other commands that change things.
- The commands are for macOS or Linux, in bash or zsh, run from the repository's root unless a step says `cd`.

## 0. Which edition

If the person did not say, ask exactly one question:

> Which edition do you want?
> - Local: runs on this computer in Docker. Free. About five minutes.
> - Cloudflare: runs on your own Cloudflare account (Workers Paid plan, and a domain in that account). Nothing runs on this computer once it is installed.

## 1. The repository

If the current directory is not already a clone (no `README.md` and `local/compose.yaml` here), clone it into the current directory and work in it:

```sh
git clone https://github.com/pandazki/agent-app-governance.git
cd agent-app-governance
```

## The local edition

### Checks, before anything changes

| What | Command | Good answer | A bad answer means |
| --- | --- | --- | --- |
| Docker answers | `docker info --format '{{.ServerVersion}}'` | A version number | Docker is not running. Ask the person to start Docker Desktop or colima; do not start or reconfigure it yourself. |
| Which Docker context | `docker context show` | A name, such as `default`, `desktop-linux` or `colima` | If it is not the context the person uses for Docker, ask which one; then put `DOCKER_CONTEXT=<name>` before every `docker` command below. |
| Compose | `docker compose version --short` | 2.17 or newer | Older Compose cannot build the Host's image (it uses `additional_contexts`). Ask the person to update Docker. |
| Node.js | `node --version` | v24 or newer | Ask the person to install Node.js 24. The apps' tests need it. |
| git | `git --version` | A version | Ask the person to install git. |
| Free ports | `lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:9000 -iTCP:8090 -sTCP:LISTEN` (on Linux without lsof: `ss -ltn`) | Nothing listening on 8080, 8081, 9000 or 8090 | A port is taken: choose others, below. |
| Compose project name | `docker ps -a --filter label=com.docker.compose.project=agent-app-governance --format '{{.Names}}'` | No output | Another stack uses the name, unless it is this same clone's earlier install (`docker compose ps` in `local/` lists it): then just go on. Otherwise choose another name, below. |
| Docker network name | `docker network ls --filter name=^agent-app-governance$ --format '{{.Name}}'` | No output, or the earlier install of this clone | Taken by something else: choose another name, below. |

### When a default port or name is taken

Put these lines in `local/.env` (create the file; `local/.env.example` lists every setting), with values nothing else on the machine uses. Leave out the lines whose default is free.

```sh
COMPOSE_PROJECT_NAME=aag-2
PNEUMA_SPACE_NETWORK=aag-2
PNEUMA_SPACE_HTTP_PORT=48360
PNEUMA_SPACE_ADMIN_PORT=48361
PNEUMA_SPACE_OBJECT_PORT=48362
APPGOV_HOST_PORT=48363
```

A changed `APPGOV_HOST_PORT` changes the page's address below. Details: [running beside other services](./local/docs/reference.md#running-beside-other-services).

### Install

```sh
cd local
docker compose up -d --build
```

The first build takes several minutes: it builds PneumaSpace and the Host from source. Run it from `local/`, so the page knows where the apps folder is.

### Check it worked, without the person

From `local/`. Use the port from `.env` if you changed it.

```sh
docker compose ps --format '{{.Service}} {{.State}}'          # six services, each "running"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/  # 200: the apps page
curl -fsS -o /dev/null http://127.0.0.1:8081/healthz && echo ok  # PneumaSpace answers
node bin/appgov.mjs list                                        # "no apps yet", or the apps
```

Do not create an app to test it: it would stay in the person's list.

### Hand-off: say this to the person

Fill in the parts in angle brackets. Do not include the owner link: you have not read it.

> It is installed. Your apps page is http://127.0.0.1:8090/
>
> 1. To decide on changes there, open it from your owner link. In your own terminal, run
>    `cd <the clone>/local && docker compose logs host | grep "owner link" | tail -1`
>    and open the address at the end of that line in your browser. Keep it to yourself.
> 2. Open Claude Code or Codex in your apps folder, `<the clone>/local/apps`. For Codex, start it with `codex -c sandbox_workspace_write.network_access=true`.
> 3. Say, for example: "Make me a new app called reading-list: a list of books I want to read, where I can add a book and tick it off when I've read it."

## The Cloudflare edition

It needs a PneumaSpace deployment on the same Cloudflare account (PneumaSpace's Cloudflare edition), so there are two installs: PneumaSpace's, then the Host's. Both are safe to run again; each resumes where it stopped.

### Where you must stop and ask the person

You cannot do these: each needs the person's own Cloudflare sign-in or choice. Ask in these words, wait for the answer, and never ask them to paste a secret into the chat.

1. **Signing in to Cloudflare.** "Please run this in your own terminal and finish the sign-in in the browser it opens: `cd <the clone>/cloudflare && npx wrangler login`. Tell me when it says you are logged in." (Why: it needs your Cloudflare password, in your browser.)
2. **Which account and plan.** "Which Cloudflare account should I use, and is it on the Workers Paid plan? Containers need Workers Paid." (Why: Wrangler cannot see the plan. When the login sees several accounts, both installers take `--account <id>`.)
3. **The domain names.** "Which domain in that Cloudflare account should PneumaSpace use? I suggest `space.<your domain>`. Should the Host use `host.<your domain>`, or its free `workers.dev` address?" (Why: they are your names; the zone must already be in the account.)
4. **The API token for PneumaSpace's installer.** Its first run stops and prints a link and a file path. Say: "Please open this link: it is Cloudflare's page for creating an API token, with the permissions filled in. Create the token, and save it, alone, in `<the file it printed>` with your editor. Do not paste it here. Tell me when it is saved." (Why: only you can create tokens on your account, and the token must not pass through this chat.)
5. **A workers.dev subdomain**, only if the Host's installer says the account has none: "Please open Workers & Pages in the Cloudflare dashboard once and choose a workers.dev subdomain, then tell me." (Why: it is a one-time choice in the dashboard.)

### Checks, before anything changes

| What | Command | Good answer | A bad answer means |
| --- | --- | --- | --- |
| Docker answers | `docker info --format '{{.ServerVersion}}'` | A version number | Ask the person to start Docker. It builds the images, for linux/amd64. |
| Which Docker context | `docker context show` | A name | As in the local edition: if it is not the one the person uses, put `DOCKER_CONTEXT=<name>` before each installer command. |
| Node.js | `node --version` | v24 or newer | PneumaSpace's installer needs 24. Ask the person to install it. |
| Bun | `bun --version` | A version | The Host's installer builds the apps page with Bun. Ask the person to install it from https://bun.sh. |
| Wrangler signed in | `(cd cloudflare && npm ci && npx wrangler whoami)` | "You are logged in", and the account | Stop point 1. |
| PneumaSpace already there | `ls ~/.pneuma-space/hosts/*/owner.json` (names only; never open them) | No such file, or a file the person confirms is theirs to use | If one exists, ask whether to use that deployment instead of installing a new one. |

### Install PneumaSpace (skip when the person has a deployment to use)

From this repository's root, so that PneumaSpace lands next to it, not inside it:

```sh
cd ..
git clone https://github.com/pandazki/pneuma-space.git
cd pneuma-space
(cd cf && npm ci)
node cf/scripts/install.mjs <space domain> --prefix <prefix>
cd -    # back to this repository
```

`<space domain>` is the person's answer to stop point 3, for example `space.example.com`. `<prefix>` names the Worker, its database and buckets, for example `space-example`; if the installer says a name is taken, choose another prefix, never remove what has it. The first run stops for stop point 4; run the same command again once the token is saved. It ends with the console's address and the owner credentials file, `~/.pneuma-space/hosts/<space domain>/owner.json`.

### Install the Host

From this repository's root:

```sh
node cloudflare/scripts/install.mjs https://<space domain> \
  --space-owner ~/.pneuma-space/hosts/<space domain>/owner.json \
  --prefix appgov-host
```

Add `--domain <host domain>` when the person chose one in stop point 3, and `--account <id>` when the login sees several accounts. If it says the account already has a Worker named `appgov-host` that this machine did not install, choose another prefix, such as `appgov-host-2`. It ends by printing the Host's address and the owner credentials file, `~/.appgov/hosts/<prefix>/owner.json`.

### Check it worked, without the person

`<host>` is the address the installer printed.

```sh
curl -s -o /dev/null -w '%{http_code}\n' <host>/          # 401: the page asks for the owner's sign-in
curl -s -o /dev/null -w '%{http_code}\n' <host>/apps      # 401: the API asks for a credential
curl -s -o /dev/null -w '%{http_code}\n' <host>/connect   # 200: what connecting an assistant runs
```

The installer has already checked that the owner key signs in.

### Hand-off: say this to the person

> It is installed. Your apps page is `<host>`
>
> 1. Open it and sign in with your owner key: the value of `"key"` in `~/.appgov/hosts/<prefix>/owner.json` on this computer. Open that file yourself; I have not read it. Do not paste the key into a chat.
> 2. On the page, under "Connect my AI assistant", name the connection (for example this computer's name), get a code, and paste the sentence it shows to Claude Code or Codex, opened in an empty folder for your apps, such as `~/apps`.
> 3. Then say to it, for example: "Make me a new app called reading-list: a list of books I want to read, where I can add a book and tick it off when I've read it."
>
> Your apps open on PneumaSpace at `https://<space domain>/apps/<name>/`; sign in there at `https://<space domain>/login` with the account and key in `~/.pneuma-space/hosts/<space domain>/owner.json`.

If the person wants you to be the assistant they connect, they give you that sentence in an empty folder; follow it there.

## Where the guides are

- Local edition, by hand: [local/README.md](./local/README.md), and every setting in [local/docs/reference.md](./local/docs/reference.md).
- Cloudflare edition, by hand: [cloudflare/README.md](./cloudflare/README.md).
- PneumaSpace's Cloudflare edition: its own guide, `cf/README.md` in its repository.
