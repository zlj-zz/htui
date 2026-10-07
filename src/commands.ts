/**
 * Headless CLI commands. These never touch the TUI and never require a TTY,
 * so an agent can drive them.
 */
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runChain, type ChainEntry } from './chain';
import { importOpenApi } from './import-openapi';
import { parseRequests } from './parse';
import { isOk, type HttpyacRequestResult } from './result';
import { httpyacOnPath, HTTPYAC_INSTALL_HINT, runRequest, selectRequest } from './run';
import { collectionDir, collectionsDir, readIndex, sanitizeName, writeIndex } from './store';

export interface Flags {
  name?: string;
  baseUrl?: string;
  env?: string;
  line?: number;
  force: boolean;
  local: boolean;
  chain: boolean;
  json: boolean;
  /** Set on a bad option; commands report it and exit 2. */
  error?: string;
  positional: string[];
}

export function parseFlags(args: string[]): Flags {
  const flags: Flags = { force: false, local: false, chain: false, json: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg === '-n') flags.name = args[++i];
    else if (arg === '--base-url') flags.baseUrl = args[++i];
    else if (arg === '--env' || arg === '-e') flags.env = args[++i];
    else if (arg === '--line' || arg === '-l') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) flags.error ??= '--line requires a positive integer';
      else flags.line = n;
    } else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--base-url=')) flags.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--env=')) flags.env = arg.slice('--env='.length);
    else if (arg === '--force' || arg === '-f') flags.force = true;
    else if (arg === '--local') flags.local = true;
    else if (arg === '--chain') flags.chain = true;
    else if (arg === '--json') flags.json = true;
    else if (arg.startsWith('-') && arg !== '-') flags.error ??= `unknown option: ${arg}`;
    else flags.positional.push(arg);
  }
  return flags;
}

export async function importCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.error) {
    process.stderr.write(`htui import: ${flags.error}\n`);
    return 2;
  }
  const { name, baseUrl, force, local, positional } = flags;
  const spec = positional[0];
  if (!spec) {
    process.stderr.write('usage: htui import <spec.json> [--name N] [--force] [--local] [--base-url URL]\n');
    return 2;
  }
  try {
    const result = await importOpenApi({ specPath: spec, name, baseUrl, force, local });
    const verb = result.overwritten ? 'overwrote' : 'imported';
    const env = result.varsAdded ? ` · +${result.varsAdded} vars` : '';
    process.stdout.write(`${verb} ${result.name} → ${result.file} (${result.endpoints} requests)${env}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`htui import: ${message(err)}\n`);
    return 1;
  }
}

export async function listCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.error) {
    process.stderr.write(`htui list: ${flags.error}\n`);
    return 2;
  }
  const { local } = flags;
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
  const flags = parseFlags(args);
  if (flags.error) {
    process.stderr.write(`htui remove: ${flags.error}\n`);
    return 2;
  }
  const { local, positional } = flags;
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
    await rm(collectionDir(name, local), { recursive: true, force: true });
    await rm(path.join(collectionsDir(local), `${name}.http`), { force: true }); // legacy flat layout
    delete index[name];
    await writeIndex(local, index);
    process.stdout.write(`removed ${name}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`htui remove: ${message(err)}\n`);
    return 1;
  }
}

export async function sendCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.error) {
    process.stderr.write(`htui send: ${flags.error}\n`);
    return 2;
  }
  const { name, line, chain, env, json, positional } = flags;
  const file = positional[0];
  if (!file) {
    process.stderr.write('usage: htui send <file.http> [--name N | --line N] [--chain] [-e ENV] [--json]\n');
    return 2;
  }

  // Say so up front instead of failing on the first request.
  if (!httpyacOnPath()) {
    process.stderr.write(`htui send: ${HTTPYAC_INSTALL_HINT}\n`);
    return 1;
  }

  const filePath = path.resolve(file);
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    process.stderr.write(`htui send: cannot read ${file}\n`);
    return 2;
  }

  const selected = selectRequest(parseRequests(content), { name, line });
  if (!selected.req) {
    process.stderr.write(`htui send: ${selected.error}\n`);
    return 2;
  }

  const activeEnv = env ?? process.env.HTUI_ENV ?? 'default';
  let target: HttpyacRequestResult | undefined;
  let prerequisites: ChainEntry[] = [];
  try {
    if (chain) {
      const outcome = await runChain({ file: filePath, content, target: selected.req, env: activeEnv });
      target = outcome.target;
      prerequisites = outcome.prerequisites;
    } else {
      target = await runRequest(filePath, selected.req, activeEnv);
    }
  } catch (err) {
    process.stderr.write(`htui send: ${message(err)}\n`);
    return 1;
  }

  const ok = isOk(target);
  process.stdout.write(
    json
      ? `${JSON.stringify({ ok, target: brief(target), prerequisites }, null, 2)}\n`
      : `${human(target, prerequisites)}\n`,
  );
  return ok ? 0 : 1;
}

function brief(target?: HttpyacRequestResult): Record<string, unknown> | null {
  if (!target) return null;
  return {
    name: target.name,
    statusCode: target.response?.statusCode,
    statusMessage: target.response?.statusMessage,
    duration: target.duration,
    body: target.response?.body,
    tests: target.testResults,
  };
}

function human(target: HttpyacRequestResult | undefined, prerequisites: ChainEntry[]): string {
  const lines: string[] = [];
  for (const p of prerequisites) {
    const status = p.statusCode != null ? ` ${p.statusCode}` : '';
    lines.push(`${p.ok ? '✓' : '✗'} ${p.name}${status}${p.message ? ` — ${p.message}` : ''}`);
  }
  if (!target) {
    lines.push('✗ request did not run');
    return lines.join('\n');
  }
  const r = target.response;
  const timing = target.duration != null ? ` · ${Math.round(target.duration)}ms` : '';
  lines.push(`${r?.statusCode ?? '?'} ${r?.statusMessage ?? ''}${timing}`.trim());
  const body = typeof r?.body === 'string' ? r.body : r?.body != null ? JSON.stringify(r.body, null, 2) : '';
  if (body) lines.push(body);
  for (const t of target.testResults ?? []) {
    lines.push(`${t.status === 'SUCCESS' ? '✓' : '✗'} ${t.message ?? ''}`);
  }
  return lines.join('\n');
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
      '  htui send <file.http> [options]         send a request (headless)',
      '  htui --help | --version',
      '',
      'import options:',
      '  --name N        collection name (default: spec title)',
      '  --force         overwrite an existing collection',
      '  --local         store in ./.htui/collections instead of ~/.config/htui',
      '  --base-url URL  override the server URL',
      '',
      'send options:',
      '  --name N | --line N  pick the request (needed if the file has several)',
      '  --chain              run prerequisite requests first',
      '  -e, --env E          httpyac environment',
      '  --json               machine-readable output',
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
