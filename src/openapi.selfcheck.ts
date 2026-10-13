import assert from 'node:assert/strict';
import { defaultCollectionName, openapiToHttp, type OpenApiDoc } from './openapi';

const spec: OpenApiDoc = {
  openapi: '3.0.3',
  info: { title: 'Pet Store' },
  servers: [{ url: 'https://api.example.com/v1' }],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Pet: { type: 'object', properties: { name: { type: 'string' }, tag: { type: 'string' } } },
    },
  },
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
    '/old': { get: { deprecated: true } },
  },
};

const { text, vars } = openapiToHttp(spec, { source: 'petstore.json' });

assert.match(text, /# source: petstore\.json · OpenAPI 3\.0\.3 · 3 endpoints/);
// variables are NOT declared in the file — a file-level @var would outrank the env
assert.doesNotMatch(text, /^@/m);
// ...they come back as environment variables instead
assert.equal(vars.baseUrl, 'https://api.example.com/v1');
assert.equal(vars.token, 'REPLACE_ME'); // auth is global
assert.ok(!('limit' in vars) && !('petId' in vars)); // per-endpoint params stay out of the env

for (const name of ['listPets', 'createPet', 'getPet']) assert.match(text, new RegExp(`### ${name}$`, 'm'));
assert.doesNotMatch(text, /### .*old/i);
assert.match(text, /^GET \{\{baseUrl\}\}\/pets\?limit=\{\{limit\}\}$/m);
assert.match(text, /^GET \{\{baseUrl\}\}\/pets\/\{\{petId\}\}$/m);
assert.match(text, /^Authorization: Bearer \{\{token\}\}$/m);
assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]{12,}/);
assert.match(text, /"name": "string"/);

// invariant: the env provides exactly the globals; per-endpoint params
// (limit, petId) are referenced by the file but deliberately absent — a send
// with a missing one fails and names the variable
assert.deepEqual(Object.keys(vars).sort(), ['baseUrl', 'token']);

// determinism
const again = openapiToHttp(spec, { source: 'petstore.json' });
assert.equal(again.text, text);
assert.deepEqual(again.vars, vars);

// rejections
assert.throws(() => openapiToHttp({ openapi: '3.0.0', paths: {} }, { source: 'x' }), /no operations/);
assert.throws(() => openapiToHttp({ swagger: '2.0' }, { source: 'x' }), /Swagger 2\.0/);
assert.throws(
  () =>
    openapiToHttp(
      { openapi: '3.0.0', paths: { '/x': { get: { parameters: [{ $ref: './common.json#/P' }] } } } },
      { source: 'x' },
    ),
  /external \$ref/,
);

assert.equal(defaultCollectionName(spec, 'x.json'), 'Pet Store');
assert.equal(defaultCollectionName({}, '/a/b/orders.json'), 'orders');

console.log('openapi.selfcheck: ok');
