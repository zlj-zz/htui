# htui 使用逻辑 / 交互 / 展示 设计方案 v2

状态：**待批准**（v1 已经 `reviewer` 评审，verdict `approve-with-changes`，本版已并入全部 Critical/Warning，并把「待核实」按已装源码定论）。

---

## 0. 事实基线（已验证 / 已从源码核对）

| 事实 | 结论 | 来源 |
|---|---|---|
| 变量优先级 | **文件内 `@var` > env 文件 > CLI `--var`** | 实测 |
| 全局脚本 | preamble 的 `{{ exports.x = ... }}` 在 **`--line` 单发时也执行** | 实测（`x-tok: FROM_GLOBAL` 送达） |
| cookie | 单次 `send` **内**流转；**不跨调用持久化**（cookieJar 内存态，无 CLI 选项） | 实测 + 源码 `cookieJarEnabled` |
| 响应取值 | 需 **`# @name x` 元数据** → 之后 `{{x}}` / `{{xResponse}}`（名会 camelCase） | 源码 `handleMetaDataName` |
| `$shared` | **存在**（多环境共享变量） | 源码 |
| region 选择 | `-n/--name` 存在；anonymous `###` 无 name → 只能用 `--line` | `send --help` |
| `--all` 结果 | JSON 里是 **N 个请求**，**必须按名选**，不能取 `requests[0]` | 代码 `cli.tsx:57` + 实测 |

> 三条「待核实」到此关闭，**都不是阻塞项**：响应取值有语法、`$shared` 有、cookieJar 无持久化（→ 反而强化下面的 run-chain）。

---

## 1. 设计原则

1. **文件即真理**，htui 是「运行器 + 观察器」——不是编辑器、不持数据库、不做平台。
2. **生成物 ≠ 手工物** —— 生成物可随时重建；**手工物永不被覆盖（含重导）**。
3. **身份用「名字」优先，行号兜底** —— 行号会因编辑失效，`(file, line)` 不可作为长期身份（见 §2.5）。
4. **键位有语法 + 显式模式** —— 移动/主操作/返回/修饰键各一族；进入输入模式必须可见、可退出。
5. **永不无路可走** —— 每屏可返回，每个错误可行动，每个空态有出路。
6. **人机同源** —— TUI 与 CLI 是同一套能力的两个前端；**run-chain 必须有 CLI 版**（J14）。

---

## 2. 领域模型

| 概念 | 定义 |
|---|---|
| **Workspace** | 项目目录（cwd） + 集合目录（`~/.config/htui/collections`） |
| **Source** | `project` \| `collection`；集合内再分 `generated` \| `local` |
| **File** | 一个 `.http` / `.rest` |
| **Region / Request** | 文件里的一段。**主身份 = region 名**（`### 标题` / `# @name`）；anonymous 块退化为 `--line` |
| **Variable** | `name → value`，优先级见 §0 |
| **Environment** | 命名变量集（`default`/`dev`/`prod`），`-e` 选中 |
| **Case** | 同一接口的手写变体（在 `.local.http`） |
| **Run / Chain** | 一次发送 \| 「前置 + 目标」按序发送（§2.4） |

> 推论 A：**文件内变量优先级最高** → 生成文件写死 `@var` 会锁死 env → 变量必须移出生成文件（§6）。
> 推论 B：**`# @name` 是响应取值与稳定身份的关键** → 解析器必须读它（`parse.ts` 要改）。

---

## 3. 使用逻辑（完整性）

### 3.1 状态机

```
                     Ctrl-O
                      ┌──▶ Import ──(done)──┐
                      │                     ▼
  Files ──Enter──▶ Requests ──Enter──▶ Sending ──▶ Result
    ▲  │              ▲  │                 │          │  │
    │  └──── Esc ─────┘  └────── b ────────┘          │  │
    │                      │                          │  │
    └── Ctrl-F ─▶ Search ──Enter───────────────────────┘  │
                                                           │
  overlay（叠在底屏上，非替换）：? help   Ctrl-E env   Ctrl-R run-chain
  Result 内：r rerun  t history  e edit  y/Y copy  / search  b back  q quit
```

> overlay 必须**叠在底屏之上**且**同一时刻只有一个活动输入处理器**。现状是 `if/return` 替换整屏（`cli.tsx:226`）→ 取消 import 会**丢失过滤/光标**。这是要改的结构。

### 3.2 必须闭合的旅程

