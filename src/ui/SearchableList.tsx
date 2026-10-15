import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chordOf, resolveKey, type Action, type Step } from '../keys';
import type { Notice } from '../notice';
import { Hints } from './Hints';
import { onMouse, setMouse, WHEEL_DOWN, WHEEL_UP, type MouseEvent } from '../mouse';
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
  /** Transient feedback (copy/save/edit confirmations) — shown above the count. */
  notice?: Notice | null;
  /** Optional colored lead cell rendered before the label (e.g. the HTTP method). */
  leadOf?: (t: T) => { text: string; color?: string } | undefined;
  groupOf?: (t: T) => string | undefined;
  header?: string;
  placeholder?: string;
  maxVisible?: number;
  isActive?: boolean;
  /** Re-anchor the cursor by identity when this changes (dual-pane sends). */
  anchorKey?: string;
  /** Called with the highlighted item whenever the cursor moves — drives the
   *  dual-pane live preview. */
  onHighlight?: (item: T | undefined) => void;
  /** Hide the count line and footer hints — the split view renders them globally. */
  showFooter?: boolean;
  /** Every command key is resolved through the shared key map, then lands here. */
  onAction: (action: Action, item: T | undefined) => void;
  /** Last selected key + filter for this screen — restored on mount. */
  restore?: { key?: string; query?: string };
  /** Called on unmount with the current key/filter, so the next mount can restore. */
  onRemember?: (key: string, query: string) => void;
  /** Dual-pane mouse rect (screen coords, 1-based, x inclusive): the list
   *  handles clicks, double-clicks and wheel inside it; the layout owns the
   *  mouse-reporting toggle. Absent in single-pane screens. */
  mousePane?: { x0: number; x1: number; y0: number };
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
 *
 * With a `groupOf`, large lists render domain group headers, `g` opens the group
 * index (pick one to filter by it) and `Space` folds/unfolds the group under the
 * cursor — folded groups render as a bare header with their item count.
 */
