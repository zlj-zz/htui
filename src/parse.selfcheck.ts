import assert from 'node:assert/strict';
import { parseRequests } from './parse';

// single request, no blocks
assert.deepEqual(parseRequests('GET https://example.com/a'), [
  { name: 'default', method: 'GET', url: 'https://example.com/a', line: 1 },
]);

// multiple named blocks; preamble with variables must NOT be selectable
const multi = `
@host = https://example.com

### list users
GET {{host}}/users

### create user
POST {{host}}/users
Content-Type: application/json

{ "name": "x" }

### gRPC ping
GRPC localhost:50051/api.Ping/Ping
`;
const reqs = parseRequests(multi);
assert.deepEqual(reqs.map((r) => [r.name, r.method]), [
  ['list users', 'GET'],
  ['create user', 'POST'],
  ['gRPC ping', 'GRPC'],
]);
assert.equal(reqs[0].url, '{{host}}/users');

// inline options on the request line must not break method/url extraction
assert.equal(parseRequests('### t\nGET https://ex.com/x?a=1&b=2').at(0)?.url, 'https://ex.com/x?a=1&b=2');

// empty / comments only -> nothing
assert.deepEqual(parseRequests('# just a comment\n'), []);

console.log('parse.selfcheck: ok');
