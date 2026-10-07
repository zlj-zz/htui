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
import { isAbort, runRequest } from './run';

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
  // A1 regression: an aborted run must kill the child instead of waiting for it.
  const slow = createServer((_req, res) =>
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    }, 3000),
  );
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = (slow.address() as { port: number }).port;
  const slowContent = `### slow\nGET http://127.0.0.1:${slowPort}/slow`;
  const slowFile = path.join(dir, 'slow.http');
  await writeFile(slowFile, slowContent);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await runRequest(slowFile, parseRequests(slowContent)[0], undefined, controller.signal);
    assert.fail('a cancelled request must not complete');
  } catch (err) {
    assert.equal(isAbort(err), true, 'the failure must be recognized as a cancel');
    assert.ok(Date.now() - started < 2000, 'the cancel must not wait for the response');
  } finally {
    slow.close();
  }

  console.log('run.e2e: ok (--line picks the right region; Esc cancel kills the child)');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
