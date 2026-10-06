/**
 * Import an OpenAPI 3.x JSON document into a `.http` collection.
 * I/O only — all generation lives in `./openapi`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultCollectionName, openapiToHttp, type OpenApiDoc } from './openapi';
import { parseRequests } from './parse';
import { collectionsDir, readIndex, sanitizeName, slugify, writeIndex } from './store';
import { swagger2ToOas3, type Swagger2Doc } from './swagger2';

export interface ImportOptions {
  specPath: string;
  name?: string;
  force?: boolean;
  /** Keep the collection inside the current project (`.htui/collections`). */
  local?: boolean;
  baseUrl?: string;
}

export interface ImportResult {
  name: string;
  file: string;
  endpoints: number;
  overwritten: boolean;
}

function resolveSpec(specPath: string): string {
  const resolved = path.resolve(specPath);
  if (/\.ya?ml$/i.test(resolved)) throw new Error('YAML specs are not supported (JSON only)');
  return resolved;
}

/** Read + validate a spec and derive its default collection name (for the TUI form). */
export async function inspectSpec(specPath: string): Promise<{ name: string }> {
  const resolved = resolveSpec(specPath);
  const doc = await readSpec(resolved);
  return { name: sanitizeName(slugify(defaultCollectionName(doc, resolved))) };
}

export async function importOpenApi(opts: ImportOptions): Promise<ImportResult> {
  const specPath = resolveSpec(opts.specPath);
  const doc = await readSpec(specPath);
  const explicitName = opts.name?.trim();
  const name = explicitName
    ? sanitizeName(explicitName) // explicit names are validated strictly, never silently rewritten
    : sanitizeName(slugify(defaultCollectionName(doc, specPath)));
  const local = Boolean(opts.local);
  const dir = collectionsDir(local);
  const file = path.join(dir, `${name}.http`);

  const index = await readIndex(local);
  const exists = index[name] !== undefined || (await fileExists(file));
  if (exists && !opts.force) {
    throw new Error(`collection "${name}" already exists (use --force to overwrite)`);
  }

  const content = openapiToHttp(doc, { source: path.basename(specPath), baseUrl: opts.baseUrl });
  await mkdir(dir, { recursive: true });

  // Atomic-ish write: unique tmp file, rename over the target.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    if (process.platform === 'win32') await rm(file, { force: true }); // win rename fails on existing
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }

  const endpoints = parseRequests(content).length;
  index[name] = { source: opts.specPath, importedAt: new Date().toISOString(), endpoints };
  await writeIndex(local, index);

  return { name, file, endpoints, overwritten: exists };
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

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
