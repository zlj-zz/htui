# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

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
