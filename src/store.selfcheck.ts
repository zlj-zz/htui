import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectionEnv, htuiHome, mergeEnv, readEnvNames, sanitizeName, slugify } from './store';

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

delete process.env.HTUI_HOME;
assert.ok(htuiHome().length > 0);

console.log('store.selfcheck: ok');
