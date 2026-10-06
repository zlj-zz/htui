# htui

A terminal UI for [httpyac](https://httpyac.github.io) — send HTTP / gRPC / WebSocket
requests straight from your terminal, backed by plain `.http` files.

## Why

- **Terminal-native (TUI)** — no browser, no Electron, no cloud account.
- **`.http` files are the single source of truth** — you edit them, agents read/write
  them, Git versions them. No proprietary database.
- **Execution is delegated to httpyac**, so you get HTTP, gRPC, WebSocket, GraphQL and
  MQTT for free. htui adds only the picker + response view.

## Requirements

- Node 20+
- httpyac: `npm i -g httpyac`

## Usage

```bash
htui                    # scan cwd for .http/.rest, pick file + request
htui api/users.http     # open a specific file
HTUI_ENV=prod htui      # choose an httpyac environment (-e)
```

Keys: `[r]` rerun · `[b]` back · `[q]` quit

## Dev

```bash
npm install
npm run dev -- examples/demo.http
npm run check        # parser self-check
npm run typecheck
npm run build        # -> dist/cli.js
```

## Design

A deliberately thin shell:

1. Parse `.http` blocks for the request picker (`src/parse.ts`).
2. Run `httpyac send <file> [--name <req>] [--json]`.
3. Render httpyac's documented `SendJsonOutput` contract.

No protocol logic, no request storage, no editor of our own — httpyac and the `.http`
file do the real work.
