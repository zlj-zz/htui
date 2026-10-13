/**
 * Headless CLI commands. These never touch the TUI and never require a TTY,
 * so an agent can drive them.
 */
import { appVersion } from './version';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runChain, type ChainEntry } from './chain';
import { importOpenApi } from './import-openapi';
import { importProto } from './import-proto';
import { parseRequests } from './parse';
import { mergeEnvHeaders, modelSlice, requestModel } from './request';
import { isOk, type HttpyacRequestResult } from './result';
import { httpyacOnPath, HTTPYAC_INSTALL_HINT, runRequest, runTempSlice, selectRequest } from './run';
import { collectionDir, collectionsDir, readEnvHeaders, readIndex, sanitizeName, writeIndex } from './store';

export interface Flags {
  name?: string;
  baseUrl?: string;
  env?: string;
  line?: number;
  into?: string;
  force: boolean;
  local: boolean;
  chain: boolean;
  json: boolean;
  reflection: boolean;
  /** Set on a bad option; commands report it and exit 2. */
  error?: string;
  positional: string[];
}

export function parseFlags(args: string[]): Flags {
  const flags: Flags = { force: false, local: false, chain: false, json: false, reflection: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg === '-n') flags.name = args[++i];
    else if (arg === '--base-url') flags.baseUrl = args[++i];
    else if (arg === '--into') flags.into = args[++i];
    else if (arg === '--env' || arg === '-e') flags.env = args[++i];
    else if (arg === '--line' || arg === '-l') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) flags.error ??= '--line requires a positive integer';
      else flags.line = n;
    } else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--base-url=')) flags.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--into=')) flags.into = arg.slice('--into='.length);
    else if (arg.startsWith('--env=')) flags.env = arg.slice('--env='.length);
    else if (arg === '--force' || arg === '-f') flags.force = true;
    else if (arg === '--local') flags.local = true;
    else if (arg === '--chain') flags.chain = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--reflection') flags.reflection = true;
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
  const { name, baseUrl, force, local, reflection, positional } = flags;
  const spec = positional[0];
  if (!spec) {
    process.stderr.write(
      'usage: htui import <spec.json | spec.proto> [--name N] [--force] [--local] [--base-url HOST:PORT] [--reflection]\n',
    );
    return 2;
  }
  const isProto = /\.proto$/i.test(spec);
  if (!isProto && positional.length > 1) {
    process.stderr.write('htui import: expected one spec file\n');
    return 2;
  }
  try {
    const result = isProto
      ? await importProto({ protoPaths: positional, name, baseUrl, force, local, reflection })
      : await importOpenApi({ specPath: spec, name, baseUrl, force, local });
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
  const req = selected.req;
  let target: HttpyacRequestResult | undefined;
  let prerequisites: ChainEntry[] = [];
  try {
    // Global headers from the env's $headers apply headless too — but the env
    // itself stays explicit (flag / HTUI_ENV / default): scripts stay reproducible.
    const envHeaders = await readEnvHeaders(path.dirname(filePath), activeEnv);
    const merged = () => mergeEnvHeaders(requestModel(content, req), envHeaders);
    if (chain) {
      const outcome = await runChain({
        file: filePath,
        content,
        target: req,
        env: activeEnv,
        slice: Object.keys(envHeaders).length ? modelSlice(content, req, merged()) : undefined,
      });
      target = outcome.target;
      prerequisites = outcome.prerequisites;
    } else if (Object.keys(envHeaders).length) {
      target = await runTempSlice({
        file: filePath,
        slice: modelSlice(content, req, merged()),
        req,
        env: activeEnv,
      });
    } else {
      target = await runRequest(filePath, req, activeEnv);
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
      '  htui new [--into <file.http>]           create a request interactively',
      '  htui import <spec.json | spec.proto>    import OpenAPI 3.x or .proto as a collection',
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
  process.stdout.write(`${appVersion()}\n`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
