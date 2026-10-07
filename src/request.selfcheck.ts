import assert from 'node:assert/strict';
import { appendRegion, modelSlice, parseRegionText, regionText, requestModel } from './request';
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

// body parsing + a region whose request line has no headers
const withBody = '### p\nPOST http://x/p\nContent-Type: application/json\n\n{"a":1}\n{"b":2}';
const post = parseRequests(withBody)[0];
assert.deepEqual(requestModel(withBody, post), {
  method: 'POST',
  url: 'http://x/p',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: '{"a":1}\n{"b":2}',
});

// the .http text keeps a body verbatim — no \n / \" escapes to hand-manage
const jsonBody = '{\n  "title": "hello",\n  "body": "from htui"\n}';
const edited = {
  method: 'POST',
  url: 'https://other/x?q=1',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: jsonBody,
};
const text = regionText(edited);
assert.equal(text, `POST https://other/x?q=1\nContent-Type: application/json\n\n${jsonBody}\n`);
assert.deepEqual(parseRegionText(text), edited); // round-trip

// a bodyless request round-trips too
assert.deepEqual(parseRegionText(regionText(model)), model);

// an edited model produces preamble + rebuilt region (deps stay runnable)
const slice = modelSlice(content, me, edited);
assert.match(slice, /^@host = http:\/\/x/);
assert.match(slice, /### login/);
assert.match(slice, /POST \{\{host\}\}\/login/); // prerequisite region kept
assert.match(slice, /### me/); // region marker (above the request line) kept
assert.match(slice, /X-T|POST https:\/\/other\/x\?q=1/);
assert.ok(slice.includes(jsonBody)); // body verbatim
assert.doesNotMatch(slice, /Bearer/); // old header replaced, not appended

// parse errors are clear, not silent
assert.throws(() => parseRegionText('not a request line'), /METHOD url/);

// appendRegion: create + append round-trips through the parser
const fresh = appendRegion(
  '',
  { method: 'GET', url: '{{grpcHost}}/user.v1.UserService/GetUser', headers: [{ name: 'x-token', value: 'abc' }], body: '{"greeting": "world"}' },
  'new-request',
);
assert.match(fresh, /^### new-request\n# @name new-request\nGET \{\{grpcHost\}\}\/user\.v1\.UserService\/GetUser\nx-token: abc\n\n\{"greeting": "world"\}\n$/);
const listed = parseRequests(fresh);
assert.equal(listed.length, 1);
assert.equal(listed[0].name, 'new-request');
const grown = appendRegion(
  fresh,
  { method: 'POST', url: '{{baseUrl}}/pets', headers: [], body: '{"a":1}' },
  'create-pet',
);
assert.equal(parseRequests(grown).length, 2);
assert.ok(grown.includes('### new-request')); // the first region is untouched
assert.ok(grown.includes('{"a":1}'));

console.log('request.selfcheck: ok');
