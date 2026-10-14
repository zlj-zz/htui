import assert from 'node:assert/strict';
import { openapiToHttp } from './openapi';
import { swagger2ToOas3, type Swagger2Doc } from './swagger2';

const v2: Swagger2Doc = {
  swagger: '2.0',
  info: { title: 'Pet Store' },
  host: 'api.example.com',
  basePath: '/v1',
  schemes: ['https'],
  consumes: ['application/json'],
  securityDefinitions: { key: { type: 'apiKey', name: 'X-Api-Key', in: 'header' } },
  security: [{ key: [] }],
  paths: {
    '/pets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }],
      get: {
        operationId: 'getPet',
        tags: ['pets'],
        parameters: [{ name: 'verbose', in: 'query', type: 'boolean' }],
      },
      put: {
        operationId: 'updatePet',
        parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Pet' } }],
      },
    },
  },
  definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
};

const oas = swagger2ToOas3(v2);
assert.equal(oas.openapi, '3.0.3');
assert.equal(oas.servers?.[0]?.url, 'https://api.example.com/v1');

const { text, vars } = openapiToHttp(oas, { source: 'petstore-v2.json' });
assert.equal(vars.baseUrl, 'https://api.example.com/v1');
assert.equal(vars.apiKey, 'REPLACE_ME');
assert.ok(!('id' in vars)); // per-endpoint params stay out of the env
assert.match(text, /^GET \{\{baseUrl\}\}\/pets\/\{\{id\}\}$/m);
assert.match(text, /^PUT \{\{baseUrl\}\}\/pets\/\{\{id\}\}$/m);
assert.match(text, /^X-Api-Key: \{\{apiKey\}\}$/m); // securityDefinitions -> securitySchemes
assert.match(text, /^# @group pets$/m); // v2 tags survive conversion + emission
assert.match(text, /"name": "string"/); // body came through #/definitions -> #/components/schemas
assert.match(text, /### getPet/);
assert.match(text, /### updatePet/);
assert.doesNotMatch(text, /verbose/); // optional query param is not emitted

console.log('swagger2.selfcheck: ok');
