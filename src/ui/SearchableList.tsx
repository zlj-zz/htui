import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chordOf, resolveKey, type Action, type Step } from '../keys';
import { Hints } from './Hints';
import { parseMouse, setMouse, WHEEL_DOWN, WHEEL_UP } from '../mouse';
import { buildEntries, filterAndRank, viewport, type DisplayEntry } from '../rows';

export interface SearchableListProps<T> {
  /** Which screen this is — drives key resolution and the footer hints. */
  step: Step;
  items: T[];
  keyOf: (t: T) => string;
  labelOf: (t: T) => string;
  hintOf?: (t: T) => string | undefined;
  /** Noun for the count line, e.g. "requests". */
  noun?: string;
  /** Optional colored lead cell rendered before the label (e.g. the HTTP method). */
  leadOf?: (t: T) => { text: string; color?: string } | undefined;
  groupOf?: (t: T) => string | undefined;
  header?: string;
  placeholder?: string;
  maxVisible?: number;
  isActive?: boolean;
  /** Every command key is resolved through the shared key map, then lands here. */
  onAction: (action: Action, item: T | undefined) => void;
  /** Last selected key + filter for this screen — restored on mount. */
  restore?: { key?: string; query?: string };
  /** Called on unmount with the current key/filter, so the next mount can restore. */
  onRemember?: (key: string, query: string) => void;
}

function Row<T>({
  entry,
  selected,
  hint,
  lead,
}: {
  entry: DisplayEntry<T>;
  selected: boolean;
  hint?: string;
  lead?: { text: string; color?: string };
}) {
  return (
    <Text wrap="truncate-end" color={selected ? 'cyan' : undefined}>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
      {lead ? <Text color={lead.color}>{lead.text}</Text> : null}
      <Text color={selected ? 'cyan' : undefined}>{entry.label}</Text>
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
  noun,
  leadOf,
  groupOf,
  header,
  placeholder = 'press / to filter',
  maxVisible,
  isActive = true,
  onAction,
  restore,
  onRemember,
}: SearchableListProps<T>) {
  const [query, setQuery] = useState(restore?.query ?? '');
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

  // Identity restore: once data arrives, jump to the remembered item (by
  // keyOf identity — line numbers drift after edits/rescans). The remembered
  // filter is applied via the query state initializer above, so the
  // setCursor(0)-on-query-change effect can never undo the cursor.
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current || items.length === 0 || !restore?.key) return;
    didRestore.current = true;
    const idx = filtered.findIndex((it) => keyOf(it) === restore.key);
    if (idx >= 0) setCursor(idx);
  }, [items, filtered, restore, keyOf]);

  // On unmount, hand the current selection/filter back to the app so the next
  // mount of this screen restores it.
  const lastState = useRef({ key: '', query: '' });
  const onRememberRef = useRef(onRemember);
  onRememberRef.current = onRemember;
  lastState.current = { key: selected ? keyOf(selected) : '', query };
  useEffect(() => () => onRememberRef.current?.(lastState.current.key, lastState.current.query), []);

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
          <Row
            key={`i${i}`}
            entry={entry}
            selected={entry.item === selected}
            hint={hintOf?.(entry.item as T)}
            lead={leadOf?.(entry.item as T)}
          />
        ),
      )}
      <Text dimColor>
        {filtered.length === items.length ? `${items.length}` : `${filtered.length}/${items.length}`}
        {noun ? ` ${noun}` : ''}
        {start > 0 ? ' ↑' : ''}
        {end < filtered.length ? ' ↓' : ''}
        {filtering ? '' : '   [/] filter'}
      </Text>
      {!filtering ? <Hints step={step} indent="  " /> : null}
    </Box>
  );
}
