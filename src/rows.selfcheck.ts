import assert from 'node:assert/strict';
import { bodyWindow, buildEntries, filterAndRank, floatToTop, formatMs, jsonSpans, scoreMatch, sparkline, truncateToWidth, urlGroup, viewport, wrapToWidth } from './rows';

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

// sparkline: trend shape over response times
assert.equal(sparkline([]), '');
assert.equal(sparkline([5, 5, 5]), '▁▁▁');
assert.equal(sparkline([4, 1]), '█▁');
assert.equal(sparkline([1, 2, 3, 4]).length, 4);

// jsonSpans: keys cyan, strings green, numbers yellow, keywords magenta
assert.deepEqual(jsonSpans('  "token": "abc",'), [
  { text: '  ' },
  { text: '"token":', color: 'cyan' },
  { text: ' ' },
  { text: '"abc"', color: 'green' },
  { text: ',' },
]);
assert.deepEqual(jsonSpans('  "exp": 3600'), [
  { text: '  ' },
  { text: '"exp":', color: 'cyan' },
  { text: ' ' },
  { text: '3600', color: 'yellow' },
]);
assert.deepEqual(jsonSpans('  "ok": true'), [
  { text: '  ' },
  { text: '"ok":', color: 'cyan' },
  { text: ' ' },
  { text: 'true', color: 'magenta' },
]);
assert.deepEqual(jsonSpans('{'), [{ text: '{' }]);

// formatMs: fixed 2 decimals
assert.equal(formatMs(182), '182.00ms');
assert.equal(formatMs(182.345), '182.35ms');
assert.equal(formatMs(0), '0.00ms');

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

// bodyWindow replaced the old 200-line clip: the whole body stays reachable
assert.deepEqual(bodyWindow(576, 18, 574), { offset: 559, count: 17, scrollable: true, maxScroll: 559 });

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

// wrapToWidth: over-wide lines must become rows Ink can count (CJK is 2 columns)
assert.deepEqual(wrapToWidth('short', 20), ['short']);
assert.deepEqual(wrapToWidth('abcdef', 3), ['abc', 'def']);
assert.deepEqual(wrapToWidth('a已发b', 4), ['a已', '发b']); // 已/发 are 2 columns each
assert.equal(wrapToWidth('a'.repeat(500), 40).every((r) => r.length <= 40), true);
assert.equal(wrapToWidth('', 10)[0], '');
assert.equal(truncateToWidth('abcdef', 4), 'abc…');
assert.equal(truncateToWidth('abc', 9), 'abc');
assert.equal(wrapToWidth('已发货金额', 5).length, 3); // 5 columns fits 2 CJK chars per row

// bodyWindow: never more rows than the pane can draw, one row for the marker
assert.deepEqual(bodyWindow(5, 10, 0), { offset: 0, count: 5, scrollable: false, maxScroll: 0 });
assert.deepEqual(bodyWindow(30, 10, 0), { offset: 0, count: 9, scrollable: true, maxScroll: 21 });
assert.deepEqual(bodyWindow(30, 10, 5), { offset: 5, count: 9, scrollable: true, maxScroll: 21 });
assert.equal(bodyWindow(30, 10, 999).offset, 21); // clamps at the end
assert.equal(bodyWindow(30, 10, -4).offset, 0); // and at the start
assert.equal(bodyWindow(0, 10, 0).count, 0);
assert.equal(bodyWindow(30, 1, 0).count, 1); // a squeezed pane still shows a row

console.log('rows.selfcheck: ok');
