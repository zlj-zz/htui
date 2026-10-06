# Plan v2: OpenAPI / Swagger 导入（htui）

状态：**待用户批准**（v1 已经过 `reviewer` subagent 评审）

## Review 结论

**verdict: approve-with-changes。** 架构判断（转 `.http` 复用现有路径、纯函数/IO/UI 分层）是对的，但两个承重假设被证伪：

1. **"cwd 相对路径"风险的实质不是"能不能发"，而是"config/env 解析会静默改变"。** 已读安装版 httpyac 6.16.7 bundle：`httpyac.config.*` 与 `http-client.env.json` 都是**从 `dirname(httpFile)` 向上**查找。集合放在 `~/.config/htui/collections/` 时，这条链永远看不到项目的 config/env。
2. **"非 TTY guard 已有"是错的** —— `src/cli.tsx:285` 在**模块顶层**，`htui import`（pipe/CI/agent）会在分发前就 exit 1。

其余：`dereference()` 是错误原语；`swagger2openapi` 拖一棵废弃依赖树；零端点 spec 会生成 htui 永远打不开的文件；文件头时间戳与"干净 diff"自相矛盾；若干边界未定。

## Review 必改项（已并入设计）

| # | 问题 | 修法 |
|---|---|---|
| C1 | 集合在 cwd 外 → httpyac 的 config/env 解析链改变 | **生成文件必须自包含**（`@baseUrl`/`@token` 全在文件内，不依赖项目 env）；集合目录即 env 解析根；**必须写一条真实 E2E**（临时 `HTUI_HOME` + mock server + `httpyac send`）；`-e` 的限制写进文档 |
| C2 | `dereference(JSON.parse(...))` 会丢外部 `$ref`；且返回**循环对象**（`JSON.stringify` 会炸） | 用 **`SwaggerParser.resolve()`/`bundle()`**（保留局部 `$ref`），生成器自己带 **cycle 守卫** 的 walker；按**路径**传参，不传对象 |
| C3 | 零端点 spec → 生成的 preamble 无 `###` → `parseRequests` 返回 `[]` → htui 打不开 | 导入时**拒绝 0 端点**（明确报错） |
| C4 | 非 TTY guard 在模块顶层 | 移到**各命令内部**；只有 TUI 才要求 TTY → 新增 **P0** |
| C5 | `list` 要的 `来源/导入时间` 文件里没有 | 引入 **sidecar `collections/index.json`**（name → source/importedAt/endpointCount） |
| C6 | 文件头写 `imported <时间>` → 每次重导都 diff | 时间戳**只进 sidecar**，文件体保持确定性 |
| W1 | `swagger2openapi` 废弃 + 拖 `node-fetch@2`/`yaml@1`/`yargs`；`swagger-parser` 是 CJS 无 `exports` | **删 `swagger2openapi`**：v1 声明 **v2 不支持**（或手写 ~40 行 v2 shim）；只用 `swagger-parser`；**默认导入**（`import SwaggerParser from …`），禁命名导入；`openapi-types` 进 devDeps |
| W2 | 静态 import 会让每次 `htui` 启动都加载 ajv/parser | `import` 命令与 Ctrl-O 里用 **`await import(...)`** |
| W3 | tmp 名会撞/留垃圾；`..` 能过清洗；Windows rename 覆盖会抛 | tmp 用 `<name>.http.<uuid>.tmp` + `finally unlink`；**显式拒绝** `.`/`..`/前导 `-`/Windows 保留名；`mkdir -p`；`list` 容忍目录不存在 |
| W4 | example 里含 `{{foo}}` → 变成 httpyac 变量，body 不再是合法 JSON | 写**转义/已知限制**策略 + 自检断言"所有 `{{x}}` 都在 preamble 声明过" |
| W5 | `servers` 缺失/相对、server 变量无 default、`allOf`/`oneOf`、`security: []` 覆盖全局、多个 scheme 是 OR、`apiKey in cookie`、`+json` 后缀、BOM、YAML 输入、`HOME` 未设、`XDG_CONFIG_HOME` 空串 | 每条落成**一行明确策略**（见下） |
| W6 | `buildWorkspace` 的 `relPath` 会变成 `../../.config/…` 显示垃圾 | 集合的 relPath 以**集合根**为基准；Ctrl-F 索引也要决定是否含集合 |
| W7 | 表单与 `Step` 联合、Ink 多 handler、rescan 无触发、自由文本路径体验最差 | 明确 `Step` 成员；`ImportForm` 分支**排在 `step==='file'` 之前**（列表卸载）；入口写进 `SearchableList` 的 `onImportKey`（**不挂第二个 App 级 useInput**）；加 `refresh` 计数触发重扫；**spec 选择器复用 SearchableList**（列 `*.json/*.yaml`），而非裸文本输入 |

