# htui

A terminal UI for [httpyac](https://httpyac.github.io) — send HTTP / gRPC / WebSocket
requests straight from your terminal, backed by plain `.http` files.

## Why

- **Terminal-native (TUI)** — no browser, no Electron, no cloud account.
- **`.http` files are the single source of truth** — you edit them, agents read/write
  them, Git versions them.
- **Execution is delegated to httpyac**, so you get HTTP, gRPC, WebSocket, GraphQL and
  MQTT for free. htui adds only the picker + response view.

## Requirements

- Node 22+ (required by Ink 8; enforced by `npm` on install)
- httpyac: `npm i -g httpyac`

## Install

```bash
npm i -g htui
```

## Usage

```bash
htui                    # TUI: scan cwd (+ imported collections); pick file -> request
htui api/users.http     # open a specific file
htui new                # TUI: create a request interactively (writes a new .http)
HTUI_ENV=prod htui      # choose an httpyac environment (-e)
```

Keys:

`htui new` opens an interactive form (method → url → name → body → target file)
and writes a standard region into a **new** `.http` file (or appends when the
target exists — `--into <file>` presets it). The new request lands selected in
the normal list: add headers with `h`, fill the body with `Ctrl-E` in the
preview, and run it like any other request. Requires a TTY.

| Where | Key | Action |
|---|---|---|
| any list | `/` | filter the list |
| any list | `↑` `↓` | move · `Enter` open / preview |
| requests, search | `Enter` | preview the request (JSON) before sending |
| preview | `Ctrl-E` | edit this request as `.http` text in `$EDITOR` (this send only, not saved) |
| preview | `y` / `Y` | copy the request body / copy the request as curl |
| preview | `Enter` | send as shown |
| any list | `Esc` | clear filter, else go back |
| any list | `Ctrl-E` | edit the highlighted request in `$EDITOR` |
| requests | `h` | edit the request headers (add / edit / delete) |
| any list | mouse wheel | move the selection (hold **Shift** to select text) |
| any list | `i` | import an OpenAPI spec |
| any list | `s` | switch environment |
| requests | `r` | run now (skip the preview) |
| any list | `Ctrl-F` | search requests across all files |
| result | `r`/`R` run · `Ctrl-E` edit · `/` search body · `v` vars · `t` history · `w` save · `h` headers · `Esc` back · `q` quit | |
| sending | `Esc` | cancel the in-flight request (kills the child) |

## Importing OpenAPI

Convert an OpenAPI 3.x (or Swagger 2.0) JSON spec into a `.http` collection. It reuses
the normal pick / filter / send path — there is no second execution engine.

```bash
htui import openapi.json --name petstore
htui list
htui remove petstore
```

Options: `--name N` (default: spec title) · `--force` (overwrite) · `--local`
(`./.htui/collections` instead of `~/.config/htui`) · `--base-url URL`.

Each collection is a directory under `$HTUI_HOME/collections` (`~/.config/htui` by
default, or `./.htui/collections` with `--local`): `<name>/<name>.http` (generated
requests — safe to re-import) and `<name>/http-client.env.json` (the variables and
environments; a re-import only fills in **missing** keys, never overwrites your
edits). The generated file contains no variables — it references `{{baseUrl}}`,
`{{token}}`, … and resolves them from the env file, so you can retarget it per
environment (`s` in the TUI, or `-e`). Limits: **YAML is not supported** (JSON
only); external (cross-file) `$ref` is not resolved; Swagger 2.0 is converted on
import.

## RPC (gRPC / tRPC / in-house)

htui adds no protocol layer of its own — [httpyac](https://httpyac.github.io) speaks
gRPC natively, and htui runs whatever the region says. A gRPC call is just another
region in the same `.http` file, with the same preview / edit / run keys.
See `examples/grpc.http` for a runnable example.

### gRPC

```http
### grpc echo
# @name grpc_echo
# @grpc-reflection
GRPC grpc.postman-echo.com/HelloService/sayHello
x-token: {{token}}

{"greeting": "world"}
```

- `# @grpc-reflection` resolves the service from **server reflection** — no `.proto`
  needed. Without reflection, load protos inside the region instead:
  `proto < ./proto/user.proto` (relative to the `.http` file).
- Headers are **gRPC metadata**. `channelcredentials: ssl` selects TLS (plain by
  default); dotted `grpc.*` headers (`grpc.max_receive_message_length`, …) become
  channel options. Give an explicit `host:port` — there is no port inference, and
  a server that terminates TLS at the ingress is still reached plaintext.
- Success is `statusCode 0` (`OK`). A failed call produces **no response** — htui
  shows the hook/test error text, which usually means a reflection or method-name
  mismatch (diagnose with `grpcurl list`).
- Unary calls only: streaming is not representable in `--json` output. Give long
  calls a deadline — gRPC without one hangs indefinitely.
- `Y` (copy as curl) is HTTP-only: for gRPC it emits a command that cannot run.

### An HTTP login flowing into a gRPC call

Response references like `{{login.response.body.$.token}}` do **not** exist in
httpyac. Bridge the two with a global variable set in a response hook:

```http
### login
# @noCookieJar
POST https://postman-echo.com/post
Content-Type: application/json

{"token":"abc123"}

> {%
  client.global.set('token', response.body.data.token);
%}

### grpc echo
GRPC grpc.postman-echo.com/HelloService/sayHello
x-token: {{token}}

{"greeting": "world"}
```

The hook sits **inside the login region, after its body**. The variable lives for
**one httpyac run** (same rule as cookies). htui sends one region at a time, so
run this pair with `httpyac send <file> --all` directly. Sending the gRPC request
alone resolves `{{token}}` from the env file only — it will not see the login's
value.

### tRPC

tRPC is HTTP + JSON — no adapter:

```http
### trpc post create
POST {{trpcUrl}}/post.create
x-trpc-source: htui

{"title":"hello"}
```

Batching is a POST with an array. A `trpc-openapi`-style spec imports through the
normal `htui import`; `httpBatchStreamLink` streaming is not expressible in `.http`.

### In-house protocols

1. **HTTP-shaped** (most are): just `.http` — signing/encryption goes in httpyac's
   in-file JS hooks (`> {% %}`).
2. **Non-HTTP**: write an [httpyac plugin](https://httpyac.github.io/plugins/) — an
   npm package named `httpyac-plugin-<name>`, auto-loaded whenever `httpyac` runs
   in the project. htui needs no changes.

## Importing proto (gRPC)

`htui import` routes by extension — a `.proto` file produces a gRPC collection:

```bash
htui import user.proto --name user --base-url localhost:50051
```

One region per rpc method (`GRPC {{grpcHost}}/pkg.Service/Method` with a `{}`
body stub), the protos copied into `collections/<name>/proto/` and referenced via
`proto <` lines, and `grpcHost` merged into the env file. Flags: `--force`,
`--local`, `--base-url host:port` (no scheme — plaintext by default; TLS via
httpyac's `channelcredentials: ssl` metadata) and `--reflection` (emit
`# @grpc-reflection` instead of copying protos; needs a server that exposes
reflection). Well-known types (`google/protobuf/*`) resolve from httpyac's
bundled copies. Streaming methods are generated too, but `--json` output is
unary-shaped. Several protos can be passed at once — each becomes a `proto <`
line, and their `import "…"` statements resolve from the copied neighbours.

## Headless (agents)

```bash
htui send api/users.http -n listUsers        # one request
htui send api/users.http --line 12 --json     # machine-readable
```

Exit codes: `0` completed · `1` failed · `2` usage/selection error.

## Dev

```bash
npm install
npm run dev -- examples/demo.http
npm run check        # 15 pure-logic self-checks (parse, rows, store, request, mouse, …)
npm run e2e          # import -> send every request via --line against a mock server
npm run typecheck
npm run build        # -> dist/cli.js
```

## Design

A deliberately thin shell:

1. Parse `.http` blocks for the request picker (`src/parse.ts`).
2. Run `httpyac send <file> --line <n> --json` — requests are identified by line.
3. Render httpyac's documented `SendJsonOutput` contract.

There is no protocol logic and no request editor of our own: httpyac and the `.http`
file do the real work. The only storage htui owns is the imported collection store.

## License

[MIT](LICENSE) — free to use, modify, and redistribute.
