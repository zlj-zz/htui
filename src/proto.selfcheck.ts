import assert from 'node:assert/strict';
import { parseRequests } from './parse';
import { parseProtoServices, protoToHttp } from './proto';

// A mundane proto whose strings/comments would break a naive scanner: an
// unbalanced `}` and a `//` inside strings, a `service` keyword in a comment,
// multi-line and same-line rpcs, proto3 `{}` bodies, streaming both ways.
const protoText = [
  'syntax = "proto3";',
  '',
  'package user.v1;',
  '',
  'import "google/protobuf/timestamp.proto";',
  '',
  '// a comment mentioning rpc fake (Fake) returns (Fake); must be ignored',
  '/* block comment: rpc fake (Fake) returns (Fake); and { braces } too */',
  'message GetUserRequest {',
  '  string id = 1; // unbalanced brace in a string: "}"',
  '}',
  '',
  'message User {',
  '  string url = 1; // "https://example.com/v1/}"',
  '  option (ext) = { pattern: "/v1/}" };',
  '}',
  '',
  '// service NotReal { rpc Not (A) returns (B); }  — must not open a service',
  'service UserService {',
  '  rpc GetUser (GetUserRequest) returns (User);',
  '  rpc Watch (WatchRequest) returns (stream User);',
  '  rpc Send (stream User) returns (User) {}',
  '  rpc Wrapped (',
  '      WrappedRequest) returns (WrappedResponse);',
  '  option (google.api.http) = { get: "/v1/users/{id}" };',
  '}',
  '',
  'service AdminService {',
  '  rpc GetUser (GetUserRequest) returns (User);  // same method name on purpose',
  '}',
].join('\n');

const services = parseProtoServices(protoText);
assert.deepEqual(
  services.map((s) => s.fullName),
  ['user.v1.UserService', 'user.v1.AdminService'],
);
const [user, admin] = services;
assert.deepEqual(
  user.methods.map((m) => [m.name, m.serverStreaming, m.clientStreaming]),
  [
    ['GetUser', false, false],
    ['Watch', true, false],
    ['Send', false, true],
    ['Wrapped', false, false],
  ],
);
assert.equal(user.methods[0].requestType, 'GetUserRequest');
assert.deepEqual(admin.methods.map((m) => m.name), ['GetUser']);

// generation: header + proto line + one region per method, names unique
const emitted = protoToHttp([{ relPath: 'user.proto', text: protoText }], { source: 'user.proto', baseUrl: 'localhost:50051' });
assert.equal(emitted.vars.grpcHost, 'localhost:50051');
assert.match(emitted.text, /^# source: user\.proto · gRPC · 5 methods/);
assert.match(emitted.text, /proto < \.\/proto\/user\.proto/);
assert.match(emitted.text, /# request: GetUserRequest/); // the type name as the proto wrote it

const regions = parseRequests(emitted.text);
assert.equal(regions.length, 5);
assert.equal(regions.every((r) => r.method === 'GRPC'), true);
const names = regions.map((r) => r.name);
assert.equal(new Set(names).size, names.length, '@name must be unique');
assert.ok(names.includes('user_v1_UserService_GetUser'));
assert.ok(names.includes('user_v1_AdminService_GetUser'));

// reflection mode: no proto copies, reflection meta instead
const refl = protoToHttp([{ relPath: 'user.proto', text: protoText }], { source: 'user.proto', reflection: true });
assert.doesNotMatch(refl.text, /proto < /);
assert.match(refl.text, /# @grpc-reflection/);

// explicit base url wins and is a locked env key
const custom = protoToHttp([{ relPath: 'user.proto', text: protoText }], { source: 'x', baseUrl: 'api.internal:7100' });
assert.equal(custom.vars.grpcHost, 'api.internal:7100');

// an empty proto must not produce an empty collection
assert.throws(
  () => protoToHttp([{ relPath: 'empty.proto', text: 'syntax = "proto3";' }], { source: 'empty.proto' }),
  /no gRPC methods/,
);

// true name collision (same target twice) dedupes with `_2`, never ` #2`
const dup = protoToHttp(
  [{ relPath: 'dup.proto', text: 'service S { rpc M (A) returns (B); }\nservice S { rpc M (A) returns (B); }' }],
  { source: 'dup.proto' },
);
const dupNames = parseRequests(dup.text).map((r) => r.name);
assert.deepEqual(dupNames.sort(), ['S_M', 'S_M_2']);

console.log('proto.selfcheck: ok');
