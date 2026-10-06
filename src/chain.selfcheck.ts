import assert from 'node:assert/strict';
import { sliceUpTo, summarizeChain } from './chain';
import { parseRequests } from './parse';

const file = [
  '@baseUrl = http://x', // 1  (preamble)
  '', //                    2
  '### login', //           3
  'POST {{baseUrl}}/login', // 4
  '', //                    5
  '### me', //              6
  'GET {{baseUrl}}/me', //  7
  '# @name me', //          8  (still inside the `me` region)
  '', //                    9
  '### other', //           10
  'GET {{baseUrl}}/other', // 11
].join('\n');

const reqs = parseRequests(file);
assert.deepEqual(reqs.map((r) => r.name), ['login', 'me', 'other']);

// slicing up to `me` keeps the preamble + both earlier regions, drops `other`
const sliced = sliceUpTo(file, reqs[1]);
assert.match(sliced, /@baseUrl/);
assert.match(sliced, /### login/);
assert.match(sliced, /### me/);
assert.doesNotMatch(sliced, /other/);
// and the slice re-parses to exactly the prerequisite + target
assert.deepEqual(parseRequests(sliced).map((r) => r.name), ['login', 'me']);

// summarize: target is last, everything before is a prerequisite
const summary = summarizeChain([
  { name: 'login', response: { statusCode: 200 } },
  { name: 'me', response: { statusCode: 200, body: 'ok' } },
]);
assert.equal(summary.target?.name, 'me');
assert.deepEqual(summary.prerequisites, [{ name: 'login', ok: true, statusCode: 200, message: undefined }]);

const failed = summarizeChain([
  { name: 'login', response: { statusCode: 500 }, testResults: [{ status: 'ERROR', message: 'bad creds' }] },
  { name: 'me' },
]);
assert.equal(failed.prerequisites[0].ok, false);
assert.equal(failed.prerequisites[0].message, 'bad creds');

assert.deepEqual(summarizeChain([]), { prerequisites: [] });

console.log('chain.selfcheck: ok');
