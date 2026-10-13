import assert from 'node:assert/strict';
import { chordLabel, chordOf, hintLines, hintsFor, resolveKey, type Step } from './keys';

// chord normalization
assert.equal(chordOf('e', { ctrl: true }), 'ctrl-e');
assert.equal(chordOf('E', { ctrl: true }), 'ctrl-e');
assert.equal(chordOf('', { return: true }), 'enter');
assert.equal(chordOf('', { escape: true }), 'escape');
assert.equal(chordOf('q', {}), 'q');
assert.equal(chordOf('', {}), null);
assert.equal(chordOf('\u001B[<64;1;1M', {}), null); // a mouse sequence — the list handles it

// globals hold on every screen, forms included
const steps: Step[] = [
  'file', 'request', 'search', 'import', 'env', 'env-vars', 'headers', 'pick-headers', 'preview',
  'sending', 'result', 'history', 'help', 'error',
];
for (const step of steps) {
  assert.equal(resolveKey(step, 'q'), 'quit', `q quits on ${step}`);
  assert.equal(resolveKey(step, '?'), 'help', `? helps on ${step}`);
  assert.equal(resolveKey(step, 'escape'), 'back', `Esc backs on ${step}`);
}

// Enter is the screen's primary action
assert.equal(resolveKey('file', 'enter'), 'open');
assert.equal(resolveKey('request', 'enter'), 'preview');
assert.equal(resolveKey('search', 'enter'), 'preview');
assert.equal(resolveKey('headers', 'enter'), 'edit-header');
assert.equal(resolveKey('preview', 'enter'), 'send');
assert.equal(resolveKey('history', 'enter'), 'resend');
assert.equal(resolveKey('env', 'enter'), 'select-env');
assert.equal(resolveKey('result', 'enter'), null);

// edit is Ctrl-E wherever it exists; the light line edit `e` lives on preview only
assert.equal(resolveKey('file', 'ctrl-e'), 'edit');
assert.equal(resolveKey('request', 'ctrl-e'), 'edit');
assert.equal(resolveKey('env', 'ctrl-e'), 'edit');
assert.equal(resolveKey('result', 'ctrl-e'), 'edit');
assert.equal(resolveKey('preview', 'ctrl-e'), 'edit-preview');
assert.equal(resolveKey('request', 'e'), null);
assert.equal(resolveKey('result', 'e'), null);
assert.equal(resolveKey('preview', 'e'), 'edit-field');
assert.equal(resolveKey('preview', 'a'), 'add-header');
assert.equal(resolveKey('preview', 'd'), 'delete-header');
assert.equal(resolveKey('preview', 'ctrl-s'), 'save'); // write the region back

// header reuse: the picker gets its own step so `Enter` means pick
assert.equal(resolveKey('headers', 'i'), 'import-headers');
assert.equal(resolveKey('pick-headers', 'enter'), 'import-headers');
assert.equal(resolveKey('pick-headers', 'escape'), 'back');

// env screen: Enter selects (hot path), e opens the structured vars editor,
// a/d add/delete envs — ctrl-e stays the $EDITOR escape hatch
assert.equal(resolveKey('env', 'e'), 'edit-env-vars');
assert.equal(resolveKey('env', 'a'), 'add-env');
assert.equal(resolveKey('env', 'd'), 'delete-env');
assert.equal(resolveKey('env', 'ctrl-e'), 'edit');
assert.equal(resolveKey('env-vars', 'enter'), 'edit-header');
assert.equal(resolveKey('env-vars', 'a'), 'add-var');
assert.equal(resolveKey('env-vars', 'h'), 'add-header');
assert.equal(resolveKey('env-vars', 'd'), 'delete-header');

// `r` runs the request on both the request list and the result screen
assert.equal(resolveKey('request', 'r'), 'run');
assert.equal(resolveKey('result', 'r'), 'run');

// `h` is "headers" on both, but a different action
assert.equal(resolveKey('request', 'h'), 'headers');
assert.equal(resolveKey('result', 'h'), 'fold-headers');

// body search on the result screen
assert.equal(resolveKey('result', '/'), 'search-body');
assert.ok(hintsFor('result').some((h) => h.key === '/' && h.label === 'search body'));

// copy lives on the preview (request body / curl) and on result (response body)
assert.equal(resolveKey('request', 'y'), null);
assert.equal(resolveKey('result', 'y'), 'copy-resp');
assert.equal(resolveKey('preview', 'y'), 'copy-body');
assert.equal(resolveKey('preview', 'Y'), 'copy-curl');

// scopes deliberately left narrow (not globalised)
assert.equal(resolveKey('search', 'r'), null);
assert.equal(resolveKey('result', 's'), null);
assert.equal(resolveKey('history', 'ctrl-f'), null);
assert.equal(resolveKey('env', 'i'), null);

// an error screen keeps the verbs that fix the request; the response-only ones
// (y/Y/w/v/t/h) stay off it, since there is no response to act on
assert.equal(resolveKey('error', 'r'), 'run');
assert.equal(resolveKey('error', 'ctrl-e'), 'edit');
assert.equal(resolveKey('error', 'y'), null);
assert.equal(resolveKey('error', 'v'), null);

// `b` is gone — Esc is the only way back
assert.equal(resolveKey('result', 'b'), null);
assert.equal(resolveKey('error', 'b'), null);

// hints are generated from the same table
const request = hintsFor('request');
const hint = (key: string) => request.find((h) => h.key === key)?.label;
assert.equal(hint('Enter'), 'preview');
assert.equal(hint('Ctrl-E'), 'edit');
assert.equal(hint('r'), 'run');
assert.equal(hint('?'), 'help');
assert.equal(hint('Esc'), 'back');
assert.equal(hint('q'), 'quit');
assert.equal(chordLabel('ctrl-e'), 'Ctrl-E');
assert.equal(chordLabel('enter'), 'Enter');

// hints pack to the terminal width without splitting a hint
const packed = hintLines('request', 40);
assert.ok(packed.length > 1);
assert.ok(packed.every((line) => line.length <= 40));
const requestHints = hintsFor('request').map((h) => `[${h.key}] ${h.label}`);
assert.ok(requestHints.every((h) => packed.some((line) => line.includes(h))));
// no room at all: one hint per line, nothing lost
assert.equal(hintLines('request', 0).length, requestHints.length);

console.log('keys.selfcheck: ok');
