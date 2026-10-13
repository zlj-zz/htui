import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectionEnv,
  envFileWithRows,
  envRowsOf,
  htuiHome,
  mergeEnv,
  readEnvNames,
  readRecency,
  recencyPath,
  sanitizeName,
  slugify,
  writeRecency,
} from './store';

// --- pure: naming ---
assert.equal(sanitizeName('petstore'), 'petstore');
assert.equal(sanitizeName('my-api.v2'), 'my-api.v2');
for (const bad of ['', '  ', '../etc/passwd', 'a/b', '.', '..', '-rf', 'con', 'NUL.json', 'a b']) {
  assert.throws(() => sanitizeName(bad), `should reject ${JSON.stringify(bad)}`);
}
assert.equal(slugify('Pet Store API'), 'pet-store-api');
assert.equal(slugify('  '), 'collection');
assert.equal(slugify('../../x'), 'x');
for (const s of ['Pet Store API', '  ', '../../x', '-weird-']) {
  assert.doesNotThrow(() => sanitizeName(slugify(s)));
}

// --- pure: home resolution ---
process.env.HTUI_HOME = '/tmp/htui-test-home';
assert.equal(htuiHome(), '/tmp/htui-test-home');

// --- IO: env merge must be write-once and fail-safe ---
const home = await mkdtemp(path.join(os.tmpdir(), 'htui-store-'));
process.env.HTUI_HOME = home;
try {
  // a corrupt (JSONC) env file must NOT be clobbered — that could erase secrets
  await mkdir(path.join(home, 'collections', 'x'), { recursive: true });
  const corrupt = '{ // jsonc comment\n  "default": { "token": "keep-me" }\n}';
  await writeFile(collectionEnv('x', false), corrupt);
  await assert.rejects(() => mergeEnv('x', false, 'default', { baseUrl: 'http://x' }), /not valid JSON/);
  assert.equal(await readFile(collectionEnv('x', false), 'utf8'), corrupt); // untouched

  // a missing file is created; write-once keeps edited values
  assert.equal(await mergeEnv('y', false, 'default', { baseUrl: 'http://a', token: 't' }), 2);
  assert.deepEqual(await readEnvNames(collectionEnv('y', false)), ['default']);
  assert.equal(await mergeEnv('y', false, 'default', { baseUrl: 'http://CHANGED', extra: '1' }), 1);
  const env = JSON.parse(await readFile(collectionEnv('y', false), 'utf8')) as Record<string, Record<string, string>>;
  assert.equal(env.default.baseUrl, 'http://a'); // kept
  assert.equal(env.default.extra, '1'); // added

  // forceKeys (explicit --base-url) overrides
  await mergeEnv('y', false, 'default', { baseUrl: 'http://forced' }, ['baseUrl']);
  const forced = JSON.parse(await readFile(collectionEnv('y', false), 'utf8')) as Record<string, Record<string, string>>;
  assert.equal(forced.default.baseUrl, 'http://forced');
} finally {
  await rm(home, { recursive: true, force: true });
}

// --- IO: recency (persisted request-list sort) round-trips and is fail-safe ---
const recHome = await mkdtemp(path.join(os.tmpdir(), 'htui-recency-'));
process.env.HTUI_HOME = recHome;
try {
  assert.deepEqual(await readRecency(), {}); // missing → {}
  await writeRecency({ '/a.http': ['GET /x'] });
  assert.deepEqual(await readRecency(), { '/a.http': ['GET /x'] });
  await writeFile(recencyPath(), '{ not json');
  assert.deepEqual(await readRecency(), {}); // corrupt → {}, no crash
  await writeFile(recencyPath(), `${JSON.stringify({ '/a.http': ['GET /x'], nope: 3, mixed: ['ok', 7] })}\n`);
  assert.deepEqual(await readRecency(), { '/a.http': ['GET /x'], mixed: ['ok'] }); // wrong shapes dropped
} finally {
  await rm(recHome, { recursive: true, force: true });
}

delete process.env.HTUI_HOME;
assert.ok(htuiHome().length > 0);

// --- env rows: rename leaves no orphan, non-string values survive ---
const envContent = `${JSON.stringify({
  dev: { token: 'abc', retries: 3, obj: { a: 1 }, $headers: { 'X-G': 'g' }, $reserved: 'keep' },
  prod: { token: 'prod-secret' },
})}\n`;
assert.deepEqual(envRowsOf(envContent, 'dev'), [
  { kind: 'var', name: 'token', value: 'abc' },
  { kind: 'header', name: 'X-G', value: 'g' },
]);
const renamed = envFileWithRows(envContent, 'dev', [
  { kind: 'var', name: 'authToken', value: 'abc' },
  { kind: 'header', name: 'X-G', value: 'g' },
]);
const devAfter = JSON.parse(renamed).dev;
assert.equal(devAfter.token, undefined); // rename left no orphan
assert.equal(devAfter.authToken, 'abc');
assert.deepEqual(devAfter.retries, 3); // non-string values survive
assert.deepEqual(devAfter.obj, { a: 1 });
assert.equal(devAfter.$reserved, 'keep'); // unknown $-keys survive
assert.equal(JSON.parse(renamed).prod.token, 'prod-secret'); // other envs untouched
const noHeaders = JSON.parse(envFileWithRows(envContent, 'dev', [{ kind: 'var', name: 'token', value: 'abc' }])).dev;
assert.equal('$headers' in noHeaders, false); // empty $headers is removed

console.log('store.selfcheck: ok');
