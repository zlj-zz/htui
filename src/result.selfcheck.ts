import assert from 'node:assert/strict';
import { hasResponse, testIcon } from './result';

// httpyac's status is a string enum — ERROR must NOT render as success.
assert.deepEqual(testIcon('SUCCESS'), { icon: '✓', color: 'green' });
assert.deepEqual(testIcon('SKIPPED'), { icon: '·', color: 'yellow' });
assert.deepEqual(testIcon('ERROR'), { icon: '✗', color: 'red' });
assert.deepEqual(testIcon(undefined), { icon: '✗', color: 'red' });

// a bare {} (failed request) is NOT a completed response
assert.equal(hasResponse({ statusCode: 200 }), true);
assert.equal(hasResponse({ statusCode: 0 }), true);
assert.equal(hasResponse({}), false);
assert.equal(hasResponse(null), false);
assert.equal(hasResponse(undefined), false);

console.log('result.selfcheck: ok');
