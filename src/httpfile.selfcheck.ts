import assert from 'node:assert/strict';
import { parseHeaders, withHeaders } from './httpfile';
import { parseRequests } from './parse';

const content = [
  '### a',
  'GET http://x/a',
  'X-Trace: 1',
  'Accept: application/json',
  '',
  '{"b":1}',
  '',
  '### b',
  'GET http://x/b',
].join('\n');
const req = parseRequests(content)[0];
const headers = parseHeaders(content, req);

assert.deepEqual(headers, [
  { name: 'X-Trace', value: '1' },
  { name: 'Accept', value: 'application/json' },
]);

// add
const added = withHeaders(content, req, [...headers, { name: 'X-New', value: '2' }]);
assert.deepEqual(parseHeaders(added, parseRequests(added)[0]), [
  { name: 'X-Trace', value: '1' },
  { name: 'Accept', value: 'application/json' },
  { name: 'X-New', value: '2' },
]);
assert.match(added, /\{"b":1\}/); // body preserved
assert.match(added, /### b\nGET http:\/\/x\/b/); // neighbour region untouched

// remove
const removed = withHeaders(content, req, [{ name: 'Accept', value: 'application/json' }]);
assert.deepEqual(parseHeaders(removed, parseRequests(removed)[0]), [{ name: 'Accept', value: 'application/json' }]);

// no headers originally
const noHeaders = '### c\nGET http://x/c\n\nbody';
const reqC = parseRequests(noHeaders)[0];
assert.deepEqual(parseHeaders(noHeaders, reqC), []);
const withOne = withHeaders(noHeaders, reqC, [{ name: 'A', value: 'b' }]);
assert.deepEqual(parseHeaders(withOne, parseRequests(withOne)[0]), [{ name: 'A', value: 'b' }]);
assert.match(withOne, /body/);

// `# @name` (which sits before the request line) is preserved as-is
const named = '### d\n# @name dd\nGET http://x/d\nX-A: 1\n\n';
assert.deepEqual(parseHeaders(named, parseRequests(named)[0]), [{ name: 'X-A', value: '1' }]);
const rewritten = withHeaders(named, parseRequests(named)[0], [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]);
assert.match(rewritten, /# @name dd/); // preserved

// gRPC channel options are dotted headers — they must stay headers, not body
const opts = '### g\nGRPC host/svc/method\nx-token: abc\ngrpc.max_receive_message_length: 100\n\n{"greeting":"world"}';
const oreq = parseRequests(opts)[0];
assert.deepEqual(parseHeaders(opts, oreq), [
  { name: 'x-token', value: 'abc' },
  { name: 'grpc.max_receive_message_length', value: '100' },
]);
const optRewritten = withHeaders(opts, oreq, [
  { name: 'x-token', value: 'abc' },
  { name: 'grpc.max_receive_message_length', value: '200' },
]);
assert.match(optRewritten, /grpc\.max_receive_message_length: 200/);
assert.match(optRewritten, /\{"greeting":"world"\}/); // body still the body

console.log('httpfile.selfcheck: ok');
