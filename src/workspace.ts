/**
 * Workspace scanning + (lazy) request index.
 * `listFiles` runs on every launch; `buildWorkspace` only when the user opens
 * cross-file search.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';
import { collectionsDir } from './store';

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
async function findHttpFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, 0, out);
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

export interface ScannedFile {
  /** Absolute path. */
  file: string;
  /** Path relative to its own root, for display. */
  relPath: string;
  source: 'project' | 'collection';
}

/** Project files under `root`, plus imported collections (outside `root`). */
export async function listFiles(root: string, local = false): Promise<ScannedFile[]> {
  const project = (await findHttpFiles(root)).map(
    (file): ScannedFile => ({ file, relPath: path.relative(root, file), source: 'project' }),
  );

  const dir = collectionsDir(local);
  const collections = (await findHttpFiles(dir)).map(
    (file): ScannedFile => ({ file, relPath: path.relative(dir, file), source: 'collection' }),
  );

  return [...project, ...collections];
}

export interface IndexedRequest extends HttpRequest {
  /** Absolute path, so a search hit can be sent without knowing the file. */
  file: string;
  /** Display path (`~/…` for imported collections). */
  relPath: string;
}

/** Parse every .http/.rest under `root` AND the collection store. */
export async function buildWorkspace(root: string, local = false): Promise<IndexedRequest[]> {
  const files = await listFiles(root, local);
  const perFile = await Promise.all(
    files.map(async ({ file, relPath, source }): Promise<IndexedRequest[]> => {
      try {
        const content = await readFile(file, 'utf8');
        const display = source === 'collection' ? `~/${relPath}` : relPath;
        return parseRequests(content).map((req) => ({ ...req, file, relPath: display }));
      } catch {
        return [];
      }
    }),
  );
  return perFile.flat();
}