| # | 旅程 | 现状 | 方案 |
|---|---|---|---|
| J1 | 探索项目有什么 | ✅ 粗 | 文件行显示 **请求数 + source 标记** |
| J2 | 快速调一个接口 | ⚠️ 见 J15 bug | `htui file.http` 直达；`r` 重发 |
| J3 | 不知道在哪个文件 | ✅ Ctrl-F | 命中高亮 + 最近优先 |
| J4 | 导入 spec 并首调 | ⚠️ 变量是坑 | 导入即产 env（§6） |
| J5 | 改请求（变量/结构） | ❌ | `e`→`$EDITOR`；`v`→变量文件 |
| J6 | 切环境 dev/prod | ❌ | `Ctrl-E` + 状态栏 |
| J7 | 多 case | ❌ | `c`→写 `.local.http`→`$EDITOR` |
| J8 | 复制/分享 | ❌ | `y`（OSC52，有上限）、`Y`（curl）、`w`（存文件） |
| J9 | agent 自动化 | ⚠️ **只读类命令** | **新增 `htui send`**（J14） |
| J10 | 出错能自救 | ❌ 展示误导 | 错误分类 + 行动（§7） |
| J11 | spec 更新后重导 | ⚠️ 会覆盖手改 | 生成物可覆盖 / **env 与 local 永不覆盖**（§6） |
| J12 | 会话内复用历史 | ❌ | `t` history，Enter 重发 |
| J13 | **依赖前置请求的接口** | ❌ 单发拿不到 | `Ctrl-R` run-chain（§2.4） |
| J14 | **agent 跑带前置的请求** | ❌ 无 CLI | **`htui send <file> -n <name> [--chain] --json`** |
| J15 | **取消在途请求** | ❌ | Sending 时 `Esc` → kill 子进程 → 回列表 |

### 3.3 主循环
```
Requests ─e→ $EDITOR 改 ─(返回)→ 自动重读该文件 → Enter 重发
```

### 3.4 执行模型与前置依赖（v2）

**诊断（成立）**：`--line` 单发拿不到跨请求状态。

| 前置需求 | 表达 | 单发 |
|---|---|---|
| 静态 header/cookie | 请求内 / `@var` / env | ✅ |
| 全局脚本注入 | preamble `{{ exports.x=... }}` | ✅ |
| **前置请求产出**（token / 会话 cookie） | 跨 region | ❌ |

**处方（重写）**：**Run-chain** = 切 `[preamble .. 目标 region 结束]` → 临时文件 → `send <tmp> --all` → **按目标 region 名从 `requests[]` 里选结果**。

硬性要求（reviewer 提出，全部采纳）：
1. **结果按名选**，不是 `requests[0]`（`cli.tsx:57` 必须改）。anonymous 目标 → 按 line 匹配。
2. **切片要 region 的「结束行」**：`[region 起始 .. 下一 `###` 之前]`，且不能把 body 里的 `###` 当分隔符 → **`parse.ts` 必须产出 region 的 start/end 与 `# @name`**（影响面里不能再写"不动 parse.ts"）。
3. **前置副作用**：`Ctrl-R` 会重跑前面所有请求。必须（a）执行前提示「将执行 N 个前置请求，（b）`--bail` 显式开启让 login 失败即停，（c）§7 增加「链中第 k 步失败」的渲染。
4. **临时文件放源文件同目录 + 点号前缀**（如 `.<name>.chain.<uuid>.tmp.http`）：cwd 会破坏 httpyac 的 env/config 解析；非点号会被 `listFiles` 当成集合列出（`workspace.ts:20` 跳过点号项）。
5. **默认语义**：目标**不是第一个 region** 时，`Enter` **默认走 run-chain**；`Ctrl-R` 为显式强制；首个 region 直接单发。**不搞两套并行流程**。

**其它已定论**：
- 用 `# @name x` + `{{x}}` / `{{xResponse}}` 就能引用前置响应 —— 但**仍需同一次调用内**，所以 run-chain 依然必要。
- **cookieJar 无持久化** → 「登录一次、后续单发」不可得（D8 = 否）；这也意味着**必须** run-chain，或把会话值写进 env。

---

## 4. 信息架构与屏幕

### 4.1 真实约束：inline
htui 是 **inline（非 alt-screen）**。因此：
- **「常驻底部状态栏」不成立**（那是 alt-screen 的形态）。
- 状态信息改为「**页脚 + 面包屑**」承载：面包屑常显上下文，页脚常显 `env · 计数 · 关键键`。
- 若未来要真状态栏 → 那是 S6（全屏模式）的一部分，不是本体。

### 4.2 统一画面骨架

```
面包屑：htui · <上下文> · [source/generated 标记]          env:dev
输入行：filter: ▏                                 匹配/总数 · ↑↓
内容区
──────────────────────────────────────────────────────────────
页脚：计数 · 本屏可用键（上下文相关）
```

