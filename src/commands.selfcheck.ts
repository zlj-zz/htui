import assert from 'node:assert/strict';
import { parseFlags } from './commands';

// all flags
assert.deepEqual(
  parseFlags(['file.http', '-n', 'x', '--line', '3', '--chain', '--json', '-e', 'dev', '--local', '--force']),
  { force: true, local: true, chain: true, json: true, reflection: false, name: 'x', line: 3, env: 'dev', positional: ['file.http'] },
);

// `--flag=value` form
assert.equal(parseFlags(['--name=foo']).name, 'foo');
assert.equal(parseFlags(['--env=prod']).env, 'prod');
assert.equal(parseFlags(['--base-url=http://x']).baseUrl, 'http://x');

// bad input is reported, not silently accepted (an agent's typo must not shift the file arg)
assert.equal(parseFlags(['--line', 'abc']).error, '--line requires a positive integer');
assert.equal(parseFlags(['--line', '0']).error, '--line requires a positive integer');
const bad = parseFlags(['--bogus', 'file.http']);
assert.equal(bad.error, 'unknown option: --bogus');
assert.deepEqual(bad.positional, ['file.http']); // the option is not mistaken for the file

// a lone `-` is a positional, not an unknown option
assert.deepEqual(parseFlags(['-']).positional, ['-']);

console.log('commands.selfcheck: ok');
