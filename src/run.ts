/**
 * Single-request execution + request selection. Shared by the TUI and the
 * headless `htui send` command, so both paths behave identically.
 */
import { execFile } from 'node:child_process';
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

export async function runRequest(
  file: string,
  req: HttpRequest,
  env?: string,
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
    }));
  } catch (err: unknown) {
    // httpyac exits non-zero on failed tests but still prints the JSON result.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout?.trim()) {
      stdout = e.stdout;
      stderr = e.stderr ?? '';
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
