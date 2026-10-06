/**
 * End-to-end: import an OpenAPI spec, then send every generated request with
 * httpyac against a local mock server. Proves the contract:
 * generate -> write http + env -> parse -> select by line -> httpyac (-e default).
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

/** httpyac needs `-e default` now that variables live in the env file. */
const send = (file: string, line: number) =>
  execFileAsync(
    'httpyac',
    ['send', path.basename(file), '--line', String(line), '--json', '--no-color', '-e', 'default'],
    { cwd: path.dirname(file) },
  );

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
  assert.ok(result.varsAdded > 0);

  // generated file: requests only; env file carries the variables
  const content = await readFile(result.file, 'utf8');
  assert.doesNotMatch(content, /^@/m);
  const env = JSON.parse(
    await readFile(path.join(path.dirname(result.file), 'http-client.env.json'), 'utf8'),
  ) as Record<string, Record<string, string>>;
  assert.equal(env.default.baseUrl, `http://127.0.0.1:${port}`);

  const requests = parseRequests(content);
  assert.equal(requests.length, 3);

  const observed: string[] = [];
  for (const request of requests) {
    const { stdout } = await send(result.file, request.line);
    const response = JSON.parse(stdout).requests[0].response;
    assert.equal(response.statusCode, 200, `line ${request.line} status`);
    const echoed = JSON.parse(response.body) as { method: string; path: string };
    observed.push(`${echoed.method} ${echoed.path}`);
  }
  assert.deepEqual(observed.sort(), ['GET /pets/0', 'GET /pets?limit=20', 'POST /pets']);

  // re-import must not clobber env edits
  const envPath = path.join(path.dirname(result.file), 'http-client.env.json');
  const edited = JSON.parse(await readFile(envPath, 'utf8')) as Record<string, Record<string, string>>;
  edited.default.baseUrl = 'http://edited';
  await writeFile(envPath, JSON.stringify(edited));
  await importOpenApi({ specPath, name: 'petstore', force: true });
  const after = JSON.parse(await readFile(envPath, 'utf8')) as Record<string, Record<string, string>>;
  assert.equal(after.default.baseUrl, 'http://edited'); // write-once: user value kept

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
  const [ping] = parseRequests(await readFile(v2.file, 'utf8'));
  const pingOut = await send(v2.file, ping.line);
  assert.equal(JSON.parse(JSON.parse(pingOut.stdout).requests[0].response.body).path, '/v1/ping');

  console.log(`import.e2e: ok (${result.endpoints} requests, env + Swagger 2.0, write-once env)`);
} finally {
  server.close();
  await rm(home, { recursive: true, force: true });
}
