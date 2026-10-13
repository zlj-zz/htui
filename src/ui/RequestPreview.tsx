import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { HEADER_RE } from '../httpfile';
import { chordOf, resolveKey, type Action } from '../keys';
import type { Notice } from '../notice';
import { REQUEST_LINE_RE, type RequestModel } from '../request';
import { viewport } from '../rows';
import { Hints } from './Hints';

/** Which part of the request a display line maps to. */
type Part =
  | { kind: 'request' }
  | { kind: 'header'; index: number }
  | { kind: 'env' }
  | { kind: 'body'; index: number }
  | { kind: 'blank' };

const TITLE: Record<Part['kind'] | 'add-header', string> = {
  request: 'request line (METHOD url)',
  header: 'header (Name: value)',
  env: 'env header',
  body: 'body line',
  blank: 'blank line',
  'add-header': 'new header (Name: value)',
};

/**
 * The step between picking a request and sending it. Tweaks are light and live:
 * move over a line and press `e` to edit it, `a` / `d` to add / remove a header —
 * no `$EDITOR`. Edits are this-send-only until `Ctrl-S`, which writes the region
 * back to the `.http` file (the region's `###` / `# @name` preamble and every
 * later region are kept); `Ctrl-E` still opens the whole region in `$EDITOR`
 * for structural edits.
 *
 * When env `$headers` exist they render after the request headers, dim with an
 * `⇩ env` tag — display-only: editing or deleting them does nothing here (they
 * live on the env screen), and `Ctrl-S` can never write them into the file.
 */
export function RequestPreview({
  model,
  envHeaders,
  edited,
  error,
  notice,
  onModel,
  onSave,
  onAction,
}: {
  model: RequestModel;
  /** Global headers from the active env — rendered merged, never editable. */
  envHeaders?: Record<string, string>;
  edited: boolean;
  error: string;
  /** Transient feedback (copy/save confirmations) — rendered above the hints. */
  notice?: Notice | null;
  /** In-memory edit — applied to this send only until saved. */
  onModel: (model: RequestModel) => void;
  /** Ctrl-S: write the current model back to the `.http` file. */
  onSave: () => void;
  onAction: (action: Action) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Part | { kind: 'add-header' } | null>(null);
  const [fieldError, setFieldError] = useState('');

  const envRows = Object.entries(envHeaders ?? {}).filter(([name]) =>
    model.headers.every((h) => h.name.toLowerCase() !== name.toLowerCase()),
  );
  const headerCount = model.headers.length + envRows.length;
  const lines = [
    `${model.method} ${model.url}`,
    ...model.headers.map((h) => `${h.name}: ${h.value}`),
    ...envRows.map(([name, value]) => `${name}: ${value}`),
    ...(model.body ? ['', ...model.body.split('\n')] : []),
  ];

  /** The part a display line edits (env rows and the blank separator are not editable). */
  function partAt(i: number): Part {
    if (i === 0) return { kind: 'request' };
    const h = i - 1;
    if (h < model.headers.length) return { kind: 'header', index: h };
    if (h - model.headers.length < envRows.length) return { kind: 'env' };
    if (model.body) {
      const rel = i - 1 - headerCount;
      if (rel >= 1) return { kind: 'body', index: rel - 1 };
    }
    return { kind: 'blank' };
  }

  // Keep the cursor in range when the model grows or shrinks.
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, lines.length - 1))), [lines.length]);

  // A text field owns the keyboard while it is up; only Esc (cancel) stays ours.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setEditing(null);
        setFieldError('');
      }
    },
    { isActive: editing !== null },
  );

  function applyEdit(value: string): void {
    if (editing?.kind === 'request') {
      const m = value.trim().match(REQUEST_LINE_RE);
      if (!m) return setFieldError('expected "METHOD url"');
      onModel({ ...model, method: m[1].toUpperCase(), url: m[2] });
    } else if (editing?.kind === 'header') {
      const m = value.match(HEADER_RE);
      if (!m) return setFieldError('expected "Name: value"');
      onModel({ ...model, headers: model.headers.map((h, i) => (i === editing.index ? { name: m[1], value: m[2] } : h)) });
    } else if (editing?.kind === 'body') {
      const body = model.body.split('\n');
      body[editing.index] = value;
      onModel({ ...model, body: body.join('\n') });
    } else if (editing?.kind === 'add-header') {
      const m = value.match(HEADER_RE);
      if (!m) return setFieldError('expected "Name: value"');
      onModel({ ...model, headers: [...model.headers, { name: m[1], value: m[2] }] });
    }
    setEditing(null);
    setFieldError('');
  }

  function handle(action: Action | null): void {
    if (action === 'edit-field') {
      const part = partAt(cursor);
      if (part.kind !== 'blank' && part.kind !== 'env') {
        setFieldError('');
        setEditing(part);
      }
    } else if (action === 'add-header') {
      setFieldError('');
      setEditing({ kind: 'add-header' });
    } else if (action === 'delete-header') {
      const part = partAt(cursor);
      if (part.kind === 'header') onModel({ ...model, headers: model.headers.filter((_, i) => i !== part.index) });
    } else if (action === 'save') {
      onSave();
    } else if (action) onAction(action);
  }

  useInput(
    (input, key) => {
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(lines.length - 1, c + 1));
      handle(resolveKey('preview', chordOf(input, key)));
    },
    { isActive: editing === null },
  );

  if (editing) {
    const value =
      editing.kind === 'request'
        ? `${model.method} ${model.url}`
        : editing.kind === 'header'
          ? `${model.headers[editing.index]?.name ?? ''}: ${model.headers[editing.index]?.value ?? ''}`
          : editing.kind === 'body'
            ? (model.body.split('\n')[editing.index] ?? '')
            : '';
    return (
      <Box flexDirection="column">
        <Text bold>Edit {TITLE[editing.kind]}</Text>
        <TextInput key={editing.kind + ('index' in editing ? editing.index : '')} defaultValue={value} onSubmit={applyEdit} />
        <Text dimColor>Esc cancels · Enter applies</Text>
        {fieldError ? <Text color="red">✗ {fieldError}</Text> : null}
      </Box>
    );
  }

  const size = Math.max(1, (process.stdout.rows ?? 24) - 8);
  const { start, end } = viewport(lines.length, cursor, size);
  return (
    <Box flexDirection="column">
      <Text bold>Request{edited ? ' · edited (Ctrl-S saves)' : ''}</Text>
      {lines.slice(start, end).map((line, k) => {
        const i = start + k;
        const fromEnv = i > model.headers.length && i <= headerCount;
        return fromEnv ? (
          <Text key={i} dimColor>
            {i === cursor ? '❯ ' : '  '}
            {line || ' '}  ⇩ env
          </Text>
        ) : (
          <Text key={i} color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {line || ' '}
          </Text>
        );
      })}
      {start > 0 ? <Text dimColor>↑ {start} more</Text> : null}
      {end < lines.length ? <Text dimColor>↓ {lines.length - end} more</Text> : null}
      {error ? <Text color="red">✗ {error}</Text> : null}
      <Text color={notice?.kind === 'warn' ? 'yellow' : 'cyan'}>{notice?.text ?? ' '}</Text>
      <Hints step="preview" />
    </Box>
  );
}
