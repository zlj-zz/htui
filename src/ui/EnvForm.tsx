import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { chordOf, resolveKey, type Action } from '../keys';
import type { Notice } from '../notice';
import { envFileWithRows, envRowsOf, type EnvRow } from '../store';
import { SearchableList } from './SearchableList';

/**
 * Structured editor for one environment inside ONE env file: its variables and
 * its `$headers` (global headers applied to every request while this env is
 * active). Rows come from — and are written back to — this single file, so a
 * delete always deletes: variables inherited from a parent env file do not show
 * here (they still apply at send, via the nearest-wins merge). A file that is
 * not valid JSON is never rewritten.
 */

type Editing = { mode: 'edit'; row: EnvRow } | { mode: 'add-var' } | { mode: 'add-header' };

const VAR_NAME_RE = /^[A-Za-z_][\w.-]*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function EnvForm({
  envFile,
  envName,
  content,
  notice,
  onSave,
  onAction,
}: {
  /** The file that defines this env — the single write target. */
  envFile: string;
  envName: string;
  content: string;
  notice?: Notice | null;
  onSave: (content: string) => Promise<void>;
  /** Actions this form does not own (back / help / quit) go to the app. */
  onAction: (action: Action) => void;
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => envRowsOf(content, envName));
  // undefined = list mode; otherwise a text field is up
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [error, setError] = useState('');

  const baseName = envFile.split(/[\\/]/).pop() ?? envFile;

  async function commit(next: EnvRow[]) {
    const previous = rows;
    const field = editing;
    setEditing(undefined);
    setRows(next);
    try {
      await onSave(envFileWithRows(content, envName, next));
    } catch (err) {
      setRows(previous);
      setError(err instanceof Error ? err.message : String(err));
      setEditing(field);
    }
  }

  // In the text field: Esc leaves the field, nothing else — the input owns the
  // keyboard (typing "q" must type "q").
  useInput(
    (_input, key) => {
      if (key.escape) setEditing(undefined);
    },
    { isActive: editing !== undefined },
  );

  if (editing) {
    const title =
      editing.mode === 'add-var' ? 'Add variable' : editing.mode === 'add-header' ? 'Add global header' : 'Edit entry';
    const value = editing.mode === 'edit' ? `${editing.row.name}: ${editing.row.value}` : '';
    return (
      <Box flexDirection="column">
        <Text bold>
          {title} · {envName} · {baseName}
        </Text>
        <Text dimColor>Name: value · Esc to cancel</Text>
        <TextInput
          defaultValue={value}
          onSubmit={(raw) => {
            const current = editing;
            setEditing(undefined); // a second Enter can no longer double-commit
            const sep = raw.indexOf(':');
            const name = (sep < 0 ? raw : raw.slice(0, sep)).trim();
            const nextValue = (sep < 0 ? '' : raw.slice(sep + 1)).trim();
            const isHeader = editing.mode === 'add-header' || (editing.mode === 'edit' && editing.row.kind === 'header');
            if (isHeader ? !HEADER_NAME_RE.test(name) : !VAR_NAME_RE.test(name)) {
              setError(
                isHeader
                  ? 'header name: letters, digits, . _ -'
                  : 'variable name: letters, digits, _ . - (no leading $)',
              );
              setEditing(current);
              return;
            }
            if (nextValue.includes('\n')) {
              setError('value must be a single line');
              setEditing(current);
              return;
            }
            setError('');
            if (editing.mode === 'edit') {
              void commit(rows.map((r) => (r === editing.row ? { ...r, name, value: nextValue } : r)));
              return;
            }
            const kind: EnvRow['kind'] = editing.mode === 'add-header' ? 'header' : 'var';
            const hit = rows.find((r) => r.kind === kind && r.name.toLowerCase() === name.toLowerCase());
            void commit(
              hit ? rows.map((r) => (r === hit ? { ...r, value: nextValue } : r)) : [...rows, { kind, name, value: nextValue }],
            );
          }}
        />
        {error ? <Text color="red">✗ {error}</Text> : null}
      </Box>
    );
  }

  return (
    <SearchableList
      step="env-vars"
      header={`Env ${envName} · ${baseName}  (${rows.length})`}
      placeholder="filter entries…"
      noun="entries"
      notice={notice}
      items={rows}
      keyOf={(r) => `${r.kind}:${r.name}`}
      labelOf={(r) => `${r.name}: ${r.value}`}
      groupOf={(r) => (r.kind === 'header' ? 'global headers' : 'variables')}
      onAction={(action, row) => {
        if (action === 'edit-header' && row) {
          setError('');
          setEditing({ mode: 'edit', row });
        } else if (action === 'add-var') {
          setError('');
          setEditing({ mode: 'add-var' });
        } else if (action === 'add-header') {
          setError('');
          setEditing({ mode: 'add-header' });
        } else if (action === 'delete-header' && row) {
          void commit(rows.filter((r) => r !== row));
        } else {
          onAction(action);
        }
      }}
    />
  );
}
