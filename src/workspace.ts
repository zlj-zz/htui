/**
 * Workspace scanning + (lazy) request index.
 * `findHttpFiles` is used on every launch; `buildWorkspace` only when the user
 * opens cross-file search.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';

const HTTP_FILE = /\.(http|rest)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist']);

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else if (HTTP_FILE.test(entry.name)) out.push(full);
  }
}

/** Sorted so grouping/ranking is deterministic (readdir order is not). */
export async function findHttpFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, 0, out);
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

export interface IndexedRequest extends HttpRequest {
  /** Absolute path, so a search hit can be sent without knowing the file. */
  file: string;
  /** Path relative to the workspace root, for display. */
  relPath: string;
}

/** Parse every .http/.rest under `root` into a flat, sendable request list. */
export async function buildWorkspace(root: string): Promise<IndexedRequest[]> {
  const files = await findHttpFiles(root);
  const perFile = await Promise.all(
    files.map(async (file): Promise<IndexedRequest[]> => {
      try {
        const content = await readFile(file, 'utf8');
        const relPath = path.relative(root, file);
        return parseRequests(content).map((req) => ({ ...req, file, relPath }));
      } catch {
        return [];
      }
    }),
  );
  return perFile.flat();
}
