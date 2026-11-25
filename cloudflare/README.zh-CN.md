# agent-app-governance：Cloudflare 版

[English](./README.md) · [回到仓库总览](../README.zh-CN.md)

这个版本把 Host 跑在 Cloudflare 上，把应用发布到部署在 Cloudflare 上的 PneumaSpace。你的 coding agent 在任意一台机器上的工作副本里改应用并提交，Host 负责检查改动，交给规则或你来批准，再发布出去，并写进应用的历史。Host 和本地版是同一份代码，跑在一个 Worker 后面的 Cloudflare Container 里。

## 和本地版的不同

- **记录在中心。** 每个应用的目录（源码、`.pneuma-framework/` 里的每个版本和历史、`.appgov/` 里 Host 的状态）是 R2 存储桶里的一个对象。每次操作先把它读出来，执行，再写回去，而且只有在这期间没人改过它时才写。容器的磁盘只是缓存：两次操作之间它可能消失，不会丢任何东西。agent 编辑的是一份工作副本；CLI 在 `submit` 时把它发过去，并在每次改动应用的操作之后让它和中心保持一致。
- **主人要登录。** 安装程序会生成一把主人密钥，只写一次，写进你机器上的一个文件。用它登录得到一个会话。你为自己的 agent 创建 agent 令牌。agent 令牌可以创建应用、提交、查看状态和历史、取回工作副本、撤销和丢弃改动。它不能批准或拒绝改动，不能确认退过单向改动，也不能创建令牌。这些拒绝发生在 Worker 里，不在 CLI 里。
- **没有主人页面。** 没有应用页面，没有截图，也没有数据快照。你在终端里做决定。

## 开始之前

- **一个开通了 Workers Paid 的 Cloudflare 账户**，可以使用 Containers，并且 Wrangler 已经登录（在 `cloudflare/` 里运行 `npx wrangler login`）。账户要有一个 workers.dev 子域名；Host 就在那里提供服务，不用自定义域名。
- **一个部署在 Cloudflare 上的 PneumaSpace**（PneumaSpace 的 `cf/` 版本），它的地址，以及它的主人凭据文件。安装程序会以这个主人的身份登录一次，为 Host 创建一个令牌。它不会改动那个部署的 Worker、数据库结构、密钥或配额。
- **Docker** 要在运行，用来构建 linux/amd64 的 Host 镜像。在 arm64 的 Mac 上构建是在模拟下进行的；镜像只在 Cloudflare 上启动。
- **Node.js 20 或更新版本**，用来跑安装程序和 CLI。单跑 CLI 用 Node 18 就够。
- **需要联网。** 镜像会从 GitHub 按 `local/compose.yaml` 里固定的提交取 pneuma-framework，从 npm 取 Bun。

## 安装

在这个仓库的克隆里：

```sh
node cloudflare/scripts/install.mjs https://space.example.com \
  --space-owner ~/.pneuma-space/hosts/space.example.com/owner.json \
  --prefix appgov-host
```

它在改动任何东西之前，先检查 Node、Docker、Wrangler 的登录和 PneumaSpace 的登录。然后它创建 R2 存储桶 `<prefix>-folders`（位置提示 `wnam`），创建一个只带 `read`、`publish`、`invoke`、`manage` 和 `remove` 权限的 PneumaSpace 令牌，生成主人密钥，并部署名为 `<prefix>` 的 Worker 及其容器。最后它打印 Host 的地址和主人凭据文件的位置。仓库有改动之后，或者某一步失败之后，再跑一次即可：它会沿用之前建好的存储桶、令牌、主人密钥和容器密钥。

如果你的 Docker 跑在别的 context 下，先设好 `DOCKER_CONTEXT`（colima 的话：`DOCKER_CONTEXT=colima`）。

重跑部署了新构建之后，Durable Object 还在活动的应用会继续用之前的构建，直到它空闲下来；想让它马上换上新构建，以主人身份运行 `node cloudflare/bin/appgov.mjs container <app> stop`：它停掉这个应用的容器并重启它的 Durable Object，下一条命令就会用新构建启动 Host（`container <app>` 会显示正在用的镜像和 Worker 版本）。还在 2026-11-25 之前构建上的应用没有这个重启，只能等它空闲几分钟之后才换上。

## 登录，并给 agent 一个令牌

```sh
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev login
node cloudflare/bin/appgov.mjs --host https://appgov-host.<subdomain>.workers.dev token create --label laptop --write ~/apps
```

`login` 读取主人凭据文件，把会话（12 小时）存在它旁边。`token create --write ~/apps` 把中心的地址和一个新的 agent 令牌写进 `~/apps/.appgov/centre.json`（权限 0600），不会把令牌打印出来。它还在旁边写下这个中心部署时带的 CLI（`~/apps/.appgov/appgov.mjs`），以及一个 `AGENTS.md`（Claude Code 通过 `CLAUDE.md` 读到它），告诉在 `~/apps` 里启动的 agent：这个目录是什么，怎样列出、创建和取回应用，以及 `centre.json` 是凭据，不能打印、复制或提交。你在这个 `AGENTS.md` 里、它写的那一段之外留下的文字会保留。你的 agent 在 `~/apps` 里工作。`token list` 和 `token revoke <id>` 用来管理令牌。

