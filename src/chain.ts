/**
 * Run-chain: execute a request together with the prerequisite requests it
 * depends on (login → token, session cookie).
 *
 * httpyac can only run one region (`--line`) or the whole file (`--all`), and
 * cross-request state (cookies, response variables) lives only inside a single
 * invocation. So we slice the file up to the target region and run the slice.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HttpRequest } from './parse';
import { isOk, parseSendOutput, type HttpyacRequestResult } from './result';

const execFileAsync = promisify(execFile);

/** Preamble + every region up to and including `target` — the slice to run. */
export function sliceUpTo(content: string, target: HttpRequest): string {
  return content.split(/\r?\n/).slice(0, target.endLine).join('\n') + '\n';
}

export interface ChainEntry {
  name: string;
  ok: boolean;
  statusCode?: number;
  message?: string;
}

/**
 * In the sliced run the target is the LAST request and everything before it is
 * a prerequisite (avoids matching by name, which httpyac can reject).
 */
export function summarizeChain(requests: HttpyacRequestResult[]): {
  target?: HttpyacRequestResult;
  prerequisites: ChainEntry[];
} {
  if (requests.length === 0) return { prerequisites: [] };
  const target = requests[requests.length - 1];
  const prerequisites = requests.slice(0, -1).map((r) => ({
    name: r.name ?? 'request',
    ok: isOk(r),
    statusCode: r.response?.statusCode,
    message: (r.testResults ?? []).find((t) => t.status === 'ERROR')?.message,
  }));
  return { target, prerequisites };
}

export interface ChainOutcome {
  /** The target's result, or undefined when `--bail` stopped before it ran. */
  target?: HttpyacRequestResult;
  prerequisites: ChainEntry[];
}

export async function runChain(opts: {
  file: string;
  content: string;
  target: HttpRequest;
  env?: string;
}): Promise<ChainOutcome> {
  const dir = path.dirname(opts.file);
  // Dot-prefixed so workspace scanning never treats the temp file as a collection.
  const tmp = `.${path.basename(opts.file)}.chain.${randomUUID()}.tmp.http`;
  const tempPath = path.join(dir, tmp);

  const args = ['send', tmp, '--all', '--json', '--no-color', '--bail'];
  if (opts.env) args.push('-e', opts.env);

  try {
    await writeFile(tempPath, sliceUpTo(opts.content, opts.target), 'utf8');
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await execFileAsync('httpyac', args, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        cwd: dir,
      }));
    } catch (err: unknown) {
      // httpyac exits non-zero on failure but still prints the JSON result.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout?.trim()) {
        stdout = e.stdout;
        stderr = e.stderr ?? '';
      } else {
        throw new Error(e.stderr || e.message || String(err));
      }
    }
    const outcome = summarizeChain(parseSendOutput(stdout));
    if (outcome.target && !outcome.target.response && stderr.trim()) outcome.target.stderr = stderr.trim();
    return outcome;
  } finally {
    await rm(tempPath, { force: true });
  }
}
