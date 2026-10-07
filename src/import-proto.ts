/**
 * Import `.proto` files into a gRPC collection. I/O only — generation lives in
 * `./proto`.
 *
 * Adds to the standard collection layout:
 *   collections/<name>/proto/**   generated copies of the input protos
 *                                 (`proto <` lines in the generated `.http`
 *                                 point here, relative to the `.http` file)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { protoToHttp } from './proto';
import { sanitizeName, slugify } from './store';
import { writeCollection, type ImportResult } from './write-collection';

export interface ImportProtoOptions {
  protoPaths: string[];
  name?: string;
  force?: boolean;
  /** Keep the collection inside the current project (`.htui/collections`). */
  local?: boolean;
  /** gRPC target, `host:port` — no scheme. */
  baseUrl?: string;
  /** Emit `# @grpc-reflection` and skip copying protos. */
  reflection?: boolean;
}

function defaultName(protoPaths: string[]): string {
  return path.basename(protoPaths[0]).replace(/\.proto$/i, '') || 'grpc';
}

async function readProtos(
  protoPaths: string[],
): Promise<{ sources: Array<{ relPath: string; text: string }>; source: string }> {
  if (protoPaths.length === 0) throw new Error('no proto files given');
  const abs = protoPaths.map((p) => path.resolve(p));
  const root = commonRoot(abs);
  const sources: Array<{ relPath: string; text: string }> = [];
  for (const file of abs) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new Error(`cannot read proto: ${file}`);
    }
    sources.push({ relPath: path.relative(root, file), text });
  }
  return { sources, source: protoPaths.join(', ') };
}

/** Longest directory prefix shared by every path (a single file: its own dir). */
function commonRoot(abs: string[]): string {
  if (abs.length === 1) return path.dirname(abs[0]);
  const parts = abs.map((a) => a.split(path.sep));
  const common: string[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) common.push(segment);
    else break;
  }
  return common.length ? common.join(path.sep) : path.sep;
}

/** Read + validate the protos and derive the default collection name (for the TUI form). */
export async function inspectProto(protoPath: string): Promise<{ name: string }> {
  const { sources } = await readProtos([protoPath]);
  protoToHttp(sources, { source: protoPath }); // throws when nothing parses
  return { name: sanitizeName(slugify(defaultName([protoPath]))) };
}

export async function importProto(opts: ImportProtoOptions): Promise<ImportResult> {
  const explicitName = opts.name?.trim();
  const name = explicitName
    ? sanitizeName(explicitName) // explicit names are validated strictly, never silently rewritten
    : sanitizeName(slugify(defaultName(opts.protoPaths)));
  const { sources, source } = await readProtos(opts.protoPaths);

  const { text, vars } = protoToHttp(sources, {
    source,
    baseUrl: opts.baseUrl,
    reflection: opts.reflection,
  });

  return writeCollection({
    name,
    local: Boolean(opts.local),
    force: opts.force,
    text,
    vars,
    lockKeys: opts.baseUrl ? ['grpcHost'] : [],
    source,
    copy: opts.reflection ? undefined : sources.map((s) => ({ relPath: s.relPath, content: s.text })),
    copyDir: 'proto',
  });
}
