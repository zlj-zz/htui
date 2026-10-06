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

const http = openapiToHttp(oas, { source: 'petstore-v2.json' });
assert.match(http, /^@baseUrl = https:\/\/api\.example\.com\/v1$/m);
assert.match(http, /^GET \{\{baseUrl\}\}\/pets\/\{\{id\}\}$/m);
assert.match(http, /^PUT \{\{baseUrl\}\}\/pets\/\{\{id\}\}$/m);
assert.match(http, /^@id = 0$/m);
assert.match(http, /^X-Api-Key: \{\{apiKey\}\}$/m); // securityDefinitions -> securitySchemes
assert.match(http, /"name": "string"/); // body came through #/definitions -> #/components/schemas
assert.match(http, /### getPet/);
assert.match(http, /### updatePet/);
assert.doesNotMatch(http, /verbose/); // optional query param is not emitted

console.log('swagger2.selfcheck: ok');
