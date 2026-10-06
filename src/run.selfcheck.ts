import assert from 'node:assert/strict';
import { parseRequests } from './parse';
import { selectRequest } from './run';

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

console.log('run.selfcheck: ok');
