# dsh-gitbar-lite

**给 DSH 用的 GitHub Desktop 风格 Git 面板**——装在 DSH **自带的右侧栏**里，和「文件 / 文档 / 聊天」并排。

变更文件列表、勾选提交、Summary + Description、Commit / Commit and Push、一个会随分支状态变化的 Push/Fetch 按钮、舍弃更改进插件自己的回收站、双击看 diff——都在这一栏里。

> English: [README.en.md](./README.en.md)

## 为什么是「右侧栏的一个 tab」

DSH 的右栏本来就是一个常驻的标签区。Git 面板放这里，意味着它和会话是同一份上下文：**当前会话的工作区就是它看的仓库**，切换会话就跟着切，不用再挑一次目录。

面板很窄（右栏最小 300px，窄视口下会自动全屏），所以它是按窄栏设计的：文件列表单列、路径按「文件名 + 目录」两级显示、提交框只留一个 Summary 输入框加一个可展开的小三角。

## 功能

| 功能 | 说明 |
|---|---|
| 变更文件列表 | 修改 / 新增 / 删除 / 重命名 / 未跟踪都能识别，每行带 `+n −n` 行数统计 |
| 勾选 | **勾选就是真的 `git add`**，取消就是 `git restore --staged`。终端里 `git status` 看到的就是同一件事 |
| 半暂存 | 一个文件索引和工作区都有改动时，勾选框显示成「半选」，点一下把它整体重述为勾上或没勾 |
| Summary / Description | Summary 常驻一行；最右边一个小三角展开 Description |
| Commit | 只提交勾上的（因为勾选写进了索引） |
| Commit and Push | 提交后立刻推送；**推送失败不会说「提交失败」**——提交已经发生了，面板会明说「已提交 xxx，但推送失败」 |
| 上下文按钮 | 有本地未推送提交时是 **Push**，没有上游时是 **Publish**，否则是 **Fetch** |
| 舍弃更改 | 单个文件或「全部舍弃」；动手前先把这次改动的 diff 归档，确认框里可以勾「彻底删除」 |
| 回收站 | 独立 tab。每次舍弃存一份 diff，并记下**是对哪个提交（`abc1234 初始提交`）取的 diff** |
| diff 预览 | 双击文件，或点回收站里的一条，在右栏开一个 diff 标签页——**永远只占一个**，再点就复用 |
| 仓库绑定 | 工作区本身是 Git 仓库就自动绑定并记住；不是就让你从工作区里扫出来的仓库里挑，或直接填路径 |

## 前置条件

| 需要什么 | 说明 |
|---|---|
| DSH `>= 0.2.0-rc.2` | 右侧栏 tab API 是这一版的行为 |
| Node `>= 22` | 宿主半边用到 `AbortSignal.any` 与 `node:test` |
| **本机有一个 `git`** | 默认从 `PATH` 找；找不到时面板会明确说「本机找不到 git」，不会静默失败。装在别处可以用 `gitPath` 指定 |
| 凭据 | Push 用的是**系统 git 的凭据**（credential helper）。先在终端里成功 push 过一次，插件就跟着能推 |

插件不会自己存任何凭据。宿主半边不读 `$DSH_HOME` 里的密钥，也不写。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-gitbar-lite
```

装完**重启 DSH**。然后在一个会话里打开右侧栏，引导页上会多一张 **「Git 更改」** 卡片，点它就进面板。

<details>
<summary>从本地克隆安装 / 卸载 / 装完打不开怎么办</summary>

**本地目录安装**（改代码时用这个）：

```sh
dsh plugin --profile desktop add link:/绝对路径/dsh-gitbar-lite
```

**卸载**：

```sh
dsh plugin --profile <你的 profile> remove dsh-gitbar-lite
```

**装完 DSH 起不来**：先跑 `node scripts/check-client-bundle.mjs .`。DSH 把
`exports["./client"]` 当**精确文件路径**读，没有扩展名补全也没有目录回退；指向一个不存在的文件会直接
`MissingClientBundleError` **中止整个 Host 启动**，而不是「这个插件不显示」。这个脚本就是复刻那条判定，让你不必靠重启去试。

</details>

## 使用

```
右栏引导页
┌──────────────────────────────────┐
│  ▸ Git 更改                      │  ← 引导卡片，点开面板
│    查看改动、勾选要提交的文件…    │
└──────────────────────────────────┘
        ↓ 点开
