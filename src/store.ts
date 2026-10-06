/**
 * The collection store: where imported OpenAPI collections live on disk, how
 * their names are validated, and the sidecar index that records provenance.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Root of htui's user-level state: $HTUI_HOME > $XDG_CONFIG_HOME/htui > ~/.config/htui. */
export function htuiHome(): string {
  const override = process.env.HTUI_HOME?.trim();
  if (override) return path.resolve(override);

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'htui');

  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = ''; // stripped containers can throw; fall through to tmpdir
  }
  return path.join(home || os.tmpdir(), '.config', 'htui');
}

/** `--local` keeps collections inside the project so httpyac's config/env lookup still finds them. */
export function collectionsDir(local: boolean): string {
  return local
    ? path.join(process.cwd(), '.htui', 'collections')
    : path.join(htuiHome(), 'collections');
}

function indexPath(local: boolean): string {
  return path.join(collectionsDir(local), 'index.json');
}

// Windows reserved device names would make an unopenable file.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeName(input: string): string {
  const name = input.trim();
  const reject = (why: string): never => {
    throw new Error(`invalid collection name "${input}": ${why}`);
  };
  if (!name) reject('empty');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) reject('only A-Za-z0-9._- allowed');
  if (name === '.' || name === '..') reject('reserved');
  if (name.startsWith('-')) reject('must not start with "-"');
  if (RESERVED.test(name)) reject('reserved device name');
  return name;
}

/** Derive a usable default name from a spec title or file name. */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'collection';
}

interface CollectionMeta {
  source: string;
  importedAt: string;
  endpoints: number;
}

type CollectionIndex = Record<string, CollectionMeta>;

export async function readIndex(local: boolean): Promise<CollectionIndex> {
  try {
    return JSON.parse(await readFile(indexPath(local), 'utf8')) as CollectionIndex;
  } catch {
    return {}; // missing or corrupt index is not fatal
  }
}

export async function writeIndex(local: boolean, index: CollectionIndex): Promise<void> {
  const dir = collectionsDir(local);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(local), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}
