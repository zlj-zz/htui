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
| any list | `↑` `↓` | move · `Enter` open/send |
| any list | `Esc` | clear filter, else go back |
| any list | `e` | edit the highlighted request in `$EDITOR` |
| requests | `h` | edit the request headers (add / edit / delete) |
| any list | `i` | import an OpenAPI spec |
| any list | `s` | switch environment |
| requests | `r` | run-chain (prerequisites first) |
| any list | `Ctrl-F` | search requests across all files |
| result | `r` rerun · `e` edit · `v` vars · `t` history · `y`/`Y` copy · `w` save · `h` headers · `b` back · `q` quit | |

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
npm run check        # pure-logic self-checks (parse, rows, store, openapi)
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