CLI 和中心会核对彼此说的 API 级别。级别不同的 CLI 会停下并说明；`node .appgov/appgov.mjs update` 会把它换成中心自己的 CLI。

## 创建应用

在 `~/apps` 里：

```sh
node .appgov/appgov.mjs create todo
```

Host 会复制这个版本自己的应用模板（PneumaSpace 的 Cloudflare 起步应用，契约 `pneuma-space.cf/1`，声明了 `identity.required`），加上写给 agent 的说明，跑一遍应用的测试，把它作为预览启动一次，然后发布为 `v1`，成为 PneumaSpace 上由 `appgov` 管理的应用。工作副本放在 `~/apps/todo/`，里面有一份 CLI（`.appgov/appgov.mjs`），中心地址和令牌在 `.appgov/centre.json`。登录了那个 PneumaSpace 的人可以在 `https://<PneumaSpace 地址>/apps/todo/` 打开这个应用。

## 把应用交给 agent

用 Claude Code、Codex 或别的 agent 打开 `~/apps/todo/`，让它改。应用的 `AGENTS.md`（Claude Code 通过 `CLAUDE.md` 读到它）开头就是规则：先看 `status` 和 `history`，改文件，在 `tests/` 下加测试，跑 `npm test`，然后用 `node .appgov/appgov.mjs submit "<你要的改动>"` 提交。

要在另一台机器上继续，在那里取回一份工作副本：

```sh
APPGOV_HOST=https://appgov-host.<subdomain>.workers.dev APPGOV_TOKEN=<一个 agent 令牌> \
  node appgov.mjs fetch todo
```

落后于中心的工作副本（之后有人发布了新版本）在 `submit` 时会被拒绝；`fetch` 会把它更新到最新，但如果有会被覆盖的编辑，`fetch` 也会拒绝。

`.appgov/centre.json` 里有 agent 令牌。它永远不属于任何版本，也不会随文件发出去；模板的 `.gitignore` 把它排除在 git 之外。不要把它放进任何你要分享的东西里。

## 做决定

Host 以 `personal` 模式运行。改动必须通过应用的测试（在 Host 的容器里跑；`submit` 和 `history` 会说其中有多少是应用自己的测试，改了 `app/` 却一个都没跑时会提醒），并且能在预览里启动；预览是 PneumaSpace 上的一个临时应用，用完就丢弃。常设规则放行常规改动。按这个版本的预设（`policy/personal.json`），以下改动要等你决定：应用不再声明 `identity.required`；或者新的 SQL 删除或重命名表或列、删除索引、清空表、删除所有行。

`submit` 回答 `needs_approval <id>` 时，agent 会停下来，把它打印的内容给你看，其中有预览的地址。以主人身份登录后，在应用的工作副本里：

```sh
node .appgov/appgov.mjs approve <id>
node .appgov/appgov.mjs deny <id> "原因"
```

agent 令牌这样做会被 Worker 拒绝。

## 退回

```sh
node .appgov/appgov.mjs undo "原因"          # 退回一个版本
node .appgov/appgov.mjs undo --to v2 "原因"  # 直接退回到更早的某个版本
```

撤销把早先版本的代码放回去。如果 PneumaSpace 上还有一个文件完全相同的发布，Host 用它的类型化操作 `rollback`；否则重新上传那些文件。存储的数据保持原样。退过单向改动需要主人：登录后运行 `undo --accept-one-way "原因"`。

## 东西放在哪里

| 什么 | 在哪里 |
| --- | --- |
| 每个应用的源码、每个版本、历史、等待中的改动 | R2 存储桶 `<prefix>-folders` 里每个应用一个 tar 对象（`folders/<app>.tar`），外加一份给 `list` 用的简短摘要（`summaries/<app>.json`） |
| 工作副本 | 你创建或取回它的地方；CLI 会把中心的 `.pneuma-framework/` 同步进来 |
| 主人的会话和 agent 令牌（哈希后） | Worker 的一个 Durable Object |
| 主人密钥、Worker 的密钥、生成的 Wrangler 配置 | 运行安装程序的那台机器上的 `~/.appgov/hosts/<prefix>/`（权限 0700） |
| CLI 用的主人会话 | `~/.appgov/hosts/<prefix>/session.json` |
| 每个应用存储的数据和它的发布 | PneumaSpace |

## 限度

- **防范的是会犯错的 agent，不是会攻击的 agent。** 应用的测试在 Host 的容器里以第二个 unix 用户运行，这个用户读不到 Host 的文件和环境变量（PneumaSpace 令牌和 Worker 发来的密钥）。它们共享内核、网络（可以上互联网）和磁盘。没有第二层沙箱。
- 没有做的：主人页面、截图、数据快照、由 Host 启动 Claude Code 或 Codex（`drive` 那条路），以及 `record` 和 `review-all` 模式。只跑过 `personal` 模式。
- 只管新应用。没有办法导入已有的应用或它的数据。
- 撤销只恢复代码；存储的数据从不放回。
- PneumaSpace 的令牌不能彻底清除（purge）应用。Host 撤下一个应用的地址时，应用被移除，名字会一直被占用，直到 PneumaSpace 的主人在控制台里把它清除。
- 每个应用一个容器，按需启动。一次提交在整个检查期间都占着连接，在下面的运行里约 30 秒，其中约三分之二是 PneumaSpace 先发布预览、再发布正式版本（见下面的表）。
- 默认规则靠匹配文本找破坏性 SQL，和本地版一样。

