# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-10-14

### Added

- **Dual-pane layout** on wide terminals (>= 100 columns): the request list on
  the left, a detail pane on the right that always shows something — a
  read-only preview of the highlighted request, the send progress, or the
  response. `Tab` moves the keyboard between panes and the focused pane's
  border turns cyan; the right pane's first row names what it is showing
  (`REQUEST · read-only`, `REQUEST · ready to send`, `SENDING …`,
  `RESPONSE 200 OK · 15.20ms · api.http`).
- **Scroll the response body** (`j`/`k`, arrow keys, or the mouse wheel): the
  position marker reports `rows 11-29 of 754`, and the last line of any
  response is reachable — the old 200-line body clip is gone.
- **Mouse support in the dual pane**: click focuses a pane, click selects a
  list row, double-click opens it, and the wheel scrolls either pane. With
  reporting on, drag-select needs Shift (Option in Terminal.app).
- **JSON syntax highlighting** for response bodies, per-request timing
  sparklines in the list, and durations fixed to two decimals.
- Import: OpenAPI/Swagger operation tags are written into each region as
  `# @group` and the request list prefers them over URL-derived grouping
  (specs without tags keep URL-derived groups).

### Changed

- Footer colors carry the action hierarchy: the screen's primary action
  (`Enter`) renders bold, screen verbs have cyan keys, ever-present globals
  are dim; the status line segments screen, focus, request, and the response
  status in its status color.
- Transient feedback (copied, saved, cancelled) sits flush right on the
  status line — visible on every layout, including the dual pane.

### Fixed

- Panes no longer leave stale fragments behind when their content grows: a
  fixed-height pane clips its own content (`flexShrink={0}`) and wraps lines
  itself by display width (CJK counts as 2), so Ink's row bookkeeping always
  matches the screen.

## [0.3.0] — 2026-10-13

## [0.3.0] — 2026-10-13

### Added

- **Interactive env editing** (`s` → `e`): add/delete environments (`a`/`d`,
  delete confirms with a second press) and edit an env's variables and global
  headers in place — written to the one env file that defines the env; a file
  that is not valid JSON is never rewritten.
- **Global headers per env**: `$headers` in the env applies to every request
  while that env is active (TUI and `htui send` alike), injected at send time
  without touching the `.http` file; a request's own header always wins.
  The preview renders the merged view (`⇩ env` rows) and copy-as-curl uses it.
- **The selected env persists** across restarts, scoped per env file
  (`HTUI_ENV` still wins; headless `htui send` keeps its explicit resolution).
- **Copy the response body** (`y` on the result screen): the full,
  pretty-printed body — unclipped and unaffected by the body-search filter.
- The env picker opens with the cursor on the active env.

### Changed

- Import: only global variables (`baseUrl`, security schemes) are written to
  `http-client.env.json`. Per-endpoint path/query parameters stay as
  `{{placeholders}}` in the generated `.http` — a request with a missing value
  fails and names the variable, instead of every endpoint's params landing in
  the env file. Existing env files are never touched (write-once).
- Key hints are unambiguous: `y` copies the request body on the preview and the
  response body on the result screen (`copy resp`); `Ctrl-E` on the preview
  reads `editor`; the header-source picker's `Enter` reads `reuse headers`.

### Removed

- **Chain mode** (`R`, `htui send --chain`): a send always runs exactly one
  region. Cross-request references (`{{login.response…}}`) and cookies from
  earlier regions no longer resolve on send — run multi-region flows with
  `httpyac send <file> --all` directly.

## [0.2.0] — 2026-10-09

### Added

- **In-place request editing on the preview**: move over a line with
  `↑`/`↓` and press `e` to edit it; `a` / `d` add and remove headers. Changes
  are this-send-only until `Ctrl-S` writes the region back to the `.http` file
  (the region's `###` / `# @name` preamble and every later region are kept).
  `Ctrl-E` still opens the whole region in `$EDITOR`.
- **Reuse headers from another request** (`i` on the headers screen): merge
  another request's headers into the current one, keeping values you already
  have.
- **Copy the request body / as curl** (`y` / `Y`) on the preview, with
  environment-file and file `@var` variables resolved so the copied curl
  command is runnable as-is.
- **Persistent request-list sort**: the recently-run-first ordering is
  persisted and restored across restarts.
- **Unified key feedback**: acknowledgements fade, warnings stay until the
  next action.

### Fixed

- The filtered-list cursor is restored by identity instead of reset when
  returning to a list.
- Atomic writes preserve the target file's permissions — editing a `0600`
  `.http` (it can hold secrets) no longer widens it to the umask default.

## [0.1.0] — 2026-10-07

Initial release.

### Added

- **TUI for httpyac**: pick a file → pick a request → run, with result
  rendering (status, duration, tests, headers, body) and inline failure
  diagnosis (stderr, per-test errors).
- **Vim-like two-mode key model**: plain keys are commands, `/` enters filter
  mode; backed by a single key registry (`src/keys.ts`) that also generates
  the footer hints and the `?` help overlay, so bindings cannot drift between
  screens.
- **Request preview before sending** (`Enter`): shows the resolved request in
  `.http` form; `Ctrl-E` edits it in `$EDITOR` for this send only.
- **Interactive request creation**: `htui new` (method → url → name → body →
  target file) writes a standard region into a new or existing `.http` file;
  the new request lands selected in the normal list.
- **Import**: OpenAPI 3.x / Swagger 2.0 specs and `.proto` files become
  collections; `htui import` routes by extension.
- **gRPC**: regions execute natively through httpyac (`GRPC` request lines),
  including server reflection (`# @grpc-reflection`), `proto <` files,
  metadata, channel options and TLS; methods render with semantic colors.
- **Run-chain**: run a request together with its prerequisites so cookies and
  tokens carry over (`r` / `R`, `htui send --chain`); temporary slices are
  cleaned up even when cancelled.
- **Cancel an in-flight request**: `Esc` on the sending screen kills the
  child process and returns to the previous screen.
- **Response body search** (`/`) with live match count.
- **Header folding** (`h`), **copy body / copy as curl** (`y` / `Y`),
  **save body** (`w`, written with owner-only permissions).
- **Session history** (`t`): resend any recent request.
- **Environments**: picker (`s`), env-file discovery up the directory tree,
  `HTUI_ENV`, and write-once env merges on import.
- **Header editor** (`h` on the request list): add/edit/delete a request's
  headers directly, persisted to the `.http` file.
- **Headless mode for agents**: `htui send --name/--line/--chain/--json`,
  `htui list`, `htui remove`, `htui import`; non-TTY invocations are rejected
  with a clear message.
- **Startup guards**: TTY requirement and a missing-`httpyac` install hint
  before any interaction.
- **Mouse wheel** scrolls lists.
- **Cross-platform**: explicit Windows handling (bin names, atomic-write
  fallbacks) and `NO_COLOR` respected through the color stack.

### Security

- Saved response bodies are written with owner-only permissions (`0600`) —
  they may contain auth data.
- Copying a request as curl warns when the command may contain credentials.
- Imported environment files are merged write-once and a corrupt env file
  aborts the import instead of being overwritten.

[0.1.0]: https://github.com/zlj-zz/htui/releases/tag/v0.1.0
[0.3.0]: https://github.com/zlj-zz/htui/releases/tag/v0.3.0
[0.2.0]: https://github.com/zlj-zz/htui/releases/tag/v0.2.0
