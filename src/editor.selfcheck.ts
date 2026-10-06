import assert from 'node:assert/strict';
import { editorInvocation } from './editor';

// vim family: +N
assert.deepEqual(editorInvocation('a.http', 12, { VISUAL: 'nvim' }), { bin: 'nvim', args: ['+12', 'a.http'] });
assert.deepEqual(editorInvocation('a.http', 12, { VISUAL: '/usr/bin/vim' }), {
  bin: '/usr/bin/vim',
  args: ['+12', 'a.http'],
});

// VS Code: --goto file:line
assert.deepEqual(editorInvocation('a.http', 12, { EDITOR: 'code --wait' }), {
  bin: 'code',
  args: ['--wait', '--goto', 'a.http:12'],
});

// unknown editor: open the file, no line flag
assert.deepEqual(editorInvocation('a.http', 12, { EDITOR: 'myedit' }), { bin: 'myedit', args: ['a.http'] });

// fallback + precedence
assert.deepEqual(editorInvocation('a.http', 3, {}), { bin: 'vi', args: ['+3', 'a.http'] });
assert.equal(editorInvocation('a.http', 1, { VISUAL: 'nvim', EDITOR: 'code' }).bin, 'nvim');

console.log('editor.selfcheck: ok');
