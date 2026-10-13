/**
 * Single-request execution + request selection. Shared by the TUI and the
 * headless `htui send` command, so both paths behave identically.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HttpRequest } from './parse';
import { parseSendOutput, type HttpyacRequestResult } from './result';

const execFileAsync = promisify(execFile);

/** httpyac rejects paths outside its cwd: pass a relative path, run from the file's dir. */
export function httpyacTarget(file: string): { arg: string; cwd: string } {
  const rel = path.relative(process.cwd(), file);
  const insideCwd = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return insideCwd ? { arg: rel, cwd: process.cwd() } : { arg: path.basename(file), cwd: path.dirname(file) };
}

export const HTTPYAC_INSTALL_HINT = 'httpyac was not found on PATH — install it with:  npm i -g httpyac';

/** True when an exec run was cancelled through the abort signal. */
export function isAbort(err: unknown): boolean {
  const e = err as { killed?: boolean; name?: string; code?: string };
  return e?.killed === true || e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

/**
 * True when an `httpyac` executable sits somewhere on `p` (default $PATH).
 * A PATH scan, not a spawn: startup must not pay a node cold-start. Shell
 * aliases and functions are invisible to this — those callers still get the
 * hint from the ENOENT mapping in `runRequest`.
 */
export function httpyacOnPath(p: string = process.env.PATH ?? ''): boolean {
  const names = process.platform === 'win32' ? ['httpyac.exe', 'httpyac.cmd', 'httpyac.bat'] : ['httpyac'];
  return p
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) =>
      names.some((name) => {
        try {
          return statSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      }),
    );
}

export async function runRequest(
  file: string,
  req: HttpRequest,
  env?: string,
  signal?: AbortSignal,
): Promise<HttpyacRequestResult> {
  const { arg, cwd } = httpyacTarget(file);
  // httpyac's --line matches a region by its `###` line, NOT the request line:
  // a request line right before the next `###` falls in a dead zone and makes
  // httpyac open its interactive picker (a hang when headless).
  const args = ['send', arg, '--line', String(req.startLine), '--json', '--no-color'];
  if (env) args.push('-e', env);

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync('httpyac', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      cwd,
      signal,
    }));
  } catch (err: unknown) {
    // httpyac exits non-zero on failed tests but still prints the JSON result.
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (isAbort(err)) throw err; // the caller cancelled — keep the abort recognizable
    if (e.stdout?.trim()) {
      stdout = e.stdout;
      stderr = e.stderr ?? '';
    } else if (e.code === 'ENOENT') {
      throw new Error(HTTPYAC_INSTALL_HINT);
    } else {
      throw new Error(e.stderr || e.message || String(err));
    }
  }

  const first = parseSendOutput(stdout)[0];
  if (!first) throw new Error('httpyac returned no requests');
  // A request with no response gives us only stderr as the failure channel.
  if (!first.response && stderr.trim()) first.stderr = stderr.trim();
  return first;
}

export interface Selector {
  /** Resolved region name (`# @name` or `### title`). */
  name?: string;
  /** Any line inside the region. */
  line?: number;
}

export function selectRequest(
  requests: HttpRequest[],
  sel: Selector,
): { req?: HttpRequest; error?: string } {
  if (sel.name != null) {
    const hits = requests.filter((r) => r.name === sel.name);
    if (hits.length === 0) return { error: `no request named "${sel.name}"` };
    if (hits.length > 1) return { error: `multiple requests named "${sel.name}"; use --line` };
    return { req: hits[0] };
  }
  if (sel.line != null) {
    const hit = requests.find((r) => r.startLine <= sel.line! && sel.line! <= r.endLine);
    return hit ? { req: hit } : { error: `no request at line ${sel.line}` };
  }
  if (requests.length === 1) return { req: requests[0] };
  return { error: 'file has multiple requests; pass --name or --line' };
}

/**
 * Send a materialized slice for one region — same `--line` semantics as
 * `runRequest`, but on provided content (used when env `$headers` must be
 * merged into the outgoing request). The temp file lives next to the original
 * so env discovery and relative references keep working, and `slice` must
 * preserve the region's line index (`modelSlice` does by construction).
 */
export async function runTempSlice(opts: {
  file: string;
  slice: string;
  req: HttpRequest;
  env?: string;
  signal?: AbortSignal;
}): Promise<HttpyacRequestResult> {
  const dir = path.dirname(opts.file);
  // Dot-prefixed so workspace scanning never treats the temp file as a collection.
  const tempPath = path.join(dir, `.${path.basename(opts.file)}.htui.${randomUUID()}.tmp.http`);
  // The slice can carry env-header secrets: never land it wider than the original.
  let mode: number | undefined;
  try {
    mode = (await stat(opts.file)).mode;
  } catch {
    mode = undefined;
  }
  await writeFile(tempPath, opts.slice, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  try {
    return await runRequest(tempPath, opts.req, opts.env, opts.signal);
  } finally {
    await rm(tempPath, { force: true });
  }
}
