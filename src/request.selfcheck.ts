import assert from 'node:assert/strict';
import { fromJson, modelSlice, requestModel, toJson } from './request';
import { parseRequests } from './parse';

const content = [
  '@host = http://x',
  '',
  '### login',
  '# @name login',
  'POST {{host}}/login',
  'Content-Type: application/json',
  '',
  '{"u":"a"}',
  '',
  '### me',
  '# @name me',
  'GET {{host}}/me',
  'Authorization: Bearer {{login.response.body.$.t}}',
].join('\n');

const me = parseRequests(content).find((r) => r.name === 'me');
assert.ok(me);
const model = requestModel(content, me);
assert.deepEqual(model, {
  method: 'GET',
  url: '{{host}}/me',
  headers: [{ name: 'Authorization', value: 'Bearer {{login.response.body.$.t}}' }],
  body: '',
});

// JSON round-trip
assert.deepEqual(fromJson(toJson(model)), model);

// body parsing + a region whose request line has no headers
const withBody = '### p\nPOST http://x/p\nContent-Type: application/json\n\n{"a":1}\n{"b":2}';
const post = parseRequests(withBody)[0];
assert.deepEqual(requestModel(withBody, post), {
  method: 'POST',
  url: 'http://x/p',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: '{"a":1}\n{"b":2}',
});

// an edited model produces preamble + rebuilt region (deps stay runnable)
const edited = { method: 'POST', url: 'https://other/x?q=1', headers: [{ name: 'X-T', value: '1' }], body: '{"a":1}' };
const slice = modelSlice(content, me, edited);
assert.match(slice, /^@host = http:\/\/x/);
assert.match(slice, /### login/);
assert.match(slice, /POST \{\{host\}\}\/login/); // prerequisite region kept
assert.match(slice, /### me/); // region marker (above the request line) kept
assert.match(slice, /POST https:\/\/other\/x\?q=1/);
assert.match(slice, /X-T: 1/);
assert.match(slice, /\{"a":1\}/);
assert.doesNotMatch(slice, /Bearer/); // old header replaced, not appended

// validation errors are clear, not bare SyntaxErrors
assert.throws(() => fromJson('{'), /invalid JSON/);
assert.throws(() => fromJson('[]'), /expected a JSON object/);
assert.throws(() => fromJson('{"method":"GET"}'), /"url"/);
assert.throws(() => fromJson('{"method":"GET","url":"x","headers":{"A":1}}'), /must be a string/);

console.log('request.selfcheck: ok');
