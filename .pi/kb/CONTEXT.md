# htui — Project Context

## What
httpyac 之上的终端 API 客户端（Ink TUI + headless CLI）。`.http` 文件是唯一真源，htui 只做「运行器 + 观察器」，不是编辑器、不持数据库。

## Entry
```bash
npm run dev -- examples/demo.http   # TUI（扫描 cwd + 导入的集合）
npm run check                       # 10 个纯逻辑 selfcheck（无需网络）
npm run e2e                         # import + chain 端到端（需全局 httpyac）
npm run typecheck && npm run build  # -> dist/cli.js
# 依赖全局 httpyac：npm i -g httpyac
```

## Key Files
| File | Purpose |
|---|---|
| `src/cli.tsx` | TUI 状态机 + argv 分发 + 命令接线 |
| `src/parse.ts` | `.http` region 解析（start/end 行；名字 = `# @name` > `### 标题`） |
| `src/run.ts` | 单发执行 + 请求选择（TUI 与 CLI 共用） |
| `src/chain.ts` | run-chain：切 `[preamble..目标]` → `send --all` |
| `src/openapi.ts` | 纯生成器：OpenAPI → `.http` + `vars`（**不在文件里写变量**） |
| `src/swagger2.ts` | Swagger 2.0 → OpenAPI 3.0 shim |
| `src/store.ts` | 集合目录布局 + env merge（write-once）+ index |
| `src/import-openapi.ts` | 导入 I/O（写 http + merge env） |
| `src/commands.ts` | `htui import/list/remove/send/help/version` |
| `src/result.ts` `src/share.ts` `src/editor.ts` `src/rows.ts` | 结果判定 / 复制·curl / `$EDITOR` / 过滤·分组·视窗 |
| `docs/design-ux.md` | UX 设计 v2（含已实现状态与待办） |

## Hard-won facts（实测 httpyac 6.16.7）
- **变量优先级：文件内 `@var` > env 文件 > CLI `--var`** → 生成文件里写死变量 = 锁死环境。
- **env 必须显式 `-e <name>`**（无自动 default）；**未知 env 无害**（不报错，file `@var` 仍优先）。
- **region 身份 = `# @name`（有则优先）否则 `### 标题`**；`--name` 匹配此名；**匹配不上会弹交互提示（=挂起）**。匿名 `###` 只能用 `--line`。
- **跨请求状态只在单次调用内**：cookie 在 `--all` 同轮流转，但**不跨调用持久化**（cookieJar 内存态，无 CLI 选项）→ run-chain 只能「切片 + 同一次 `--all`」。
- **响应取值靠 `# @name x` → `{{x}}` / `{{xResponse}}`**（`### 标题` 不产生变量）。
- `response.request` = 已解析的最终请求 `{url, method, headers, body}`（`Y`/curl 用）。
- 文件路径**必须在 httpyac 的 cwd 内**（否则 globby 报错）→ 传相对路径，或 `cwd=dirname(file)` + basename。
- `testResults[].status` 是**字符串** `SUCCESS | ERROR | SKIPPED`（不是布尔）。

## 架构定案
- **零运行时依赖**（唯一外部依赖是全局 `httpyac`）。
- **生成物 ≠ 手工物**：`collections/<name>/{<name>.http（可重导）, http-client.env.json（write-once）, <name>.local.http（永不覆盖）}`。
- 编辑器交接用 Ink 官方 **`suspendTerminal()`**（非手工 raw-mode）。
- 键位语法：**可打印字符 = 过滤输入**；动作走修饰键（`Ctrl-F/O/E/R`）+ `?`（过滤为空时）。Result 页无过滤框，故明文 `r/e/v/t/y/Y/w/h`。
- 身份用 **region 名**（行号会因编辑失效）。
- 失败判定：`hasResponse`（有 statusCode）+ `testResults` 三值。

## Top pitfalls
- 生成文件里写 `@var` → env 永远失效（写死不写活）。
- `--name` 传不存在的名字 → httpyac **弹交互提示挂死**（用解析后的名或 `--line`）。
- 空 `@var = ` → httpyac 视作未定义（`X is not defined`）；server url 相对/缺失要有**绝对占位 fallback**。
- run-chain 用 `--all` → 输出是 N 个请求，**目标 = 切片最后一个**，别取 `requests[0]`。
- 切片临时文件放**源目录 + 点号前缀**（否则被当成 collection，或破坏 env/config 解析）。
- OSC52 大 payload 会被终端截断 → 已设上限并提示改用 `w`。

## Dependencies
| Dep | How |
|---|---|
| `httpyac`（全局） | 执行引擎：`send` / `--line` / `--name` / `--all` / `-e` / `--json` / `--bail` |
| `ink@8` + `react@19` + `@inkjs/ui` | TUI（含官方 `suspendTerminal`） |

## 待办
见 `docs/design-ux.md` §12（取消在途发送、body 搜索、缺 httpyac 检测、旧布局迁移提示、`c` 建 case、可选全屏）。