┌──────────────────────────────────┐
│ dsh-gitbar-lite  main   ↑1 ↓0    │  ← 仓库名 / 分支 / 领先落后
│              [Push] [↻] [🗄] [⑂]  │  ← 上下文按钮、刷新、回收站、换绑
│ 更改   5 个文件 · 已勾选 2  [全部舍弃] │
│ ☑ M  a.txt                  +3 −1 ↩│  ← 双击 = 看 diff；↩ = 舍弃这个文件
│ ▣ M  src/big.ts            +12 −4 ↩│  ← ▣ = 半暂存
│ ☐ ?  new note.md             +7   ↩│
│ ☐ D  docs/old.md             −31  ↩│
│ ☐ R  moved.txt                    ↩│
│ ┌────────────────────────────┐ ˅ │  ← ˅ 展开 Description
│ │ Summary（必填）             │   │
│ └────────────────────────────┘   │
│ [   Commit   ] [ Commit and Push ]│
└──────────────────────────────────┘
```

- **勾选**：点一下写进索引，再点一下撤出。半选状态点一下会整体勾上，再点整体撤出。
- **双击文件行** → 右栏开 diff 标签页；再双击别的文件，**复用同一个标签页**。
- **舍弃**（行尾 ↩ 或「全部舍弃」）→ 弹确认框：

  ```
  舍弃「a.txt」的更改？
   · a.txt
   ☐ 彻底删除（不存入回收站）
     这次的 diff 会存进插件的回收站，之后还能回看是改了什么。
  [ 取消 ]  [ 舍弃 ]
  ```

  **默认不勾「彻底删除」**：这次改动的 diff 会存进回收站。勾上就什么都不留。这个勾选框会记住你上一次的选择。
- **回收站**（🗄）：按时间列出记录，每条显示「多久之前 · 单个文件/全部更改 · 文件数 · +n −n · 基于 `abc1234 初始提交`」。
  点一条看 diff，行尾的 🗑 删掉它，右上「清空回收站」一次清掉（只清当前仓库，勾上「显示全部仓库」就清全部）。
- **换绑**（⑂）：解除当前绑定。工作区是仓库会重新自动绑定；不是的话回到选择界面。

### 舍弃到底做了什么

顺序是固定的，不能换：

1. 按当前改动生成 diff（已跟踪的文件走 `git diff HEAD`；**未跟踪的新文件由插件自己合成一份 new-file diff**，
   因为 `git diff HEAD` 看不见它们，而舍弃未跟踪文件就是删掉它——不先合成，回收站里就只剩一条「删了一个文件」的空记录）。
2. 存进回收站（除非勾了「彻底删除」）。
3. 已跟踪的 `git restore --source=HEAD --staged --worktree`；未跟踪的直接删文件，并把因此变空的目录一起清掉。

> **冲突中的文件会被拒绝舍弃**，只给一句提示。在合并中途 `git restore` 到 HEAD 有扰动合并状态的风险，不值得为省一句话去冒。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `gitPath` | `""` | 指定 git 可执行文件；空 = 从 `PATH` 找 |
| `stateDir` | `""` | 插件状态目录；空 = `<DSH_HOME>/dsh-gitbar-lite` |
| `timeoutMs` | `30000` | 单条 git 命令超时。推到慢远端可以调大 |
| `maxDiffBytes` | `524288` | 一份归档 diff 的上限；超出按**行**截断并记下丢了多少行 |
| `maxFileBytes` | `2097152` | 比这大的未跟踪文件只列出来，不读内容、不归档、不出 diff |
| `trashLimit` | `200` | 回收站保留多少条；超出丢弃最旧的连同它的 diff 文件 |
| `scanDepth` | `3` | 「不是仓库时」扫描工作区找仓库的目录深度 |

每个字段都是 volatile 的，所以在设置页改了立刻生效、不用重启。

**状态存在哪**：`<DSH_HOME>/dsh-gitbar-lite/`（没有 `DSH_HOME` 就回落 `~/.dsh`）——
`bindings.json`（工作区 → 仓库）、`prefs.json`（那两个勾选偏好）、`trash/index.json` + `trash/<id>.diff`。
都是先写临时文件再 rename，所以写到一半崩了也不会把文件截断。

## 工作原理

```
lib/shared.js          线协议字面量（浏览器半边手抄一份，自检脚本负责比对）
lib/index.js           插件入口：Config、apply、把路由挂到 connection.fetch
lib/host/git.js        git 执行层：走 ctx.subprocess，解析可执行文件、限流输出、清洗环境
lib/host/parse.js      porcelain v2 / numstat 解析（纯函数）
lib/host/diff.js       diff 合成、按行截断、按文件切分（纯函数）
lib/host/repo.js       仓库操作：status / stage / commit / push / fetch / fileDiff / discard
lib/host/store.js      绑定、偏好、回收站（原子写 + 按文件串行化）
lib/host/workspace.js  会话 → 工作区目录
lib/host/routes.js     单条 /api 路由 + action 分发 + 错误码映射
lib/client.js          浏览器半边：三个 tab 类型 + 面板/回收站/diff，手写、无构建
```

几个值得写下来的决定：

- **一条 `/api` 路由 + `action` 字段**，不是一条路由一个操作。`connection.fetch` 按精确 pathname 匹配，
  而每次调用本来就要带 `sessionId`；分开写只会把十五个路径字面量摊到两种语言里。
- **必须挂在 `connection.fetch` 上，绝不挂 `webServer` 的 exact 路由**：web server 会先匹配 exact 路由，
  而同路径的 exact 路由会遮蔽 `/api` 前缀路由——Host/Origin fence、浏览器 cookie 校验、operator 身份**全在那条前缀路由上**。
  用 exact 就等于开了一个不需要鉴权的 git 接口。测试与自检脚本都专门盯这一条，并且**反过来验证这条断言是有牙齿的**。
- **diff tab 用 `dsh-resource://` 固定地址**，不是 page kind。重新打开同一个资源地址会让宿主**聚焦已开的那个 tab**，
  并把新的 `params` 导航进去；page kind 只在当前 dock pane 内复用，被浮动出去就会多开一个。固定地址本身就是「永远只占一个」。
