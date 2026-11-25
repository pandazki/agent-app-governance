# agent-app-governance

[English](./README.md)

Claude Code、Codex 这样的 coding agent，几分钟就能做出一个带存储数据的小应用。难的是之后怎么跟这个应用过日子：

- 没人记下改了什么、是谁要求的、上线前有没有检查过。
- 下一次改动可能把应用改坏，或者删掉它的数据，而 agent 不一定会停下来问你。
- 想回退只能靠猜。agent 的会话已经没了，存储的数据也不会跟着代码一起回去。

这个仓库给这类应用定下一条上线的路。应用在这里用模板创建；之后不管哪个 agent 来改，都把改动提交给一个叫 Host 的服务。Host 负责检查改动，交给规则或你来批准，再发布出去，并把经过记进应用自己的目录。它管的是用它创建的应用：你手上已有的应用接不进来，它也不是这些应用数据的备份。它基于 [pneuma-framework](https://github.com/pandazki/pneuma-framework) 和 [PneumaSpace](https://github.com/pandazki/pneuma-space)。

## 你得到什么

- **一个设置决定管得多严。** Host 以三种模式之一运行：
  - `record`：每次改动都记录下来，由 Host 发布，没有任何检查或批准。启动不起来的改动仍然记录在案，只是没有上线。
  - `personal`（默认）：改动要通过应用自己的测试；除非关掉了预览，还要在预览里启动成功。常规改动由常设规则放行；有风险的改动，比如去掉登录、删除存储的数据，等你决定。
  - `review-all`：同样的检查，每次改动都由你决定。

  什么改动算有风险，写在一个预设文件里，不写在代码里。
- **每次改动都有记录。** 每个版本都保存在应用目录里，带着当时的要求、是哪个 agent 改的、哪些保证成立：检查过、预览过、批准过、检查之后没再变过。只记录、没检查的版本也会如实写明。把目录拷到另一台机器，源码和历史跟着走，应用存储的数据不会跟着走。
- **撤销，并写明它的限度。** 撤销会放回早先版本的代码，存储的数据保持原样；只有为 PostgreSQL 上的应用开启可选的数据快照，数据才能一起回去。快照默认关闭，`status` 会如实显示。越过单向改动（比如删除存储数据的改动）往回退，需要你确认。在 `personal` 和 `review-all` 模式下由预设标出这类改动；在 `record` 模式下只有 agent 提交时自己加 `--one-way` 才会标出。
- **任何 agent，或者自己启动 agent 的产品。** agent 在原地改应用，再用应用目录里的一个小 CLI 提交。也可以由程序让 Host 自己启动 Claude Code 或 Codex。两种方式写进同一份历史。一个页面列出你的应用和等你决定的事，你可以在上面做决定、往回退。

## 版本

| 版本 | 状态 | 应用跑在哪里 |
| --- | --- | --- |
| [本地版](./local/README.zh-CN.md) | 能跑 | 你的机器：一条 `docker compose up` 启动 PneumaSpace 和 Host，只监听回环端口 |
| [Cloudflare 版](./cloudflare/README.md) | 正在构建 | Cloudflare |

本地版假定只用在一台你信任的机器上，127.0.0.1 上有四个空闲端口，装有 Docker（它的 gateway 容器会挂载 Docker socket）和 Node.js 24。开始前需要什么，见 [local/README.zh-CN.md](./local/README.zh-CN.md)。准备好以后：

```sh
cd local
docker compose up -d --build
node bin/pneuma.mjs create todo
```

然后打开 http://127.0.0.1:8090/ 。后面的步骤见本地版指南：把应用交给你的 agent、对改动做决定、往回退。

## 限度

- 它管的是在这里用 PneumaSpace 模板新建的应用，没有导入已有应用或其数据的办法。
- 一台信任的机器，一个人用。主人没有经过认证：批准需要一个终端，或者 Host 打印在日志里的一个链接。这能挡住诚实的 agent 批准自己的改动，挡不住同一台机器上的其他程序。
- 撤销恢复的是代码。存储的数据只有通过可选的快照做法才能回来，而且只适用于数据库在 PostgreSQL 上的应用。SQLite 上的应用，以及文件、键值数据和对象，都不在范围内。
- 预设里针对 SQL 的规则是文本匹配：写在字符串里、根本不会执行的 `DROP` 也会被拦下，用变量拼出来的删除却拦不住。
- Host 是这个仓库里的代码，不是可以直接 import 的包。发布版本、确认应用有应答、把地址放回去的那部分代码在 `local/` 里，不在 pneuma-framework 里。
- 实际跑过的：本地版在 macOS 上用 colima 和 Docker Desktop 都跑过，包括真实的 Claude Code 和 Codex 会话。整台 Linux 机器、多用户和托管运行都还没跑过。

## 基于

- [pneuma-framework](https://github.com/pandazki/pneuma-framework) 提供改动历史及其保证、改动生效前的检查顺序、批准规则、某个地址正在跑哪个版本的记录，以及启动 Claude Code 和 Codex 的适配器。它的包没有发布；本地版从源码取，固定在一个提交。
- [PneumaSpace](https://github.com/pandazki/pneuma-space) 运行这些应用：应用是一个目录加一份清单，预览是会自己结束的临时应用，发布出去的应用会拒绝没有写明管理它的 Host 的写操作。本地版从源码构建它，固定在一个提交。
