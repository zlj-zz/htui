/**
 * Headless CLI commands. These never touch the TUI and never require a TTY,
 * so an agent can drive them.
 */
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { importOpenApi } from './import-openapi';
import { collectionsDir, readIndex, sanitizeName, writeIndex } from './store';

interface Flags {
  name?: string;
  baseUrl?: string;
  force: boolean;
  local: boolean;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { force: false, local: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg === '-n') flags.name = args[++i];
    else if (arg === '--base-url') flags.baseUrl = args[++i];
    else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--base-url=')) flags.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--force' || arg === '-f') flags.force = true;
    else if (arg === '--local') flags.local = true;
    else flags.positional.push(arg);
  }
  return flags;
}

export async function importCommand(args: string[]): Promise<number> {
  const { name, baseUrl, force, local, positional } = parseFlags(args);
  const spec = positional[0];
  if (!spec) {
    process.stderr.write('usage: htui import <spec.json> [--name N] [--force] [--local] [--base-url URL]\n');
    return 2;
  }
  try {
    const result = await importOpenApi({ specPath: spec, name, baseUrl, force, local });
    const verb = result.overwritten ? 'overwrote' : 'imported';
    process.stdout.write(`${verb} ${result.name} → ${result.file} (${result.endpoints} requests)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`htui import: ${message(err)}\n`);
    return 1;
  }
}

export async function listCommand(args: string[]): Promise<number> {
  const { local } = parseFlags(args);
  const index = await readIndex(local);
  const names = Object.keys(index).sort();
  if (names.length === 0) {
    process.stdout.write(`no collections in ${collectionsDir(local)}\n`);
    return 0;
  }
  for (const name of names) {
    const meta = index[name];
    process.stdout.write(`${name}\t${meta.endpoints} requests\t${meta.source}\t${meta.importedAt}\n`);
  }
  return 0;
}

export async function removeCommand(args: string[]): Promise<number> {
  const { local, positional } = parseFlags(args);
  const raw = positional[0];
  if (!raw) {
    process.stderr.write('usage: htui remove <name> [--local]\n');
    return 2;
  }
  try {
    const name = sanitizeName(raw);
    const index = await readIndex(local);
    if (index[name] === undefined) {
      process.stderr.write(`htui remove: no such collection "${name}"\n`);
      return 1;
    }
    await rm(path.join(collectionsDir(local), `${name}.http`), { force: true });
    delete index[name];
    await writeIndex(local, index);
    process.stdout.write(`removed ${name}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`htui remove: ${message(err)}\n`);
    return 1;
  }
}

export function printHelp(): void {
  process.stdout.write(
    [
      'htui — a terminal UI for httpyac',
      '',
      'usage:',
      '  htui [<file.http>]                      open the TUI (scans cwd)',
      '  htui import <spec.json> [options]       import OpenAPI 3.x as a collection',
      '  htui list [--local]                     list imported collections',
      '  htui remove <name> [--local]            delete a collection',
      '  htui --help | --version',
      '',
      'import options:',
      '  --name N        collection name (default: spec title)',
      '  --force         overwrite an existing collection',
      '  --local         store in ./.htui/collections instead of ~/.config/htui',
      '  --base-url URL  override the server URL',
      '',
      'note: YAML specs are not supported (JSON only); Swagger 2.0 is converted to OpenAPI 3.',
    ].join('\n') + '\n',
  );
}

export function printVersion(): void {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json') as { version: string };
  process.stdout.write(`${version}\n`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