### 4.3 Files

```
htui · /Users/haha/haha-projects/crm                      env:dev
❯ filter files…                                   12/12 · ↑↓
  project/api/
    users.http                                    8 reqs
    orders.http                                   3 reqs
  ~ imported/crm/
    crm-api.http              ⟳ generated  204 reqs   ⚠ no env
    crm-api.local.http        ✎ local        4 reqs
──────────────────────────────────────────────────────────────
12 files · 215 requests     ? help · Ctrl-F search · Ctrl-O import
```
- 标记 `⟳ generated` / `✎ local` / `⚠ no env` → **`ScannedFile` 需增加 `kind` 字段**（`workspace.ts:38`）。

### 4.4 Requests

```
htui · ~/crm/crm-api.http  ⟳ generated                    env:dev
❯ filter requests…                                204/204
  POST /v1/account/create            · accountAccountCreate
❯ GET  /v1/account/{{id}}            · accountAccountGet       200 ✓
──────────────────────────────────────────────────────────────
204 requests   Enter send/run · Ctrl-R chain · e edit · c case · Esc
```
- 徽标按 region 名索引（不是行号）。

### 4.5 Search（跨文件）

保持；补命中高亮、最近优先。

### 4.6 Result

```
htui · POST {{baseUrl}}/v1/account/create  ~/crm/crm-api.http   env:dev
200 OK · 128ms · 1.2 KB · application/json                  ▸ headers(8)
──────────────────────────────────────────────────────────────
  1  { "code": 0, "data": { "id": 1024 } }
──────────────────────────────────────────────────────────────
r rerun · t history · e edit · y copy · / search · b back · q quit
```
- 长响应只渲染可视窗口；`f` 折叠、`w` 换行开关、`/` 在 body 内搜索（**进入输入模式**，见 §5）。
- **无响应**：直接错误块（§7），不再显示 `?`。

### 4.7 Env 选择器（Ctrl-E）
列当前文件目录可见的 env（httpyac 从文件目录向上找）；`Enter` 选中 → 会话状态 + 页脚常显；`v` 编辑 env 文件。

### 4.8 Import（Ctrl-O）
spec 选择器（复用 `SearchableList` 列 `*.json/*.yaml`）→ 命名 → 覆盖确认；**成功后产出 env（write-once）**；Files 高亮新集合。
> overlay 化：叠在底屏上，取消后**保留过滤/光标**。

### 4.9 Help（?）
分组键位表。

---

## 5. 键位语法（含模式）

**规则**：**普通模式**下可打印字符 = 过滤；**输入模式**（filter / body 搜索 / 表单）由显式状态持有，`Esc` 退出。

| 键 | 归属 | 动作 |
|---|---|---|
| `↑` `↓` `PgUp/PgDn` | 列表 | 移动 |
| `Enter` | 列表 | 主操作：open / send（**非首 region 时默认 run-chain**） |
| `Esc` | 全局 | 输入模式→退出；否则返回 |
| `Ctrl-F` | 全局 | 跨文件搜索 |
| `Ctrl-O` | 全局 | 导入 |
| `Ctrl-E` | 全局 | 环境选择器 |
| `Ctrl-R` | Requests | 强制 run-chain |
| `?` | 全局 | 帮助 |
| `e` / `v` | Requests/Result | `$EDITOR` 打开请求 / 变量文件 |
| `c` | Requests | 建 case |
| `r` / `t` | Result | 重发 / 历史 |
| `y` / `Y` / `w` | Result | 复制体 / curl / 存文件 |
| `h` | Result | headers 折叠 |
| `/` | Result | **进入** body 搜索模式 |
| `q` | 全局 | 退出 |

**必须改 `SearchableList`**：它写死 `ctrl-f`/`ctrl-o` 并 `if (key.ctrl || key.meta) return`（`ui/SearchableList.tsx:90-98`）→ Ctrl-E/Ctrl-R/Ctrl-T 在它挂载时**无法存在**。方案：把保留键交给上层（props 回调 / `isActive` 网关），本组件只负责"可打印字符进过滤"。

**模式定义**：`filter`（列表过滤）、`search-body`（Result 内）、`form`（Import）。三者互斥，任一时刻只有 `SearchableList` 或 `TextInput` 或 body 搜索挂载。

---

## 6. 编辑 / 持久化模型

### 6.1 证据
见 §0（file `@var` > env > `--var`）。→ 生成文件写死变量 = 锁死环境。

