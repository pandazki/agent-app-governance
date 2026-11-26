# agent-app-governance

[English](./README.md)

## 从这里开始

你会得到一个页面：上面是你的 coding agent（Claude Code 或 Codex）为你做的小应用，每次改动都有记录，有风险的改动由你说了算，也随时能回到早先的版本。它管的是在这里创建的应用：你已有的应用接不进来，它也不是这些应用数据的备份。

先选一个版本：

- **本地版**：跑在你自己的电脑上，用 Docker。需要 Docker、Node.js 24 和 git。不用花钱。镜像已经构建好时，agent 的一次安装用了大约两分钟；第一次要先构建镜像，会更久。
- **Cloudflare 版**：跑在你自己的 Cloudflare 账号上，装好之后你的电脑上什么都不用跑。需要一个开通 Workers Paid 套餐的 Cloudflare 账号（每月收费），账号里要有一个域名（域名每年收费）；安装时还需要 Docker、Node.js 24 和 Bun。它会顺带在那里装好 PneumaSpace，中间有几步只有你能在 Cloudflare 上做，到时会问你。

最省事的开始方式：在想放它的文件夹里打开 Claude Code 或 Codex，粘贴一句话。

- 本地版：`Install the local edition of https://github.com/pandazki/agent-app-governance on this computer, following AGENTS.md in that repository.`
- Cloudflare 版：`Install the Cloudflare edition of https://github.com/pandazki/agent-app-governance on my Cloudflare account, following AGENTS.md in that repository.`

你的 agent 会先检查需要的东西，遇到只有你能做的事会停下来问你。想自己动手，就看[本地版指南](./local/README.zh-CN.md)或 [Cloudflare 版指南](./cloudflare/README.zh-CN.md)。

装好之后，你会有一个在浏览器里打开的应用页面（本地版是 http://127.0.0.1:8090/ 或 agent 告诉你的地址，Cloudflare 版是你的 Host 自己的地址），页面会告诉你下一步做什么。然后直接告诉你的 agent 你想要什么，比如：“帮我做一个叫 reading-list 的新应用：记下我想读的书，可以添加书，读完了可以打勾。”

## 这是什么

Claude Code、Codex 这样的 coding agent，几分钟就能做出一个带存储数据的小应用。难的是之后怎么跟这个应用过日子：

- 没人记下改了什么、是谁要求的、上线前有没有检查过。
- 下一次改动可能把应用改坏，或者删掉它的数据，而 agent 不一定会停下来问你。
- 想回退只能靠猜。agent 的会话已经没了，存储的数据也不会跟着代码一起回去。

这个仓库给这类应用定下一条上线的路。应用在这里用模板创建；之后不管哪个 agent 来改，都把改动提交给一个叫 Host 的服务。Host 负责检查改动，交给规则或你来批准，再发布出去，并把经过记进应用自己的目录。

## 你得到什么

- **一个设置决定管得多严。** Host 以三种模式之一运行：
  - `record`：每次改动都记录下来，由 Host 发布，没有任何检查或批准。启动不起来的改动仍然记录在案，只是没有上线。
  - `personal`（默认）：改动要通过应用自己的测试；除非关掉了预览，还要在预览里启动成功，并按预期回答应用在 `preview.json` 里声明的请求。常规改动由常设规则放行；有风险的改动等你决定。按默认预设，有风险指的是访客不再需要登录，或者新加的 SQL 删除或重命名表或列、删除索引、清空一张表，或删除所有行。改写已存数据行的 `UPDATE` 不会被拦下。
  - `review-all`：同样的检查，应用创建之后的每次改动都由你决定。创建应用本身不用等你。

  什么改动算有风险，写在一个预设文件里，不写在代码里。
- **每次改动都有记录。** 每个版本都保存在应用目录里，带着当时的要求、是哪个 agent 改的、哪些保证成立：检查过、预览过、批准过、检查之后没再变过。只记录、没检查的版本也会如实写明。把目录拷到另一台机器，源码和历史跟着走，应用存储的数据不会跟着走。
- **撤销，并写明它的限度。** 撤销会放回早先版本的代码，存储的数据保持原样；只有为 PostgreSQL 上的应用开启可选的数据快照，数据才能一起回去。快照默认关闭，`status` 会如实显示。单向改动是指放回旧代码也撤销不了的改动，比如删掉一列。越过单向改动往回退，需要你确认。在 `personal` 和 `review-all` 模式下由预设标出这类改动；不管哪种模式，agent 都可以在提交时加 `--one-way "<会丢失什么>"` 自己标出。预设定下一个改动至少要过哪一关，agent 只能往上加，不能往下减：agent 自己标出的改动会等你决定，它的原话会作为它自己的声明给你看，即使规则什么也没发现。
- **任何 agent，或者自己启动 agent 的产品。** agent 在原地改应用，再用应用目录里的一个小 CLI 提交。也可以由程序让 Host 自己启动 Claude Code 或 Codex。两种方式写进同一份历史。一个页面列出你的应用和等你决定的事，你可以在上面做决定、往回退。

