/**
 * Pure list logic: matching, grouping, viewport math.
 * No React, no I/O — everything here is unit-checkable.
 */

export interface DisplayEntry<T> {
  type: 'group' | 'item';
  label: string;
  item?: T;
}

/** Normalize so macOS NFD paths (APFS) and NFC input compare equal. */
function norm(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/**
 * Case-insensitive substring match. Returns the match offset (0 = prefix =
 * best), or null when there is no match.
 */
export function scoreMatch(query: string, target: string): number | null {
  const q = norm(query);
  if (!q) return 0;
  const idx = norm(target).indexOf(q);
  return idx < 0 ? null : idx;
}

/** Filter + rank (earlier match first, then original order). Stable. */
export function filterAndRank<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, index) => ({ item, index, score: scoreMatch(query, key(item)) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.item);
}

/** Flatten items into render entries, inserting a dim group header on change. */
export function buildEntries<T>(
  items: T[],
  opts: { labelOf: (t: T) => string; groupOf?: (t: T) => string | undefined; showGroups: boolean },
): DisplayEntry<T>[] {
  const entries: DisplayEntry<T>[] = [];
  let last: string | undefined;
  for (const item of items) {
    const group = opts.showGroups ? opts.groupOf?.(item) : undefined;
    if (group !== undefined && group !== last) {
      entries.push({ type: 'group', label: group });
      last = group;
    }
    entries.push({ type: 'item', label: opts.labelOf(item), item });
  }
  return entries;
}

/** Visible slice [start, end) that keeps `cursor` on screen. */
export function viewport(total: number, cursor: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = Math.min(Math.max(0, cursor - Math.floor(size / 2)), total - size);
  return { start, end: start + size };
}

/** Stable partition: items with a rank (lower = more recent) float to the top
 *  in rank order; the rest keep their original order. */
export function floatToTop<T>(items: T[], rank: (t: T) => number): T[] {
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** Cap what we render — an unbounded body is the biggest screen-flood source. */
export const MAX_BODY_LINES = 200;

export function clipBody(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_BODY_LINES) return text;
  return `${lines.slice(0, MAX_BODY_LINES).join('\n')}\n… (+${lines.length - MAX_BODY_LINES} more lines)`;
}