export function SearchableList<T>({
  step,
  items,
  keyOf,
  labelOf,
  hintOf,
  noun,
  notice,
  leadOf,
  groupOf,
  header,
  placeholder = 'press / to filter',
  maxVisible,
  isActive = true,
  anchorKey,
  onHighlight,
  showFooter = true,
  onAction,
  restore,
  onRemember,
  mousePane,
}: SearchableListProps<T>) {
  const [query, setQuery] = useState(restore?.query ?? '');
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState(false);
  const [groupCursor, setGroupCursor] = useState(0);

  const filtered = useMemo(() => filterAndRank(query, items, keyOf), [query, items, keyOf]);
  const selected = filtered[cursor];
  const showGroups = !query.trim() && groupOf !== undefined;

  // The group index (`g`): every domain with its size. `recent` is excluded —
  // it is a transient float, not a navigable group.
  const groupEntries = useMemo(() => {
    if (!groupOf) return [];
    const counts = new Map<string, number>();
    for (const item of items) {
      const group = groupOf(item);
      if (group === undefined || group === 'recent') continue;
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [items, groupOf]);

  // Total items per group, for collapsed headers.
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!showGroups || !groupOf) return counts;
    for (const item of filtered) {
      const group = groupOf(item);
      if (group !== undefined) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return counts;
  }, [filtered, showGroups, groupOf]);

  const isHidden = (item: T) => {
    if (!showGroups || !groupOf) return false;
    const group = groupOf(item);
    return group !== undefined && collapsed.has(group);
  };

  // Cursor movement steps over items hidden inside collapsed groups.
  const move = (delta: 1 | -1) =>
    setCursor((c) => {
      let i = c + delta;
      while (i >= 0 && i < filtered.length && isHidden(filtered[i])) i += delta;
      return Math.max(0, Math.min(filtered.length - 1, i));
    });

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    // Clamp, then rest the cursor on a rendered item (never inside a folded group).
    setCursor((c) => {
      let i = Math.min(Math.max(0, c), Math.max(0, filtered.length - 1));
      while (i < filtered.length - 1 && isHidden(filtered[i])) i++;
      return i;
    });
  }, [filtered.length, collapsed, showGroups, groupOf, filtered]);

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

  // Mouse reporting: in the dual pane the layout owns it (it stays on for both
  // panes); narrow lists toggle it themselves while they own the keyboard.
  useEffect(() => {
    if (mousePane) return;
    if (!isActive || filtering) return;
    setMouse(true);
    return () => setMouse(false);
  }, [isActive, filtering, mousePane]);

  // Pane mouse: wheel moves the selection, a click selects the row under the
  // pointer, a fast second click opens it. Geometry comes from the layout.
  const mouseRef = useRef<(event: MouseEvent) => void>(() => {});
  mouseRef.current = (event) => {
    if (groupMode || filtering) return;
    if (!mousePane) {
      // Narrow: reporting is only on while this list owns the keyboard.
      if (!isActive) return;
      if (event.button === WHEEL_UP) move(-1);
      else if (event.button === WHEEL_DOWN) move(1);
      return;
    }
    const { x0, x1, y0 } = mousePane;
    if (event.x < x0 || event.x > x1 || event.y < y0) return;
    if (event.button === WHEEL_UP) move(-1);
    else if (event.button === WHEEL_DOWN) move(1);
    else if (event.button === 0 && !event.release) clickRow(event.y - y0);
  };
  useEffect(() => onMouse((event) => mouseRef.current(event)), []);

  /** Fold/unfold the group under the cursor. */
  function toggleGroupCollapse() {
    if (!showGroups || !groupOf) return;
    const item = filtered[cursor];
    if (!item) return;
    const group = groupOf(item);
    // `recent` is a transient float, not a navigable group — folding it would
    // hide recently-run requests with no way back.
    if (group === undefined || group === 'recent') return;
    const next = new Set(collapsed);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    // Keep at least one unfolded group — an all-folded list would strand the
    // cursor (and `r`/Enter) on invisible items.
    if (groupEntries.every((g) => next.has(g.name))) return;
    setCollapsed(next);
    // If the cursor's item just got hidden, rest it on the next visible one.
    if (next.has(group)) {
      const hidden = (it: T) => {
        const g = groupOf(it);
        return g !== undefined && next.has(g);
      };
      setCursor((c) => {
        for (let i = c + 1; i < filtered.length; i++) if (!hidden(filtered[i])) return i;
        for (let i = c - 1; i >= 0; i--) if (!hidden(filtered[i])) return i;
        return c;
      });
    }
  }

  /** A click on a pane row: select it; a fast second click opens it. */
  const lastClick = useRef<{ key: string; t: number } | null>(null);
  function clickRow(index: number) {
    const entry = entries[index];
    if (!entry || entry.type !== 'item' || !entry.item) return; // group headers: the cursor is item-indexed
    const key = keyOf(entry.item);
    const absolute = filtered.indexOf(entry.item);
    if (absolute < 0) return;
    const now = Date.now();
    const dbl = lastClick.current?.key === key && now - lastClick.current.t < 400;
    lastClick.current = { key, t: now };
    setCursor(absolute);
    if (dbl) {
      lastClick.current = null; // a triple-click must not open twice
      const action = resolveKey(step, 'enter');
      if (action) onAction(action, entry.item);
    }
  }

  useInput(
    (input, key) => {
      if (groupMode || !isActive) return;
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
        move(-1);
        return;
      }
      if (key.downArrow) {
        move(1);
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
      if (action === 'groups') {
        if (groupEntries.length) {
          setGroupCursor(0);
          setGroupMode(true);
        }
        return;
      }
      if (action === 'collapse-group') {
        toggleGroupCollapse();
        return;
      }
      if (action) onAction(action, selected);
    },
    { isActive },
  );

  // The group index owns the keyboard while it is open.
  useInput(
    (input, key) => {
      if (key.upArrow) setGroupCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setGroupCursor((c) => Math.min(groupEntries.length - 1, c + 1));
      else if (key.return) {
        const group = groupEntries[groupCursor];
        if (group) {
          if (group.name === 'other') {
            // The fallback group is not a substring of its URLs — it cannot be
            // a text filter, so Enter just unfolds it.
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete('other');
              return next;
            });
          } else {
            setQuery(group.name); // the group name is a substring of its URLs
          }
          setGroupMode(false);
        }
      } else if (input === 'u') {
        // Unfold without filtering — the only way back from a folded group.
        const group = groupEntries[groupCursor];
        if (group) setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(group.name);
          return next;
        });
      } else if (key.escape) setGroupMode(false);
    },
    { isActive: groupMode },
  );

  useEffect(() => setGroupCursor((c) => Math.min(c, Math.max(0, groupEntries.length - 1))), [groupEntries.length]);

  // Re-anchor the cursor by identity when `anchorKey` changes (a send floats
  // the request to the top while this list stays mounted in dual-pane mode).
  useEffect(() => {
    if (!anchorKey || query.trim()) return;
    const idx = filtered.findIndex((it) => keyOf(it) === anchorKey);
    if (idx >= 0) setCursor(idx);
  }, [anchorKey, filtered, query]);

  // Viewport over items; collapsed groups render as a bare header via buildEntries.
  const size = Math.max(1, maxVisible ?? Math.max(1, (process.stdout.rows ?? 24) - 8));
  const { start, end } = viewport(filtered.length, cursor, Math.max(1, size - (showGroups ? 1 : 0)));
  const visible = filtered.slice(start, end);
  const entries = buildEntries(visible, { labelOf, groupOf, showGroups, collapsed, counts: groupCounts });

  // Report the highlighted item so the detail pane can follow the cursor.
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;
  useEffect(() => {
    onHighlightRef.current?.(selected);
  }, [selected]);

  if (groupMode) {
    return (
      <Box flexDirection="column">
        <Text bold>Groups</Text>
        {groupEntries.map((group, i) => (
          <Text key={group.name} color={i === groupCursor ? 'cyan' : undefined}>
            {i === groupCursor ? '❯ ' : '  '}
            {collapsed.has(group.name) ? '▸ ' : ''}
            {group.name} ({group.count})
          </Text>
        ))}
        {groupEntries.length === 0 ? <Text dimColor>{'  (no groups)'}</Text> : null}
        <Text dimColor>Enter filters · u unfold · Esc back</Text>
      </Box>
    );
  }

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
            {'  '}◆ {entry.label}
            {entry.count != null ? ` (${entry.count})` : ''}
            {entry.collapsed ? ' ▸' : ''}
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
      <Text color={notice?.kind === 'warn' ? 'yellow' : 'cyan'}>{notice?.text ?? ' '}</Text>
      {showFooter ? (
        <>
          <Text dimColor>
            {filtered.length === items.length ? `${items.length}` : `${filtered.length}/${items.length}`}
            {noun ? ` ${noun}` : ''}
            {start > 0 ? ' ↑' : ''}
            {end < filtered.length ? ' ↓' : ''}
            {filtering ? '' : '   [/] filter'}
          </Text>
          {!filtering ? <Hints step={step} indent="  " /> : null}
        </>
      ) : null}
    </Box>
  );
}
