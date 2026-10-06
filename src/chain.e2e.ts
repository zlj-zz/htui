/**
 * End-to-end: prove that the slice-and-run chain carries session state (a
 * login cookie) into the target request — the whole point of run-chain.
 * Run: npm run e2e   (needs `httpyac` on PATH)
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runChain } from './chain';
import { parseRequests } from './parse';

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/login') {
      res.setHeader('set-cookie', 'sid=abc; Path=/');
      res.end(JSON.stringify({ token: 'XYZ' }));
    } else {
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const dir = await mkdtemp(path.join(os.tmpdir(), 'htui-chain-'));
try {
  const file = path.join(dir, 'chain.http');
  const content = [
    '### login',
    `POST http://127.0.0.1:${port}/login`,
    'Content-Type: application/json',
    '',
    '{"u":"a"}',
    '',
    '### me',
    `GET http://127.0.0.1:${port}/me`,
  ].join('\n');
  await writeFile(file, content);

  const target = parseRequests(content)[1];
  const outcome = await runChain({ file, content, target });

  assert.equal(outcome.prerequisites.length, 1);
  assert.equal(outcome.prerequisites[0].ok, true);
  assert.equal(outcome.target?.response?.statusCode, 200);
  // the login cookie set in the prerequisite reached the target
  assert.equal(JSON.parse(String(outcome.target?.response?.body)).cookie, 'sid=abc');

  // a preamble `@var` must survive the slice and apply under --all
  const preFile = path.join(dir, 'preamble.http');
  const preContent = [`@host = http://127.0.0.1:${port}`, '', '### ping', 'GET {{host}}/ping'].join('\n');
  await writeFile(preFile, preContent);
  const preTarget = parseRequests(preContent)[0];
  const preOutcome = await runChain({ file: preFile, content: preContent, target: preTarget });
  assert.equal(preOutcome.target?.response?.statusCode, 200, 'preamble @var must resolve under --all');

  console.log('chain.e2e: ok (session cookie + preamble var survive the slice)');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
