/**
 * Transient feedback shown above a screen's footer.
 *
 * Policy: an acknowledgement fades (the information was consumed the moment
 * the key was pressed), while a warning stays until the next action — a
 * warning the user never saw is far worse than a stale acknowledgement.
 * Pure — unit-checked in notice.selfcheck.ts.
 */
export type NoticeKind = 'info' | 'warn';

export interface Notice {
  text: string;
  kind: NoticeKind;
}

/** How long a notice lives, in ms — `null` means "until the next action". */
export function noticeTtl(kind: NoticeKind): number | null {
  return kind === 'info' ? 2000 : null;
}

/**
 * A pending fade must not clear a newer notice: every `showNotice` takes a
 * generation number, and only the timer that still owns the current one clears.
 */
export function isStaleGeneration(timer: number, current: number): boolean {
  return timer !== current;
}
