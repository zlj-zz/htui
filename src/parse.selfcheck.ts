import assert from 'node:assert/strict';
import { parseRequests } from './parse';

// single request, no blocks -> "default", not addressable by name
assert.deepEqual(parseRequests('GET https://example.com/a'), [
  { name: 'default', method: 'GET', url: 'https://example.com/a', line: 1, startLine: 1, endLine: 1 },
]);

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
assert.deepEqual(
  reqs.map((r) => [r.name, r.method, r.line]),
  [
    ['list users', 'GET', 5],
    ['create user', 'POST', 8],
    ['gRPC ping', 'GRPC', 14],
  ],
);
// the preamble (variables/scripts) is never a selectable request
assert.ok(reqs.every((r) => r.startLine >= 4));
// slice boundaries: each region ends just before the next `###`
assert.deepEqual(
  reqs.map((r) => [r.startLine, r.endLine]),
  [
    [4, 6],
    [7, 12],
    [13, 15],
  ],
);

// `# @name` wins over the `### title`
const named = parseRequests('### Title\n# @name meta\nGET https://x/y');
assert.equal(named[0].name, 'meta');
assert.equal(named[0].startLine, 1);

// anonymous `###` block -> synthesized name
assert.deepEqual(parseRequests('###\nGET http://x/y'), [
  { name: 'request@1', method: 'GET', url: 'http://x/y', line: 2, startLine: 1, endLine: 2 },
]);

// inline options on the request line must not break method/url extraction
assert.equal(parseRequests('### t\nGET https://ex.com/x?a=1&b=2').at(0)?.url, 'https://ex.com/x?a=1&b=2');

// empty / comments only -> nothing
assert.deepEqual(parseRequests('# just a comment\n'), []);

console.log('parse.selfcheck: ok');
