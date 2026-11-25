# agent-app-governance：本地版

[English](./README.md) · [回到仓库总览](../README.zh-CN.md)

本地版在你自己的电脑上用 Docker 运行。它启动两样东西：PneumaSpace，一个运行网页应用、保存应用数据的小平台；以及 Host，一个站在你的 coding agent 和 PneumaSpace 之间的服务。agent 在应用目录里改好应用并提交，Host 负责检查改动，交给规则或你来批准，再发布出去，并写进应用的历史。以后你能查到改了什么，也能退回去。

## 它管什么

- **在这里创建的应用。** `create` 用 PneumaSpace 的应用模板新建一个应用：一个用 TypeScript 写的小型网页应用，可以申请数据库、文件存储、键值存储和对象存储。你已经有的应用及其数据，没有办法接进来。
- **经过 Host 的改动。** 只有 agent 提交的改动才会被记录。用别的方式改动应用，比如在 PneumaSpace 控制台里操作，应用就和它的历史对不上了。
- **代码，而不是数据。** 回退是把早先版本的代码放回应用的地址上，应用存储的数据保持原样。这不是数据备份。有一项针对 PostgreSQL 数据库的可选设置，会在删除数据的改动之前存一份数据库副本（见[参考文档](./docs/reference.zh-CN.md#postgresql-数据快照)）。

## 开始之前

- **一台电脑、一个人，而且你信任这台电脑。** Host 没有登录。能访问它端口的人，都能看到你的应用页面和它的 API。防止 agent 自己批准自己改动的那些措施（`approve` 必须在终端里运行，页面上做决定需要一个私有链接），挡不住同一台电脑上的其他程序。
- **Docker** 要在运行，Compose 的版本要支持构建时的 `additional_contexts`，Host 的镜像用到了它。在 Linux 上，装 Docker Engine 加 Compose 和 buildx 插件就够了。
- **`gateway` 容器会挂载 Docker socket**（`/var/run/docker.sock`），也就是说它能控制这台电脑上的 Docker。
- **127.0.0.1 上要有四个空闲端口：** 8080（应用）、8081（PneumaSpace 控制台）、9000（对象存储）和 8090（Host）。其他地址上什么都不监听。要换端口，见[和其他服务并排运行](./docs/reference.zh-CN.md#和其他服务并排运行)。
- **Node.js 24 或更新版本。** 单跑 CLI 用 Node 18 就够，但 agent 会在你的电脑上跑每个应用的测试，而应用模板要求 Node 24。
- **第一次构建需要联网。** 镜像会从 GitHub 按 `compose.yaml` 里固定的提交构建 PneumaSpace 和 pneuma-framework，还会从 Docker Hub 拉基础镜像。

## 启动

在这个仓库的克隆里：

```sh
cd local
docker compose up -d --build
```

第一次构建要下载基础镜像，还要从源码构建 PneumaSpace 和 Host，所以比以后每次启动都慢。完成后有六个容器在运行：`gateway`、`runner`、`rustfs` 和 `redis` 属于 PneumaSpace，`screenshot` 给应用页面拍截图，`host` 就是 Host。

## 创建应用

```sh
node bin/pneuma.mjs create todo
```

应用名以小写字母开头，最多 30 个字符，只能用小写字母、数字和连字符。Host 会把模板拷到 `apps/todo/`，加上写给 agent 的说明和一个 `.pneuma/` 目录，跑一遍应用的测试，用一个临时名字把应用启动一次、确认它有应答（这叫预览），然后发布为版本 `v1`。它会打印应用地址，接着是该用 agent 打开的目录：

```
published v1 at http://127.0.0.1:8080/apps/todo/
risks: release_change; approved by: policy:auto
```

`policy:auto` 是放行常规改动的常设规则。不管哪种模式，创建应用都不用等你批准。

## 打开两个页面

- 应用本身：http://127.0.0.1:8080/apps/todo/
- 你的应用页面：http://127.0.0.1:8090/ ，列出你的应用、每个应用的历史，以及等你决定的改动。

谁都能查看应用页面。要在页面上做决定（让改动上线、拒绝改动、退回某个版本），需要从你的主人链接打开它。Host 会把这个链接打印在日志里：

```sh
docker compose logs host | grep "owner link"
```

那一行以 `http://127.0.0.1:8090/#owner=` 加一串令牌结尾。请你自己在浏览器里打开这个链接，不要交给 agent。Host 重启后链接不变。要换一个新链接，运行 `docker compose exec host rm /state/owner-token` 和 `docker compose restart host`，再看一遍日志。

PneumaSpace 控制台在 http://127.0.0.1:8081/ ，是平台自己的管理页面，没有登录。在那里改动应用会绕过 Host，应用的历史就和线上跑的东西对不上了。

## 把应用交给 agent

用你平常用的 agent 打开应用目录，用自己的话提出改动：

```sh
cd apps/todo
claude
```

或者

```sh
cd apps/todo
codex -c sandbox_workspace_write.network_access=true
```

应用里的 `AGENTS.md`（Claude Code 通过 `CLAUDE.md` 读到它）开头就是给 agent 的规则：先看 `status` 和 `history`，再改文件、加测试、跑 `npm test`，最后用 `node .pneuma/pneuma.mjs submit "<你提出的要求>"` 提交。这些都不用你去交代。

- **Codex：** 它默认的沙箱会拦住到 127.0.0.1 的连接，于是应用的测试开不了端口，`submit` 也连不上 Host。上面那个设置会放行这两件事。不加这个设置的话，Codex 请求运行命令时要批准，否则文件改了，却什么也没发布。
- **Claude Code** 运行 `npm` 和 `node` 之前会先问你，两个都允许即可。

历史会记下是哪个 agent 提交的，依据是 Claude Code 和 Codex 在各自 shell 里设置的环境变量；分辨不出来就记为 `unknown`。想自己指定，设置 `PNEUMA_AGENT`。你随时可以换 agent：下一个 agent 需要的东西都在目录里。

## submit 会怎么回答

Host 以三种模式之一运行。在 `local/.env` 里用 `PNEUMA_GOVERNANCE` 设置（可以从 `.env.example` 复制），然后再运行一次 `docker compose up -d`。`status` 会显示当前模式。

| 模式 | 改动会经历什么 |
| --- | --- |
| `record` | 记录下来并发布，没有任何检查或批准。 |
| `personal`（默认） | 应用的测试必须通过；除非关掉了预览，应用还得在预览里启动成功。常规改动由常设规则放行；规则认为有风险的改动等你决定。按默认规则，有风险指的是访客不用再登录，或者新加的 SQL 会删除或改写已存的数据。 |
| `review-all` | 同样的检查，每次改动都等你决定。 |

`submit` 会给出四种回答之一：

| 回答 | 意思 | 接下来做什么 |
| --- | --- | --- |
| `published vN at <address>` | 改动已经作为第 N 版上线。 | 打开应用看看。 |
| `rejected (<reason>)` | 什么都没上线。常见原因：测试没过，改了受保护的文件或应用代码以外的文件，预览没启动起来，没有任何改动。 | 让 agent 修好再提交，或者用 `node .pneuma/pneuma.mjs discard` 丢掉这些编辑。 |
| `needs_approval <id>` | 改动在等你决定。agent 应该停下，把它打印的内容拿给你看。 | 在从主人链接打开的应用页面上决定；或者在你自己的终端里、在应用目录下运行 `node .pneuma/pneuma.mjs approve <id>` 或 `node .pneuma/pneuma.mjs deny <id> "原因"`。两条命令都会要你输入那个词来确认。 |
| `recorded vN, but it did not go live` | 只在 `record` 模式出现。这个版本已经进了历史，但没能启动，Host 试着把地址放回上一个版本，后面几行会说明放回去没有。 | 修好原因再提交；如果没有新的编辑，同一个版本会原样再发布一次。也可以回退。 |

## 查看历史和回退

在应用目录里：

```sh
node .pneuma/pneuma.mjs status              # 版本、地址、模式、还没提交的文件、等你决定的事
node .pneuma/pneuma.mjs history             # 每一次尝试：要求是什么、哪个 agent、检查、批准、结果
node .pneuma/pneuma.mjs list                # 所有应用一览
node .pneuma/pneuma.mjs undo "原因"         # 退回一个版本；再运行一次就再往前退
node .pneuma/pneuma.mjs undo --to v2 "原因" # 直接退回到更早的某个版本
```

在 `apps/` 目录本身，`list`、`create <name>`、`status <name>` 和 `history <name>` 也能用。Host 在那里放了一份 `AGENTS.md` 和 CLI 的副本，所以在 `apps/` 里启动的 agent 能回答"我有哪些应用"。

`undo` 沿着当前版本所基于的那些版本往回退。它先发布旧版本的代码，确认应用有应答，然后才改动历史。目录里有从没提交过的编辑时，它会拒绝执行；先提交，或者用 `discard` 丢掉。在应用页面上，当前版本所基于的每个版本旁边都有"回到这个版本"按钮（页面按浏览器的语言显示中文或英文）。

**单向改动**是指放回旧代码也撤销不了的改动，比如删掉一列。在 `personal` 和 `review-all` 模式下由规则标出（默认是新加的、会删除或改写已存数据的 SQL）。在 `record` 模式下，只有 agent 提交时加了 `--one-way "<会丢失什么>"` 才会标出。不管哪种模式，越过单向改动往回退都会被拒绝，直到你确认：在你的终端里运行 `node .pneuma/pneuma.mjs undo --accept-one-way "原因"`（它会要你输入 `accept`），或者在应用页面上确认。除非 PostgreSQL 那项设置事先存了数据副本，否则回去的只有代码，旧版本可能读不了现在的数据。

## 看起来不对劲时

| 你看到的 | 意思 | 怎么办 |
| --- | --- | --- |
| agent 说改完了，线上却没变化，`status` 在 `uncommitted` 下面列出了文件 | agent 改了文件但没提交，或者它的沙箱拦住了 `submit`。 | 让它提交，或者用 `discard` 丢掉这些编辑。 |
| `preview: none standing`，或页面说预览没在运行，批准被拒绝 | 预览一小时后会自己结束（`PNEUMA_PREVIEW_TTL`），而 Host 不会让一个没人看过的改动上线。 | 运行 `node .pneuma/pneuma.mjs preview <id>`，或者点"再给我看一次"，看过之后再决定。 |
| `recorded vN, but it did not go live`，或 `status` 显示 `the address serves vM, not vN` | `record` 模式：第 N 版已经记录，地址上跑的仍是第 M 版。 | 修好原因再提交（没有新编辑时，第 N 版会原样发布），或者回退。 |
| `the Host cannot vouch for what the address serves` | Host 不知道地址上跑的是哪个版本：要么发布或回退失败后，没能把地址放回去；要么回退已经发出去，却没能记进历史。 | 照那一行说的做。第一种情况，下一次有应答的发布或回退就会把它理清。第二种情况，在你运行 `undo` 之前，提交和批准都会被拒绝。 |
| `undo` 拒绝执行，提示往回退会越过一个 "that putting files back cannot undo" 的改动 | 中间隔着一个单向改动。 | 由你决定：在终端里运行 `undo --accept-one-way "原因"`，或者在页面上回退。 |
| `cannot reach the Host at ...` | Host 没在运行，或者在另一个地址上。 | 在 `local/` 里运行 `docker compose ps`。如果在别的地址，加上 `--host <url>`。 |

## 东西存在哪里

| 什么 | 在哪里 |
| --- | --- |
| 源码、每一个版本、历史、等待中的改动 | 应用目录 `apps/<name>/`，大部分在 `.pneuma/` 下 |
| 主人链接的令牌、应用截图 | Docker 卷 `host-state` |
| 每个应用存储的数据（数据库、文件、键值数据、对象）及其已发布的版本 | PneumaSpace 的 Docker 卷：`gateway-data`、`runner-data`、`redis-data`、`rustfs-data`，开启 PostgreSQL 时还有 `postgres-data` |
| 数据快照（仅限 PostgreSQL 那项设置） | PostgreSQL 服务器上额外的数据库 |

Docker 会在每个卷名前面加上 compose 项目名，比如 `agent-app-governance_host-state`。`docker compose down` 会保留这些卷；`docker compose down -v` 会删掉它们，连同每个应用存储的数据和主人链接一起删掉，应用目录则不受影响。把应用目录拷到另一台电脑，拷过去的是源码和历史，不包括数据。

## 限度

- 一台信任的电脑，没有登录，见"开始之前"。
- 只管新应用。没有任何办法导入已有的应用或其数据。
- 回退恢复的是代码。存储的数据只有在开启 PostgreSQL 那项设置、数据库在 PostgreSQL 上、并且是越过单向改动往回退时才会回来。SQLite 数据库、文件、键值数据和对象从不放回。
- 默认规则靠文本匹配找出破坏性的 SQL：写在字符串里、根本不会执行的 `DROP` 会被标出来，用变量拼出来的删除却会漏掉。
- 预览启动时存储是空的。它能说明应用能启动、首页的应答不是服务器错误，说明不了应用在你的数据上、或者对已登录的访客是否正常。一个改动可能在应用自己的测试一个都没跑的情况下通过，这时 `submit` 和 `history` 会如实说明。
- `screenshot` 服务给应用拍截图时，应用的脚本（包括预览的脚本）仍然能向 compose 网络里的其他服务发请求。要关掉截图，在 `.env` 里写上 `PNEUMA_SCREENSHOT_CDP=`。
- 实际跑过的：搬进这个仓库之前，本地版在 macOS 上用 colima 和 Docker Desktop 都跑过，包括真实的 Claude Code 和 Codex 会话。搬进来以后，跑过它的测试，以及一次用脚本完成的创建、改动和回退。没跑过的：整台 Linux 机器、多用户、托管运行。

[docs/reference.zh-CN.md](./docs/reference.zh-CN.md) 里有 CLI、各模式和每项记录下来的保证是什么意思、风险规则、单向改动与回退、PostgreSQL 那项设置、由 Host 启动 Claude Code 或 Codex（`bun run drive`）、和其他服务并排运行，以及测试。
