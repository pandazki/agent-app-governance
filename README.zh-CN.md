# agent-app-governance

[English](./README.md)

Claude Code、Codex 这样的 coding agent，几分钟就能做出一个带存储数据的小应用。难的是之后怎么跟这个应用过日子：

- 没人记下改了什么、是谁要求的、上线前有没有检查过。
- 下一次改动可能把应用改坏，或者删掉它的数据，而 agent 不一定会停下来问你。
- 想回退只能靠猜。agent 的会话已经没了，存储的数据也不会跟着代码一起回去。

这个仓库把这类应用放进同一条受治理的回路。不管哪个 agent 来改，改动上线前都走同一条路，记录留在应用自己的目录里。它基于 [pneuma-framework](https://github.com/pandazki/pneuma-framework) 和 [PneumaSpace](https://github.com/pandazki/pneuma-space)。

## 你得到什么

- **一条回路，一个旋钮。** 启动 Host 时选三种模式之一：
  - `record`：每次改动都记录并发布，什么都不检查。
  - `personal`（默认）：每次改动都跑应用的测试和预览。常规改动由常设策略放行；有风险的改动，比如去掉登录、删除存储的数据，等你决定。
  - `review-all`：同样的检查，每次改动都由你决定。

  什么改动算有风险，写在一个预设文件里，不写在代码里。
- **每次改动都有记录。** 每个版本都保存在应用目录里，带着当时的要求、是哪个 agent 改的、哪些保证成立：检查过、预览过、批准过、检查之后没再变过。只记录、没检查的版本也会如实写明。把目录拷到另一台机器，历史跟着走。
- **撤销，并写明它的限度。** 撤销会放回早先版本的代码。存储的数据只有在 Host 声明了数据快照能力时才会回来；默认配置没有声明，并会如实告诉你。删除数据的改动会标为单向，越过它往回退需要你确认。
- **任何 agent，或者自己启动 agent 的产品。** agent 在原地改应用，再用应用目录里的一个小 CLI 提交。产品也可以自己启动 Claude Code 或 Codex。两种方式写进同一份历史。一个页面列出你的应用和等你决定的事，你可以在上面做决定、往回退。

## 版本

| 版本 | 状态 | 应用跑在哪里 |
| --- | --- | --- |
| [本地版](./local/README.zh-CN.md) | 能跑 | 你的机器：一条 `docker compose up` 启动 PneumaSpace 和 Host，只监听回环端口 |
| [Cloudflare 版](./cloudflare/README.md) | 正在构建 | Cloudflare |

试用本地版（Docker 需在运行）：

```sh
cd local
docker compose up -d --build
node bin/pneuma.mjs create todo
```

然后打开 http://127.0.0.1:8090/ 。其余内容见 [local/README.zh-CN.md](./local/README.zh-CN.md)：把应用交给你的 agent、主人链接、换端口、测试。

## 限度

以下来自 [local/README.zh-CN.md](./local/README.zh-CN.md) 记录的实跑，以及 pneuma-framework 的 [第 54 个里程碑快照](https://github.com/pandazki/pneuma-framework/blob/c1ffce726866a3b315e9714c49a5547c2426fbcf/docs/archive/milestone-54-snapshot.zh-CN.md)，后者写明了这套东西证明了什么、没证明什么。

- `local/` 里的 Host 是拿去照抄的示例，不是可以直接 import 的包。发布版本、确认应用有应答、把地址放回去的那部分代码在示例里，不在 pneuma-framework 里。
- 在一台机器上，主人没有经过认证。批准需要一个终端，或者 Host 打印在日志里的一个链接。这能挡住诚实的 agent 批准自己的改动，挡不住同一台机器上的其他程序。
- 撤销时存储的数据只有在声明了快照能力时才会回来。`local/` 带了一个作为实践，默认关闭，只适用于数据库在 PostgreSQL 上的应用。SQLite 上的应用，以及文件、键值数据和对象，都不在范围内。
- 预设里针对 SQL 的规则是文本匹配：写在字符串里、根本不会执行的 `DROP` 也会被拦下，用变量拼出来的删除却拦不住。
- 它在 macOS 上端到端跑过，colima 和 Docker Desktop 都跑过。整台 Linux 机器、多用户和托管运行都还没跑过。

## 基于

- [pneuma-framework](https://github.com/pandazki/pneuma-framework) 提供回路：变更记录、受治理的改动、批准规则、发布状态，以及 Claude Code 和 Codex 通道。它的包没有发布；本地版从源码取，固定在一个提交。
- [PneumaSpace](https://github.com/pandazki/pneuma-space) 运行这些应用：应用是一个目录加一份清单，预览是会自己结束的应用，发布出去的应用会拒绝没有写明其管理者的写操作。本地版从源码构建它，固定在一个提交。
