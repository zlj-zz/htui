/**
 * Swagger 2.0 → OpenAPI 3.0 shim. Pure, just enough for our generator:
 * servers, body/formData params → requestBody, non-body params → schema,
 * definitions → components.schemas, securityDefinitions → securitySchemes,
 * and `$ref` rewriting. Not a general-purpose converter.
 */
import type { OpenApiDoc } from './openapi';

// ponytail: v2 and v3 shapes do not map 1:1, so a couple of values are cast
// loosely (`as unknown as OpenApiDoc['components']`). Behaviour is pinned by
// swagger2.selfcheck + openapi.selfcheck + import.e2e.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

export interface Swagger2Doc {
  swagger?: string;
  info?: { title?: string };
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  paths?: Record<string, Record<string, unknown>>;
  definitions?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  securityDefinitions?: Record<string, Swagger2SecurityDef>;
  security?: Array<Record<string, string[]>>;
}

interface Swagger2SecurityDef {
  type?: string;
  name?: string;
  in?: string;
}

interface Swagger2Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  items?: unknown;
  schema?: unknown;
  collectionFormat?: string;
}

interface Swagger2Operation {
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: Swagger2Parameter[];
  consumes?: string[];
  security?: Array<Record<string, string[]>>;
}

function rewriteRef(ref: string): string {
  return ref
    .replace(/^#\/definitions\//, '#/components/schemas/')
    .replace(/^#\/parameters\//, '#/components/parameters/');
}

/** Recursively rewrite v2 `$ref` pointers to their v3 locations. */
function rewriteRefs<T>(node: T): T {
  if (Array.isArray(node)) return node.map(rewriteRefs) as unknown as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === '$ref' && typeof value === 'string' ? rewriteRef(value) : rewriteRefs(value);
    }
    return out as T;
  }
  return node;
}

/** v2 non-body params carry type/format/enum at the top level; v3 nests them under `schema`. */
function convertParam(p: Swagger2Parameter): Record<string, unknown> {
  if (p.$ref) return { $ref: rewriteRef(p.$ref) };
  return rewriteRefs({
    name: p.name,
    in: p.in,
    required: p.required,
    description: p.description,
    schema: { type: p.type, format: p.format, enum: p.enum, default: p.default, items: p.items },
  }) as Record<string, unknown>;
}

function convertOperation(op: Swagger2Operation, doc: Swagger2Doc): Record<string, unknown> {
  const params = op.parameters ?? [];
  const body = params.find((p) => p.in === 'body');
  const formData = params.filter((p) => p.in === 'formData');
  const rest = params.filter((p) => p.in !== 'body' && p.in !== 'formData').map(convertParam);

  const out: Record<string, unknown> = { operationId: op.operationId, parameters: rest };
  if (op.tags) out.tags = op.tags;
  if (op.deprecated) out.deprecated = true;
  if (op.security) out.security = op.security;

  const consumes = op.consumes ?? doc.consumes ?? ['application/json'];
  if (body) {
    out.requestBody = { content: { [consumes[0]]: { schema: rewriteRefs(body.schema) } } };
  } else if (formData.length) {
    out.requestBody = {
      content: {
        [consumes[0]]: {
          schema: {
            type: 'object',
            properties: Object.fromEntries(formData.map((p) => [p.name, { type: p.type, format: p.format }])),
          },
        },
      },
    };
  }
  return out;
}

export function swagger2ToOas3(v2: Swagger2Doc): OpenApiDoc {
  const servers: Array<{ url: string }> = [];
  if (v2.host) {
    const scheme = v2.schemes?.[0] ?? 'https';
    servers.push({ url: `${scheme}://${v2.host}${v2.basePath ?? ''}` });
  } else if (v2.basePath) {
    servers.push({ url: v2.basePath });
  }

  const securitySchemes: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(v2.securityDefinitions ?? {})) {
    if (def.type === 'basic') securitySchemes[name] = { type: 'http', scheme: 'basic' };
    else if (def.type === 'apiKey') securitySchemes[name] = { type: 'apiKey', name: def.name, in: def.in };
    else if (def.type === 'oauth2') securitySchemes[name] = { type: 'oauth2' };
  }

  const paths: Record<string, unknown> = {};
  for (const [route, item] of Object.entries(v2.paths ?? {})) {
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (key === 'parameters') converted.parameters = (value as Swagger2Parameter[]).map(convertParam);
      else if ((METHODS as readonly string[]).includes(key)) {
        converted[key] = convertOperation(value as Swagger2Operation, v2);
      } else converted[key] = value; // summary / description
    }
    paths[route] = converted;
  }

  return {
    openapi: '3.0.3',
    info: v2.info,
    servers: servers.length ? servers : undefined,
    paths: paths as OpenApiDoc['paths'],
    components: {
      securitySchemes,
      schemas: rewriteRefs(v2.definitions ?? {}),
      parameters: rewriteRefs(v2.parameters ?? {}),
    } as unknown as OpenApiDoc['components'],
    security: v2.security,
  };
}
