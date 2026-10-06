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
      Pet: {
        type: 'object',
        properties: { name: { type: 'string' }, tag: { type: 'string' } },
      },
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

const out = openapiToHttp(spec, { source: 'petstore.json' });

// provenance header: version + non-deprecated endpoint count
assert.match(out, /# source: petstore\.json · OpenAPI 3\.0\.3 · 3 endpoints/);

// base url is a variable
assert.match(out, /^@baseUrl = https:\/\/api\.example\.com\/v1$/m);

// names from operationId; deprecated is skipped
for (const name of ['listPets', 'createPet', 'getPet']) assert.match(out, new RegExp(`### ${name}$`, 'm'));
assert.doesNotMatch(out, /### .*old/i);

// method + templated url (path param + required query param)
assert.match(out, /^GET \{\{baseUrl\}\}\/pets\?limit=\{\{limit\}\}$/m);
assert.match(out, /^GET \{\{baseUrl\}\}\/pets\/\{\{petId\}\}$/m);

// auth is a placeholder, never a literal credential
assert.match(out, /^Authorization: Bearer \{\{token\}\}$/m);
assert.doesNotMatch(out, /Bearer [A-Za-z0-9._-]{12,}/);

// parameter defaults come from the schema
assert.match(out, /^@limit = 20$/m);
assert.match(out, /^@petId = 0$/m);

// body synthesized through the $ref schema
assert.match(out, /"name": "string"/);

// invariant (S1): every {{var}} is declared in the preamble
const declared = new Set([...out.matchAll(/^@([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]));
for (const m of out.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
  assert.ok(declared.has(m[1]), `undeclared variable {{${m[1]}}}`);
}

// determinism (S2): same input -> byte-identical output
assert.equal(openapiToHttp(spec, { source: 'petstore.json' }), out);

// rejections
assert.throws(() => openapiToHttp({ openapi: '3.0.0', paths: {} }, { source: 'x' }), /no operations/);
assert.throws(() => openapiToHttp({ swagger: '2.0' }, { source: 'x' }), /Swagger 2\.0/);
assert.throws(
  () => openapiToHttp({ openapi: '3.0.0', paths: { '/x': { get: { parameters: [{ $ref: './common.json#/P' }] } } } }, { source: 'x' }),
  /external \$ref/,
);

// default name falls back to title, then file name
assert.equal(defaultCollectionName(spec, 'x.json'), 'Pet Store');
assert.equal(defaultCollectionName({}, '/a/b/orders.json'), 'orders');

console.log('openapi.selfcheck: ok');
