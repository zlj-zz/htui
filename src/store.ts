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

/** Explicit names are validated strictly, never silently rewritten. */
export function resolveCollectionName(explicit: string | undefined, fallback: string): string {
  return explicit?.trim() ? sanitizeName(explicit.trim()) : sanitizeName(slugify(fallback));
}

interface CollectionMeta {
  source: string;
  importedAt: string;
  endpoints: number;
}

type CollectionIndex = Record<string, CollectionMeta>;

export async function readIndex(local: boolean): Promise<CollectionIndex> {
  const file = indexPath(local);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CollectionIndex;
  } catch (err) {
    // A missing index is fine; a corrupt one should not pass silently.
    if (!isMissing(err)) process.stderr.write(`htui: ignoring unreadable ${file}\n`);
    return {};
  }
}

export async function writeIndex(local: boolean, index: CollectionIndex): Promise<void> {
  const dir = collectionsDir(local);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(local), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

// --- per-collection layout: collections/<name>/{<name>.http, http-client.env.json, <name>.local.http} ---

export function collectionDir(name: string, local: boolean): string {
  return path.join(collectionsDir(local), name);
}

export function collectionHttp(name: string, local: boolean): string {
  return path.join(collectionDir(name, local), `${name}.http`);
}

export function collectionEnv(name: string, local: boolean): string {
  return path.join(collectionDir(name, local), 'http-client.env.json');
}

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

export type EnvVars = Record<string, string>;

/** Environment names declared in an http-client.env.json file (for the picker). */
export async function readEnvNames(file: string): Promise<string[]> {
  try {
    return Object.keys(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>);
  } catch {
    return [];
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

/** Nearest-first http-client.env.json files from `startDir` up to the fs root. */
export async function findEnvFiles(startDir: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, 'http-client.env.json');
    if (await fileExists(file)) found.push(file);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Every environment name visible to a file in `startDir` (httpyac walks parents). */
export async function collectEnvNames(startDir: string): Promise<{ names: string[]; files: string[] }> {
  const files = await findEnvFiles(startDir);
  const names = new Set<string>();
  for (const file of files) for (const name of await readEnvNames(file)) names.add(name);
  return { names: [...names].sort(), files };
}

/**
 * Write `vars` into `envName`, filling only missing keys so a re-import never
 * clobbers a value the user edited. `forceKeys` are written regardless
 * (an explicit --base-url). Returns how many keys were added.
 */
export async function mergeEnv(
  name: string,
  local: boolean,
  envName: string,
  vars: EnvVars,
  forceKeys: string[] = [],
): Promise<number> {
  const file = collectionEnv(name, local);
  let env: Record<string, EnvVars> = {};
  try {
    env = JSON.parse(await readFile(file, 'utf8')) as Record<string, EnvVars>;
  } catch (err) {
    // A missing file is fine (start fresh); a corrupt one must NOT be silently
    // replaced — that would erase the user's variables and secrets.
    if (!isMissing(err)) {
      throw new Error(`not overwriting ${file}: it is not valid JSON`);
    }
  }
  const target = env[envName] ?? (env[envName] = {});
  const force = new Set(forceKeys);
  let added = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in target)) added++;
    if (force.has(key) || !(key in target)) target[key] = value;
  }
  await mkdir(collectionDir(name, local), { recursive: true });
  await writeFile(file, `${JSON.stringify(env, null, 2)}\n`, 'utf8');
  return added;
}
