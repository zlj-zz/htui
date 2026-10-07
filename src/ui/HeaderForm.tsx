import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { parseHeaders, withHeaders, type Header } from '../httpfile';
import { chordOf, resolveKey, type Action } from '../keys';
import type { HttpRequest } from '../parse';
import { SearchableList } from './SearchableList';

/**
 * View and edit a request's headers. Writes back to the `.http` file; the
 * editor (or the file) stays the source of truth — no hidden request state.
 */
export function HeaderForm({
  content,
  req,
  onSave,
  onAction,
}: {
  content: string;
  req: HttpRequest;
  onSave: (content: string) => Promise<void>;
  /** Actions this form does not own (back / help / quit) go to the app. */
  onAction: (action: Action) => void;
}) {
  const [headers, setHeaders] = useState<Header[]>(() => parseHeaders(content, req));
  // undefined = list mode, null = adding, a Header = editing that one
  const [editing, setEditing] = useState<Header | null | undefined>(undefined);
  const [error, setError] = useState('');

  async function commit(next: Header[]) {
    setHeaders(next);
    await onSave(withHeaders(content, req, next));
    setEditing(undefined);
  }

  // In the text field: Esc leaves the field, and nothing else here — the input
  // owns the keyboard (so typing "q" does not quit).
  useInput(
    (_input, key) => {
      if (key.escape) setEditing(undefined);
    },
    { isActive: editing !== undefined },
  );

  if (editing !== undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>
          {editing ? 'Edit header' : 'Add header'} · {req.method} {req.url}
        </Text>
        <Text dimColor>Name: value · Esc to cancel</Text>
        <TextInput
          defaultValue={editing ? `${editing.name}: ${editing.value}` : ''}
          onSubmit={(value) => {
            const sep = value.indexOf(':');
            const name = sep < 0 ? '' : value.slice(0, sep).trim();
            const val = sep < 0 ? '' : value.slice(sep + 1).trim();
            if (!name) {
              setError('expected "Name: value"');
              return;
            }
            commit(
              editing
                ? headers.map((h) => (h === editing ? { name, value: val } : h))
                : headers.some((h) => h.name.toLowerCase() === name.toLowerCase())
                  ? headers.map((h) => (h.name.toLowerCase() === name.toLowerCase() ? { name, value: val } : h))
                  : [...headers, { name, value: val }],
            );
          }}
        />
        {error ? <Text color="red">✗ {error}</Text> : null}
      </Box>
    );
  }

  return (
    <SearchableList
      step="headers"
      header={`Headers · ${req.method} ${req.url}  (${headers.length})`}
      placeholder="filter headers…"
      items={headers}
      keyOf={(h) => h.name}
      labelOf={(h) => `${h.name}: ${h.value}`}
      onAction={(action, h) => {
        if (action === 'add-header') {
          setError('');
          setEditing(null);
        } else if (action === 'edit-header' && h) {
          setError('');
          setEditing(h);
        } else if (action === 'delete-header' && h) {
          void commit(headers.filter((x) => x !== h));
        } else {
          onAction(action);
        }
      }}
    />
  );
}
