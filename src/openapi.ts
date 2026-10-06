/**
 * Pure OpenAPI v3 → `.http` generation. No I/O, no dependencies.
 *
 * Only internal `$ref` (`#/...`) is supported — external (cross-file) refs are
 * rejected with a clear error, since that is where the dependency graph stops
 * being worth it. The caller is expected to pass a plain JSON document.
 */

export interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: Server[];
  paths?: Record<string, PathItem>;
  components?: {
    securitySchemes?: Record<string, SecurityScheme>;
    schemas?: Record<string, Schema>;
    parameters?: Record<string, unknown>;
  };
  security?: SecurityRequirement[];
}

interface Server {
  url?: string;
  variables?: Record<string, { default?: string; enum?: string[] }>;
}

interface SecurityScheme {
  type?: string;
  scheme?: string;
  name?: string;
  in?: string;
}

type SecurityRequirement = Record<string, string[]>;

interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  deprecated?: boolean;
  example?: unknown;
  schema?: Schema;
}

interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  default?: unknown;
  enum?: unknown[];
  example?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
}

interface MediaType {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
}

interface RequestBody {
  content?: Record<string, MediaType>;
}

interface Operation {
  operationId?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  security?: SecurityRequirement[];
}

type PathItem = { parameters?: Parameter[] } & Partial<Record<Method, Operation>>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type Method = (typeof METHODS)[number];

function lookupRef(doc: OpenApiDoc, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  let cur: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/** Inline an internal `$ref`; a ref already on the stack yields an empty node (cycle). */
function deref<T>(doc: OpenApiDoc, node: T, seen: Set<string>): T {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const ref = (node as { $ref?: string }).$ref;
    if (typeof ref === 'string') {
      if (seen.has(ref)) return {} as T;
      seen.add(ref);
      const target = lookupRef(doc, ref);
      const resolved = target === undefined ? ({} as T) : deref(doc, target as T, seen);
      seen.delete(ref);
      return resolved;
    }
  }
  return node;
}

/** allOf = merge; oneOf/anyOf = take the first alternative. */
function resolveSchema(doc: OpenApiDoc, schema: Schema | undefined, seen: Set<string>): Schema {
  if (!schema) return {};
  const s = deref(doc, schema, seen);
  if (s.allOf) {
    const merged: Schema = { type: 'object', properties: {} };
    for (const part of s.allOf) {
      const r = resolveSchema(doc, part, seen);
      Object.assign(merged.properties!, r.properties ?? {});
      for (const key of ['type', 'enum', 'default', 'example', 'format'] as const) {
        if (r[key] !== undefined) (merged as Record<string, unknown>)[key] = r[key];
      }
    }
    return merged;
  }
  const union = s.oneOf ?? s.anyOf;
  if (union?.length) return resolveSchema(doc, union[0], seen);
  return s;
}

function exampleFromSchema(doc: OpenApiDoc, schema: Schema | undefined, seen: Set<string>): unknown {
  const s = resolveSchema(doc, schema, seen);
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];

  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(s.properties ?? {})) {
        out[key] = exampleFromSchema(doc, value, seen);
      }
      return out;
    }
    case 'array':
      return s.items ? [exampleFromSchema(doc, s.items, seen)] : [];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      if (s.format === 'date-time') return '1970-01-01T00:00:00Z';
      if (s.format === 'date') return '1970-01-01';
      return 'string';
    default:
      return s.properties ? exampleFromSchema(doc, { ...s, type: 'object' }, seen) : null;
  }
}

function serverUrl(doc: OpenApiDoc, warnings: string[]): string {
  const server = doc.servers?.[0];
  if (!server?.url) {
    warnings.push('# spec has no servers[0].url — set @baseUrl');
    return 'http://localhost:3000';
  }
  let url = server.url;
  for (const [name, variable] of Object.entries(server.variables ?? {})) {
    const value = variable.default ?? variable.enum?.[0];
    if (value === undefined) {
      warnings.push(`# server variable "${name}" has no default`);
      url = url.replace(`{${name}}`, `{{${name}}}`);
    } else {
      url = url.replace(`{${name}}`, value);
    }
  }
  if (!/^https?:\/\//.test(url)) {
    warnings.push(`# servers[0].url is relative ("${url}") — make @baseUrl absolute`);
  }
  return url.replace(/\/+$/, '');
}

interface Auth {
  headers: string[];
  query: string[];
  vars: Record<string, string>;
}

/** A Security Requirement Object is AND; the array is OR — take the first alternative. */
function securityFor(doc: OpenApiDoc, op: Operation, warnings: string[]): Auth {
  const auth: Auth = { headers: [], query: [], vars: {} };
  const requirement = (op.security ?? doc.security ?? [])[0];
  if (!requirement) return auth;

  const schemes = doc.components?.securitySchemes ?? {};
  for (const schemeName of Object.keys(requirement)) {
    const scheme = deref(doc, schemes[schemeName] ?? {}, new Set());
    switch (scheme.type) {
      case 'http':
        if (scheme.scheme === 'basic') {
          auth.vars.basicAuth = 'REPLACE_ME';
          auth.headers.push('Authorization: Basic {{basicAuth}}');
        } else {
          auth.vars.token = 'REPLACE_ME';
          auth.headers.push('Authorization: Bearer {{token}}');
        }
        break;
      case 'oauth2':
      case 'openIdConnect':
        auth.vars.token = 'REPLACE_ME';
        auth.headers.push('Authorization: Bearer {{token}}');
        break;
      case 'apiKey':
        auth.vars.apiKey = 'REPLACE_ME';
        if (scheme.in === 'header') auth.headers.push(`${scheme.name}: {{apiKey}}`);
        else if (scheme.in === 'query') auth.query.push(`${scheme.name}={{apiKey}}`);
        else warnings.push(`# apiKey "${schemeName}" in ${scheme.in} not supported`);
        break;
      default:
        if (scheme.type) warnings.push(`# security scheme "${schemeName}" (${scheme.type}) not supported`);
    }
  }
  return auth;
}