## 待你拍板的决策

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | **集合位置**（Reviewer 倾向放 cwd，但与你要求冲突） | (a) `<cwd>/.htui/collections/`（resolution 完全正确，但非 user 级）<br>(b) `~/.config/htui/collections/`（**你要的 user 级**；靠"文件自包含"绕开 config 问题；`-e` 需把 env 文件放集合目录）<br>(c) 默认 (b) + `--local` 切 (a) | **(c)** —— 尊重你的 user 级要求，同时给出 resolution 正确的退路 |
| D2 | **v2 (Swagger 2.0)** | 支持（手写 ~40 行 shim，零依赖）/ 不支持（`--help` 明说） | **先声明不支持**，真需要再补 shim（别引废弃包） |
| D3 | **`list` 元数据** | sidecar `index.json` / 只显示 name+请求数 | **sidecar**（同时支撑 `remove`、重导对账、C6） |
| D4 | **TUI 选 spec 的方式** | 复用 `SearchableList` 选 `*.json/*.yaml`（可就地过滤）/ 裸文本输入 | **选择器**（复用现有组件，零新 UI 代码） |
| D5 | **YAML spec** | 支持（加 `yaml@2`，零依赖、双模块）/ 只 JSON | 先**只 JSON**，YAML 后续（`--help` 明说） |

## 修订后的设计

### 目录与解析语义（C1/D1）
```
$HTUI_HOME            # 覆盖；默认 $XDG_CONFIG_HOME/htui；兜底 ~/.config/htui
└── collections/
    ├── index.json    # sidecar: 来源/导入时间/端点数
    └── <name>.http   # 自包含：所有变量在文件内
```
- **生成文件自包含**：不依赖项目 `httpyac.config.*` / `http-client.env.json`
- **必须**：一条 E2E —— 临时 `HTUI_HOME` + mock server，`httpyac send <collection> --line N` 断言 method/path
- 已知限制写入文档：`-e <env>` 的 env 文件需置于集合目录（或 `~`）

### CLI（P0 先落地）
```
htui                      → TUI（唯一要求 TTY 的分支）
htui import <spec> [--name N] [--force] [--local] [--base-url URL]
htui list
htui remove <name>
htui --help | --version
```
- 手写 argv 分发（不引 commander）；`--version` 用 `createRequire` 读 `package.json`
- 非 TTY guard 移进 TUI 分支
- `import`/`list`/`remove` headless、stdout/stderr、退出码 0/1

### TUI（D4/W7）
- 入口 `Ctrl-O`（修饰键）→ 经 `SearchableList` 的 `onImportKey` 属性；footer 提示 `[Ctrl-O] import`
- spec 选择：复用 `SearchableList` 列 `*.json/*.yaml`（可就地过滤）
- `Step` 新增 **单一成员 `import`** + 组件内 `phase: 'spec' | 'name' | 'confirm'`
- 成功 → `refresh` 计数 +1 触发重扫 → 回 browse
- `ImportForm` 分支排在 `step === 'file'` **之前**；该步内只有 `TextInput` 一个 handler

### 导入流程
```
读文件(按路径) → 去 BOM → JSON.parse（.yaml/.yml → 明确报 "YAML not supported"）
  → 校验 openapi 字段（swagger 2.0 → "v2 not supported"）
  → SwaggerParser.resolve(specPath)        # 非 dereference；保留局部 $ref
  → 端点计数 == 0 → 拒绝
  → openapiToHttp(spec, opts) → string      # 纯函数
  → 原子写（tmp+uuid → rename，finally 清理）
  → 更新 sidecar index.json
```