### 6.2 三层文件布局（每集合一目录）

```
~/.config/htui/collections/crm/
├── crm-api.http            # 生成物：纯请求结构，无 @变量   ⟳ 可随时重导（唯一可覆盖物）
├── http-client.env.json    # 手工物：变量值 + 多环境          ← write-once + merge
└── crm-api.local.http      # 手工物：你改的请求 / 多 case     ← 永不覆盖
```

### 6.3 重导语义（**修 §6 的自相矛盾**）
- **只有 `crm-api.http` 可被 `import --force` 覆盖。**
- `http-client.env.json`：**write-once**；重导时只**合并新 key**（不覆盖已有值；缺 key 补占位），并在 stdout 报告「合并了 N 个变量」。
- `crm-api.local.http`：**永不触碰**。
- `index.json` 记录生成物 hash / 端点计数，供重导对账。

### 6.4 导入产物
1. `<name>/<name>.http`（结构）
2. `<name>/http-client.env.json`（`default` env，缺则创建；存在则 merge）
- **必须始终传 `-e`**（默认 `default`）：变量移到 env 后，"开箱即跑"依赖显式 env。`cli.tsx:39` 现在只读一次 `process.env.HTUI_ENV` → 需要真正的会话状态。

### 6.5 case 流程（`c`）
选中 → 命名 → 追加到 `<name>.local.http` → `$EDITOR` 打开。
> **列表可见性**：`.local.http` 是同一目录的另一文件，Files 层级能看到；要让它**在 Requests 里与生成物并列**，需在 Requests 屏支持「同目录多文件」聚合，或 `c` 后跳转到 `.local.http`。§4.4 要补这条。

### 6.6 编辑器交接 + 身份稳定性
- `e`/`v`/`c`：禁用 raw mode → 显示光标 → 卸载 → `spawn($EDITOR, ...)`（`stdio:'inherit'`）→ 返回后重渲染 + 重读文件。
- `$EDITOR +<line>` **不通用**（`code` 需 `--goto`；`$EDITOR` 可能带参数）→ 需要小映射表 + 尊重 `$VISUAL`。
- **身份**：编辑后 `line` 失效 → **徽标 / `r` 重发 / run-chain 目标都用 region 名**；anonymous 块才退回 line。

### 6.7 迁移
扁平 `collections/<name>.http` → 目录化。检测旧布局 → 提示迁移。**迁移不能等到 S5（S2 就会破坏布局）。**

---

## 7. 反馈与错误

### 7.1 错误分类
| 类型 | 触发 | 展示 | 动作 |
|---|---|---|---|
| 配置/变量 | `x is not defined`、空 `@var` | 红块 + 原文 | `v` / `Ctrl-E` |
| **缺前置** | 报 `X is not defined`/无响应，且文件前面有 region | 红块 + 提示 | **`Ctrl-R` chain** |
| **链中某步失败** | run-chain 里第 k 个 region 出错 | 逐步结果列表，标出失败步 | 修该步 / `e` |
| 连接 | ECONNREFUSED / TLS / DNS / 超时 | 红块 + host:port | `r` / `e` |
| HTTP 4xx/5xx | 有响应 | 正常结果页，红状态码 | `r` / `e` |
| 断言失败 | `testResults` | 三值渲染（见 7.2） | `e` |
| 解析 | `.http` 语法错 | 文件:行 | `e` |
| **executor 不可用** | `spawn httpyac` ENOENT | 安装提示 | 安装 |
| **输出不可解析/超限** | `--all` 超 32MB、stdout 截断 → `JSON.parse` 抛裸 `SyntaxError` | 明确报「输出超限/截断」 | 缩小请求 / 加 `--filter` |
| 导入 | 非 spec / 0 端点 | 表单内联错误 | 改路径（不丢输入） |

### 7.2 必修渲染 bug
- `testResults[].status` 是 **3 值**（`SUCCESS|ERROR|SKIPPED`）→ 现有真值判断把错误显示成 `✓`；`=== 'SUCCESS'` 又会让 `SKIPPED` 变 `✗`。需三分支。
- `requests[].error` / `testResults[].error` **从未读取** → 无响应时错误信息只能靠 message，需补。
- `HttpyacRequestResult` 类型随之修正。

### 7.3 其它
- **取消**：Sending 时 `Esc` → kill → 回列表。
- **重扫**：`R`；后续 watch。
- **空态**：三类各一行出路。

---

## 8. 边界与可访问性

