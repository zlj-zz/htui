import assert from 'node:assert/strict';
import { buildEntries, clipBody, filterAndRank, floatToTop, scoreMatch, urlGroup, viewport } from './rows';

// urlGroup: scheme/host stripped, version segments skipped, domain extracted
assert.equal(urlGroup('https://api.example.com/v1/orders/123?id=7'), 'orders');
assert.equal(urlGroup('http://{{host}}/pets/{petId}'), 'pets');
assert.equal(urlGroup('{{host}}/pets/{petId}'), 'pets');
assert.equal(urlGroup('{{grpcHost}}/user.v1.UserService/GetUser'), 'user.v1.userservice');
assert.equal(urlGroup('/api/v2/thing'), 'thing');
assert.equal(urlGroup('/V1/orders'), 'orders'); // version match is case-insensitive
assert.equal(urlGroup('{{baseUrl}}'), 'other'); // no path — never the host
assert.equal(urlGroup('https://host:8443'), 'other');
assert.equal(urlGroup('{{petId}}/upload'), 'upload'); // template segments skipped
assert.equal(urlGroup('{{host}}/docs#/orders/get'), 'docs'); // fragment split
assert.equal(urlGroup('https://host?a=1/b'), 'other'); // query before any slash
assert.equal(urlGroup('host#f/x'), 'other'); // fragment before any slash

const k = (s: string) => s;

// empty query is a no-op passthrough (same array)
const all = ['a', 'b'];
assert.equal(filterAndRank('', all, k), all);

// substring match, prefix ranks first, original order preserved otherwise
assert.deepEqual(filterAndRank('post', ['xx post', 'post 1', 'nope'], k), ['post 1', 'xx post']);
assert.deepEqual(filterAndRank('get', ['GET a', 'GET b'], k), ['GET a', 'GET b']);
assert.deepEqual(filterAndRank('zzz', ['a', 'b'], k), []);
assert.equal(scoreMatch('post', 'post 1'), 0);
assert.equal(scoreMatch('post', 'xx post'), 3);

// NFC/NFD must compare equal (macOS readdir returns NFD)
const nfd = 'café'.normalize('NFD');
assert.notEqual(nfd, 'café');
assert.equal(scoreMatch('café', nfd), 0);

// grouping inserts a header only when the group changes
const entries = buildEntries(['a/x', 'a/y', 'b/z'], {
  labelOf: k,
  groupOf: (p) => p.split('/')[0],
  showGroups: true,
});
assert.deepEqual(
  entries.map((e) => `${e.type}:${e.label}`),
  ['group:a', 'item:a/x', 'item:a/y', 'group:b', 'item:b/z'],
);
// no groups when filtering
assert.deepEqual(
  buildEntries(['a/x'], { labelOf: k, groupOf: () => 'a', showGroups: false }).map((e) => e.type),
  ['item'],
);

// viewport keeps the cursor visible and never overflows
assert.deepEqual(viewport(3, 0, 5), { start: 0, end: 3 });
assert.deepEqual(viewport(10, 0, 4), { start: 0, end: 4 });
assert.deepEqual(viewport(10, 5, 4), { start: 3, end: 7 });
assert.deepEqual(viewport(10, 9, 4), { start: 6, end: 10 });

// clipBody caps the render and reports the remainder
assert.equal(clipBody('a\nb\nc'), 'a\nb\nc');
const big = Array.from({ length: 250 }, (_, i) => `line${i}`).join('\n');
const clippedLines = clipBody(big).split('\n');
assert.equal(clippedLines.length, 201); // 200 kept + one summary line
assert.equal(clippedLines[0], 'line0');
assert.match(clippedLines[200], /\(\+50 more lines\)/);

// floatToTop: ranked items float up in rank order; unranked keep their order
assert.deepEqual(
  floatToTop(['a', 'b', 'c', 'd'], (x) => (x === 'c' ? 0 : x === 'a' ? 1 : Number.MAX_SAFE_INTEGER)),
  ['c', 'a', 'b', 'd'],
);

const foldedEntries = buildEntries(
  [
    { g: 'a', id: 1 },
    { g: 'a', id: 2 },
    { g: 'b', id: 3 },
  ],
  {
    labelOf: (x: any) => `item-${x.id}`,
    groupOf: (x: any) => x.g,
    showGroups: true,
    collapsed: new Set(['a']),
    counts: new Map([
      ['a', 2],
      ['b', 1],
    ]),
  },
);
assert.deepEqual(
  foldedEntries.map((e) => (e.type === 'group' ? `g:${e.label}:${e.collapsed}:${e.count}` : `i:${e.label}`)),
  ['g:a:true:2', 'g:b:false:1', 'i:item-3'],
);

console.log('rows.selfcheck: ok');
