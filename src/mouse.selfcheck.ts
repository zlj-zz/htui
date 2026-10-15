import assert from 'node:assert/strict';
import { parseMouse, WHEEL_DOWN, WHEEL_UP } from './mouse';

// The stream listener feeds the raw form (Ink swallows mouse bytes); the
// ESC-stripped form stays accepted for callers that pre-strip.
assert.deepEqual(parseMouse('[<64;10;5M'), { button: WHEEL_UP, x: 10, y: 5, release: false });
assert.deepEqual(parseMouse('\u001B[<64;10;5M'), { button: WHEEL_UP, x: 10, y: 5, release: false });
assert.deepEqual(parseMouse('\u001B[<65;3;20M'), { button: WHEEL_DOWN, x: 3, y: 20, release: false });
assert.deepEqual(parseMouse('[<0;1;1M'), { button: 0, x: 1, y: 1, release: false });
assert.deepEqual(parseMouse('[<0;1;1m'), { button: 0, x: 1, y: 1, release: true });

// Anything that is not a mouse sequence is left to the keyboard handlers.
assert.equal(parseMouse('q'), null);
assert.equal(parseMouse('\u001B[A'), null);
assert.equal(parseMouse(''), null);
assert.equal(parseMouse('[not a mouse'), null);
assert.equal(parseMouse('[<64;10M'), null);

console.log('mouse.selfcheck: ok');
