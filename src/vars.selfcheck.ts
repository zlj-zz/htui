import assert from 'node:assert/strict';
import { fileVars, resolveVars } from './vars';

// file @var declarations (file-global; indented body lines are not declarations)
const content = [
  '@host = https://api.example.com',
  '@token = abc.def.ghi',
  '@empty =',
  '',
  '### create',
  'POST {{host}}/v1/create',
  'Authorization: Bearer {{token}}',
  '',
  '{"contact": "@not-a-var = x"}',
].join('\n');
assert.deepEqual(fileVars(content), { host: 'https://api.example.com', token: 'abc.def.ghi', empty: '' });

// plain replacement, including inside a body
assert.equal(
  resolveVars('POST {{host}}/x\nAuthorization: Bearer {{token}}', { host: 'https://a', token: 't' }).text,
  'POST https://a/x\nAuthorization: Bearer t',
);

// spacing variants and repeated occurrences
assert.equal(resolveVars('{{a}}/{{ a }}/{{a}}', { a: 'v' }).text, 'v/v/v');

// chained variables resolve over passes
assert.equal(resolveVars('{{baseUrl}}/pets', { baseUrl: '{{scheme}}://h', scheme: 'https' }).text, 'https://h/pets');

// unknown / dynamic references stay and are reported
const dynamic = resolveVars('GET {{host}}/x?r={{$random}}&t={{login.response.body.$.token}}', { host: 'https://a' });
assert.equal(dynamic.text, 'GET https://a/x?r={{$random}}&t={{login.response.body.$.token}}');
assert.deepEqual(dynamic.unresolved.sort(), ['$random', 'login.response.body.$.token']);

console.log('vars.selfcheck: ok');
