/**
 * End-to-end: import an OpenAPI spec, then send every generated request with
 * httpyac `--line` against a local mock server. This is the test that proves
 * the whole contract (generate -> parse -> select by line -> httpyac -> HTTP).
 *
 * Run: npm run e2e   (needs `httpyac` on PATH; not part of `npm run check`)
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { importOpenApi } from './import-openapi';
import { parseRequests } from './parse';

const execFileAsync = promisify(execFile);

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() || null }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const home = await mkdtemp(path.join(os.tmpdir(), 'htui-e2e-'));
process.env.HTUI_HOME = home; // collections land here, never in the repo

try {
  const specPath = path.join(home, 'petstore.json');
  await writeFile(
    specPath,
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Pet Store' },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', default: 20 } }],
          },
          post: {
            operationId: 'createPet',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          },
        },
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
          },
        },
      },
      components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
    }),
  );

  const result = await importOpenApi({ specPath, name: 'petstore' });
  assert.equal(result.endpoints, 3);

  const content = await readFile(result.file, 'utf8');
  const requests = parseRequests(content);
  assert.equal(requests.length, 3);

  const observed: string[] = [];
  for (const request of requests) {
    const { stdout } = await execFileAsync(
      'httpyac',
      ['send', path.basename(result.file), '--line', String(request.line), '--json', '--no-color'],
      { cwd: path.dirname(result.file) },
    );
    const response = JSON.parse(stdout).requests[0].response;
    assert.equal(response.statusCode, 200, `line ${request.line} status`);
    const echoed = JSON.parse(response.body) as { method: string; path: string };
    observed.push(`${echoed.method} ${echoed.path}`);
  }

  assert.deepEqual(observed.sort(), ['GET /pets/0', 'GET /pets?limit=20', 'POST /pets']);

  // overwrite semantics
  await assert.rejects(() => importOpenApi({ specPath, name: 'petstore' }), /already exists/);
  const again = await importOpenApi({ specPath, name: 'petstore', force: true });
  assert.equal(again.overwritten, true);

  // explicit names are rejected, not silently rewritten
  await assert.rejects(() => importOpenApi({ specPath, name: '../evil' }), /invalid collection name/);

  // Swagger 2.0 is converted and still sends
  const v2Path = path.join(home, 'legacy.json');
  await writeFile(
    v2Path,
    JSON.stringify({
      swagger: '2.0',
      info: { title: 'Legacy' },
      host: `127.0.0.1:${port}`,
      basePath: '/v1',
      schemes: ['http'],
      paths: { '/ping': { get: { operationId: 'ping' } } },
    }),
  );
  const v2 = await importOpenApi({ specPath: v2Path, name: 'legacy' });
  assert.equal(v2.endpoints, 1);
  const v2Content = await readFile(v2.file, 'utf8');
  assert.match(v2Content, new RegExp(`^@baseUrl = http://127\\.0\\.0\\.1:${port}/v1$`, 'm'));
  const [ping] = parseRequests(v2Content);
  const pingOut = await execFileAsync(
    'httpyac',
    ['send', path.basename(v2.file), '--line', String(ping.line), '--json', '--no-color'],
    { cwd: path.dirname(v2.file) },
  );
  assert.equal(JSON.parse(JSON.parse(pingOut.stdout).requests[0].response.body).path, '/v1/ping');

  console.log(`import.e2e: ok (${result.endpoints} requests, sent via --line; Swagger 2.0 ok)`);
} finally {
  server.close();
  await rm(home, { recursive: true, force: true });
}
