/**
 * Regression for C1: httpyac's `--line` matches a region by its `###` line, not
 * by the request line. A request line immediately before the next `###` is a
 * dead zone: httpyac then opens its interactive picker, which hangs an agent.
 *
 * Run: npm run e2e
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRequests } from './parse';
import { runRequest } from './run';

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const dir = await mkdtemp(path.join(os.tmpdir(), 'htui-run-'));
try {
  const file = path.join(dir, 'minimal.http');
  // No blank lines: every request line sits right before the next `###`.
  const content = ['### a', `GET http://127.0.0.1:${port}/a`, '### b', `GET http://127.0.0.1:${port}/b`].join('\n');
  await writeFile(file, content);

  const requests = parseRequests(content);
  assert.equal(requests.length, 2);
  for (const req of requests) {
    const result = await runRequest(file, req);
    assert.equal(result.response?.statusCode, 200, `${req.name} must complete, not hang`);
    // and it must be the RIGHT region, not a neighbour
    assert.equal(JSON.parse(String(result.response?.body)).path, `/${req.name}`);
  }
  console.log('run.e2e: ok (--line selects the right region; no dead-zone hang)');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
