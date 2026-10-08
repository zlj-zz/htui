import assert from 'node:assert/strict';
import { isStaleGeneration, noticeTtl } from './notice';

// acknowledgements fade; warnings and state explanations stay put
assert.equal(noticeTtl('info'), 2000);
assert.equal(noticeTtl('warn'), null);

// a pending fade from an older notice must not clear the newer one
assert.equal(isStaleGeneration(1, 2), true);
assert.equal(isStaleGeneration(3, 3), false);

console.log('notice.selfcheck: ok');
