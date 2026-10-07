import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRequests } from './parse';
import { httpyacOnPath, selectRequest } from './run';

const reqs = parseRequests(
  ['### login', 'POST http://x/login', '', '### me', '# @name me', 'GET http://x/me'].join('\n'),
);
assert.deepEqual(reqs.map((r) => r.name), ['login', 'me']);

// by resolved name (title + @name both addressable)
assert.equal(selectRequest(reqs, { name: 'login' }).req?.name, 'login');
assert.equal(selectRequest(reqs, { name: 'me' }).req?.name, 'me');
assert.match(selectRequest(reqs, { name: 'nope' }).error ?? '', /no request named/);

// by line, anywhere inside the region
assert.equal(selectRequest(reqs, { line: 2 }).req?.name, 'login');
assert.equal(selectRequest(reqs, { line: 5 }).req?.name, 'me');
assert.match(selectRequest(reqs, { line: 99 }).error ?? '', /no request at line/);

// no selector: only unambiguous when there is a single request
assert.match(selectRequest(reqs, {}).error ?? '', /multiple requests/);
assert.equal(selectRequest(parseRequests('GET http://x/only'), {}).req?.name, 'default');

// PATH scan: spots a fake executable, rejects an empty / missing PATH
const dir = mkdtempSync(path.join(os.tmpdir(), 'htui-run-'));
try {
  writeFileSync(path.join(dir, 'httpyac'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(httpyacOnPath(dir), true);
  assert.equal(httpyacOnPath(''), false);
  assert.equal(httpyacOnPath(path.join(dir, 'nope')), false);
  assert.equal(httpyacOnPath([dir, path.join(dir, 'empty')].join(path.delimiter)), true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('run.selfcheck: ok');