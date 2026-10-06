import assert from 'node:assert/strict';
import { hasResponse, isOk, parseSendOutput, testIcon } from './result';

// httpyac's status is a string enum — ERROR must NOT render as success.
assert.deepEqual(testIcon('SUCCESS'), { icon: '✓', color: 'green' });
assert.deepEqual(testIcon('SKIPPED'), { icon: '·', color: 'yellow' });
assert.deepEqual(testIcon('ERROR'), { icon: '✗', color: 'red' });
assert.deepEqual(testIcon(undefined), { icon: '✗', color: 'red' });

// a bare {} (failed request) is NOT a completed response
assert.equal(hasResponse({ statusCode: 200 }), true);
assert.equal(hasResponse({}), false);
assert.equal(hasResponse(null), false);

// one definition of "ok"
assert.equal(isOk({ response: { statusCode: 200 } }), true);
assert.equal(isOk({ response: { statusCode: 302 } }), true);
assert.equal(isOk({ response: { statusCode: 404 } }), false);
assert.equal(isOk({ response: { statusCode: 500 } }), false);
assert.equal(isOk({ response: { statusCode: 200 }, testResults: [{ status: 'ERROR' }] }), false);
assert.equal(isOk({ testResults: [{ status: 'ERROR' }] }), false); // no response
assert.equal(isOk(null), false);

// parsing httpyac output; a parse failure reads as truncation, not a bare SyntaxError
assert.deepEqual(parseSendOutput('{"requests":[{"name":"a"}]}'), [{ name: 'a' }]);
assert.deepEqual(parseSendOutput('{}'), []);
assert.throws(() => parseSendOutput('not json'), /not valid JSON/);

console.log('result.selfcheck: ok');