- 非 TTY：TUI 报错退出；`import/list/remove/send` headless。
- 缺 httpyac：启动检测（与 §7 的 ENOENT 区分）。
- Unicode：路径 NFC 归一（已有）。
- **NO_COLOR**：现在只给 httpyac 传 `--no-color`，htui **自身**未遵循 → 需支持。
- OSC52：大 payload 会被终端截断、`tmux`/ssh 需 passthrough → **限长 + 失败提示 + 指向 `w`**。
- 小终端 / 宽字符 / 大集合：见 §4。

---

## 9. 分期路线

| 期 | 内容 | 价值 | 成本 |
|---|---|---|---|
| **S1** | **仅两个渲染 bug**：`testResults.status` 三值判定；无响应 → 错误块（读 `error` 字段） | 高 | 低 |
| **S2.5** | **前置依赖**：`parse.ts` 出 region start/end/`@name`；`Enter` 非首 region 默认 chain；`Ctrl-R`；结果按名选；临时文件点号前缀；前置提示 + 逐失败渲染 | **高（补执行模型）** | 中 |
| **S2** | 变量移出生成文件（write-once env）+ 目录化 + `Ctrl-E` + **始终 `-e`** | 高（解核心矛盾） | 中 |
| **S3** | `e`/`v`（编辑器交接 + 名字身份）、`c` case、历史 `t` | 中高 | 中 |
| **S4** | `y`/`Y`/`w`、body 搜索模式、headers 折叠、取消 | 中 | 中 |
| **S5** | `?` 帮助、空态、ENOENT、NO_COLOR、迁移收尾 | 中 | 低 |
| **S6** | （可选）全屏三栏 + 真状态栏 | 低 | 高 |

> 顺序依据：**S1 只修 bug**（避免过早教用户手改生成文件）；**S2.5 先于 S2**（修功能缺口，且不依赖 S2）；`e` 放 S3（要等 §6 的目录化落地后才有安全的可编辑对象）。

---

## 10. 待决策

| # | 决策 | 建议 |
|---|---|---|
| A | S1 范围 | **只做两个渲染 bug**（`e` 挪到 S3） |
| B | 默认执行语义 | **非首 region 默认 run-chain**，`Ctrl-R` 强制；不做两套并行流程 |
| C | headless 契约 | **立刻定**：`htui send <file> -n <name> [--chain] [--json]` + 退出码 0/1 |
| D | 切片临时位置 | **源文件同目录 + 点号前缀**（依赖 `parse.ts` 提供 region 结束行） |
| E | cookieJar | **关**（内存态，不可持久化） |
| D1 | 生成文件彻底不写变量 | **是** |
| D2 | 集合目录化 | **是** |
| D3 | 变量源只用 env | **是**（"参数回退内联"不是 fallback，是**重返 file>env**，不做） |
| D4 | `$shared` | **确认存在**，可用于跨 env 共享 |
| D5 | 编辑只走 `$EDITOR` | **是**；`$EDITOR` 参数差异化处理 |
| D6 | 保持 inline | **是**（"常驻底栏"随 S6 全屏一起做） |
| D7 | ~~切片 vs 全局脚本二选一~~ | **收拢**：默认切片；全局脚本作为文档化逃生口 |
| D8 | cookieJar 跨调用 | **否**（已从源码定论） |

---

## 11. 影响面（完整）

- **改**：`src/cli.tsx`（模式/overlay/名字选择/chain/取消/页脚）、`src/parse.ts`（region start/end + `# @name`）、`src/workspace.ts`（`ScannedFile.kind`、目录化）、`src/store.ts`（目录化 + env write-once/merge + index）、`src/openapi.ts`（不写变量）、`src/import-openapi.ts`（产/merge env）、`src/commands.ts`（新增 `send`；`--base-url` 语义写 env）、`src/ui/SearchableList.tsx`（保留键上移）
- **改（测试，reviewer 点名）**：`src/openapi.selfcheck.ts`（`:45` `@baseUrl`、`:66-69` 变量声明断言，均随 §6 失效）、`src/import.e2e.ts`（`:75,:114` 无 env 的 `--line` 发送）
- **新**：`src/ui/EnvPicker.tsx`、`src/ui/Help.tsx`、`src/editor.ts`、`src/chain.ts`（切片 + 结果按名选）

---

## 12. 本轮 review 未覆盖 / 仍待定

- `--name` 匹配的是 `### 标题` 还是仅 `# @name` → 落地前用一条最小实验敲定（决定 §2.4 结果选择与 §6.6 身份）。
- `.local.http` 与生成物**在 Requests 屏并列**的具体形态（聚合视图 vs 跳转）。
- `htui send` 的输出契约细节（human vs `--json`、`--chain` 的前置输出是否折叠）。
