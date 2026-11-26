# 参考：本地版

[English](./reference.md) · [回到指南](../README.zh-CN.md)

启动和日常使用见指南。这里写其余的内容：完整的 CLI、各个模式、风险规则、回退、收起和清除应用、PostgreSQL 那项设置、由 Host 启动 agent、和其他服务并排运行，以及测试。

## CLI

每个应用在 `.appgov/appgov.mjs` 有一份 CLI 副本，应用总目录里也有一份，源文件是 `local/bin/appgov.mjs`。它只需要 Node 18 或更新版本，别的都不用装。

| 命令 | 作用 |
| --- | --- |
| `status [<name>]` | 应用在不在（不在时最先说明）、当前版本、地址、回退会回到的版本、主人、模式、是否开启了数据快照能力、PneumaSpace 上由谁管理这个应用、还没提交的文件，以及等待中的改动和各自的预览 |
| `history [<name>]` | 每一次尝试，从早到晚，附带每次成立的保证 |
| `list` | 所有应用：版本、地址、在不在、最近一次改动、等待中的改动、还没提交的文件 |
| `submit "<intent>"` | 把工作目录交给 Host 走一遍流程。`--one-way "<会丢失什么>"` 声明这个改动会删除或改写已存的数据，任何模式都可用（见[单向改动与回退](#单向改动与回退)） |
| `discard` | 把工作目录放回当前版本，丢掉从没提交过的编辑 |
| `undo "<why>"` | 退回一个版本。`--to <version>` 直接退到更早的某个版本；`--accept-one-way` 是主人确认越过单向改动往回退 |
| `approve <id>`、`deny <id> [why]` | 主人对等待中的改动做决定。都需要终端，并要你输入那个词来确认 |
| `preview <id>` | 等待中的改动的预览自己结束后，重新发布一次 |
| `create <name>` | 创建并发布一个新应用 |
| `take-down [<name>] [why]` | 主人的操作：收起，让应用停止服务，保留一切（见[收起和清除应用](#收起和清除应用)） |
| `bring-back [<name>] [why]` | 主人的操作：恢复一个已收起的应用，带着 PneumaSpace 保留的数据重新提供服务 |
| `publish-again [<name>] [why]` | 主人的操作：重新发布，在 PneumaSpace 上已经没有这个应用时，用它的当前版本重新创建。没有任何存储的数据 |
| `clear [<name>]` | 主人的操作：清除一个不提供服务的应用，并在 PneumaSpace 上彻底删除（purge）它。要你输入应用名 |
| `guide [--write <file>]` | 打印一小段文字，可放进 agent 的用户级说明里：Host 的地址、应用总目录和各条命令。`--write` 把它写进指定文件的两个标记之间，以后再运行就替换那一段 |

在应用目录里，命令作用于这个应用；在别处，用 `--app <name>` 指明（`status`、`history`、`take-down`、`bring-back`、`publish-again` 和 `clear` 也可以直接把名字写在后面）。`--json` 会把 Host 的回答原样以 JSON 打印出来。

CLI 按下面的顺序取 Host 的地址，用第一个有地址的：`--host <url>` 参数；`APPGOV_HOST`；Host 写下的 `.appgov/host.json`，依次在当前目录和它上面的每一层目录里找，然后在 CLI 文件旁边找，再到 CLI 所在目录旁边的 `apps/.appgov/host.json` 里找（`local/bin/appgov.mjs` 就是这样找到 `local/apps/.appgov/host.json` 的）；最后是 `http://127.0.0.1:8090`。连不上时，它会说明试的是哪个地址、这个地址从哪里来。

历史里记下的 agent 名字来自 `--agent <name>`、`APPGOV_AGENT`，或者 agent 在自己 shell 里设置的环境变量：Claude Code 是 `CLAUDECODE` 或 `CLAUDE_CODE_ENTRYPOINT`，Codex 是 `CODEX_THREAD_ID` 或 `CODEX_TOOL_CALL_ID`。如果两家的变量同时存在、又没有指明名字，就记为 `unknown`，同时保留两个候选，并给出警告。

退出码：0 表示命令做成了要做的事；1 表示改动被拒绝、版本没能上线，或用法错误；2 表示需要主人决定（`needs_approval`，或越过单向改动的回退）；3 表示 Host 拒绝了请求，或者连不上 Host。

## 三种模式

`APPGOV_GOVERNANCE` 设置模式：`record`、`personal`（默认）或 `review-all`。所有模式写的是同一份历史，模式改变的只是一个版本被记录之前要经历什么。

- **`record`**：`submit` 把工作目录记为下一个版本并发布。没有测试、没有预览、不检查改动碰了哪些目录、不用风险规则，也没有批准。发布之后，Host 只访问一次应用首页，用来判断这次发布有没有上线。如果 PneumaSpace 拒绝了构建，或者应用没有应答，这个版本仍然记录在案，Host 把地址放回之前的版本，历史条目写明发布失败，`submit` 以 1 退出。之后如果没有新的编辑再 `submit`，就把那个版本原样发布，不再记录新版本；如果有新的编辑，就在上面记一个新版本，发布时两个一起上线。
- **`personal`**：每个改动都要经过检查（见下文）。常设规则（历史里的 `policy:auto`）批准预设在 `auto_approve` 下列出的风险，其他风险都等主人决定。
- **`review-all`**：同样的检查，每个改动都由主人批准，常规改动也一样。

在 `personal` 和 `review-all` 模式下，`create` 同样会跑测试和预览，但从不等待：在 `personal` 下由常设规则批准，在 `review-all` 下记为主人的批准。

批准一个等待中的改动时，按的是 Host 此刻所在模式的规则。一个在 `review-all` 下等待的改动，如果 Host 重启到 `personal` 之后才被批准，就由常设规则批准；主人点了同意的话，历史里也会写上主人。

从 `record` 切到要检查的模式，不会继承 `record` 放过的东西。要检查的模式从 Host 自己的那份配置（`overlay/appgov.scaffold.json`）读取改动能碰哪些目录、哪些文件受保护、用什么测试命令，而不是读应用里那份；比较改动时，对照的是地址上正在跑的版本。所以一个在 `record` 模式下记录、从没上线过的版本，在要检查的模式下上线之前会先被检查。

## 每项保证的含义

每条历史都列出对它成立的保证。没列出来的，就是不成立。

| 保证 | 含义 |
| --- | --- |
| `verified` | 应用的测试（`npm ci --ignore-scripts && npm test`）在这份内容上通过了 |
| `previewed` | 这份内容在发布前以临时名字在 PneumaSpace 上启动过，首页的应答不是服务器错误（状态码低于 500） |
| `approved` | 有一条批准记录：常设规则的或主人的 |
| `sealed` | 发布并记录下来的内容，和检查过的内容逐字节相同 |

| 条目 | 保证 |
| --- | --- |
| 在 `personal` 或 `review-all` 下发布的 | `verified`、`approved`、`sealed`；开启预览时还有 `previewed` |
| 等主人决定的，或被拒绝的 | 检查挣来的：`verified`，预览通过时还有 `previewed` |
| 被检查拦下的 | 失败之前通过了的那些，常常一项都没有。检查之后又变过的草稿：一项都没有 |
| 批准了但发布失败的 | `verified`、`approved`，跑过预览时还有 `previewed`。什么都没记录，所以没有 `sealed` |
| 之前记录过、由一次要检查的提交原样发布的版本 | 那条发布记录写明这次发布成立的保证 |
| `record` 模式下的任何条目、回退、数据快照 | 一项都没有 |

回退条目不对它恢复的版本作任何担保；那个版本发布时成立了什么，看它自己的条目。

## 在 `personal` 和 `review-all` 下改动要经历什么

1. 工作目录被拷成一份草稿。改动只能碰 `src/`、`public/app/`、`pneuma-space.json`、`package.json`、`package-lock.json` 和 `AGENTS.md`；碰了别的，在任何检查之前就以 `outside_writable_roots` 拒绝。改了 `sdk/`、`ui/`、`public/ui.css`、`public/ui.js`、`appgov.scaffold.json` 或 `CLAUDE.md`，以 `protected_file_changed` 拒绝。这两份清单在 `overlay/appgov.scaffold.json` 里。
2. `npm ci --ignore-scripts && npm test` 在应用目录之外的另一份拷贝里运行，因为测试也是 agent 写的代码。条目会记下跑了多少个测试、其中多少是应用自己的；这个数字来自 Node 24 及以上版本的测试运行器写出的 JUnit 报告，换了别的运行器，应用自己的那部分就记为未知。改动碰了 `src/` 或 `public/app/`、却一个应用自己的测试都没跑时，`submit` 会用一行话说明。这不会拦下改动。
3. 预览：草稿以临时应用发布，名字是 `<app>-pv` 加上改动编号的四个字符，有自己的空存储。它在发布 `APPGOV_PREVIEW_TTL` 秒后自己结束（默认 3600；PneumaSpace 不接受超过它的 `ephemeral_max_ttl_seconds`，这个值默认是 3600，可以用 `PUT /api/policy` 调高）。每个等待中的改动会占用一个临时应用，直到有了决定或预览结束。如果 PneumaSpace 拒绝发布预览，原因是租户的临时应用名额用完了，或者要求的存活时间太长，改动就以 `preview_refused` 拒绝，这不算检查没通过。
4. 风险规则给改动分类，批准规则决定它要不要等主人。
5. Host 在对比草稿时算一次内容哈希，在即将发布的那份拷贝上再比一次。中间变过的草稿以 `draft_changed_after_check` 拒绝。
6. 发布。PneumaSpace 拒绝时（`publish_failed`），地址没被动过；应用没有应答时（`published_unhealthy`），Host 把地址放回之前的版本。两种情况下改动都被拒绝，不记录新版本。

等主人决定的改动会一直保留预览，直到有了决定或预览结束。批准时预览必须还在：预览结束后批准会被拒绝，返回 `preview_gone`（409）；PneumaSpace 没有应答时返回 `preview_unknown`（502）。`preview <id>`，或页面上的"再给我看一次"，会把检查过的草稿重新发布成预览，并有新的结束时间。批准或拒绝都会丢弃预览。设置 `APPGOV_PREVIEW=off` 后没有预览，批准也不需要预览，任何条目都不会有 `previewed`。

这些从不属于任何版本：`node_modules`、`.pneuma-framework`、`.appgov`、`.git`、`dist`、`.work`、`.claude`、`.codex`、`.vscode` 和 `.idea` 目录，pneuma-skills 用的 `.pneuma` 目录，最上层的 `data` 目录，以及 `.env`、`.env.local` 和 `.DS_Store` 文件。

### Host 无法担保地址上跑的是什么

这时 `status`、`list` 和页面都会说明这一点，不管它们显示的是哪个版本，并说明该怎么做。有两种情况。

- 发布或回退失败后，Host 没能把地址放回去，之后没人见过地址有应答。这时什么都不拒绝，下一次有应答的发布或回退会把它理清。
- 当前版本以前上线过，而地址现在跑的是一个更旧的版本：要么一次回退已经发出去却没能记录，要么 Host 之外的什么挪动了地址。这时提交或批准会把当前版本的代码重新放到旧版本所用的数据上，所以两者都以 `serving_uncertain`（409）拒绝，什么都不写。有应答的回退会结束这种状态。

## 风险预设

什么改动带什么风险，写在一个 JSON 文件里，不写在代码里。Host 读 `policy/personal.json`，除非 `APPGOV_POLICY_FILE` 指定了别的文件。对容器来说，这是容器里的路径，所以要把你的文件也挂载进去。Host 遇到不认识的字段会在启动时停下，免得一条拼错的规则悄悄放过改动。带有批准记录的历史条目会写明它是按哪个预设决定的。

| 预设的组成 | 说的是什么 |
| --- | --- |
| `change` | 每个改动都带的风险，以及改动只在某些路径下时较轻的风险 |
| `paths` | 这些路径下的改动带这个风险，比如支付代码一律要主人决定 |
| `manifest` | `pneuma-space.json` 每种变化对应的风险：增加或去掉一项能力、去掉一项存放数据的能力（`storage_removed`）、换了运行时、不再要求登录 |
| `content` | 对改动文件做文本匹配。匹配到的内容比改动前出现得多，这条规则才算命中 |
| `auto_approve` | `personal` 模式下常设规则可以批准的风险。其他风险都等主人决定 |

`paths`、`manifest` 或 `content` 规则可以带 `one_way: true`，它找到的改动就被标为单向。`policy/personal.json` 的规则如下：

| 规则在磁盘上找到的 | 风险 | `personal` | `review-all` |
| --- | --- | --- | --- |
| 源码或浏览器文件有改动 | `source_code_change`；只改了 `public/` 时是 `additive_ui` | 常设规则 | 主人 |
| `pneuma-space.json` 增加了一项能力 | `definition_additive` | 常设规则 | 主人 |
| 去掉了一项能力，或换了运行时 | `release_change` | 常设规则 | 主人 |
| 去掉了一项存放数据的能力（`db`、`kv`、`files`、`object`）：PneumaSpace 保留数据，但应用再也读不到 | `destructive_definition`，单向 | 主人 | 主人 |
| 访客不再需要登录 | `policy_change` | 主人 | 主人 |
| 在 `.ts`、`.js` 或 `.sql` 文件（及其变体）里新出现 `DROP TABLE/COLUMN/INDEX`、`ALTER TABLE ... DROP/RENAME`、`TRUNCATE`，或不带 `WHERE` 的 `DELETE` | `destructive_definition`，单向 | 主人 | 主人 |

在 `record` 模式下，提交的改动不经这些规则分类，也不由它们批准；不过 Host 启动时仍会读取并检查这个文件。SQL 规则是文本匹配。它们不匹配 `UPDATE`，也不匹配带 `WHERE` 的 `DELETE`，所以在 `personal` 下，改写或删除部分已存数据行的改动不经主人就会上线。写在字符串里、根本不会执行的 `DROP` 会被标出来，用变量拼出来的删除却会漏掉。没有规则去读文件、键值数据或对象上的删除：删除的调用每个普通应用里都有（比如删掉一条待办），对它报警的规则只会让主人不再细看警告。对这些存储，Host 依靠提交者的 `--one-way`。请把这个文件当作写自己规则的起点。

## 单向改动与回退

- **回退是一步步往回走的。** 每次 `undo` 回到当前版本所基于的那个版本：从 v5 到 v4，再到 v3。`undo --to <version>` 直接退到其中某一个。当前版本并非基于它的那些版本，不能作为回退目标；想找回这样的版本，从 `.pneuma-framework/versions/<version>/` 把它的文件重新提交一次。回退之后的新改动会得到一个新编号。
- **每一步**都先发布旧版本，确认它有应答，然后才改动历史、把旧文件放回工作目录。工作目录里有从没提交过的编辑时，回退不会开始。如果回退进行中工作目录被改了，版本照样发出去，工作目录保持原样，并附上一条说明。
- **哪些改动是单向的。** 预设的规则会标出一部分：`policy/personal.json` 里破坏性 SQL 那条规则和去掉存放数据的能力那条规则。提交的人在任何模式下都可以用 `submit --one-way "<会丢失什么>"` 标出任何改动；每个应用里给 agent 的说明都要求它，只要改动会删除或改写应用已经存下的数据（不论哪种存储），就这样做，因为规则只读 SQL 文本和清单。预设定下一个改动至少要过哪一关，声明只能往上加。在 `record` 模式下它把这个版本标为单向。在 `personal` 和 `review-all` 下，不管有哪些风险，这个改动都要等主人（批准路线 `declared-one-way`；常设策略和主人以外的任何人都会被拒绝，Host 换了模式重启之后也一样）。风险仍是规则发现的那些，主人会在单独一行里读到提交者的原话，并注明这是 agent 自己的说法，不是规则的发现。批准之后，这个版本记为单向，原因先写规则发现的东西，再写 `declared one-way when it was submitted: "<原话>"`，原话本身另存在 `declared_one_way` 里。主人批准单向改动之前，Host 会告诉他批准的代价，以及它能不能把存储的数据放回去。
- **越过单向改动往回退，在任何模式下都要等主人。** 回退会被拒绝（`crosses_one_way_change`，CLI 以 2 退出），什么都不会动。提示会列出每个单向版本及其原因，并说明属于哪种情况：(a) Host 在那次改动之前存了数据，数据会回到那份快照，此后存下的一切都被搁到一边、不再出现在应用里；(b) 回去的只有代码，旧版本可能读不了现在的数据。API 的回答里带有 `data_restore: "snapshot"` 或 `"none"`。
- **主人确认**：在终端里运行 `undo --accept-one-way "<why>"` 并输入 `accept`，或者在从主人链接打开的页面上确认。确认会带上方案开始时的版本；如果这中间又有别的版本上线，Host 返回 `plan_changed`（409），什么都不变。除主人以外，Host 对任何人都返回 403。历史条目会记下 `one_way_crossed`、`confirmed_by`，在情况 (a) 下还会记下被替换的数据去了哪里。如果越过的某个版本是提交者声明为单向的，回退的回答会在 `declared_one_way` 里列出它和那段原话，CLI 也会打印出来：回退放回的是它的代码，不是它对已存数据做过的事。

## 收起和清除应用

应用在不在，来自两个地方：Host 自己的记录（主人有没有通过这个 Host 收起它，也就是历史里有一条 `take_down`，后面没有跟着 `bring_back` 或 `publish_again`），以及 PneumaSpace 对这个应用的说法。每次 `status`、`list` 和页面上的每个应用，以及每次提交、批准和回退之前，Host 都会问 PneumaSpace；在这个版本上，每次读取都是当场去问。`status` 和 `list` 把 PneumaSpace 的回答放在 `runtime` 里（`serving`、`removed`、`gone` 或 `unknown`，带 `checked_at`），把主人的收起放在 `taken_down` 里（谁、什么时候、通过什么），把两者合起来的结论放在 `standing` 里。`status` 还带有 `choices`（主人现在能做什么）和 `clearing`（清除会删掉什么、留下什么）。

| `standing` | 意思 | 主人能做什么 |
| --- | --- | --- |
| `running` | PneumaSpace 在提供它的服务，这里也没人收起它 | 收起 |
| `down` | 主人通过这个 Host 收起了它。PneumaSpace 把它保留为已移除，带着数据，或者已经没有它了 | 恢复；PneumaSpace 上已经没有它时重新发布；清除 |
| `removed_elsewhere` | PneumaSpace 把它保留为已移除，带着数据，但不是通过这个 Host | 恢复，或清除 |
| `vanished` | PneumaSpace 上已经没有这个应用（或正在彻底删除它），而这个 Host 没有收起它，所以它存储的数据已经不在了 | 重新发布，或清除 |
| `unconfirmed` | PneumaSpace 没有回应 | 在它回应之前，什么都不能做 |

Host 记为已收起、PneumaSpace 却又在提供服务的应用（在控制台里被恢复了），仍然是 `down`。主人可以再次收起它，或者恢复它；恢复这时只是把它记为已恢复，不动 PneumaSpace。

每个操作做什么：

- **收起**调用 PneumaSpace 的 `remove`，带上 Host 的管理者名字。地址不再应答；PneumaSpace 保留应用存储的数据，Host 保留目录、各个版本和历史。历史里会多一条 `take_down`，写明是谁、通过什么做的（从页面上做时是 `"channel": "owner-page"`），主人给的理由写在它的意图里。等待中的改动留着：在应用恢复之前，批准会被拒绝，拒绝改动仍然可以。
- **恢复**带着 PneumaSpace 保留的数据，重新提供当前版本的服务。本地的 gateway 没有恢复这个操作，所以 Host 把当前版本发布到那个已移除的应用上，gateway 会以同一个 id、同样的数据重新登记它。之后 Host 访问一次首页；没有应答时，`bring_back` 条目会写明。
- **重新发布**只用于 PneumaSpace 上已经没有的应用。它把当前版本发布成一个新应用，存储是空的，`publish_again` 条目会写明应用以前存储的数据已经不在了。
- **清除**先检查 `confirm` 是不是应用名，再检查 PneumaSpace 是否不在提供它的服务：它从不一步从 `running` 走到清除。它丢弃等待中的改动的预览；如果 PneumaSpace 把应用保留为已移除，就在那里彻底删除它和它存储的全部数据；然后删掉应用目录 `apps/<name>/`：源码、每一个版本、历史和等待中的改动。这个目录也是你的 agent 工作的地方。没有历史可以写了；Host 的日志里会留下一行，写明是谁清除的。PneumaSpace 拒绝彻底删除时，什么都不清除。PostgreSQL 那项设置做的数据快照（历史里写着名字的那些数据库）不会被删掉：`status` 在 `clearing.keeps` 里列出它们，CLI 和页面会在你输入应用名之前显示这几行。

清除会不会彻底删除，取决于 Host 的 PneumaSpace 运行时有没有这项能力（`SpaceRuntime.purge`），不是一项设置。本地的 gateway 允许 Host 彻底删除一个已移除的应用。Cloudflare 版的平台不给 Host 彻底删除的权限，所以在那里，清除会把应用留在 PneumaSpace 上（已移除，带着数据），由 PneumaSpace 的主人去彻底删除。

**CLI。** `take-down`、`bring-back`、`publish-again` 和 `clear` 在应用目录之外可以把应用名直接写在后面；其余的话是主人的理由。每条命令没有终端就拒绝运行，先显示应用的状态和这个操作会做什么（`clear` 会显示会删除什么、会保留什么），再要你输入命令名，`clear` 要输入应用名。它以 `APPGOV_OWNER`（默认 `user:me`）作为身份发出。

**路由。** 前三个返回 `standing`、`runtime`、`taken_down`，以及一句说明发生了什么的 `note`。`clear` 返回 `deleted`、`kept` 和 `space_holds`（PneumaSpace 是否还留着这个应用）。JSON API 对写操作的规则同样适用：不能带 `Origin` 或 `Sec-Fetch-Site`，必须声明 `content-type: application/json`。

| 路由 | 请求体 |
| --- | --- |
| `POST /apps/<name>/take-down`、`/bring-back`、`/publish-again` | `subject`（只接受应用的主人），可选 `reason` |
| `POST /apps/<name>/clear` | 同上，再加 `confirm`：应用名 |
| `POST /owner/apps/<name>/take-down`、`/bring-back`、`/publish-again`、`/clear` | 页面用的，带主人链接的令牌。身份是应用的主人，条目里写着 `"channel": "owner-page"`。可选 `reason`；`clear` 要带 `confirm` |

**拒绝。** 这些拒绝都不写任何东西，CLI 以 3 退出。

| 代码 | 状态码 | 什么时候 |
| --- | --- | --- |
| `app_down` | 409 | 主人收起了应用时的提交、批准或回退。提示会写明是谁、什么时候收起的，并说明要由主人恢复 |
| `app_removed_elsewhere` | 409 | 同上，应用是在 PneumaSpace 上收起的，不是通过这个 Host |
| `app_vanished` | 409 | 同上，PneumaSpace 上已经没有这个应用：发布只会把它重新建成一个空应用。由主人重新发布或清除 |
| `owner_required` | 403 | 应用主人以外的人要求收起、恢复、重新发布或清除 |
| `confirm_name` | 400 | 清除时 `confirm` 里不是一字不差的应用名 |
| `clear_running` | 409 | PneumaSpace 正在提供这个应用的服务时要求清除：先收起 |
| `cannot_take_down`、`cannot_bring_back`、`cannot_publish_again` | 409 | 这个操作不符合应用现在的状态：比如恢复一个 PneumaSpace 上已经没有的应用，或者重新发布一个它还留着的应用 |
| `space_unknown` | 502 | PneumaSpace 没有回应，无法知道应用在不在 |
| `space_refused` | 502 | PneumaSpace 拒绝了移除、发布或彻底删除，或者没有回应 |

## PostgreSQL 数据快照

这是一种可选的做法，不是 pneuma-framework 或 PneumaSpace 的承诺。开启后，单向改动第一次上线之前，Host 会复制一份应用的 PostgreSQL 数据库；经确认越过那次改动的回退会把这份副本放回去。代码在 `src/data-snapshot-postgres.ts`，复制用的是 PostgreSQL 的 `CREATE DATABASE ... TEMPLATE`。

设置，要在应用第一次声明数据库（`pneuma-space.json` 里的 `"db": {}`）之前完成：

1. 启动 PostgreSQL：`docker compose --profile postgres up -d`。
2. 让新数据库都建在 PostgreSQL 上：

   ```sh
   curl -X PUT http://127.0.0.1:8081/api/policy -H 'content-type: application/json' -d '{"db_backend":"postgres"}'
   ```

   此后，应用的第一个数据库会是它自己的一个 PostgreSQL 数据库。已经有数据库的应用保持不变；PneumaSpace 不会在两种引擎之间搬数据。
3. 在 `local/.env` 里写：

   ```sh
   APPGOV_DATA_SNAPSHOT=postgres-template
   APPGOV_DATA_SNAPSHOT_URL=postgresql://postgres:pneuma-local@postgres:5432/postgres
   ```

   再运行一次 `docker compose --profile postgres up -d`，让 Host 带着这两项重启。之后 `status` 会显示 `data snapshot: postgres-template`。只写了名字没写 URL，或者写了别的名字，Host 会在启动时停下并说明原因。

**快照。** 一个发布第一次让单向改动上线之前，Host 先问 PneumaSpace 这个应用用的是哪个 PostgreSQL 数据库，停下应用，把数据库复制为 `snap_<app>_<version>_<time>`。这份副本只对超级用户开放，并加上一条注释，写明应用、版本、来源数据库和时间。应用在 SQLite 上或没有数据库时会被拒绝，改动不会上线（`data_snapshot_failed`）。如果一次单向发布已经发出去却没有应答，下一次尝试会沿用第一份快照，而不是复制那次失败的尝试可能已经改过的数据。

**恢复。** 快照的名字来自应用的历史，而 agent 能写这份历史，所以 Host 先检查：名字带着这个应用的前缀，数据库归超级用户所有，并带有这个应用的标记。通不过检查的名字以 `data_snapshot_refused` 拒绝，此时什么都还没变。然后旧代码先发出去并且要有应答，应用的数据库改名为 `<database>_replaced_<time>`（什么都不删），快照的一份新副本顶上这个名字，应用要再应答一次，历史才会更新。先放代码，是因为删掉数据的那个版本通常一启动就会再删一遍。

限度：

- 只覆盖 PostgreSQL 数据库。文件、键值数据和对象保持原样。SQLite 上的应用不在范围内，在策略改成 `postgres` 之前就有了数据库的应用也不在。
- 只在单向改动之前取快照。恢复会让应用失去那之后存下的一切，这些数据只留在被替换的数据库里。
- 每次快照和恢复都是完整复制，耗时和占用的磁盘随数据库增长。复制或替换数据库时应用会停下。
- 从旧代码发出去到数据放回之间，旧代码跑在新数据上，可能返回错误。
- `APPGOV_DATA_SNAPSHOT_URL` 是对那台服务器上所有应用数据库的超级用户权限。
- 快照和被替换的数据库会一直留着，直到有人删掉，清除应用也不会删掉它们。被替换的数据库仍归应用的 PostgreSQL 角色所有，所以只要还留着一个，PneumaSpace 彻底删除（purge）这个应用就会失败，清除这个应用也会以 `space_refused` 被拒绝；先删掉被替换的数据库。

## 由 Host 启动 agent（`bun run drive`）

除了在应用目录里打开 agent，也可以让 Host 在应用的一份拷贝上启动 Claude Code 或 Codex，再让结果走同样的检查。自己管理对话的产品会用这种方式。它运行在你的电脑上（`claude` 和 `codex` 在这里登录），连接正在运行的那套服务。

需要：Bun 1.4.5，Node 24 或更新版本，`compose.yaml` 固定的那个提交的 PneumaSpace 源码（为了用它的 CLI `appctl`），以及正在运行的 compose 服务。取这份源码的办法：克隆 PneumaSpace，检出 `compose.yaml` 里 `x-space-context` 那一行的提交；`appctl` 不用安装：

```sh
git clone https://github.com/pandazki/pneuma-space.git "$HOME/pneuma-space"
git -C "$HOME/pneuma-space" checkout 6e7353809338901a604973e9fe90d1cafe4cb3cc
```

```sh
cd local
bun run setup                                       # 一次即可：把 pneuma-framework 取到 vendor/，然后 bun install
export APPGOV_SPACE_CLI="$HOME/pneuma-space/cli/appctl.ts"

bun run drive change todo "add a due date to each item" --agent claude-code
bun run drive change todo "sort by due date" --agent codex
bun run drive change todo "leave a note" --agent scripted
```

`--agent scripted` 不需要登录：它把要求写进 `public/app/note.txt`，足以让一次改动完整走过 Host。不带参数运行 `bun run drive` 会列出其他命令（`create`、`status`、`history`、`undo`、`discard`、`approve`、`deny`、`preview`）。

`drive` 和容器一样从环境变量读设置。如果服务跑在别的端口或别的项目名下，要设置 `APPGOV_SPACE_ADMIN`（PneumaSpace 管理地址，例如 `http://127.0.0.1:48361`）、`APPGOV_SPACE_INGRESS` 和 `APPGOV_SPACE_PUBLIC`（应用所在的地址）、`APPGOV_APPS_DIR`，服务设置了 `APPGOV_MANAGER` 时也要设成一样；管理者名字不同，Host 会拒绝改动这套服务的应用（`managed_elsewhere`）。`APPGOV_GOVERNANCE` 和 `APPGOV_POLICY_FILE` 要和服务用的一致。

这样启动的改动、主人的批准和回退，都会把一个版本写到工作目录上，所以工作目录里有从没提交过的编辑时，它们都不会开始。不要让 `drive` 和目录里的 agent 同时改同一个应用。由 Host 启动 Claude Code 时，没人回答它的权限提示，所以超出允许范围的工具调用会被拒绝，并打印成 `[claude:denied ...]`。

## 和其他服务并排运行

这套服务监听四个端口，都在 127.0.0.1 上。某个端口被占用时，在 `.env` 里换一个：

| 变量 | 默认 | 监听的是什么 |
| --- | --- | --- |
| `PNEUMA_SPACE_HTTP_PORT` | 8080 | 应用，在 `/apps/<name>/` |
| `PNEUMA_SPACE_ADMIN_PORT` | 8081 | PneumaSpace 控制台和管理 API |
| `PNEUMA_SPACE_OBJECT_PORT` | 9000 | 对象存储 |
| `APPGOV_HOST_PORT` | 8090 | Host：你的应用页面，以及 CLI 调用的 API |

Host 启动时、创建或打开应用时，会把自己的地址记在应用总目录和每个应用的 `.appgov/host.json` 里，所以那里的 CLI 副本在任何端口都能找到它。CLI 怎么选地址，见[CLI](#cli)一节。应用总目录不在 `local/` 下时，`node bin/appgov.mjs` 看不到那份记录：运行那个目录里的副本，或者加上 `--host`。

在第一套旁边再跑一套，需要它自己的 compose 项目名、Docker 网络名、端口和应用总目录。`PNEUMA_SPACE_NETWORK` 设置网络名，并把同一个名字告诉 gateway。如果用的是仓库的第二个克隆，把下面几行写进那个克隆的 `.env`。如果用的是同一个克隆，就写进另一个文件，并在这套服务的每条 `docker compose` 命令里用 `--env-file` 指定它；这个文件会代替 `.env`，所以 `.env` 里你依赖的设置要再写一遍。

```sh
COMPOSE_PROJECT_NAME=aag-second
PNEUMA_SPACE_NETWORK=aag-second
PNEUMA_SPACE_HTTP_PORT=48360
PNEUMA_SPACE_ADMIN_PORT=48361
PNEUMA_SPACE_OBJECT_PORT=48362
APPGOV_HOST_PORT=48363
APPGOV_APPS_DIR=/path/to/second-apps    # 先自己建好，让它归你所有
```

然后运行 `docker compose --env-file second.env up -d --build`，再运行一次 `node bin/appgov.mjs create notes --host http://127.0.0.1:48363`。此后，在 `/path/to/second-apps` 或 `/path/to/second-apps/notes` 里运行 CLI，什么都不用设就能连到第二个 Host。

在 Linux 上，Host 必须以你的身份写应用文件，否则 agent 改不了它们。以 root 启动时，它会切换成挂载进来的应用总目录的所有者（`host-entrypoint.sh`）。仓库里带了一个空的 `apps/`，这样在 Docker 挂载它之前它就归你所有。如果把 `APPGOV_APPS_DIR` 指到别处，先自己建好那个目录；由 Docker 创建的目录归 root 所有。

Host 只接受这些主机名：`localhost`、`127.0.0.1`、`[::1]`、`APPGOV_HOST_URL` 里的主机名，以及 `APPGOV_HOST_BIND` 是单个地址时的那个地址。其他名字，包括局域网地址和 `host.docker.internal`，都返回 403 `wrong_host_name`。想用别的名字访问，把 `APPGOV_HOST_URL` 设成带那个名字的地址。

## 应用目录里有什么

| 路径 | 是什么 |
| --- | --- |
| `AGENTS.md`、`CLAUDE.md` | 怎么改这个应用：先是给 agent 的规则，然后是 PneumaSpace 对模板的说明 |
| `pneuma-space.json` | 应用向 PneumaSpace 申请什么（能力） |
| `appgov.scaffold.json` | 改动能碰哪些目录、哪些文件受保护，以及有哪些检查 |
| `.pneuma-framework/versions/vN/` | 每个记录下来的版本的干净源码 |
| `.pneuma-framework/history.jsonl` | 每次尝试一行，附带成立的保证 |
| `.pneuma-framework/record.json` | 版本计数和当前版本 |
| `.pneuma-framework/build-threads.json` | 按顺序记下的每个要求、方案和决定 |
| `.pneuma-framework/release-rollout.json` | 地址上正在跑哪个版本，以及之前那个 |
| `.appgov/appgov.mjs` | CLI |
| `.appgov/host.json` | Host 的地址 |
| `.appgov/app.json` | 应用的名字、主人和创建时间 |
| `.appgov/pending/`、`.appgov/drafts/` | 等主人决定的改动及其草稿 |

这两个隐藏目录由不同的一方写入。`.pneuma-framework/` 由 pneuma-framework 写入，存着每一个版本和历史。`.appgov/` 由 Host 写入，存着它的 CLI、它的地址和等待决定的改动。这两个目录都不属于任何版本，也不会随 Host 的发布出去。

把这个目录拷到另一台机器，再让一个 Host 指向它，历史就能接着记下去。应用存储的数据不会跟着拷过去。

## 在一台机器上，主人这道关做了什么

- `approve`、`deny`、`undo --accept-one-way`、`take-down`、`bring-back`、`publish-again` 和 `clear` 没有终端就拒绝运行；需要主人做的决定如果来自别的身份，Host 返回 403。主人是应用的 `.appgov/app.json` 里写的那个，取自创建应用时的 `APPGOV_OWNER`（默认 `user:me`）。做决定的身份是 Host 从请求里读的，所以这只能挡住诚实的 agent 批准自己的改动，挡不住这台机器上的其他程序。
- 主人链接：Host 生成一次随机令牌，存在自己的状态卷里（`/state/owner-token`，只有 Host 的用户能读），每次启动都打印这个链接。令牌放在地址里 `#` 之后的部分，浏览器不会把这部分发给任何服务器；页面把它留在当前标签页，每次做决定时从页面自己的源一起发出。页面上的决定和终端里的决定经过同样的检查，写下同样的历史条目，只多一项 `"channel": "owner-page"`。能读 Host 日志的程序就能读到这个链接。
- Host 的 JSON API 拒绝只有浏览器才会发的请求：会改动东西的请求不能带 `Origin` 或 `Sec-Fetch-Site`，而且必须声明 `content-type: application/json`。这能防止网页通过 API 做事，但不是认证。
- 截图：`screenshot` 服务是一个无界面的 Chrome。某个版本上线时、等待中的改动有预览时，以及隔 `APPGOV_SCREENSHOT_REFRESH_HOURS` 小时（默认 24）之后，Host 会请它给应用拍一张截图。每次拍照都不带 cookie，所以要求访客登录的应用拍不到截图。被拍的页面自己发出的请求只能去它自己的地址或走 https，但 WebSocket，以及来自其他站点的框架发出的任何请求，都不受限制，所以页面的脚本（包括预览的脚本）能向 compose 网络里的每个服务发请求。那里的 PneumaSpace 管理 API 有一些写操作不需要登录，比如停掉一个应用。在意这一点的话，设置 `APPGOV_SCREENSHOT_CDP=` 关掉截图，其他一切照旧。
- PneumaSpace 上的管理者：Host 发布的每个应用和每个预览，都把 Host 登记为管理者（`APPGOV_MANAGER`，默认 `appgov`）。对这类应用的写操作，不带这个名字 PneumaSpace 就拒绝，它的控制台也会先要你输入这个名字。这个名字不是秘密，所以只能防止失误。每次写之前，Host 都会问 PneumaSpace 这个应用由谁管理。是别的名字：写操作以 `managed_elsewhere`（409）拒绝，提示会说明怎么处理；拒绝一个等待中的改动仍然可以。没有管理者：写操作照常进行，并把应用标记为由这个 Host 管理，结果里会说明。

### 更换主人链接

Host 重启后链接不变。要作废它、换一个新的，删掉令牌再重启 Host；之后日志里最后一行 "owner link" 就是新链接：

```sh
docker compose exec host rm /state/owner-token
docker compose restart host
docker compose logs host | grep "owner link" | tail -1
```

用旧链接打开的页面不能再做决定，请打开新链接。

## 测试与框架源码

Host 用到四个 pneuma-framework 包（`@pneuma-framework/core`、`host-kit`、`backend-codex`、`backend-claude-code`）。它们没有发布，所以从源码取，固定在一个提交上，而这个提交只在一个地方设置：`compose.yaml` 里 `x-framework-context` 那一行，就在 PneumaSpace 的固定提交旁边。

- Host 的镜像把那个提交作为单独的构建上下文从 GitHub 取来，PneumaSpace 也是这样取的。`docker compose up` 不需要别的。
- 在你的电脑上，`bun run setup` 读同一行，把那个提交取到 `vendor/pneuma-framework`（git 会忽略它），运行 `bun install --frozen-lockfile`，再把共享的 Host 代码要导入的两个框架包链接到 `../host/node_modules`（git 会忽略它）。

```sh
cd local
bun run setup         # 一次即可，固定的提交变了之后再运行一次
bun run typecheck
bun test              # 离线测试：内存里的 PneumaSpace 和脚本化的 agent CLI；apps/ 和 vendor/ 不在内
```

`bun run dev:page` 不用 Docker，就能用各种状态的示例应用展示应用页面；`bun run build:page` 把页面构建到 `web/dist`。

要换到框架的另一个提交，改 `compose.yaml` 里的那一行，然后运行 `bun run setup`。如果因为框架的包改了依赖而停下，运行 `bun install` 并提交新的 `bun.lock`。要用本地检出的源码而不是固定的提交来构建，在 `.env` 里设置 `APPGOV_SPACE_CONTEXT` 或 `APPGOV_FRAMEWORK_CONTEXT`（见 `.env.example`）。