## 跑过什么

2026-11-25，在 macOS 上用 colima，针对一个默认配额的、部署在 Cloudflare 上的 PneumaSpace：安装（以及两次重跑）、主人登录、一个 agent 令牌、`create`、一个由常设规则放行的常规改动、一个去掉 `identity.required` 并等待主人决定的改动（agent 令牌的批准被拒绝，返回 403；主人批准后上线）、`undo`、用令牌在一个空目录里 `fetch` 并从那里提交、从过期的工作副本提交被拒绝、在容器被停掉之后的提交，以及一个故意失败的测试，用来显示测试用户能读到什么（它读不到 `/data`、Host 的主目录和 Host 的环境变量，环境里也没有 `APPGOV_` 开头的变量）。离线测试（在 `cloudflare/` 里运行 `npm run setup`、`npm run typecheck`、`bun test`）覆盖了对着假平台 API 的运行时适配器、带冲突写入的记录往返、Worker 对主人和 agent 令牌的规则，以及在一台机器上用 CLI 走完整个流程。

一次提交的时间花在哪里：用 `--timing`（它打印每个回答在 `timing` 里带的各个步骤）对一个常规改动（`app/public/index.html` 里的页面标题）测量，节省前后各一次冷提交、两次热提交。单位是秒；冷提交包括启动容器和读入记录。

| 步骤 | 之前：冷、热、热 | 之后：冷、热、热 |
| --- | --- | --- |
| 整次提交，在 CLI 这边看 | 41.5、42.8、40.5 | 31.9、30.0、30.3 |
| 启动容器，从 R2 读入记录 | 1.8、0、0 | 1.2、0、0 |
| 在 PneumaSpace 上查这个应用 | 1.3、0.9、0.9 | 1.0、0.5、0.5 |
| 测试：`npm ci --ignore-scripts` | 1.2、1.6、1.5 | 1.2、0.0、0.0 |
| 测试：`npm test` | 0.8、1.5、1.5 | 0.8、1.6、1.6 |
| 预览：查询、创建、申请上传、上传 | 4.3、3.6、3.5 | 2.6、2.7、2.7 |
| 预览：PneumaSpace 发布它 | 9.5、12.3、9.2 | 8.9、8.3、9.2 |
| 等预览回应（并让它休眠） | 3.9、4.1、4.3 | 0.6、0.7、0.7 |
| 读预览的状态 | 0.9、0.9、0.9 | 0.6、0.5、0.5 |
| 正式发布：查询、申请上传、上传 | 2.3、2.3、2.7 | 1.8、1.8、1.7 |
| 正式发布：PneumaSpace 发布它 | 10.2、10.3、10.1 | 10.9、11.4、10.9 |
| 等正式发布回应 | 1.5、1.5、1.4 | 0.6、0.6、0.7 |
| 丢弃预览 | 2.2、2.1、2.1 | 3.7、3.6、3.5，和正式发布同时进行 |
| 把记录写回 R2 | 0.5、0.5、0.5 | 0.3、0.3、0.3 |
| 网络、Worker 和 Durable Object | 0.9、0.9、1.5 | 1.2、1.4、1.3 |

做了的节省不改变任何检查：两个探测请求同时发出，而不是一个接一个；探测之后让预览休眠这一步不再等它做完；预览在正式发布进行的同时丢弃（在这个平台上正式发布从不用预览的上传，而且提交仍然要等丢弃做完才回答）；知道应用的 id 之后，查询只读这个应用的详情，创建之后也不再马上读回一次；`npm ci --ignore-scripts` 沿用同一个容器里先前一次用同样的 `package.json`、lockfile 和 `.npmrc` 装出来的依赖，那份依赖是在任何测试跑之前留下的，测试用户碰不到。没做的：任何跳过或缩短检查的做法（测试、两个探测中的任何一个、预览）；在预览回应之前或与预览同时正式发布；测试和预览同时进行（那样没通过测试的改动也会作为预览到达 PneumaSpace）；在决定发布之前就上传正式发布的包（发出去的必须是刚好在记录之前、对照封存的草稿检查过的那份副本）。两次 PneumaSpace 发布占了 30 秒里的约 20 秒，那是平台自己的工作，这个版本不改它。之后那组测量先前还跑过一次，得到 30.5、28.1 和 29.3 秒。`create` 之前 44 秒，之后 32 到 38 秒；`undo` 9 秒；`fetch` 1 秒。

没跑过：真实的 coding agent 会话对这个版本操作、多人使用、在 Linux 机器上运行安装程序、等一个预览超过一小时自行结束，以及超出 PneumaSpace 默认配额（5 个应用、3 个临时应用、2 个同时唤醒）的情况。
