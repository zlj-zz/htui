import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { buildEntries, filterAndRank, viewport, type DisplayEntry } from '../rows';
import { parseMouse, setMouse, WHEEL_DOWN, WHEEL_UP } from '../mouse';

export interface KeyHint {
  /** Shown literally, e.g. `e`, `Ctrl-F`, `/`. */
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
  /** Esc with no filter. */
  onBack?: () => void;
  /** Plain keys in normal mode (filter is entered with `/`). */
  onCommand?: (key: string, item: T | undefined) => void;
  /** Ctrl-<key> chords, reserved everywhere. */
  onControl?: (key: string, item: T | undefined) => void;
  /** `?` in normal mode. */
  onHelp?: () => void;
  /** `q` in normal mode — quit. */
  onQuit?: () => void;
  /** Footer hints (display only). */
  controls?: KeyHint[];
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
 * Vim-like list: normal mode takes plain command keys, `/` enters filtering
 * (type to narrow, Enter to keep, Esc to clear). One instance is mounted per
 * step, so a single `useInput` is safe.
 */
export function SearchableList<T>({
  items,
  keyOf,
  labelOf,
  hintOf,
  groupOf,
  header,
  placeholder = 'press / to filter',
  maxVisible,
  isActive = true,
  onSelect,
  onBack,
  onCommand,
  onControl,
  onHelp,
  onQuit,
  controls,
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
      if (key.ctrl && input.length === 1) {
        onControl?.(input.toLowerCase(), selected);
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

      // normal mode
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(filtered.length - 1, c + 1));
      else if (key.return) {
        if (selected) onSelect(selected); // no-op on an empty match set
      } else if (key.escape) {
        if (query) setQuery('');
        else onBack?.();
      } else if (input === '/') setFiltering(true);
      else if (input === '?') onHelp?.();
      else if (input === 'q') onQuit?.();
      else if (input.length === 1) onCommand?.(input, selected);
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
        {filtering ? '' : `   [/] filter`}
        {filtering ? '' : controls?.map((c) => `   [${c.key}] ${c.label}`).join('')}
        {filtering ? '' : onHelp ? '   [?] help' : ''}
      </Text>
    </Box>
  );
}