- **不发 `-m`，用 `-F -` 把提交信息从 stdin 送进去**：Summary 里有引号、有换行、以 `-` 开头，都只是文本，不是参数。
- **`:(literal)` pathspec**：否则舍弃一个叫 `docs` 的文件会顺带动 `docs/` 里的所有东西，`a[1].txt` 会被当成通配。
- **不 import `@deepseek-ai/dsh-client-ui-primitives`**：浏览器半边只 `require('react')`。
  一个会抛错的 import 会把整个 slot entry 变成空白，而官方插件开发清单也要求客户端半边不导入 Harness Client 包。
  需要的那几个控件手写，颜色全部走 `--dsw-alias-*` token；图标是**逐 path 抄宿主 `IconBranchOutlineRegular`
  等 artwork**，所以它和旁边的宿主图标是一套东西。

更多细节（线协议全表、状态文件格式、为什么这么排序、哪些没验证）在 [`docs/CONTRACT.md`](./docs/CONTRACT.md)。

## 验证

```sh
npm test          # 单测 + 真 git 的 e2e + 产物自检
npm run test:e2e  # 只跑真 git 的 e2e（19 个小节，各自造自己的夹具，230 项断言）
npm run check     # 只用产物自检（不启 DSH 也能发现会让 DSH 起不来的问题）
npm run test:live # 探测一个正在运行的 DSH（不在 npm test 里，需要跑着应用）
```

| 套件 | 覆盖什么 |
|---|---|
| `test/parse.test.mjs` | porcelain v2 与 numstat 解析，含重命名、暂存删除、冲突、非 ASCII 路径、带空格的路径 |
| `test/diff.test.mjs` | diff 合成（含无尾换行、二进制、CRLF）、按行截断不切断多字节字符、按文件切分 |
| `test/store.test.mjs` | 绑定键归一、绑定/偏好/回收站往返、坏文件容错、并发写不丢更新 |
| `test/index.test.mjs` | Config 字段与默认值、**路由载体与「只注册一次」**、错误码映射 |
| `test/client.test.mjs` | 按 manifest 的确切路径加载真实 bundle；三个 tab 类型的 id/kind/guide/keepMounted；每个 slot key 都是注册过的 id；字典与错误码齐全；无 hook 的三个组件按渲染树断言 |
| `test/e2e.mjs` | 真实 git、真实 handler、真实路由层：勾选真的写索引（之后读 `git status` 回来比对）、提交、push 到本地裸远端、推送被拒、舍弃单文件/全部/重命名/暂存删除、冲突拒绝、回收站增删清空、按仓库过滤、扫描深度 |
| `test/check.mjs` | manifest 指向的文件都存在且进得了 tarball、patch 层只有一行且没有密钥、两份线协议字面量一致、字典与 `locale/*.json` 一致、每个 `t('字面量')` 都能查到、README/workflow 的存在性与内容 |
| `scripts/check-client-bundle.mjs` | 复刻 client-modules 的判定：`exports["./client"]` 指向的文件是否真的存在 |

