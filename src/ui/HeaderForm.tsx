import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { parseHeaders, withHeaders, type Header } from '../httpfile';
import type { Notice } from '../notice';
import { chordOf, resolveKey, type Action } from '../keys';
import { parseRequests, type HttpRequest } from '../parse';
import { SearchableList } from './SearchableList';

/**
 * View and edit a request's headers. Writes back to the `.http` file; the
 * editor (or the file) stays the source of truth — no hidden request state.
 * `i` reuses headers from another request in the same file (a name you already
 * have is left untouched, so an explicit value is never overwritten).
 */
export function HeaderForm({
  content,
  req,
  onSave,
  onAction,
  notice,
}: {
  content: string;
  req: HttpRequest;
  onSave: (content: string) => Promise<void>;
  /** Actions this form does not own (back / help / quit) go to the app. */
  onAction: (action: Action) => void;
  /** Transient feedback shown under the header list. */
  notice?: Notice | null;
}) {
  const [headers, setHeaders] = useState<Header[]>(() => parseHeaders(content, req));
  // undefined = list mode, null = adding, a Header = editing that one
  const [editing, setEditing] = useState<Header | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  // Other regions in the same file — the pool for "reuse headers".
  const siblings = useMemo(
    () => parseRequests(content).filter((r) => r.startLine !== req.startLine),
    [content, req.startLine],
  );

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

  if (importing) {
    return (
      <SearchableList
        step="pick-headers"
        header={`Reuse headers from…  (${siblings.length} other request${siblings.length === 1 ? '' : 's'})`}
        placeholder="filter requests…"
        noun="requests"
        notice={notice}
        items={siblings}
        keyOf={(r) => `${r.startLine} ${r.name}`}
        labelOf={(r) => `${r.method} ${r.url}`}
        hintOf={(r) => (r.name !== 'default' ? r.name : undefined)}
        onAction={(action, r) => {
          if (action === 'open' && r) {
            // Merge in only names we do not already have; never overwrite a value.
            const have = new Set(headers.map((h) => h.name.toLowerCase()));
            const add: Header[] = [];
            for (const h of parseHeaders(content, r)) {
              const key = h.name.toLowerCase();
              if (have.has(key)) continue;
              have.add(key);
              add.push(h);
            }
            void commit([...headers, ...add]);
            setImporting(false);
          } else if (action === 'back') setImporting(false);
          else onAction(action);
        }}
      />
    );
  }

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
      noun="headers"
      notice={notice}
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
        } else if (action === 'import-headers') {
          setImporting(true);
        } else {
          onAction(action);
        }
      }}
    />
  );
}
