/**
 * The key map, in one place. Every screen resolves its keys through
 * `resolveKey`, so a key cannot mean different things on different screens, and
 * the footer hints are generated from the same tables it dispatches on — they
 * cannot disagree with what is actually bound.
 *
 * Pure: no React, no IO, so keys.selfcheck can assert the whole model.
 *
 * Layer rule: `q` quits, `?` helps, `Esc` goes back — on every screen,
 * including forms. Inside a text input none of this applies (the input owns the
 * keyboard), which is why a form only consults the map when no field is up.
 */
export type Step =
  | 'file'
  | 'request'
  | 'search'
  | 'import'
  | 'new'
  | 'env'
  | 'headers'
  | 'pick-headers'
  | 'preview'
  | 'sending'
  | 'result'
  | 'history'
  | 'help'
  | 'error';

export type Action =
  | 'help'
  | 'quit'
  | 'back'
  | 'search'
  | 'open'
  | 'preview'
  | 'send'
  | 'resend'
  | 'run'
  | 'chain'
  | 'edit'
  | 'edit-preview'
  | 'headers'
  | 'fold-headers'
  | 'env'
  | 'select-env'
  | 'import'
  | 'history'
  | 'vars'
  | 'copy-body'
  | 'copy-curl'
  | 'save'
  | 'search-body'
  | 'add-header'
  | 'edit-header'
  | 'delete-header'
  | 'edit-field'
  | 'import-headers'
  | 'overwrite';

/** Normalized key chord: `a`, `R`, `?`, `enter`, `escape`, `ctrl-e`. */
export type Chord = string;

export interface KeyLike {
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
}

export function chordOf(input: string, key: KeyLike): Chord | null {
  if (key.return) return 'enter';
  if (key.escape) return 'escape';
  if (key.ctrl && input.length === 1) return `ctrl-${input.toLowerCase()}`;
  if (input.length === 1) return input;
  return null;
}

export function chordLabel(chord: Chord): string {
  if (chord === 'enter') return 'Enter';
  if (chord === 'escape') return 'Esc';
  if (chord.startsWith('ctrl-')) return `Ctrl-${chord.slice(5).toUpperCase()}`;
  return chord;
}

/** Available on every screen. */
const GLOBAL: Record<Chord, Action> = { '?': 'help', escape: 'back', q: 'quit' };

/** `Enter` is the screen's primary action — the only key that differs by design. */
const PRIMARY: Partial<Record<Step, Action>> = {
  file: 'open',
  request: 'preview',
  search: 'preview',
  history: 'resend',
  env: 'select-env',
  headers: 'edit-header',
  'pick-headers': 'open',
  preview: 'send',
};

/**
 * Screen-local actions. Deliberately narrow: `s`/`t`/`v`/`i`/`Ctrl-F` are *not*
 * global yet — globalising them is a separate decision, and this table is where
 * it would happen.
 */
const PER_STEP: Partial<Record<Step, Record<Chord, Action>>> = {
  file: { 'ctrl-e': 'edit', i: 'import', s: 'env', 'ctrl-f': 'search' },
  request: {
    r: 'run',
    R: 'chain',
    h: 'headers',
    i: 'import',
    s: 'env',
    'ctrl-e': 'edit',
    'ctrl-f': 'search',
  },
  search: {},
  history: {},
  env: { 'ctrl-e': 'edit' },
  headers: { a: 'add-header', d: 'delete-header', i: 'import-headers' },
  preview: {
    'ctrl-e': 'edit-preview',
    e: 'edit-field',
    a: 'add-header',
    d: 'delete-header',
    'ctrl-s': 'save',
    y: 'copy-body',
    Y: 'copy-curl',
  },
  import: { o: 'overwrite' },
  error: { r: 'run', R: 'chain', 'ctrl-e': 'edit' },
  result: {
    r: 'run',
    R: 'chain',
    'ctrl-e': 'edit',
    h: 'fold-headers',
    '/': 'search-body',
    v: 'vars',
    t: 'history',
    w: 'save',
  },
};

export function resolveKey(step: Step, chord: Chord | null): Action | null {
  if (!chord) return null;
  if (chord === 'enter') return PRIMARY[step] ?? null;
  return PER_STEP[step]?.[chord] ?? GLOBAL[chord] ?? null;
}

export const ACTION_LABEL: Record<Action, string> = {
  help: 'help',
  quit: 'quit',
  back: 'back',
  search: 'search',
  open: 'open',
  preview: 'preview',
  send: 'send',
  resend: 'resend',
  run: 'run',
  chain: 'chain',
  edit: 'edit',
  'edit-preview': 'edit',
  headers: 'headers',
  'fold-headers': 'headers',
  env: 'env',
  'select-env': 'select',
  import: 'import',
  history: 'history',
  vars: 'vars',
  'copy-body': 'copy',
  'copy-curl': 'curl',
  save: 'save',
  'search-body': 'search body',
  'add-header': 'add',
  'edit-header': 'edit',
  'delete-header': 'delete',
  'edit-field': 'edit line',
  'import-headers': 'reuse headers',
  overwrite: 'overwrite',
};

/** A screen's own keys: its `Enter` action plus its per-screen verbs. */
export function screenHints(step: Step): Array<{ key: string; label: string }> {
  const hints: Array<{ key: string; label: string }> = [];
  const primary = PRIMARY[step];
  if (primary) hints.push({ key: 'Enter', label: ACTION_LABEL[primary] });
  for (const [chord, action] of Object.entries(PER_STEP[step] ?? {})) {
    hints.push({ key: chordLabel(chord), label: ACTION_LABEL[action] });
  }
  return hints;
}

/** Footer hints for a screen: its own keys plus the ones available everywhere. */
export function hintsFor(step: Step): Array<{ key: string; label: string }> {
  return [
    ...screenHints(step),
    ...Object.entries(GLOBAL).map(([chord, action]) => ({ key: chordLabel(chord), label: ACTION_LABEL[action] })),
  ];
}

/**
 * Pack the hints into lines that fit `width`, never splitting one — a footer
 * that breaks `[i]` away from `import` is unreadable. A hint alone wider than
 * `width` still gets its own line.
 */
export function hintLines(step: Step, width: number): string[] {
  const items = hintsFor(step).map((h) => `[${h.key}] ${h.label}`);
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const candidate = current ? `${current}  ${item}` : item;
    if (current && candidate.length > width) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
