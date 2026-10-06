import assert from 'node:assert/strict';
import { htuiHome, sanitizeName, slugify } from './store';

// name sanitization: accept the boring, reject anything path- or argv-dangerous
assert.equal(sanitizeName('petstore'), 'petstore');
assert.equal(sanitizeName('my-api.v2'), 'my-api.v2');
for (const bad of ['', '  ', '../etc/passwd', 'a/b', '.', '..', '-rf', 'con', 'NUL.json', 'a b']) {
  assert.throws(() => sanitizeName(bad), `should reject ${JSON.stringify(bad)}`);
}

// slugify always produces something sanitizeName accepts
assert.equal(slugify('Pet Store API'), 'pet-store-api');
assert.equal(slugify('  '), 'collection');
assert.equal(slugify('../../x'), 'x');
for (const s of ['Pet Store API', '  ', '../../x', '-weird-']) {
  assert.doesNotThrow(() => sanitizeName(slugify(s)));
}

// HTUI_HOME overrides; the default must never throw
process.env.HTUI_HOME = '/tmp/htui-test-home';
assert.equal(htuiHome(), '/tmp/htui-test-home');
delete process.env.HTUI_HOME;
assert.ok(htuiHome().length > 0);

console.log('store.selfcheck: ok');
