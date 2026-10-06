import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { buildEntries, filterAndRank, viewport, type DisplayEntry } from '../rows';

export interface ControlHint {
  /** Lowercase letter, triggered as Ctrl-<key>. */
  key: string;
  label: string;
}

export interface SearchableListProps<T> {
  items: T[];
  keyOf: (t: T) => string;
  labelOf: (t: T) => string;
  hintOf?: (t: T) => string | undefined;
  groupOf?: (t: T) => string | undefined;
  header?: string;
  placeholder?: string;
  maxVisible?: number;
  isActive?: boolean;
  onSelect: (t: T) => void;
  /** Esc with an empty query. */
  onBack?: () => void;
  /** Reserved Ctrl-<key> actions (they never land in the filter). */
  onControl?: (key: string, item: T | undefined) => void;
  /** `?` when the filter is empty. */
  onHelp?: () => void;
  /** Footer hints for the reserved keys (display only). */
  controls?: ControlHint[];
}

function Row<T>({ entry, selected, hint }: { entry: DisplayEntry<T>; selected: boolean; hint?: string }) {
  return (
    <Text wrap="truncate-end" color={selected ? 'cyan' : undefined}>
      <Text color={selected ? 'cyan' : undefined}>
        {selected ? '❯ ' : '  '}
        {entry.label}
      </Text>
      {hint ? <Text dimColor>{'  '}{hint}</Text> : null}
    </Text>
  );
}

/**
 * Single-keyboard list: type to filter, ↑/↓ to move, Enter to select.
 * Only one instance is mounted per step, so a single `useInput` is safe.
 */
export function SearchableList<T>({
  items,
  keyOf,
  labelOf,
  hintOf,
  groupOf,
  header,
  placeholder = 'type to filter',
  maxVisible,
  isActive = true,
  onSelect,
  onBack,
  onControl,
  onHelp,
  controls,
}: SearchableListProps<T>) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => filterAndRank(query, items, keyOf), [query, items, keyOf]);
  const size = Math.max(1, maxVisible ?? Math.max(1, (process.stdout.rows ?? 24) - 6));
  const { start, end } = viewport(filtered.length, cursor, size);
  const visible = filtered.slice(start, end);
  const entries = buildEntries(visible, { labelOf, groupOf, showGroups: !query.trim() });
  const selected = filtered[cursor];

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(filtered.length - 1, c + 1));
        return;
      }
      if (key.return) {
        if (selected) onSelect(selected); // no-op on empty match set
        return;
      }
      if (key.escape) {
        if (query) setQuery('');
        else onBack?.();
        return;
      }
      if (key.ctrl && input.length === 1) {
        onControl?.(input.toLowerCase(), selected); // reserved; never filtered
        return;
      }
      if (key.ctrl || key.meta) return;
      // `?` is help when nothing is being typed (to type a literal ? start elsewhere).
      if (input === '?' && !query) {
        onHelp?.();
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input) setQuery((q) => q + input.replace(/[\r\n\t]/g, '')); // paste arrives as one multi-char input
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {header ? <Text bold>{header}</Text> : null}
      <Text>
        <Text color="cyan">❯ </Text>
        {query ? <Text>{query}</Text> : <Text dimColor>{placeholder}</Text>}
      </Text>
      {filtered.length === 0 ? <Text dimColor>{'  (no matches)'}</Text> : null}
      {entries.map((entry, i) =>
        entry.type === 'group' ? (
          <Text key={`g${i}`} dimColor>
            {'  '}
            {entry.label}
          </Text>
        ) : (
          <Row key={`i${i}`} entry={entry} selected={entry.item === selected} hint={hintOf?.(entry.item as T)} />
        ),
      )}
      <Text dimColor>
        {filtered.length === items.length ? `${items.length}` : `${filtered.length}/${items.length}`}
        {start > 0 ? ' ↑' : ''}
        {end < filtered.length ? ' ↓' : ''}
        {controls?.map((c) => `   [Ctrl-${c.key.toUpperCase()}] ${c.label}`).join('')}
        {onHelp ? '    ?  help' : ''}
      </Text>
    </Box>
  );
}
