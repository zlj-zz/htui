/**
 * Import an OpenAPI 3.x JSON document into a collection. I/O only — generation
 * lives in `./openapi`.
 *
 * Layout per collection:
 *   collections/<name>/<name>.http           generated, overwritten on re-import
 *   collections/<name>/http-client.env.json  hand-owned, only ever merged
 *   collections/<name>/<name>.local.http     hand-owned, never touched
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultCollectionName, openapiToHttp, type OpenApiDoc } from './openapi';
import { resolveCollectionName } from './store';
import { swagger2ToOas3, type Swagger2Doc } from './swagger2';
import { writeCollection, type ImportResult } from './write-collection';

export interface ImportOptions {
  specPath: string;
  name?: string;
  force?: boolean;
  /** Keep the collection inside the current project (`.htui/collections`). */
  local?: boolean;
  baseUrl?: string;
}

export type { ImportResult } from './write-collection';

function resolveSpec(specPath: string): string {
  const resolved = path.resolve(specPath);
  if (/\.ya?ml$/i.test(resolved)) throw new Error('YAML specs are not supported (JSON only)');
  return resolved;
}

/** Read + validate a spec and derive its default collection name (for the TUI form). */
export async function inspectSpec(specPath: string): Promise<{ name: string }> {
  const resolved = resolveSpec(specPath);
  const doc = await readSpec(resolved);
  return { name: resolveCollectionName(undefined, defaultCollectionName(doc, resolved)) };
}

export async function importOpenApi(opts: ImportOptions): Promise<ImportResult> {
  const specPath = resolveSpec(opts.specPath);
  const doc = await readSpec(specPath);
  const name = resolveCollectionName(opts.name, defaultCollectionName(doc, specPath));
  const { text, vars } = openapiToHttp(doc, { source: path.basename(specPath), baseUrl: opts.baseUrl });
  return writeCollection({
    name,
    local: Boolean(opts.local),
    force: opts.force,
    text,
    vars,
    lockKeys: opts.baseUrl ? ['baseUrl'] : [],
    source: opts.specPath,
  });
}

async function readSpec(specPath: string): Promise<OpenApiDoc> {
  let raw: string;
  try {
    raw = await readFile(specPath, 'utf8');
  } catch {
    throw new Error(`cannot read spec: ${specPath}`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, '')); // strip BOM
  } catch {
    throw new Error(`not valid JSON: ${specPath}`);
  }

  const candidate = doc as OpenApiDoc;
  if (!candidate || typeof candidate !== 'object' || (!candidate.openapi && !candidate.swagger)) {
    throw new Error(`not an OpenAPI/Swagger document: ${specPath}`);
  }
  // Normalize Swagger 2.0 to OpenAPI 3 so the generator only ever sees v3.
  return candidate.openapi ? candidate : swagger2ToOas3(candidate as Swagger2Doc);
}