## 版本

| 版本 | 状态 | 应用跑在哪里 |
| --- | --- | --- |
| [本地版](./local/README.zh-CN.md) | 能跑 | 你的机器：一条 `docker compose up` 启动 PneumaSpace 和 Host，只监听回环端口 |
| [Cloudflare 版](./cloudflare/README.zh-CN.md) | 能跑，只有 `personal` 模式，应用页面要先登录 | Cloudflare：Host 跑在 Worker 后面的 Container 里，每个应用的记录在 R2，应用跑在部署于 Cloudflare 的 PneumaSpace 上。主人要登录；agent 用主人创建的令牌 |

本地版假定只用在一台你信任的机器上，127.0.0.1 上有四个空闲端口，装有 Docker（它的 gateway 容器会挂载 Docker socket）和 Node.js 24。开始前需要什么，见 [local/README.zh-CN.md](./local/README.zh-CN.md)。准备好以后：

```sh
cd local
docker compose up -d --build
```

然后打开应用页面 http://127.0.0.1:8090/ ，它会显示做出第一个应用的两步。后面的步骤见本地版指南：对改动做决定、往回退。

## 限度

- 它管的是在这里用 PneumaSpace 模板新建的应用，没有导入已有应用或其数据的办法。
- 本地版：一台信任的机器，一个人用。主人没有经过认证：批准需要一个终端，或者 Host 打印在日志里的一个链接。这能挡住诚实的 agent 批准自己的改动，挡不住同一台机器上的其他程序。
- 撤销恢复的是代码。存储的数据只有通过可选的快照做法才能回来，而且只适用于数据库在 PostgreSQL 上的应用。SQLite 上的应用，以及文件、键值数据和对象，都不在范围内。
- 预设里针对 SQL 的规则是文本匹配：写在字符串里、根本不会执行的 `DROP` 也会被拦下，用变量拼出来的删除却拦不住。
- 规则只读 SQL 文本和应用的清单。一个删除或改写文件、键值数据或对象的改动，在规则看来就是普通的代码改动；这种情况下 Host 依靠 agent 用 `--one-way` 自己声明。每个应用里给 agent 的说明都要求它这样做。
- Host 是这个仓库里的代码，不是可以直接 import 的包。发布版本、确认应用有应答、把地址放回去的那部分代码在 `host/` 里，不在 pneuma-framework 里。
- 实际跑过的：在这份代码较早的一个版本上，在 macOS 上用 colima 和 Docker Desktop 跑过真实的 Claude Code 和 Codex 会话（改应用并提交）、等主人决定后被批准或拒绝的改动、越过单向改动的回退，以及 PostgreSQL 数据快照。在这份代码上：跑过离线测试，以及在 macOS 上用 colima 完成的一次创建、一次脚本化改动和一次回退。2026-11-26，一个 Codex 会话照“从这里开始”里的那句话，在默认端口已被占用的机器上装好了本地版（它换用了别的端口，没有碰任何别的东西），第二个会话照它的交接说明做出了一个能用的应用（reading-list）。没跑过的：整台 Linux 机器、多用户、托管运行。

## 基于

- [pneuma-framework](https://github.com/pandazki/pneuma-framework) 提供改动历史及其保证、改动生效前的检查顺序、批准规则、某个地址正在跑哪个版本的记录，以及启动 Claude Code 和 Codex 的适配器。它的包没有发布；本地版从源码取，固定在一个提交。
- [PneumaSpace](https://github.com/pandazki/pneuma-space) 运行这些应用：应用是一个目录加一份清单，预览是会自己结束的临时应用，发布出去的应用会拒绝没有写明管理它的 Host 的写操作。本地版从源码构建它，固定在一个提交。

## 许可证

[MIT](./LICENSE)。构建镜像所用的 pneuma-framework 和 PneumaSpace 也是 MIT。
