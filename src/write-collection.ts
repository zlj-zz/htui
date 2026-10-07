/**
 * The one writer for imported collections: force gate, `.http`, copied
 * material, env merge, index. Every importer (OpenAPI, proto) goes through it,
 * so the paths cannot drift — and the TUI's overwrite-confirm contract (the
 * exact "already exists" message, matched by ImportForm) is defined here
 * exactly once.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRequests } from './parse';
import { collectionDir, collectionHttp, mergeEnv, readIndex, writeIndex } from './store';

export const ENV_NAME = 'default';

export interface ImportResult {
  name: string;
  file: string;
  endpoints: number;
  overwritten: boolean;
  /** Environment variables newly added to the env file (never overwritten). */
  varsAdded: number;
  envName: string;
}

export interface WriteCollectionOptions {
  name: string;
  local: boolean;
  force?: boolean;
  /** Generated `.http` content — `endpoints` is computed from it. */
  text: string;
  /** Variables merged (write-once) into the env file. */
  vars: Record<string, string>;
  /** Env keys written even when they already exist (an explicit --base-url). */
  lockKeys?: string[];
  /** Recorded verbatim in the index — the path as the user typed it. */
  source: string;
  /** Generated files to place under `copyDir` inside the collection. */
  copy?: Array<{ relPath: string; content: string }>;
  /** Removed before `copy` files are written, so stale material cannot linger. */
  copyDir?: string;
}

export async function writeCollection(opts: WriteCollectionOptions): Promise<ImportResult> {
  const file = collectionHttp(opts.name, opts.local);

  const index = await readIndex(opts.local);
  const exists = index[opts.name] !== undefined || (await fileExists(file));
  if (exists && !opts.force) {
    throw new Error(`collection "${opts.name}" already exists (use --force to overwrite)`);
  }

  const endpoints = parseRequests(opts.text).length;
  const dir = collectionDir(opts.name, opts.local);
  await mkdir(dir, { recursive: true });
  await writeAtomic(file, opts.text);

  // Generated material, so it sits behind the force gate: an aborted import
  // writes nothing, and a re-import never leaves stale copies behind.
  if (opts.copy?.length && opts.copyDir) {
    const copyRoot = path.join(dir, opts.copyDir);
    await rm(copyRoot, { recursive: true, force: true });
    for (const item of opts.copy) {
      const target = path.join(copyRoot, item.relPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, item.content);
    }
  }

  // The env file is hand-owned: fill missing keys only (lockKeys win).
  const varsAdded = await mergeEnv(opts.name, opts.local, ENV_NAME, opts.vars, opts.lockKeys ?? []);

  index[opts.name] = { source: opts.source, importedAt: new Date().toISOString(), endpoints };
  await writeIndex(opts.local, index);

  return { name: opts.name, file, endpoints, overwritten: exists, varsAdded, envName: ENV_NAME };
}

export async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    if (process.platform === 'win32') await rm(file, { force: true }); // win rename fails on existing
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
