import assert from 'node:assert/strict';
import { modelSlice, parseRegionText, regionText, requestModel, toJson } from './request';
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

// the JSON view nests a JSON body (no escapes leak); a non-JSON body stays text
assert.deepEqual(JSON.parse(toJson(edited)).body, { title: 'hello', body: 'from htui' });
assert.deepEqual(JSON.parse(toJson({ ...edited, body: 'a=1&b=2' })).body, 'a=1&b=2');

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

console.log('request.selfcheck: ok');