function mergeParams(doc: OpenApiDoc, pathItem: PathItem, op: Operation): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const raw of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(doc, raw, new Set());
    if (p.name && p.in) byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

function paramDefault(doc: OpenApiDoc, p: Parameter): string {
  if (p.example !== undefined) return String(p.example);
  const s = resolveSchema(doc, p.schema, new Set());
  if (s.default !== undefined) return String(s.default);
  if (s.enum?.length) return String(s.enum[0]);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'integer' || type === 'number') return '0';
  if (type === 'boolean') return 'false';
  return 'string';
}

function pickJsonContent(content: Record<string, MediaType>): string | undefined {
  const keys = Object.keys(content);
  return (
    keys.find((k) => /^application\/json\b/i.test(k)) ??
    keys.find((k) => k.toLowerCase().endsWith('+json'))
  );
}

function bodyFor(
  doc: OpenApiDoc,
  op: Operation,
  warnings: string[],
): { contentType: string; text: string } | undefined {
  const body = op.requestBody ? deref(doc, op.requestBody, new Set()) : undefined;
  if (!body?.content) return undefined;

  const contentType = pickJsonContent(body.content);
  if (!contentType) {
    warnings.push('# request body is not JSON — skipped');
    return undefined;
  }
  const media = body.content[contentType];
  let value: unknown;
  if (media.example !== undefined) value = media.example;
  else if (media.examples) value = Object.values(media.examples)[0]?.value;
  if (value === undefined && media.schema) value = exampleFromSchema(doc, media.schema, new Set());

  return { contentType, text: JSON.stringify(value ?? {}, null, 2) };
}

function uniqueName(op: Operation, method: Method, route: string, seen: Set<string>): string {
  const base =
    (op.operationId ?? `${method.toUpperCase()} ${route}`).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() ||
    `${method.toUpperCase()} ${route}`;
  let name = base;
  for (let n = 2; seen.has(name); n++) name = `${base} #${n}`;
  seen.add(name);
  return name;
}

interface EmitOptions {
  source: string;
  baseUrl?: string;
}

/** The generated `.http` text plus the variables the environment must provide. */
export interface EmittedCollection {
  text: string;
  vars: Record<string, string>;
}

export function openapiToHttp(doc: OpenApiDoc, opts: EmitOptions): EmittedCollection {
  if (doc.swagger && !doc.openapi) throw new Error('Swagger 2.0 is not supported (OpenAPI 3.x only)');

  const warnings: string[] = [];
  // Variables live in the env file, not the generated file: a file-level `@var`
  // would outrank the env (verified), which would lock the environment.
  const vars: Record<string, string> = { baseUrl: opts.baseUrl ?? serverUrl(doc, warnings) };
  const blocks: string[] = [];
  const names = new Set<string>();
  let endpoints = 0;

  const declare = (name: string, value: string) => {
    if (!(name in vars)) vars[name] = value;
  };

  for (const route of Object.keys(doc.paths ?? {}).sort()) {
    const pathItem = doc.paths?.[route];
    if (!pathItem) continue;

    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (op.deprecated) {
        warnings.push(`# skipped deprecated ${method.toUpperCase()} ${route}`);
        continue;
      }
      endpoints++;

      const params = mergeParams(doc, pathItem, op);
      let url = `{{baseUrl}}${route}`;
      for (const p of params) {
        if (p.in === 'path' && p.name) {
          url = url.replace(`{${p.name}}`, `{{${p.name}}}`);
          declare(p.name, paramDefault(doc, p));
        }
      }

      const auth = securityFor(doc, op, warnings);
      for (const [name, value] of Object.entries(auth.vars)) declare(name, value);

      const query = [...auth.query];
      for (const p of params) {
        if (p.in === 'query' && p.required && p.name) {
          query.push(`${p.name}={{${p.name}}}`);
          declare(p.name, paramDefault(doc, p));
        }
      }
      if (query.length) url += `?${query.join('&')}`;

      const headers = [...auth.headers];
      const body = bodyFor(doc, op, warnings);
      if (body) headers.push(`Content-Type: ${body.contentType}`);
      headers.push('Accept: application/json');

      const lines = [`### ${uniqueName(op, method, route, names)}`, `${method.toUpperCase()} ${url}`, ...headers];
      if (body) lines.push('', body.text);
      blocks.push(lines.join('\n'));
    }
  }

  if (endpoints === 0) throw new Error('spec has no operations');

  const header = [
    `# source: ${opts.source} · OpenAPI ${doc.openapi ?? '3.x'} · ${endpoints} endpoints`,
    ...warnings,
  ].join('\n');

  return { text: `${[header, ...blocks].join('\n\n')}\n`, vars };
}

/** Title if present, else the file name without extension. Slugified by the caller. */
export function defaultCollectionName(doc: OpenApiDoc, sourcePath: string): string {
  const title = doc.info?.title?.trim();
  if (title) return title;
  return sourcePath.split(/[\\/]/).pop()?.replace(/\.(json|yaml|yml)$/i, '') ?? 'collection';
}
