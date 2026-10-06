import assert from 'node:assert/strict';
import { osc52, shellQuote, toCurl } from './share';

assert.equal(shellQuote("a'b"), "'a'\\''b'");
assert.equal(shellQuote('plain'), "'plain'");

const curl = toCurl({
  method: 'POST',
  url: 'http://x/things',
  headers: { 'Content-Type': 'application/json', 'Content-Length': '5', 'X-Trace': 'abc' },
  body: '{"name":"x"}',
});
assert.match(curl, /^curl -X POST \\\n/);
assert.match(curl, /-H 'Content-Type: application\/json'/);
assert.match(curl, /-H 'X-Trace: abc'/);
assert.doesNotMatch(curl, /Content-Length/); // curl sets it
assert.match(curl, /--data-raw '\{"name":"x"\}'/);
assert.match(curl, /'http:\/\/x\/things'$/);

// GET without a body
assert.equal(toCurl({ method: 'get', url: 'http://x/a' }), "curl -X GET \\\n  'http://x/a'");

// OSC 52 wraps the base64 payload
assert.equal(osc52('hi'), '\u001b]52;c;aGk=\u0007');

console.log('share.selfcheck: ok');
