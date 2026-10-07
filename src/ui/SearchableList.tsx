import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { chordOf, hintsFor, resolveKey, type Action, type Step } from '../keys';
import { parseMouse, setMouse, WHEEL_DOWN, WHEEL_UP } from '../mouse';
import { buildEntries, filterAndRank, viewport, type DisplayEntry } from '../rows';

export interface SearchableListProps<T> {
  /** Which screen this is — drives key resolution and the footer hints. */
  step: Step;
  items: T[];
  keyOf: (t: T) => string;
  labelOf: (t: T) => string;
  hintOf?: (t: T) => string | undefined;
  groupOf?: (t: T) => string | undefined;
  header?: string;
  placeholder?: string;
  maxVisible?: number;
  isActive?: boolean;
  /** Every command key is resolved through the shared key map, then lands here. */
  onAction: (action: Action, item: T | undefined) => void;
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
 * Vim-like list: normal mode takes command keys, `/` enters filtering (type to
 * narrow, Enter to keep, Esc to clear). Movement and filtering live here; every
 * command key goes through `resolveKey` so it cannot drift from other screens.
 * One instance is mounted per step, so a single `useInput` is safe.
 */
export function SearchableList<T>({
  step,
  items,
  keyOf,
  labelOf,
  hintOf,
  groupOf,
  header,
  placeholder = 'press / to filter',
  maxVisible,
  isActive = true,
  onAction,
}: SearchableListProps<T>) {
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => filterAndRank(query, items, keyOf), [query, items, keyOf]);
  const size = Math.max(1, maxVisible ?? Math.max(1, (process.stdout.rows ?? 24) - 6));
  const { start, end } = viewport(filtered.length, cursor, size);
  const visible = filtered.slice(start, end);
  const entries = buildEntries(visible, { labelOf, groupOf, showGroups: !query.trim() });
  const selected = filtered[cursor];
  const hints = useMemo(() => hintsFor(step), [step]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Mouse reporting is on only while this list owns the keyboard; while
  // filtering a TextInput is up and would take the raw bytes as text.
  useEffect(() => {
    if (!isActive || filtering) return;
    setMouse(true);
    return () => setMouse(false);
  }, [isActive, filtering]);

  useInput(
    (input, key) => {
      const mouse = parseMouse(input);
      if (mouse) {
        if (mouse.button === WHEEL_UP) setCursor((c) => Math.max(0, c - 1));
        else if (mouse.button === WHEEL_DOWN) setCursor((c) => Math.min(filtered.length - 1, c + 1));
        return;
      }
      if (key.meta) return;

      if (filtering) {
        if (key.return) setFiltering(false); // keep the filter
        else if (key.escape) {
          setQuery('');
          setFiltering(false);
        } else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
        else if (input) setQuery((q) => q + input.replace(/[\r\n\t]/g, ''));
        return;
      }

      // normal mode — movement and the filter switch stay local
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(filtered.length - 1, c + 1));
        return;
      }
      if (input === '/') {
        setFiltering(true);
        return;
      }
      if (key.escape && query) {
        setQuery(''); // clear the filter before going back
        return;
      }

      const action = resolveKey(step, chordOf(input, key));
      if (action) onAction(action, selected);
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {header ? <Text bold>{header}</Text> : null}
      <Text>
        <Text color="cyan">{filtering ? '❯ ' : '/ '}</Text>
        {filtering ? (
          <Text>
            {query}
            <Text color="cyan">▏</Text>
          </Text>
        ) : query ? (
          <Text>{query}</Text>
        ) : (
          <Text dimColor>{placeholder}</Text>
        )}
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
        {filtering ? '' : '   [/] filter'}
        {filtering ? '' : hints.map((h) => `   [${h.key}] ${h.label}`).join('')}
      </Text>
    </Box>
  );
}