### 生成器 `openapiToHttp()`（纯函数）
输出形如：
```
# source: petstore.json · OpenAPI 3.0.3 · 42 endpoints
@baseUrl = https://petstore.example.com/v1
@token = REPLACE_ME
@petId = 1

### listPets
GET {{baseUrl}}/pets
Accept: application/json
Authorization: Bearer {{token}}
```
策略（每条对应一个 W5 边界）：
- baseUrl：`servers[0].url`（展开变量默认值；无 default → `enum[0]` → `{{var}}`）；**相对/缺失 → 占位 + 警告**
- 参数默认值取自 param **schema**（`default` → `enum[0]` → 类型占位），不是一律 `'string'`；path→`{{p}}`；required query→`?p={{p}}`；optional 跳过
- body：`example` → `examples` 首值 → schema 合成（`allOf` 合并 / `oneOf|anyOf` 取首 / array 取一项 / 递归 + **cycle 守卫**）
- content-type：**后缀匹配** `+json`、前缀 `application/json`；显式列出 content key
- security：operation 级 `security` 覆盖全局；`security: []` = 无鉴权；多 scheme 取**第一个**；bearer/oauth2/openIdConnect→`Authorization: Bearer {{token}}`；basic→`{{basicAuth}}`；apiKey(header/query)→对应位置；**cookie 先不做**；**绝不写真实值**
- `### 名`：`operationId`（清洗空格/unicode/`#`/`{{`）否则 `METHOD /path` slug；去重 `-2`
- 排序：path 升序 + method 固定序 → **重导 byte-identical**（自检）
- 时间戳**不进文件**（进 sidecar）
- `deprecated: true`：**跳过**，计入注释
- 不写 `{{` 之外的裸变量；example 里出现的 `{{` → 记已知限制并转义

### 明确不做（v1）
YAML、v2、multipart/form-urlencoded、响应示例、按 tag 拆文件、cookie auth、TUI 内删除

## 分期

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0** | argv 分发 + **各命令内非 TTY** + `--help/--version` | 手动；`htui import` 在管道下不误退 |
| P1 | `paths.ts` + `openapi.ts` + selfcheck | `npm run check` |
| P2 | `import-openapi.ts`（resolve/校验/原子写/sidecar）+ CLI `import` | **E2E：临时 HTUI_HOME + mock server** |
| P3 | CLI `list` / `remove`（基于 sidecar） | 手动 |
| P4 | 扫描集合目录 + 分组 + `relPath` | 手动 |
| P5 | TUI 导入（选择器 + 表单，复用 P2 核心） | 手动 |
| P6 | README（含 `-e` 限制、更新的 "no request storage" 表述） | — |

## 测试（S1–S6 已并入）

- `openapi.selfcheck`：端点计数 / `###` 名 / method·url / `@baseUrl` / **无真实密钥字面量** / **所有 `{{x}}` 均已声明** / **重导 byte-identical**
- `paths.selfcheck`：`HTUI_HOME` 覆盖；`HOME` 未设不抛；`XDG_CONFIG_HOME` 空串
- `import-openapi` 测试：force/refuse、名称清洗拒绝、tmp 清理、目录缺失
- **E2E（最高价值）**：生成 → 对每个 `parseRequests().line` 发 `httpyac send --line N` → 断言 method/path
- 全套串进 `npm run check`

## 影响面
- 新：`src/paths.ts`、`src/openapi.ts`、`src/openapi.selfcheck.ts`、`src/paths.selfcheck.ts`、`src/import-openapi.ts`、`src/commands.ts`（argv 分发）、`src/ui/ImportForm.tsx`
- 改：`src/cli.tsx`（P0 分发 + 集合扫描 + 分组 + Ctrl-O）、`src/workspace.ts`（`ScannedFile` + `relPath` 基准 + Ctrl-F 是否含集合）、`package.json`（`swagger-parser` + dev `openapi-types`；check）、`README.md`
- 不动：`src/parse.ts`、`src/rows.ts`、`src/ui/SearchableList.tsx`（仅加 `onImportKey` 属性）