**没有真浏览器 harness**，这是有意的：本插件不做任何 DOM 量测、不增强宿主 DOM、没有 portal 到 `document.body` 的东西，
而那套夹具的忠实性本身就是负担（同家族的插件曾因为夹具抄错一条 CSS 规则，把 bug 固化成绿色）。
`test/client.test.mjs` 里无 hook 的三个组件是按**渲染树**断言的，覆盖了勾选状态、确认框默认值、候选人列表这些真正的 UI 规则。
如果以后 UI 长出依赖 `:hover` 或需要量测的东西，这里就该重新考虑——那条判断写进了 `docs/CONTRACT.md`。

## 已知限制

- 一个工作区绑一个仓库，一个仓库一次推一个远端（有 `origin` 就优先它）。不做子模块、worktree、分支切换、历史列表、stash。
- Fetch 用的是 `git fetch --prune`，会删掉远端已经删除的分支对应的 remote-tracking ref（和 GitHub Desktop 一致）。
- 提交会跑你自己的 commit hook。卡住的 hook 是你自己的 hook；`timeoutMs` 是唯一的兜底。
- 回收站存的是 **diff，不是文件**。恢复要自己手工 apply 那份 diff——「恢复按钮」是我们说好不做的。
- 二进制文件不归档内容，只记一句 `Binary files … differ`。这很诚实，但那不是备份。
- 超过 `maxFileBytes` 的未跟踪文件被舍弃时，归档里只有一段说明。确认框目前不会特别提示这一点。
- 「舍弃未跟踪文件」是直接删除（不进系统回收站）——这是说好的设计：插件自己的回收站承接它，不勾「彻底删除」时能看到内容。

## 发布（维护者）

版本号就是发布按钮：

1. 改 `package.json` 的 `version`。
2. 推到 `main`。

`.github/workflows/publish.yml` 会跑 `npm test`，然后 `npm view <name>@<version>`——**该版本已经在线就静默跳过**（绿色的 no-op，并提示你 bump）。所以漏改版本号不会静默重发，也不会变成一次红色失败。

认证是 npm 的 **Trusted Publishing（OIDC）**：没有任何 token secret，`id-token: write` 就是全部凭据。

<details>
<summary>一次性配置：在 npmjs.com 上绑定 Trusted Publisher</summary>

包的页面 → Settings → Trusted Publisher，填：

| 字段 | 值 |
|---|---|
| Publisher | GitHub Actions |
| Repository | `Ckarefulon/dsh-gitbar-lite` |
| Workflow filename | `publish.yml` |
| Environment | （留空） |

**首次发布必须手工 `npm publish`**——Trusted Publisher 只能绑到一个已经存在于 registry 上的包名。

工作流刻意**不用** `actions/setup-node` 的 `registry-url`：它会往 `~/.npmrc` 写
`_authToken=${NODE_AUTH_TOKEN}`，而这个字面占位符会被当成凭据发出去。registry 由 `publishConfig` 提供。

另外它会先把 npm 升到 `^11.5.1`：Trusted Publishing 是 npm CLI 的能力，Node 22 自带的 npm 10 不支持 OIDC 交换，
在 npm 10 上会以 `ENEEDAUTH` 失败——那看起来像缺 token，其实是 npm 太旧。

</details>

## 许可

MIT，见 [LICENSE](./LICENSE)。

「GitHub Desktop」是 GitHub, Inc. 的产品名称；本插件不是 GitHub 的产品，也与 GitHub 无关，只是借用了那种布局。
