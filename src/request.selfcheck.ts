import assert from 'node:assert/strict';
import { appendRegion, mergeEnvHeaders, modelSlice, parseRegionText, regionText, replaceRegion, requestModel } from './request';
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
assert.match(slice, /POST \{\{host\}\}\/login/); // earlier region kept
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

// replaceRegion: in-place write-back keeps the preamble and every other region
const saved = replaceRegion(content, me, edited);
assert.match(saved, /^@host = http:\/\/x/); // file preamble kept
assert.match(saved, /### me/); // region preamble (### / @name) kept
assert.match(saved, /### login/); // earlier region untouched
assert.match(saved, /POST https:\/\/other\/x\?q=1/);
assert.ok(saved.includes(jsonBody)); // body verbatim
assert.doesNotMatch(saved, /Bearer/); // old header replaced, not appended
assert.ok(parseRequests(saved).some((r) => r.name === 'me')); // still re-parses

// a middle region: the blank line before the next `###` must survive
const two = ['### a', 'GET http://x/a', '', '### b', 'GET http://x/b', ''].join('\n');
const a = parseRequests(two).find((r) => r.name === 'a');
assert.ok(a);
assert.equal(
  replaceRegion(two, a, { method: 'GET', url: 'http://x/a2', headers: [], body: '' }),
  ['### a', 'GET http://x/a2', '', '### b', 'GET http://x/b', ''].join('\n'),
);

// a whole-file request (no `###`, startLine = 1)
const whole = 'GET http://x/y\nX: 1\n';
const w = parseRequests(whole)[0];
assert.ok(w);
assert.equal(
  replaceRegion(whole, w, { method: 'POST', url: 'http://x/z', headers: [{ name: 'A', value: 'b' }], body: '' }),
  'POST http://x/z\nA: b\n',
);

// CRLF files keep CRLF
const crlf = '### a\r\nGET http://x/a\r\nX: 1\r\n';
const ca = parseRequests(crlf)[0];
assert.ok(ca);
assert.equal(
  replaceRegion(crlf, ca, { method: 'GET', url: 'http://x/a', headers: [{ name: 'X', value: '2' }], body: '' }),
  '### a\r\nGET http://x/a\r\nX: 2\r\n',
);

// mergeEnvHeaders: request wins, env fills the rest (case-insensitive)
const withEnv = mergeEnvHeaders(
  { method: 'GET', url: 'http://x', headers: [{ name: 'authorization', value: 'req' }], body: '' },
  { Authorization: 'global', 'X-Trace': 't1' },
);
assert.deepEqual(withEnv.headers, [
  { name: 'authorization', value: 'req' },
  { name: 'X-Trace', value: 't1' },
]);

console.log('request.selfcheck: ok');
