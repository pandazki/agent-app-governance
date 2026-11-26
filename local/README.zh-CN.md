# agent-app-governance：本地版

[English](./README.md) · [回到仓库总览](../README.zh-CN.md)

本地版在你自己的电脑上用 Docker 运行。它启动两样东西：PneumaSpace，一个运行网页应用、保存应用数据的小平台；以及 Host，一个站在你的 coding agent 和 PneumaSpace 之间的服务。agent 在应用目录里改好应用并提交，Host 负责检查改动，交给规则或你来批准，再发布出去，并写进应用的历史。以后你能查到改了什么，也能退回去。

## 它管什么

- **在这里创建的应用。** `create` 用 PneumaSpace 的应用模板新建一个应用：一个用 TypeScript 写的小型网页应用，可以申请数据库、文件存储、键值存储和对象存储。你已经有的应用及其数据，没有办法接进来。
- **经过 Host 的改动。** 只有 agent 提交的改动才会被记录。用别的方式改动应用，比如在 PneumaSpace 控制台里操作，应用就和它的历史对不上了。
- **代码，而不是数据。** 回退是把早先版本的代码放回应用的地址上，应用存储的数据保持原样。这不是数据备份。有一项针对 PostgreSQL 数据库的可选设置，会在规则标为破坏数据的改动之前存一份数据库副本（见[参考文档](./docs/reference.zh-CN.md#postgresql-数据快照)）。

## 开始之前

- **一台电脑、一个人，而且你信任这台电脑。** Host 没有登录。能访问它端口的人，都能看到你的应用页面和它的 API。防止 agent 自己批准自己改动的那些措施（`approve` 必须在终端里运行，页面上做决定需要一个私有链接），挡不住同一台电脑上的其他程序。
- **Docker** 要在运行，Compose 的版本要支持构建时的 `additional_contexts`，Host 的镜像用到了它。在 Linux 上，装 Docker Engine 加 Compose 和 buildx 插件就够了。
- **仓库要克隆在 Docker 共享给容器的文件夹里。** colima 默认只共享你的主目录。放在别处时，Host 看到的是一个空文件夹，而不是 `local/apps`：它会说明这一点，并拒绝创建会丢失的应用。
- **`gateway` 容器会挂载 Docker socket**（`/var/run/docker.sock`），也就是说它能控制这台电脑上的 Docker。
- **127.0.0.1 上要有四个空闲端口：** 8080（应用本身，在 `/apps/<name>/` 下）、8081（PneumaSpace 控制台）、9000（对象存储）和 8090（应用页面，也就是 Host）。其他地址上什么都不监听。要换端口，见[和其他服务并排运行](./docs/reference.zh-CN.md#和其他服务并排运行)。
- **Node.js 24 或更新版本。** 单跑 CLI 用 Node 18 就够，但 agent 会在你的电脑上跑每个应用的测试，而应用模板要求 Node 24。
- **第一次构建需要联网。** 镜像会从 GitHub 按 `compose.yaml` 里固定的提交构建 PneumaSpace 和 pneuma-framework，还会从 Docker Hub 拉基础镜像。

## 启动

在这个仓库的克隆里：

```sh
cd local
docker compose up -d --build
```

第一次构建要下载基础镜像，还要从源码构建 PneumaSpace 和 Host，所以比以后每次启动都慢。完成后有六个容器在运行：`gateway`、`runner`、`rustfs` 和 `redis` 属于 PneumaSpace，`screenshot` 给应用页面拍截图，`host` 就是 Host。请在 `local/` 里运行它，这样页面才知道应用文件夹在你电脑上的位置。应用存储的数据放在这些容器的 Docker 命名卷里，不在这个文件夹里，所以拷贝或备份这个文件夹并不会带上数据（见[东西存在哪里](#东西存在哪里)）。

## 打开你的应用页面

打开 http://127.0.0.1:8090/ 。它列出你的应用、每个应用的历史，以及等你决定的改动。还没有应用的时候，它会改为显示做出第一个应用的两步：在这台电脑上的哪个应用文件夹里打开你的 agent，以及对它说的一句话。

这个版本没有什么需要“连接”的。它没有账号，也没有令牌：在应用文件夹里启动的 agent 能在那里找到它需要的东西，也就是 Host 放在 `apps/` 里的 `AGENTS.md` 和 CLI；而 Host 对这台电脑上的任何人都有应答（见“开始之前”）。

谁都能查看应用页面。要在页面上做决定（让改动上线、拒绝改动、退回某个版本），需要从你的主人链接打开它。Host 会把这个链接打印在日志里：

```sh
docker compose logs host | grep "owner link"
```

那一行以 `http://127.0.0.1:8090/#owner=` 加一串令牌结尾。请你自己在浏览器里打开这个链接，不要交给 agent。Host 重启后链接不变；要换一个新链接，见[更换主人链接](./docs/reference.zh-CN.md#更换主人链接)。

## 让 agent 做一个应用

在应用文件夹 `local/apps/` 里打开 Claude Code 或 Codex：

```sh
cd apps
claude
```

或者

```sh
cd apps
codex -c sandbox_workspace_write.network_access=true
```

然后说出你想要的，比如：“帮我做一个叫 reading-list 的新应用：记下我想读的书，可以添加书，读完了可以打勾。”agent 会用 `node .appgov/appgov.mjs create reading-list` 创建应用，把起步应用发布为 `apps/reading-list/` 里的 `v1`，再在那里把你要的应用作为一次改动做出来并提交。两者都会出现在页面上。

- **Codex：** 它默认的沙箱会拦住到 127.0.0.1 的连接，于是应用的测试开不了端口，`submit` 也连不上 Host。上面那个设置会放行这两件事。不加这个设置的话，Codex 请求运行命令时要批准，否则文件改了，却什么也没发布。
- **Claude Code** 运行 `npm` 和 `node` 之前会先问你，两个都允许即可。

## 或者在终端里创建应用

```sh
node bin/appgov.mjs create todo
```

应用名以小写字母开头，最多 30 个字符，只能用小写字母、数字和连字符。Host 会把模板拷到 `apps/todo/`，加上写给 agent 的说明和两个隐藏目录 `.pneuma-framework/` 与 `.appgov/`，跑一遍应用的测试，用一个临时名字把应用启动一次、确认它有应答（这叫预览），然后发布为版本 `v1`。它会打印应用地址、这次发布是怎么批准的，以及该用 agent 打开的目录：

```
published v1 at http://127.0.0.1:8080/apps/todo/
risks: release_change; approved by: policy:auto
The app directory is /path/to/agent-app-governance/local/apps/todo. Open it with your coding agent.
```

`release_change` 是 Host 给应用第一次发布记的风险名，`policy:auto` 是放行常规改动的常设规则。不管哪种模式，创建应用都不用等你批准。

`create todo` 得到的是模板自带的起步应用，名字叫 `todo`：只有一个页面，写着 "Hello, guest"（中文浏览器下是"你好，访客"），带一个登录按钮。它还不是待办清单，要让 agent 去做。

应用本身的地址是 http://127.0.0.1:8080/apps/todo/ ，应用页面上也会列出它。

PneumaSpace 控制台在 http://127.0.0.1:8081/ ，是平台自己的管理页面，没有登录。在那里改动应用会绕过 Host，应用的历史就和线上跑的东西对不上了。

## 把应用交给 agent

要改一个应用，用你平常用的 agent 打开它的目录（或者留在 `apps/` 里、说出应用名），用自己的话提出改动：

```sh
cd apps/todo
claude
```

或者

```sh
cd apps/todo
codex -c sandbox_workspace_write.network_access=true
```

应用里的 `AGENTS.md`（Claude Code 通过 `CLAUDE.md` 读到它）开头就是给 agent 的规则：先看 `status` 和 `history`，再改文件、加测试、跑 `npm test`，最后用 `node .appgov/appgov.mjs submit "<你提出的要求>"` 提交。这些都不用你去交代。

Codex 的沙箱和 Claude Code 的询问，同[上面](#让-agent-做一个应用)说的一样。

历史会记下是哪个 agent 提交的，依据是 Claude Code 和 Codex 在各自 shell 里设置的环境变量；分辨不出来就记为 `unknown`。想自己指定，设置 `APPGOV_AGENT`。你随时可以换 agent：下一个 agent 需要的东西都在目录里。

## submit 会怎么回答

Host 以三种模式之一运行。在 `local/.env` 里用 `APPGOV_GOVERNANCE` 设置（可以从 `.env.example` 复制），然后再运行一次 `docker compose up -d`。`status` 会显示当前模式。

| 模式 | 改动会经历什么 |
| --- | --- |
| `record` | 记录下来并发布，没有任何检查或批准。 |
| `personal`（默认） | 应用的测试必须通过；除非关掉了预览，应用还得在预览里启动成功。常规改动由常设规则放行；规则认为有风险的改动等你决定。按默认规则，有风险指的是访客不用再登录，`pneuma-space.json` 不再声明一项存放数据的能力（`db`、`kv`、`files` 或 `object`），或者代码或 `.sql` 文件里新加的 SQL 删除表、列或索引，用 `ALTER TABLE` 删除或重命名列或表，用 `TRUNCATE` 清空一张表，或者执行不带 `WHERE` 的 `DELETE`。改写已存数据行的 `UPDATE` 不会被拦下。 |
| `review-all` | 同样的检查，`create` 之后的每次改动都等你决定。 |

`submit` 会给出四种回答之一：

| 回答 | 意思 | 接下来做什么 |
| --- | --- | --- |
| `published vN at <address>` | 改动已经作为第 N 版上线。 | 打开应用看看。 |
| `rejected (<reason>)` | 什么都没上线。常见原因：测试没过，改了受保护的文件或应用代码以外的文件，预览没启动起来，没有任何改动。 | 让 agent 修好再提交，或者用 `node .appgov/appgov.mjs discard` 丢掉这些编辑。 |
| `needs_approval <id>` | 改动在等你决定。agent 应该停下，把它打印的内容拿给你看。 | 在从主人链接打开的应用页面上决定；或者在你自己的终端里、在应用目录下运行 `node .appgov/appgov.mjs approve <id>` 或 `node .appgov/appgov.mjs deny <id> "原因"`。两条命令都会要你输入那个词来确认。 |
| `recorded vN, but it did not go live` | 只在 `record` 模式出现。这个版本已经进了历史，但没能启动，Host 试着把地址放回上一个版本，后面几行会说明放回去没有。 | 修好原因再提交；如果没有新的编辑，同一个版本会原样再发布一次。也可以回退。 |

## 查看历史和回退

在应用目录里：

```sh
node .appgov/appgov.mjs status              # 版本、地址、模式、还没提交的文件、等你决定的事
node .appgov/appgov.mjs history             # 每一次尝试：要求是什么、哪个 agent、检查、批准、结果
node .appgov/appgov.mjs list                # 所有应用一览
node .appgov/appgov.mjs undo "原因"         # 退回一个版本；再运行一次就再往前退
node .appgov/appgov.mjs undo --to v2 "原因" # 直接退回到更早的某个版本
```

在 `apps/` 目录本身，`list`、`create <name>`、`status <name>` 和 `history <name>` 也能用。

`undo` 沿着当前版本所基于的那些版本往回退。它先发布旧版本的代码，确认应用有应答，然后才改动历史。目录里有从没提交过的编辑时，它会拒绝执行；先提交，或者用 `discard` 丢掉。在应用页面上，当前版本所基于的每个版本旁边都有"回到这个版本"按钮（页面按浏览器的语言显示中文或英文）。

**单向改动**是指放回旧代码也撤销不了的改动，比如删掉一列。在 `personal` 和 `review-all` 模式下由规则标出（默认就是上面 `personal` 一行列出的那些 SQL，以及去掉一项存放数据的能力）。不管哪种模式，agent 也可以自己标出：提交时加 `--one-way "<会丢失什么>"`。应用的 `AGENTS.md` 要求它，只要改动会删除或改写应用已经存下的数据（不论存在哪种存储里），就这样做。规则定下一个改动至少要过哪一关，agent 只能往上加，不能往下减：在 `personal` 和 `review-all` 模式下，agent 标出的改动即使规则什么也没发现也会等你决定，它的原话会作为 agent 自己的声明给你看，和规则发现的东西分开。不管哪种模式，越过单向改动往回退都会被拒绝，直到你确认：在你的终端里运行 `node .appgov/appgov.mjs undo --accept-one-way "原因"`（它会要你输入 `accept`），或者在应用页面上确认。除非 PostgreSQL 那项设置事先存了数据副本，否则回去的只有代码，旧版本可能读不了现在的数据。

## 收起、恢复或清除应用

每次你运行 `status` 或 `list`、打开应用页面，或者有改动被提交、批准或回退时，Host 都会问 PneumaSpace 这个应用还在不在。不在的时候，`status`、`list` 和页面会先说明这一点：是你收起了它，是它在 PneumaSpace 上被收起了（比如在控制台里），是 PneumaSpace 上已经没有它了，还是 PneumaSpace 没有回应。应用被收起或不见了的时候，提交、批准等待中的改动和回退都会被拒绝，也不会有任何东西自动把它重新建出来。

这些事由你来做，在你自己的终端里。每条命令都会先说明要做什么，再要你输入命令名（`clear` 要输入应用名）；应用名后面的话是你的理由，历史会记下来。

```sh
node bin/appgov.mjs take-down todo "原因"   # 收起：停止服务；这里的历史和 PneumaSpace 上存储的数据都保留
node bin/appgov.mjs bring-back todo         # 恢复：重新提供服务，带着 PneumaSpace 保留的数据
node bin/appgov.mjs publish-again todo      # 重新发布：只在 PneumaSpace 上已经没有它时可用，重新创建，没有存储的数据
node bin/appgov.mjs clear todo              # 清除：忘掉它；只在它不提供服务时可用
```

应用被收起期间，agent 的 `submit` 会被拒绝，并用一句话说明是你收起了它。`clear` 只对不提供服务的应用有效，所以正在服务的应用要先收起。它会删掉应用目录 `apps/<name>/`（源码、每一个版本、历史和等待中的改动）；在这个版本上，它还会在 PneumaSpace 上彻底删除（purge）这个应用和它存储的全部数据。这无法撤销。用 PostgreSQL 那项设置时，这个应用的数据快照和回退时被换下来的数据库会先被删掉，彻底删除才能完成；确认时会列出快照的名字。

如果一个应用在 Host 不知情的情况下在 PneumaSpace 上被移除并彻底删除，`status` 和页面会说它不在 PneumaSpace 上，它存储的数据已经不在了。由你选择：重新发布（没有任何存储的数据），或者清除。

在从主人链接打开的应用页面上，同样的操作在应用页面底部、和应用详情放在一起的"收起或清除"里；应用不在的时候，这一栏默认展开。你收起的应用单独放在应用列表下方一个折叠起来的区域里。路由和拒绝原因见[参考文档](./docs/reference.zh-CN.md#收起和清除应用)。

## 看起来不对劲时

| 你看到的 | 意思 | 怎么办 |
| --- | --- | --- |
| agent 说改完了，线上却没变化，`status` 在 `uncommitted` 下面列出了文件 | agent 改了文件但没提交，或者它的沙箱拦住了 `submit`。 | 让它提交，或者用 `discard` 丢掉这些编辑。 |
| `preview: none standing`，或页面说预览没在运行，批准被拒绝 | 预览一小时后会自己结束（`APPGOV_PREVIEW_TTL`），而批准时这个改动的预览必须还在运行。Host 检查的是预览还在运行，不是有没有人打开看过。 | 运行 `node .appgov/appgov.mjs preview <id>`，或者点"再给我看一次"，看过之后再决定。 |
| `recorded vN, but it did not go live`，或 `status` 显示 `the address serves vM, not vN` | `record` 模式：第 N 版已经记录，地址上跑的仍是第 M 版。 | 修好原因再提交（没有新编辑时，第 N 版会原样发布），或者回退。 |
| `the Host cannot vouch for what the address serves` | Host 不知道地址上跑的是哪个版本：要么发布或回退失败后，没能把地址放回去；要么回退已经发出去，却没能记进历史。 | 照那一行说的做。第一种情况，下一次有应答的发布或回退就会把它理清。第二种情况，在你运行 `undo` 之前，提交和批准都会被拒绝。 |
| `undo` 拒绝执行，提示往回退会越过一个 "that putting files back cannot undo" 的改动 | 中间隔着一个单向改动。 | 由你决定：在终端里运行 `undo --accept-one-way "原因"`，或者在页面上回退。 |
| `submit`、`approve` 或 `undo` 被拒绝，原因是 `app_down`、`app_removed_elsewhere` 或 `app_vanished` | 应用被收起了（被你，或者在 PneumaSpace 上），或者 PneumaSpace 上已经没有它了。什么都没检查，也没发布。 | 恢复它；如果 PneumaSpace 上已经没有它，就重新发布或清除。见[收起、恢复或清除应用](#收起恢复或清除应用)。 |
| `cannot reach the Host at ...` | Host 没在运行，或者在另一个地址上。 | 在 `local/` 里运行 `docker compose ps`。要连的 Host 不是这个克隆启动的，就加上 `--host <url>`。 |

## 东西存在哪里

| 什么 | 在哪里 |
| --- | --- |
| 源码、每一个版本、历史、等待中的改动 | 应用目录 `apps/<name>/`：每个版本和历史在 `.pneuma-framework/` 里，等待中的改动在 `.appgov/` 里 |
| 主人链接的令牌、应用截图 | Docker 卷 `host-state` |
| 每个应用存储的数据（数据库、文件、键值数据、对象）及其已发布的版本 | PneumaSpace 的 Docker 卷：`gateway-data`、`runner-data`、`redis-data`、`rustfs-data`，开启 PostgreSQL 时还有 `postgres-data` |
| 数据快照（仅限 PostgreSQL 那项设置） | PostgreSQL 服务器上额外的数据库 |

应用目录里有两个隐藏目录。`.pneuma-framework/` 由 pneuma-framework 写入，存着每一个版本和历史。`.appgov/` 由 Host 写入，存着它的 CLI 和等待决定的改动。

Docker 会在每个卷名前面加上 compose 项目名，比如 `agent-app-governance_host-state`。`docker compose down` 会保留这些卷；`docker compose down -v` 会删掉它们，连同每个应用存储的数据和主人链接一起删掉，应用目录则不受影响。把应用目录拷到另一台电脑，拷过去的是源码和历史，不包括数据。

## 限度

- 一台信任的电脑，没有登录，见"开始之前"。
- 只管新应用。没有任何办法导入已有的应用或其数据。
- 回退恢复的是代码。存储的数据只有在开启 PostgreSQL 那项设置、数据库在 PostgreSQL 上、并且是越过单向改动往回退时才会回来。SQLite 数据库、文件、键值数据和对象从不放回。
- 默认规则靠文本匹配找出破坏性的 SQL：写在字符串里、根本不会执行的 `DROP` 会被标出来，用变量拼出来的删除却会漏掉。
- 规则只读 SQL 文本和 `pneuma-space.json`。一个删除或改写文件、键值数据或对象的改动，在规则看来就是普通的代码改动，在 `personal` 下常设规则会直接放行；对这些存储，Host 依靠 agent 用 `--one-way` 自己声明。
- 预览启动时存储是空的。它能说明应用能启动、首页的应答不是服务器错误，说明不了应用在你的数据上、或者对已登录的访客是否正常。一个改动可能在应用自己的测试一个都没跑的情况下通过，这时 `submit` 和 `history` 会如实说明。
- `screenshot` 服务给应用拍截图时，应用的脚本（包括预览的脚本）仍然能向 compose 网络里的其他服务发请求。要关掉截图，在 `.env` 里写上 `APPGOV_SCREENSHOT_CDP=`。
- 实际跑过的：在这份代码较早的一个版本上，在 macOS 上用 colima 和 Docker Desktop 跑过真实的 Claude Code 和 Codex 会话（改应用并提交）、等主人决定后被批准或拒绝的改动、越过单向改动的回退，以及 PostgreSQL 数据快照。在这份代码上：跑过离线测试，以及在 macOS 上用 colima 完成的一次创建、一次脚本化改动和一次回退。2026-11-26，一个 Codex 会话照仓库总览“从这里开始”里的那句话，在默认端口已被占用的机器上装好了这个版本（它换用了别的端口，没有碰任何别的东西），第二个会话照它的交接说明做出了一个能用的应用（reading-list）。同样在 2026-11-26，在 colima 上开着 PostgreSQL 那项设置：一个数据在 PostgreSQL 上的应用做了两次单向改动，每次都先批准、再经主人确认回退，然后收起并清除；这项实践先删掉了它的两份快照和两个被换下来的数据库，PneumaSpace 的彻底删除随之完成。一个数据在 SQLite 上的应用，在批准前看到的是数据回不来，批准后改动在没有快照的情况下上线。没跑过的：整台 Linux 机器、多用户、托管运行。

[docs/reference.zh-CN.md](./docs/reference.zh-CN.md) 里有 CLI、各模式和每项记录下来的保证是什么意思、风险规则、单向改动与回退、收起和清除应用、PostgreSQL 那项设置、由 Host 启动 Claude Code 或 Codex（`bun run drive`）、和其他服务并排运行，以及测试。
