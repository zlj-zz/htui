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

- Node 20+
- httpyac: `npm i -g httpyac`

## Usage

```bash
htui                    # TUI: scan cwd (+ imported collections); pick file -> request
htui api/users.http     # open a specific file
HTUI_ENV=prod htui      # choose an httpyac environment (-e)
```

Keys:

| Where | Key | Action |
|---|---|---|
| any list | `/` | filter the list |
| any list | `↑` `↓` | move · `Enter` open / preview |
| requests, search | `Enter` | preview the request (JSON) before sending |
| preview | `Ctrl-E` | edit this request as `.http` text in `$EDITOR` (this send only, not saved) |
| preview | `Enter` | send as shown |
| any list | `Esc` | clear filter, else go back |
| any list | `Ctrl-E` | edit the highlighted request in `$EDITOR` |
| requests | `h` | edit the request headers (add / edit / delete) |
| any list | mouse wheel | move the selection (hold **Shift** to select text) |
| any list | `i` | import an OpenAPI spec |
| any list | `s` | switch environment |
| requests | `r` / `R` | run now (skip the preview) / run with prerequisites (chain) |
| any list | `Ctrl-F` | search requests across all files |
| result | `r`/`R` run · `Ctrl-E` edit · `v` vars · `t` history · `y`/`Y` copy · `w` save · `h` headers · `Esc` back · `q` quit | |

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
region in the same `.http` file, with the same preview / edit / run / chain keys.
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

### Chaining an HTTP login into a gRPC call

Response references like `{{login.response.body.$.token}}` do **not** exist in
httpyac. Chain through a global variable set in a response hook:

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
**one httpyac run** (same rule as cookies): send the pair with `r`/`R` (run-chain)
or `--chain`. Sending the gRPC request alone resolves `{{token}}` from the env
file only — it will not see the login's value.

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

## Headless (agents)

```bash
htui send api/users.http -n listUsers        # one request
htui send api/users.http -n getMe --chain     # run prerequisite requests first (login -> token/cookie)
htui send api/users.http --line 12 --json     # machine-readable
```

Exit codes: `0` completed · `1` failed · `2` usage/selection error. `--chain`
slices the file up to the target region and runs it with `--all`, so session
state from earlier requests (cookie, token) is available.

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
